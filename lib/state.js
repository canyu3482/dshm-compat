/**
 * Durable, bounded state for the compatibility plugin.
 *
 * @module dshm-compat/state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_VERSION = 1
const MAX_REPORTS = 100
const MAX_INSTALLS = 100

/** @param {NodeJS.ProcessEnv} env */
export function dshHome(env = process.env) {
  return env.DSHM_HOME || env.DSH_HOME || join(homedir(), '.dsh')
}

/** @param {NodeJS.ProcessEnv} env */
export function compatDir(env = process.env) {
  return env.DSHM_COMPAT_DIR || join(dshHome(env), 'dshm-compat')
}

/** @param {string} dir */
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** @param {string} file @param {unknown} value */
export function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, text, 'utf8')
  try {
    renameSync(temporary, file)
  } catch {
    // Windows can refuse a replacing rename while another handle is open.
    writeFileSync(file, text, 'utf8')
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
}

/** @param {string} file */
export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return undefined }
}

/** @param {NodeJS.ProcessEnv} env */
export function stateFile(env = process.env) {
  return join(compatDir(env), 'state.json')
}

/** @param {NodeJS.ProcessEnv} env */
export function readState(env = process.env) {
  const value = readJson(stateFile(env))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { version: STATE_VERSION, reports: [], installs: [] }
  }
  return {
    version: STATE_VERSION,
    reports: Array.isArray(value.reports) ? value.reports : [],
    installs: Array.isArray(value.installs) ? value.installs : [],
    // Installs that still owe a boot check (see lib/verify.js). Declared here because
    // this reader is a whitelist: an unlisted field is written but never read back.
    pendingVerify: Array.isArray(value.pendingVerify) ? value.pendingVerify : [],
  }
}

/** @param {ReturnType<typeof readState>} state @param {NodeJS.ProcessEnv} env */
export function writeState(state, env = process.env) {
  ensureDir(compatDir(env))
  writeJsonAtomic(stateFile(env), state)
}

/**
 * Persist one analyzer report and its index entry.
 * @param {Record<string, any>} report
 * @param {NodeJS.ProcessEnv} env
 */
export function recordReport(report, env = process.env) {
  const dir = compatDir(env)
  ensureDir(join(dir, 'reports'))
  const file = join(dir, 'reports', `${report.fingerprint}.json`)
  writeJsonAtomic(file, report)
  const state = readState(env)
  const entry = {
    fingerprint: report.fingerprint,
    spec: report.spec,
    // A local tarball resolves to its own path, so `resolved.name` is a filename
    // there. The package's own manifest is the authority when it was parsed.
    name: report.package?.name ?? report.resolved?.name,
    version: report.package?.version ?? report.resolved?.version,
    strategy: report.strategy,
    confidence: report.confidence,
    createdAt: new Date().toISOString(),
    reportFile: file,
  }
  state.reports = [entry, ...state.reports.filter(item => item?.fingerprint !== report.fingerprint)].slice(0, MAX_REPORTS)
  writeState(state, env)
  return entry
}

/** @param {Record<string, any>} install @param {NodeJS.ProcessEnv} env */
export function recordInstall(install, env = process.env) {
  const state = readState(env)
  state.installs = [install, ...state.installs].slice(0, MAX_INSTALLS)
  writeState(state, env)
}

/** @param {NodeJS.ProcessEnv} env */
export function status(env = process.env) {
  const state = readState(env)
  // L2 verdict cache size (lib/verdicts.js) — diagnostic only; unreadable = 0.
  const verdicts = readJson(join(compatDir(env), 'verdicts.json'))
  const verdictsCount = verdicts !== null && typeof verdicts === 'object' && verdicts.entries !== null && typeof verdicts.entries === 'object'
    ? Object.keys(verdicts.entries).length
    : 0
  return {
    platform: env.DSHM_PLATFORM ?? null,
    dshm: env.DSHM_PLATFORM === 'ohos' || typeof env.DSHM_HOME === 'string',
    dshHome: dshHome(env),
    compatDir: compatDir(env),
    queueDir: join(dshHome(env), 'install-queue'),
    reports: state.reports,
    installs: state.installs,
    verdictsCount,
  }
}

/** @param {string} dir */
export function directoryExists(dir) {
  return existsSync(dir)
}
