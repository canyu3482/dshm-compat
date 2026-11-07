/**
 * Generic guest sidecar staging and JSON-stdio calls.
 *
 * An S2 plugin's native worker is a Linux/AArch64 executable. This module
 * stages such a worker from a converted tarball into
 * `$DSH_HOME/dshm-compat/sidecars/<id>/` and invokes it inside the Alpine guest
 * through the public subprocess service (which `dshm-vm-bash` routes).
 *
 * The worker protocol assumed here is one JSON request on stdin and one JSON
 * value on stdout per process. That is the protocol most native DSH plugins use
 * and the one the generic S2 adapter's `bash -c` wrapper preserves.
 *
 * @module dshm-compat/sidecar
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { elfSummary } from './elf.js'
import { runGuestFile } from './guest.js'
import { compatDir } from './state.js'
import { extractTar } from './tar.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** @param {NodeJS.ProcessEnv} env */
export function sidecarRoot(env = process.env) {
  return join(compatDir(env), 'sidecars')
}

/** @param {string} id */
export function validSidecarId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

/** @param {string} path */
function safeRelative(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\\')) return undefined
  const normalized = posix.normalize(path).replace(/^\.\//, '')
  if (normalized.startsWith('../') || normalized === '..') return undefined
  return normalized
}

/** @param {NodeJS.ProcessEnv} env @param {string} id */
export function sidecarDir(id, env = process.env) {
  if (!validSidecarId(id)) throw Object.assign(new Error('invalid sidecar id'), { code: 'INVALID_ID' })
  return join(sidecarRoot(env), id)
}

/** @param {NodeJS.ProcessEnv} env @param {string} id */
export function readSidecar(id, env = process.env) {
  try {
    const meta = JSON.parse(readFileSync(join(sidecarDir(id, env), 'meta.json'), 'utf8'))
    return meta !== null && typeof meta === 'object' ? meta : undefined
  } catch { return undefined }
}

/** @param {NodeJS.ProcessEnv} env */
export function listSidecars(env = process.env) {
  const root = sidecarRoot(env)
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meta = readSidecar(entry.name, env)
    if (meta !== undefined) result.push(meta)
  }
  return result.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/**
 * Stage a worker file from a tarball.
 *
 * @param {string} tarball
 * @param {string} workerPath - path inside the package, e.g. `runtime/linux-arm64/<worker>`.
 * @param {{ id?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function stageSidecar(tarball, workerPath, options = {}) {
  const env = options.env ?? process.env
  const relative = safeRelative(workerPath)
  if (relative === undefined) return { ok: false, error: 'workerPath must be a relative path inside the package' }
  if (typeof tarball !== 'string' || !existsSync(tarball)) return { ok: false, error: `tarball not found: ${String(tarball)}` }

  let entries
  try { entries = extractTar(readFileSync(tarball)).entries } catch (error) {
    return { ok: false, error: `cannot read tarball: ${String(error?.message ?? error)}` }
  }
  const entry = entries.find(item => item.type === 'file' && item.path === `package/${relative}`)
  if (entry?.data === undefined) return { ok: false, error: `worker not found in tarball: package/${relative}` }
  const elf = elfSummary(entry.data)
  if (elf === undefined) return { ok: false, error: 'worker is not an AArch64 ELF image' }

  const id = options.id ?? `worker-${elf.type.toLowerCase()}`
  if (!validSidecarId(id)) return { ok: false, error: `invalid sidecar id: ${String(id)}` }
  const target = sidecarDir(id, env)
  const staging = `${target}.staging-${process.pid}-${Date.now()}`
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'worker'), entry.data, { mode: 0o755 })
    const script = [
      '#!/bin/sh',
      'set -e',
      'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'exec "$DIR/worker" "$@"',
      '',
    ].join('\n')
    writeFileSync(join(staging, 'worker.sh'), script, { mode: 0o755 })
    const sha256 = createHash('sha256').update(entry.data).digest('hex')
    const meta = {
      id,
      worker: join(target, 'worker'),
      script: join(target, 'worker.sh'),
      workerPath: relative,
      sha256,
      bytes: entry.data.length,
      elf,
      source: tarball,
      stagedAt: new Date().toISOString(),
    }
    writeFileSync(join(staging, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    return { ok: true, ...meta }
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }) } catch { /* best effort */ }
    return { ok: false, error: `cannot stage sidecar: ${String(error?.message ?? error)}` }
  }
}

/**
 * Call a staged worker with one JSON request.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} id
 * @param {unknown} input
 * @param {{ timeoutMs?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options]
 */
export async function callSidecar(ctx, id, input, options = {}) {
  const env = options.env ?? process.env
  const meta = readSidecar(id, env)
  if (meta === undefined || typeof meta.worker !== 'string' || !existsSync(meta.worker)) {
    return { ok: false, error: `sidecar not staged: ${String(id)}` }
  }
  const file = typeof meta.script === 'string' ? meta.script : meta.worker
  const result = await runGuestFile(ctx, file, [], JSON.stringify(input ?? {}), {
    timeoutMs: options.timeoutMs ?? 120000,
    signal: options.signal,
  })
  if (result.status !== 'ok') {
    return { ok: false, status: result.status, error: result.reason ?? `worker exited ${result.exitCode}`, stdout: result.stdout, stderr: result.stderr }
  }
  try {
    return { ok: true, value: JSON.parse(String(result.stdout).trim()), stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  } catch {
    return { ok: false, error: 'worker returned invalid JSON', stdout: result.stdout, stderr: result.stderr }
  }
}

/**
 * Ask a staged worker for its version.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} id
 * @param {{ timeoutMs?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options]
 */
export async function probeSidecar(ctx, id, options = {}) {
  const env = options.env ?? process.env
  const meta = readSidecar(id, env)
  if (meta === undefined || typeof meta.worker !== 'string' || !existsSync(meta.worker)) {
    return { ok: false, error: `sidecar not staged: ${String(id)}` }
  }
  const file = typeof meta.script === 'string' ? meta.script : meta.worker
  const result = await runGuestFile(ctx, file, ['--version'], '', {
    timeoutMs: options.timeoutMs ?? 30000,
    signal: options.signal,
  })
  return {
    ok: result.status === 'ok',
    status: result.status,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.reason,
  }
}
