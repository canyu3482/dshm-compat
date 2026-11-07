/**
 * Guest (Alpine VM) probe.
 *
 * On DSHM the host has no spawnable shell. The `dshm-vm-bash` core plugin
 * redirects `bash -c` into a QEMU-backed Alpine guest. This module does not
 * assume that plumbing exists: it runs a read-only probe through the public
 * `subprocess` service and reports what came back.
 *
 * @module dshm-compat/guest
 */
import { isAbsolute } from 'node:path'

const PROBE_SCRIPT = [
  'echo DSHM_COMPAT_PROBE_BEGIN',
  'uname -srm 2>/dev/null || true',
  'cat /etc/alpine-release 2>/dev/null || true',
  'command -v bash || true',
  'command -v apk || true',
  'command -v node || true',
  'command -v npm || true',
  'command -v python3 || true',
  'echo DSHM_COMPAT_PROBE_END',
].join('\n')
/** Packages the provisioning tool may install. */
export const PROVISION_PACKAGES = Object.freeze([
  'bash',
  'apk-tools',
  'nodejs',
  'npm',
  'python3',
  'build-base',
  'linux-headers',
  'rust',
  'cargo',
  'git',
  'ffmpeg',
])

const PACKAGE_NAME = /^[a-z0-9][a-z0-9+_.-]*$/

/** @param {unknown} value */
function textOf(value) {
  return value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : ''
}

/**
 * Run one shell script through the host subprocess service.
 *
 * On DSHM `dshm-vm-bash` redirects `bash -c` into the Alpine guest. The caller
 * must still inspect `status`: a host with a real bash succeeds too, which is
 * useful for development but is not evidence of a guest.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} script
 * @param {{ timeoutMs?: number, signal?: AbortSignal, cwd?: string }} [options]
 */
export async function runGuest(ctx, script, options = {}) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    return { status: 'unavailable', reason: 'the subprocess service is not mounted' }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('guest command timed out')), options.timeoutMs ?? 30000)
  timeout.unref?.()
  const signals = [controller.signal]
  if (options.signal) signals.push(options.signal)
  try {
    const handle = subprocess.spawn({
      argv: ['bash', '-c', script],
      cwd: options.cwd ?? '/',
      stdio: { stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 5000,
      signal: AbortSignal.any(signals),
    })
    const outcome = await handle.done
    return {
      status: outcome.exitCode === 0 ? 'ok' : 'error',
      exitCode: outcome.exitCode,
      signal: outcome.signal ?? null,
      stdout: textOf(handle.collected.stdout.readFrom(0)),
      stderr: textOf(handle.collected.stderr.readFrom(0)),
    }
  } catch (error) {
    return { status: 'error', reason: String(error?.message ?? error) }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Run a standalone worker file inside the guest with JSON on stdin.
 *
 * This is the S2 primitive for native-worker plugins: the worker path is an
 * absolute path visible through the 9p share, argv is passed through `$0`/`$@`
 * so no shell quoting is needed, and stdin is supplied as one bounded blob.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} file
 * @param {string[]} [args]
 * @param {string} [input]
 * @param {{ timeoutMs?: number, signal?: AbortSignal, cwd?: string }} [options]
 */
export async function runGuestFile(ctx, file, args = [], input = '', options = {}) {
  if (typeof file !== 'string' || !isAbsolute(file)) {
    return { status: 'invalid', reason: 'worker path must be absolute and visible inside the guest' }
  }
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    return { status: 'unavailable', reason: 'the subprocess service is not mounted' }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('guest worker timed out')), options.timeoutMs ?? 120000)
  timeout.unref?.()
  const signals = [controller.signal]
  if (options.signal) signals.push(options.signal)
  try {
    const handle = subprocess.spawn({
      argv: ['bash', file, ...args.map(String)],
      cwd: options.cwd ?? '/',
      stdio: {
        ...(input !== '' ? { stdin: { data: input } } : {}),
        stdout: { maxBytes: 8 * 1024 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 5000,
      signal: AbortSignal.any(signals),
    })
    const outcome = await handle.done
    return {
      status: outcome.exitCode === 0 ? 'ok' : 'error',
      exitCode: outcome.exitCode,
      signal: outcome.signal ?? null,
      stdout: textOf(handle.collected.stdout.readFrom(0)),
      stderr: textOf(handle.collected.stderr.readFrom(0)),
    }
  } catch (error) {
    return { status: 'error', reason: String(error?.message ?? error) }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function probeGuest(ctx, options = {}) {
  const result = await runGuest(ctx, PROBE_SCRIPT, options)
  if (result.status === 'unavailable') return result
  if (result.status === 'error' && result.stdout === undefined) return result

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const begin = stdout.indexOf('DSHM_COMPAT_PROBE_BEGIN')
  const end = stdout.indexOf('DSHM_COMPAT_PROBE_END')
  const body = begin >= 0 && end > begin
    ? stdout.slice(begin + 'DSHM_COMPAT_PROBE_BEGIN'.length, end).trim()
    : stdout.trim()
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const has = value => lines.some(line => line === value || line.endsWith(`/${value}`))
  const uname = lines.find(line => /^Linux\b/.test(line)) ?? lines[0]
  const alpine = lines.find(line => /^\d+\.\d+/.test(line))
  return {
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    run: {
      uname,
      alpine,
      bash: has('bash') || lines.some(line => line.endsWith('/bash')),
      apk: has('apk') || lines.some(line => line.endsWith('/apk')),
      node: has('node') || lines.some(line => line.endsWith('/node')),
      npm: has('npm') || lines.some(line => line.endsWith('/npm')),
      python3: has('python3') || lines.some(line => line.endsWith('/python3')),
    },
    stdout: body.slice(0, 8000),
    stderr: stderr.slice(0, 4000),
  }
}

/**
 * Install a reviewed allowlist of Alpine packages in the guest.
 *
 * This uses the guest's own `apk`; if the guest has no network, the caller sees
 * the exact failure instead of a fake success. The allowlist keeps the tool
 * from becoming an arbitrary command runner.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string[] | undefined} packages
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function provisionGuest(ctx, packages, options = {}) {
  const requested = Array.isArray(packages) && packages.length > 0
    ? [...new Set(packages)]
    : ['bash', 'nodejs', 'npm', 'python3', 'build-base', 'linux-headers']
  const invalid = requested.filter(name => typeof name !== 'string' || !PACKAGE_NAME.test(name) || !PROVISION_PACKAGES.includes(name))
  if (invalid.length > 0) {
    return { status: 'invalid', reason: `packages outside the allowlist: ${invalid.join(', ')}`, allowed: PROVISION_PACKAGES }
  }
  const script = [
    'set -e',
    'if command -v apk >/dev/null 2>&1; then',
    `  apk add --no-cache ${requested.join(' ')}`,
    'elif [ -x /sbin/apk ]; then',
    `  /sbin/apk add --no-cache ${requested.join(' ')}`,
    'else',
    '  echo DSHM_COMPAT_NO_APK',
    '  exit 127',
    'fi',
  ].join('\n')
  const result = await runGuest(ctx, script, { timeoutMs: options.timeoutMs ?? 10 * 60 * 1000, signal: options.signal })
  return { packages: requested, ...result }
}
