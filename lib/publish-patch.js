/**
 * Publication-pattern compatibility patch for source workers.
 *
 * 9p (QEMU `local` backend) and hmdfs reject `link(2)`. A worker that publishes a
 * staged temporary into its final name by hard-linking therefore fails on every
 * "create a new file" path while plain overwrite (which uses `rename`) succeeds.
 *
 * The previous implementation rewrote `.hard_link(...)` to `.rename(...)` wholesale.
 * That is wrong in two ways:
 *
 *   1. It drops the no-clobber guarantee. `hard_link` fails with EEXIST when the
 *      target exists; a bare `rename` silently replaces it — and callers such as
 *      `ops_write_file{expectedRevision:"absent"}` depend on that failure.
 *   2. It drops errno filtering. Every non-link error (ENOSPC, ENOENT, EXDEV, …)
 *      is also turned into a rename attempt, which changes the reported failure.
 *
 * This module emits a *guarded* form instead: keep `hard_link` as the primary
 * path, and only fall back to `rename` when the error is specifically
 * "this filesystem cannot link", and only when the target is confirmed absent.
 *
 * The guarded form needs two things from the source file, which we cannot assume:
 * the error type must be `std::io::Error` (so `.kind()` exists) and the receiver
 * must expose a stat call (`symlink_metadata` / `try_exists`). Both are detected
 * per file; when the evidence is missing we degrade to a narrower form and say so
 * in the record via `semantics`. Nothing is ever silently "upgraded".
 *
 * This is pattern-based, never package-name based.
 *
 * @module dshm-compat/publish-patch
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bumped whenever the emitted shape changes; recorded per patch. */
export const PATCH_ID = 'publish-link@2'

/**
 * A receiver we are willing to rewrite must be a plain place expression —
 * `checked.parent`, `state.ctx.dir`. No calls or indexing: those could have side
 * effects, and evaluating them twice (once for the link, once for the fallback)
 * would change behaviour.
 */
const PLACE_RECEIVER = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/

/**
 * `.hard_link(&temporary, <dir>, <name>)` with a multi-line-tolerant receiver.
 * Group 1 = receiver chain, groups 2.. = the three arguments as written.
 */
const RUST_HARD_LINK = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+)\s*\.\s*hard_link\s*\(\s*(&[A-Za-z_]\w*)\s*,\s*([^,]+?)\s*,\s*([^()]+?)\s*\)/g

/** Calls that prove the receiver exposes a stat primitive. */
const STAT_EVIDENCE = /\.\s*(?:symlink_metadata|try_exists)\s*\(/
/**
 * Evidence that the error value is a `std::io::Error` (so `.kind()` exists).
 * `io::Result<T>` is written as `Result<T, io::Error>`, so it is evidence too —
 * and it is what a cap-std `Dir::hard_link` returns.
 */
const KIND_EVIDENCE = /(?:std|core)::io::(?:Error|ErrorKind|Result)\b|\bio::(?:Error|ErrorKind|Result)\b|\.\s*kind\s*\(\s*\)/

/** @param {string} text @param {number} index */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

/**
 * Build the replacement expression for one call site.
 * @param {{ receiver: string, staged: string, toDir: string, toName: string, kind: boolean, stat: boolean }} call
 */
function guardedExpression(call) {
  const { receiver, staged, toDir, toName } = call
  const tryLink = `${receiver}.hard_link(${staged}, ${toDir}, ${toName})`
  const doRename = `${receiver}.rename(${staged}, ${toDir}, ${toName})`

  if (call.kind && call.stat) {
    return {
      form: 'guarded',
      semantics: [],
      text: `{ match ${tryLink} {
        Ok(v) => Ok(v),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::Unsupported) => {
            /* DSHM: 9p/hmdfs 拒绝硬链接。目标已存在时必须仍然报 EEXIST，
               否则会静默覆盖 —— 这是 no-clobber 语义的全部意义。 */
            if ${receiver}.symlink_metadata(${toName}).is_ok() {
                Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists))
            } else {
                ${doRename}
            }
        }
        Err(e) => Err(e),
    } }`,
    }
  }
  if (call.kind) {
    return {
      form: 'guarded-no-stat',
      semantics: ['weakened-no-clobber'],
      text: `{ match ${tryLink} {
        Ok(v) => Ok(v),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::Unsupported) => ${doRename},
        Err(e) => Err(e),
    } }`,
    }
  }
  return {
    form: 'rename',
    semantics: ['weakened-no-clobber', 'weakened-errno-filter'],
    text: doRename,
  }
}

/**
 * Patch every `.rs` file in place.
 *
 * @param {string} dir
 * @param {{ path: string }[]} files
 * @param {{ strict?: boolean }} [options]
 * @returns {{ patches: any[], anchorsMissing: any[], filesScanned: number }}
 */
export function patchPublicationSources(dir, files, options = {}) {
  /** @type {any[]} */
  const patches = []
  /** @type {any[]} */
  const anchorsMissing = []
  let filesScanned = 0

  for (const file of files) {
    if (!file.path.endsWith('.rs')) continue
    const target = join(dir, ...file.path.split('/'))
    let text
    try { text = readFileSync(target, 'utf8') } catch { continue }
    filesScanned += 1

    const kind = KIND_EVIDENCE.test(text)
    const stat = STAT_EVIDENCE.test(text)
    let next = text.replace(RUST_HARD_LINK, (match, receiverRaw, staged, toDir, toName, offset) => {
      const receiver = receiverRaw.replace(/\s+/g, '')
      if (!PLACE_RECEIVER.test(receiver)) {
        anchorsMissing.push({
          file: file.path,
          line: lineOf(text, offset),
          reason: 'receiver is not a plain place expression (calls/indexing would be evaluated twice)',
          text: match.replace(/\s+/g, ' ').trim(),
        })
        return match
      }
      const built = guardedExpression({
        receiver,
        staged: staged.trim(),
        toDir: toDir.replace(/\s+/g, ' ').trim(),
        toName: toName.replace(/\s+/g, ' ').trim(),
        kind,
        stat,
      })
      patches.push({
        file: file.path,
        line: lineOf(text, offset),
        patternId: PATCH_ID,
        from: 'hard_link',
        to: 'rename',
        form: built.form,
        semantics: built.semantics,
        evidence: { errorKind: kind, stat },
      })
      return built.text
    })

    // A file that mentions hard_link but matched nothing means the upstream shape
    // moved. Reporting it is the whole point: a silent no-op here looks exactly
    // like "the patch was applied" once the build succeeds.
    if (next === text && /\bhard_link\s*\(/.test(text)) {
      for (const line of linesWith(text, /\bhard_link\s*\(/)) {
        anchorsMissing.push({
          file: file.path,
          line: line.number,
          reason: 'hard_link call did not match the publication shape (.receiver.hard_link(&staged, &dir, &name))',
          text: line.text.trim(),
        })
      }
    }
    if (next !== text) writeFileSync(target, next, 'utf8')
  }

  const weakened = patches.filter(patch => patch.semantics.length > 0).length
  const result = {
    patches,
    anchorsMissing,
    filesScanned,
    summary: { applied: patches.length, weakened, anchorsMissing: anchorsMissing.length },
  }
  if (options.strict === true && (anchorsMissing.length > 0 || weakened > 0)) {
    return { ...result, ok: false, reason: anchorsMissing.length > 0 ? 'anchor-missing' : 'weakened-semantics' }
  }
  return { ...result, ok: true }
}

/** @param {string} text @param {RegExp} pattern */
function linesWith(text, pattern) {
  const out = []
  text.split('\n').forEach((line, index) => {
    if (pattern.test(line)) out.push({ number: index + 1, text: line })
  })
  return out
}
