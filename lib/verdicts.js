/**
 * L2 verdict cache: `name@version → {strategy, hostRisk, hasDsh, services, outcome}`.
 *
 * The adapt pipeline answers three different questions with one expensive run:
 * what the package IS (strategy, host-risk, dsh manifest — all intrinsic to the
 * tarball, and an npm dist tarball is content-addressed, so a verdict for a fixed
 * version never goes stale on the package side), and what the DEVICE says (the
 * service gate — that part depends on the installed core, so it is recorded with
 * the core version it was computed against and a core update re-opens it).
 *
 * The cache exists so that "点一下测" from the full index — and every repeat adapt
 * attempt of the same version — stops re-downloading a tarball to re-derive a
 * verdict that is already on disk. It is best-effort by contract: every writer
 * swallows its own failure, and a missing cache only costs a download.
 *
 * Kept separate from `state.json` on purpose: the ledger is a bounded diagnostic
 * history for a human; this is a lookup table for the pipeline. Different shape,
 * different bound, different reader.
 *
 * @module dshm-compat/verdicts
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { compatDir } from './state.js'
import { readJson, writeJsonAtomic } from './state.js'

const VERDICTS_VERSION = 1
const MAX_VERDICTS = 500

/** @param {NodeJS.ProcessEnv} env */
export function verdictsFile(env = process.env) {
  return join(compatDir(env), 'verdicts.json')
}

/** @param {NodeJS.ProcessEnv} env */
function readVerdictsFile(env) {
  const value = readJson(verdictsFile(env))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { version: VERDICTS_VERSION, entries: {} }
  }
  return {
    version: VERDICTS_VERSION,
    entries: value.entries !== null && typeof value.entries === 'object' && !Array.isArray(value.entries)
      ? value.entries
      : {},
  }
}

/**
 * The whole verdict index in one read — for callers that look up many names in
 * a row (the shelf reads it once for all entries instead of once per entry).
 * Treat the returned map as read-only.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, any>}
 */
export function readVerdictIndex(env = process.env) {
  return readVerdictsFile(env).entries
}

/**
 * @param {string} name
 * @param {string} version
 */
export function verdictKey(name, version) {
  return `${String(name ?? '')}@${String(version ?? '')}`
}

/**
 * @param {string} name
 * @param {string} version
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readVerdict(name, version, env = process.env) {
  if (typeof name !== 'string' || name === '') return undefined
  const { entries } = readVerdictsFile(env)
  const entry = entries[verdictKey(name, version)]
  return entry !== null && typeof entry === 'object' ? entry : undefined
}

/**
 * The newest verdict for a name, any version — for surfaces (the shelf) that know
 * the plugin but not which version the question is about. A newer version's
 * verdict supersedes an older one by `analyzedAt`; ties fall back to the key order.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, any>} [index] pre-read verdict index (pass
 *   `readVerdictIndex()` once when looking up many names)
 */
export function readLatestVerdictByName(name, env = process.env, index) {
  if (typeof name !== 'string' || name === '') return undefined
  const entries = index ?? readVerdictsFile(env).entries
  let best
  for (const [key, entry] of Object.entries(entries)) {
    if (entry === null || typeof entry !== 'object' || entry.name !== name) continue
    if (best === undefined
      || String(entry.analyzedAt ?? '').localeCompare(String(best.analyzedAt ?? '')) > 0
      || (entry.analyzedAt === best.analyzedAt && key > String(best.__key ?? ''))) {
      best = { ...entry, __key: key }
    }
  }
  if (best === undefined) return undefined
  const { __key, ...verdict } = best
  return verdict
}

/**
 * Upsert one verdict. The package-intrinsic fields come from the analyzer report;
 * `patch` carries the outcome and any device-side additions. Oldest entries are
 * evicted past `MAX_VERDICTS` so twenty thousand index checks cannot grow the
 * file without bound.
 *
 * @param {Record<string, any>} report analyzer report (may be partial for tests)
 * @param {{ name: string, version: string }} identity authoritative package identity
 * @param {Record<string, any>} [patch]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function writeVerdict(report, identity, patch = {}, env = process.env) {
  const name = typeof report?.package?.name === 'string' && report.package.name !== ''
    ? report.package.name
    : String(identity?.name ?? '')
  const version = typeof report?.package?.version === 'string' && report.package.version !== ''
    ? report.package.version
    : String(identity?.version ?? '')
  if (name === '') return undefined
  const hostRisk = report?.signals?.hostRisk
  const verdict = {
    name,
    version,
    kind: typeof report?.resolved?.kind === 'string' ? report.resolved.kind : undefined,
    strategy: report?.strategy,
    confidence: report?.confidence,
    hostRisk: hostRisk === undefined || hostRisk === null
      ? undefined
      : { level: hostRisk.level, kinds: Array.isArray(hostRisk.kinds) ? [...hostRisk.kinds] : [] },
    hasDsh: report?.signals?.hasDsh === true,
    fingerprint: report?.fingerprint,
    analyzedAt: new Date().toISOString(),
    ...patch,
  }
  const file = verdictsFile(env)
  const { entries } = readVerdictsFile(env)
  entries[verdictKey(name, version)] = verdict
  let ordered = Object.entries(entries)
  if (ordered.length > MAX_VERDICTS) {
    ordered.sort((a, b) => String(a[1]?.analyzedAt ?? '').localeCompare(String(b[1]?.analyzedAt ?? '')))
    ordered = ordered.slice(ordered.length - MAX_VERDICTS)
  }
  mkdirSync(compatDir(env), { recursive: true })
  writeJsonAtomic(file, { version: VERDICTS_VERSION, entries: Object.fromEntries(ordered) })
  return verdict
}

/** @param {NodeJS.ProcessEnv} [env] */
export function verdictsCount(env = process.env) {
  return Object.keys(readVerdictsFile(env).entries).length
}
