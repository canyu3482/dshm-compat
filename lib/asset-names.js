/**
 * Asset files whose *names* the installer wrote wrong.
 *
 * DSHM's tar reader measured pax record lengths in bytes but sliced the decoded
 * string by character index (`hostcore/app/tar-gz.cjs`, `parsePax`). Every
 * non-ASCII path therefore swallowed the first `2 × (non-ASCII characters)`
 * characters of the record that followed:
 *
 *     东张西望.webm   →   `东张西望.webm\n19 mtim`
 *     上首软糖体.ttf  →   `上首软糖体.ttf\n19 mtime=`
 *
 * The bytes are intact; only the name is wrong. That matters because plugin
 * assets are served *by name*: `<video src="…/东张西望.webm">` becomes a 404, an
 * `<img>` shows a broken icon, `@font-face` silently falls back — and the host
 * log records nothing, because a 404 is a successful HTTP response. Users see a
 * plugin that "installed fine" and an empty screen.
 *
 * So the repair is purely nominal and deliberately conservative:
 *
 *   · only the part before the first control character is kept — that is the
 *     original name, byte for byte, because the tail was appended, never prepended;
 *   · file contents are never read, written, or compared;
 *   · nothing is deleted; a name whose target already exists is reported, not
 *     overwritten (two files collapsing into one would destroy content silently);
 *   · running it twice changes nothing the second time.
 *
 * The one shape this cannot fix is the *truncated* name: a path longer than 100
 * bytes is carried only in the pax `path` record, so when that record is dropped
 * the file lands under a `?`-substituted name with no control character in it.
 * No rename can recover that — the original name is not on disk any more. It is
 * reported as a known limit rather than guessed at.
 *
 * @module dshm-compat/asset-names
 */
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join, relative } from 'node:path'

/** C0 controls plus DEL: the signature the broken installer leaves behind. */
const CONTROL = /[\u0000-\u001f\u007f]/

const DEFAULT_MAX_ENTRIES = 20000
const DEFAULT_MAX_DEPTH = 12

/**
 * The name this entry should have had, or `undefined` when nothing can be proven.
 * The tail is whatever the installer appended after a control character, so the
 * prefix is the original name.
 *
 * @param {string} name
 */
export function repairedName(name) {
  const at = name.search(CONTROL)
  if (at < 0) return undefined
  // Trailing spaces/dots are trimmed because a filesystem may silently drop them,
  // which would make a rename look like it failed.
  const prefix = name.slice(0, at).replace(/[ .]+$/, '')
  return prefix === '' ? undefined : prefix
}

/**
 * Depth-first walk that hands every directory entry to `handler` and descends only
 * where the handler says the (possibly renamed) entry is still a directory.
 *
 * The three filesystem calls are injectable **only** so the repair path can be
 * exercised on a platform that forbids control characters in file names (Windows
 * rejects them outright, so such a tree cannot be created there). Production always
 * uses the real fs — the defaults below.
 *
 * @param {string} root
 * @param {{ maxEntries?: number, maxDepth?: number, readdir?: Function }} options
 * @param {(entry: { dir: string, name: string, rel: string, isDir: boolean, depth: number }) => { name?: string, isDir?: boolean } | undefined} handler
 */
function walk(root, options, handler) {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const readdir = options.readdir ?? readdirSync
  const stack = [{ dir: root, depth: 0 }]
  const errors = []
  let scanned = 0
  let truncated = false

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch (error) {
      errors.push({ dir, error: String(error?.message ?? error) })
      continue
    }
    for (const entry of entries) {
      scanned += 1
      if (scanned > maxEntries) {
        truncated = true
        return { scanned, truncated, errors }
      }
      // A symlink is never followed and never descended into: the phone profile
      // forbids `link(2)` anyway, and a link could point outside the profile.
      const isDir = entry.isDirectory() && !entry.isSymbolicLink()
      const outcome = handler({ dir, name: entry.name, rel: relative(root, join(dir, entry.name)), isDir, depth })
      const nextName = typeof outcome?.name === 'string' ? outcome.name : entry.name
      const nextIsDir = outcome?.isDir ?? isDir
      if (nextIsDir && depth < maxDepth) stack.push({ dir: join(dir, nextName), depth: depth + 1 })
    }
  }
  return { scanned, truncated, errors }
}

/**
 * Report the broken names under `root` without touching anything.
 *
 * @param {string} root
 * @param {{ maxEntries?: number, maxDepth?: number, readdir?: Function, exists?: Function }} [options]
 */
export function scanAssetNames(root, options = {}) {
  const exists = options.exists ?? existsSync
  if (!exists(root)) return { status: 'missing', root, scanned: 0, broken: [], truncated: false }
  const broken = []
  const walkResult = walk(root, options, entry => {
    const repaired = repairedName(entry.name)
    if (repaired !== undefined) {
      broken.push({
        path: join(entry.dir, entry.name),
        rel: entry.rel,
        name: entry.name,
        shouldBe: repaired,
        reason: 'control character in file name (installer appended pax metadata to it)',
      })
    }
    return undefined
  })
  return {
    status: 'ok',
    root,
    scanned: walkResult.scanned,
    broken,
    truncated: walkResult.truncated,
    errors: walkResult.errors,
  }
}

/**
 * Rename every broken name back to its original. Contents are untouched.
 *
 * @param {string} root
 * @param {{ maxEntries?: number, maxDepth?: number, dryRun?: boolean, readdir?: Function, exists?: Function, rename?: Function }} [options]
 */
export function repairAssetNames(root, options = {}) {
  const exists = options.exists ?? existsSync
  const rename = options.rename ?? renameSync
  if (!exists(root)) return { status: 'missing', root, repaired: [], skipped: [], counts: { repaired: 0, skipped: 0 } }
  const dryRun = options.dryRun === true
  const repaired = []
  const skipped = []

  const walkResult = walk(root, options, entry => {
    const target = repairedName(entry.name)
    if (target === undefined) return undefined
    const from = join(entry.dir, entry.name)
    const to = join(entry.dir, target)
    if (exists(to)) {
      // Never overwrite: that is how content disappears without a trace.
      skipped.push({ from, to, reason: 'target already exists; contents were not compared, so this file was left alone' })
      return undefined
    }
    if (dryRun) {
      repaired.push({ from, to, dryRun: true })
      return { name: target, isDir: entry.isDir }
    }
    try {
      rename(from, to)
      repaired.push({ from, to })
      return { name: target, isDir: entry.isDir }
    } catch (error) {
      skipped.push({ from, to, reason: String(error?.message ?? error) })
      return undefined
    }
  })

  return {
    status: 'ok',
    root,
    repaired,
    skipped,
    truncated: walkResult.truncated,
    counts: { repaired: repaired.length, skipped: skipped.length },
  }
}

/**
 * Audit one profile: the scan an install should have ended with.
 *
 * @param {string} profileDir
 * @param {{ maxEntries?: number, maxDepth?: number }} [options]
 */
export function auditAssets(profileDir, options = {}) {
  const nodeModules = join(profileDir, 'node_modules')
  if (!existsSync(nodeModules)) {
    return { status: 'missing', profileDir, nodeModules, reason: 'profile has no node_modules yet', scanned: 0, broken: [], truncated: false }
  }
  const scan = scanAssetNames(nodeModules, options)
  return {
    ...scan,
    profileDir,
    nodeModules,
    verdict: scan.broken.length === 0 ? 'clean' : 'broken-names',
    // Stated so a clean result is not read as proof: a truncated name has no
    // control character, and nothing on disk can restore the original.
    limits: 'a name with no control character is not proof of a correct name: paths over 100 bytes can also land under a truncated "?" name, which no rename can recover',
    fix: scan.broken.length === 0 ? undefined : 'rename with compat_audit { apply: true } (or `dshm-compat audit <profileDir> --fix`); the plugin keeps serving 404s until then',
  }
}
