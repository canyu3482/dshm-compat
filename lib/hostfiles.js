/**
 * Locating the host's own files without inventing a path.
 *
 * `dshm-host.log` is not inside `$DSH_HOME`. On the phone profile `$DSH_HOME` is
 * `<…>/files/dsh/home` while the log sits at `<…>/files/dshm-host.log` — the two
 * are siblings, two directories apart. Every reader that assumed
 * `join(home, 'dshm-host.log')` therefore found nothing on a real device:
 *
 *   · `pendingFromLogs()` answered `no host log found`, so `evaluatePending()`
 *     returned `unknown` for every install and `compat_verify` could never settle
 *     anything — the log it needed was 30 lines away in the same tree;
 *   · `readHostLogFacts()` (the probe readout DSHM deliberately duplicates into the
 *     log for profiles whose `home` is 0700) reported nothing as well.
 *
 * The rule here is *derive, do not hardcode*: walk the ancestors of `$DSH_HOME` a
 * bounded number of levels and take whatever exists. No HarmonyOS module name
 * (`phone`, `tablet`, `2in1`, …) appears in this module, because the module name is
 * a packaging detail and a new one must not need a code change.
 *
 * Order matters: an explicit override first (tests, diagnostics), then `$DSH_HOME`
 * itself (unchanged behaviour, and the layout the tests pin), then the ancestors
 * from nearest to farthest.
 *
 * @module dshm-compat/hostfiles
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * How far up from `$DSH_HOME` we are willing to look. Two levels covers the phone
 * layout (`files/dsh/home` → `files`); four leaves room for a profile nested one
 * level deeper without turning this into a filesystem crawl.
 */
const MAX_ANCESTORS = 4

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * Every place a host file of this name could plausibly be, in preference order.
 * None of them is asserted to exist — callers decide that.
 *
 * @param {string} name  file name only, e.g. `dshm-host.log`
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function hostFileCandidates(name, env = process.env) {
  /** @type {string[]} */
  const out = []
  /** @param {string} candidate */
  const push = candidate => {
    if (candidate !== '' && !out.includes(candidate)) out.push(candidate)
  }

  const override = env.DSHM_COMPAT_HOST_DIR
  if (typeof override === 'string' && override !== '') push(join(override, name))

  const home = env.DSHM_HOME || env.DSH_HOME
  if (typeof home !== 'string' || home === '') return out

  push(join(home, name))
  let dir = home
  for (let level = 0; level < MAX_ANCESTORS; level += 1) {
    const parent = dirname(dir)
    // `dirname('/a') === '/'` and `dirname('/') === '/'`: stop at the root, and stop
    // before walking out of a shallow absolute path on any platform.
    if (parent === dir || parent === '' || parent.length < 2) break
    dir = parent
    push(join(dir, name))
  }
  return out
}

/**
 * A log path the host itself declared, if it did.
 *
 * The upstream report asks DSHM to publish the log location in `host-ready.json`
 * (`"log": "…/dshm-host.log"`) precisely because it is not derivable from
 * `$DSH_HOME` alone. Honouring the field now costs nothing and means the day the
 * host adds it we read the exact path instead of a guess.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function declaredLogPaths(env = process.env) {
  const home = env.DSHM_HOME || env.DSH_HOME
  if (typeof home !== 'string' || home === '') return []
  const file = join(home, 'host-ready.json')
  if (!existsSync(file)) return []
  try {
    const parsed = record(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
    const declared = typeof parsed?.log === 'string' ? parsed.log : undefined
    return declared === undefined || declared === '' ? [] : [declared]
  } catch {
    return []
  }
}

/**
 * Candidate host logs, best-known first: what the host declared, then the names
 * DSHM is known to write, each searched from `$DSH_HOME` outward.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function hostLogCandidates(env = process.env) {
  return [
    ...declaredLogPaths(env),
    ...hostFileCandidates('dshm-host.log', env),
    ...hostFileCandidates('node-output.log', env),
  ]
}

/**
 * The host logs that exist right now.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function existingHostLogs(env = process.env) {
  return hostLogCandidates(env).filter(file => existsSync(file))
}

/**
 * First existing candidate — for readers that want one source and its provenance.
 * @param {string[]} candidates
 * @returns {string | undefined}
 */
export function firstExisting(candidates) {
  return candidates.find(file => existsSync(file))
}
