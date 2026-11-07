/**
 * Quarantine: disable an installed plugin that would kill the host, before the next boot.
 *
 * Why this shape. DSHM keeps one file nobody overwrites —
 * `<profile>/.dshm-plugin-rows.yml` — with entries
 *
 *     - id: dsh-rewind
 *       disabled: true
 *
 * The entry script appends it to the profile's `cordis.patch.yml` at every boot, so a
 * disabled row is simply not mounted. That is the only lever a plugin can pull over
 * "what loads next time", and it needs no signature, no HAP rebuild and no root.
 *
 * What it can and cannot do, stated plainly:
 *
 *   · It **cannot** stop a plugin that is already mounted in the current process. If a
 *     row returns a rejected promise, the host is gone before any code of ours runs.
 *   · It **can** make sure the *next* boot is clean. One death, then quarantine — as
 *     opposed to dying on every start until the user finds the row by hand.
 *   · It never acts on suspicion. Only `host-killing` findings are quarantined, and only
 *     when the caller asked for it (`apply:true`).
 *
 * A true install-time gate needs a hook in DSHM's own install path; see `MARKET-HOOK.md`.
 *
 * @module dshm-compat/quarantine
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isScannableSource, scanText, summariseHostRisk } from './host-risk.js'

export const USER_ROWS_FILENAME = '.dshm-plugin-rows.yml'
const MAX_SCAN_BYTES = 512 * 1024
const MAX_FILES_PER_PACKAGE = 40

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * Read the user rows file. Tolerant: it is a two-line-per-entry YAML fragment that this
 * project writes itself, but a hand-edited file must not be destroyed.
 * @param {string} profileDir
 */
export function readRows(profileDir) {
  const file = join(profileDir, USER_ROWS_FILENAME)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const disabled = new Set()
  const present = new Set()
  let current
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const idMatch = /^-\s*id:\s*(.+)$/.exec(line)
    if (idMatch !== null) {
      current = idMatch[1].trim().replace(/^["']|["']$/g, '')
      present.add(current)
      continue
    }
    const flag = /^disabled:\s*(true|false)$/.exec(line)
    if (flag !== null && current !== undefined && flag[1] === 'true') disabled.add(current)
  }
  return { file, text, present, disabled }
}

/**
 * Add (or flip) a `disabled: true` row. Idempotent, append-only, keeps existing content.
 *
 * @param {string} profileDir
 * @param {string} id
 */
export function quarantineRow(profileDir, id) {
  if (typeof id !== 'string' || id.trim() === '') return { ok: false, reason: 'empty row id' }
  const rows = readRows(profileDir)
  if (rows.disabled.has(id)) return { ok: true, changed: false, reason: 'already disabled' }

  const header = rows.text === '' || rows.text.trim() === ''
    ? ['# 端侧「插件」页维护的用户行：只写「行 id + disabled」。', '# dshm-compat 追加：宿主级风险插件在下次启动前停用。', ''].join('\n')
    : (rows.text.endsWith('\n') ? rows.text : `${rows.text}\n`)

  // A row that exists but is `disabled: false` is flipped in place, so the file keeps
  // one entry per id rather than growing a contradictory pair.
  let text
  if (rows.present.has(id)) {
    const lines = header.split('\n')
    let inside = false
    let flipped = false
    text = lines.map(line => {
      const idMatch = /^-\s*id:\s*(.+)$/.exec(line.trim())
      if (idMatch !== null) {
        inside = idMatch[1].trim().replace(/^["']|["']$/g, '') === id
        return line
      }
      if (inside && /^disabled:\s*false$/.test(line.trim())) {
        flipped = true
        return line.replace('false', 'true')
      }
      return line
    }).join('\n')
    if (!/\n$/.test(text)) text += '\n'
    if (!flipped) {
      // A hand-edited row whose flag is not machine-readable (trailing YAML
      // comment, different spelling) must not be reported as changed when the
      // file was rewritten with nothing altered in it.
      return { ok: false, changed: false, reason: `row ${id} exists but carries no readable "disabled: false" line to flip; edit ${rows.file} by hand` }
    }
  } else {
    text = `${header}- id: ${id}\n  disabled: true\n`
  }

  try {
    writeFileSync(rows.file, text, 'utf8')
    return { ok: true, changed: true, file: rows.file }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Installed packages that declare a bundle row, with the row ids they insert.
 * @param {string} profileDir
 */
export function listBundleRows(profileDir) {
  const modulesDir = join(profileDir, 'node_modules')
  if (!existsSync(modulesDir)) return []
  const out = []
  const consider = (name, dir) => {
    const patchFile = join(dir, 'cordis.patch.yml')
    const manifestFile = join(dir, 'package.json')
    if (!existsSync(patchFile)) return
    let manifest
    try { manifest = record(JSON.parse(readFileSync(manifestFile, 'utf8'))) } catch { manifest = undefined }
    const patchText = readFileSync(patchFile, 'utf8')
    const rowIds = [...patchText.matchAll(/^\s*-\s*id:\s*([^\s#]+)/gm)].map(match => match[1].trim())
    if (rowIds.length === 0) return
    out.push({ name: String(manifest?.name ?? name), version: String(manifest?.version ?? ''), dir, rowIds })
  }
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(modulesDir, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) consider(`${entry.name}/${scoped.name}`, join(modulesDir, entry.name, scoped.name))
      }
      continue
    }
    consider(entry.name, join(modulesDir, entry.name))
  }
  return out
}

/**
 * Audit one installed package's own source (not its dependencies).
 * @param {{ name: string, dir: string }} pkg
 */
export function auditPackage(pkg) {
  const findings = []
  let scanned = 0
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (scanned >= MAX_FILES_PER_PACKAGE) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'test', 'tests', '__tests__', 'fixtures', 'examples', 'dist'].includes(entry.name)) continue
        walk(path)
        continue
      }
      if (!isScannableSource(entry.name)) continue
      try {
        if (statSync(path).size > MAX_SCAN_BYTES) continue
        const text = readFileSync(path, 'utf8')
        scanned += 1
        findings.push(...scanText(text, path.slice(pkg.dir.length + 1)))
      } catch {
        /* unreadable source: skip, the scan count reports what was actually read */
      }
    }
  }
  walk(pkg.dir)
  return { package: pkg.name, ...summariseHostRisk(findings, { scanned }) }
}

/**
 * Audit every installed bundle row and report the ones that would kill the host.
 *
 * @param {{
 *   profileDir: string,
 *   audited?: string[],
 *   apply?: boolean,
 * }} options
 */
export function guardInstalled(options) {
  const profileDir = String(options.profileDir ?? '')
  if (profileDir === '' || !existsSync(profileDir)) {
    return { status: 'error', error: { code: 'PROFILE_MISSING', message: `no profile directory: ${profileDir}` } }
  }
  const audited = new Set(options.audited ?? [])
  const packages = listBundleRows(profileDir)
  const rows = readRows(profileDir)
  const results = packages.map(pkg => {
    const audit = auditPackage(pkg)
    return {
      ...audit,
      rowIds: pkg.rowIds,
      alreadyDisabled: pkg.rowIds.filter(id => rows.disabled.has(id)),
      // Already analysed by an earlier `compat_market` run: not "unaudited", and the
      // market would have refused it. Kept in the report so the count is honest.
      auditedBefore: audited.has(pkg.name),
    }
  })
  const dangerous = results.filter(item => item.level === 'host-killing')

  const actions = []
  if (options.apply === true) {
    for (const item of dangerous) {
      for (const rowId of item.rowIds) {
        const result = quarantineRow(profileDir, rowId)
        actions.push({ package: item.package, rowId, ...result })
      }
    }
  }

  return {
    status: 'ok',
    profileDir,
    rowsFile: rows.file,
    counts: {
      bundles: results.length,
      dangerous: dangerous.length,
      alreadyDisabled: results.reduce((sum, item) => sum + item.alreadyDisabled.length, 0),
    },
    packages: results.filter(item => item.level !== 'safe'),
    actions,
    note: dangerous.length === 0
      ? '没有发现会中断宿主的已装插件'
      : options.apply === true
        ? '已写入 disabled 行：重启后这些行不再加载（当前这次启动无法挽回）'
        : '这些插件会让宿主中断或卡死；带 apply:true 再跑一次即可在下次启动前停用它们',
  }
}
