/**
 * DSHM install-queue transport.
 *
 * On DSHM the host cannot spawn a package manager. Both the bundled pnpm shim
 * and the market bridge hand work to `$DSH_HOME/install-queue/<id>.req`; the
 * host-side installer writes `<id>.done` or `<id>.fail` as JSON. This module
 * implements the same contract for compatibility-built tarballs.
 *
 * @module dshm-compat/install
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './state.js'

const POLL_MS = 500
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

/** @param {NodeJS.ProcessEnv} env */
export function isDshm(env = process.env) {
  return env.DSHM_PLATFORM === 'ohos' || typeof env.DSHM_HOME === 'string'
}

/** @param {NodeJS.ProcessEnv} env */
export function queueDir(env = process.env) {
  return env.DSHM_COMPAT_QUEUE_DIR || join(dshHome(env), 'install-queue')
}

/** @param {string} file */
function readOutcome(file) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { ok: false, error: 'installer returned invalid JSON' }
  } catch (error) {
    return { ok: false, error: `installer result is not valid JSON: ${String(error?.message ?? error)}` }
  }
}

/**
 * Submit one spec and wait for the host installer's outcome.
 *
 * @param {string} spec - npm/GitHub/file spec the host installer understands.
 * @param {{ profileDir?: string, timeoutMs?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options]
 */
export async function enqueueInstall(spec, options = {}) {
  const env = options.env ?? process.env
  if (!isDshm(env) && env.DSHM_COMPAT_QUEUE_DIR === undefined) {
    throw Object.assign(new Error('install queue is only available on DSHM'), { code: 'NOT_DSHM' })
  }
  if (typeof spec !== 'string' || spec.trim() === '') throw Object.assign(new Error('empty install spec'), { code: 'INVALID_SPEC' })
  const normalized = spec.trim()
  if (normalized.startsWith('-') || /[\r\n]/.test(normalized)) {
    throw Object.assign(new Error('install spec must be one package target, not a pnpm option or multiple lines'), { code: 'INVALID_SPEC' })
  }
  const dir = queueDir(env)
  mkdirSync(dir, { recursive: true })
  const base = `compat-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  if (typeof options.profileDir === 'string' && options.profileDir !== '') {
    writeFileSync(join(dir, `${base}.dir`), options.profileDir, 'utf8')
  }
  writeFileSync(join(dir, `${base}.req`), `${normalized}\n`, 'utf8')

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()
  return await new Promise((resolve, reject) => {
    const tick = () => {
      if (options.signal?.aborted) {
        cleanup()
        reject(Object.assign(new Error('install was cancelled'), { code: 'CANCELLED' }))
        return
      }
      const done = join(dir, `${base}.done`)
      const failed = join(dir, `${base}.fail`)
      if (existsSync(done) || existsSync(failed)) {
        const file = existsSync(done) ? done : failed
        const outcome = readOutcome(file)
        cleanup()
        if (file === done && outcome.ok !== false) resolve({ base, ok: true, ...outcome })
        else resolve({ base, ok: false, ...outcome })
        return
      }
      if (Date.now() - started > timeoutMs) {
        cleanup()
        resolve({ base, ok: false, error: `install timed out after ${timeoutMs} ms` })
        return
      }
      setTimeout(tick, POLL_MS)
    }
    const cleanup = () => {
      for (const suffix of ['.done', '.fail']) {
        try { rmSync(join(dir, `${base}${suffix}`), { force: true }) } catch { /* host may have removed it */ }
      }
    }
    tick()
  })
}
