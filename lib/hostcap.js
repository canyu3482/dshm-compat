/**
 * Host capability facts for the compat decision.
 *
 * Two things used to be assumed globally and are actually per-device:
 *
 *   · whether `link(2)` works at all. On HarmonyOS the phone profile forbids it
 *     (probe errno `13900012`), while the PC/2in1 profile allows it (measured
 *     2026-10-05: `ln -s` succeeds, hard links share an inode). Assuming
 *     "forbidden" everywhere silently adds a source patch on devices that do not
 *     need one — and, worse, makes a PC-profile verification run look green while
 *     the phone profile is still broken.
 *   · whether a real shell / exec is available, which decides if a guest route
 *     can even start. DSHM already measures this and publishes it.
 *
 * Preference order for facts: the host's own machine-readable readout
 * (`<DSHM_HOME>/host-ready.json`, `runtime.*`), then the one-line log copy that
 * DSHM writes for profiles where `home` is not readable from `hdc`. We never
 * invent a value: an unknown stays unknown.
 *
 * @module dshm-compat/hostcap
 */
import { closeSync, existsSync, linkSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstExisting, hostFileCandidates } from './hostfiles.js'
import { dshHome } from './state.js'

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * Read `<DSHM_HOME>/host-ready.json`.
 * @param {NodeJS.ProcessEnv} env
 */
export function readHostReady(env = process.env) {
  const file = join(dshHome(env), 'host-ready.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed = record(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
    const runtime = record(parsed?.runtime)
    if (runtime === undefined) return undefined
    return {
      source: 'host-ready.json',
      file,
      pid: typeof parsed?.pid === 'number' ? parsed.pid : undefined,
      runtime: {
        nodeVersion: runtime.nodeVersion,
        platform: runtime.platform,
        jitless: runtime.jitless,
        zstd: runtime.zstd,
        natives: runtime.natives,
        exec: record(runtime.exec)?.summary ?? runtime.exec,
        terminal: record(runtime.terminal),
        python: record(runtime.python),
      },
    }
  } catch {
    return undefined
  }
}

/**
 * Fallback readout: DSHM compresses the same probe results into one log line
 * (`探针读数（日志副本）：runtime={…} …`) because the 0700 `home` directory is
 * unreadable from outside the app on phone profiles.
 *
 * The log lives next to `home`, not inside it (see `hostfiles.js`), so it is
 * located by candidate rather than by concatenation — otherwise this fallback
 * reports "no runtime readout" on exactly the profiles it was written for.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function readHostLogFacts(env = process.env) {
  const file = firstExisting(hostFileCandidates('dshm-host.log', env))
  if (file === undefined) return undefined
  let text
  try { text = readFileSync(file, 'utf8') } catch { return undefined }
  const lines = text.split('\n').filter(line => line.includes('探针读数'))
  const last = lines[lines.length - 1]
  if (last === undefined) return undefined
  /** @type {Record<string, string>} */
  const fields = {}
  for (const match of last.matchAll(/([A-Za-z][\w.]*)=([^\s，|]+)/g)) fields[match[1]] = match[2]
  const keysMatch = last.match(/runtime=\{([^}]*)\}/)
  return {
    source: 'dshm-host.log',
    file,
    probes: keysMatch === null ? [] : keysMatch[1].split(',').map(key => key.trim()).filter(Boolean),
    fields,
  }
}

/**
 * Every host fact we could establish, with the provenance of each.
 * @param {NodeJS.ProcessEnv} env
 */
export function readHostFacts(env = process.env) {
  const ready = readHostReady(env)
  const log = readHostLogFacts(env)
  return {
    available: ready !== undefined || log !== undefined,
    ready,
    log,
    source: ready?.source ?? log?.source ?? 'none',
  }
}

/**
 * Ask the filesystem directly. dshm-compat runs inside the DSHM host process, so
 * this answers the question for *this* device and *this* mount, without guessing
 * from a device class name.
 *
 * The probe is two temp files in the same directory, linked and then removed.
 *
 * @param {string} [dir]
 * @returns {{ ok: boolean, code?: string, dir?: string, reason?: string }}
 */
export function probeLinkSupport(dir) {
  const target = dir ?? tmpdir()
  const stamp = `${process.pid}-${Date.now().toString(36)}`
  const source = join(target, `.dshm-compat-link-probe-${stamp}`)
  const link = join(target, `.dshm-compat-link-probe-${stamp}.lnk`)
  try {
    const fd = openSync(source, 'w')
    try { writeSync(fd, 'probe') } finally { closeSync(fd) }
    try {
      linkSync(source, link)
      return { ok: true, dir: target }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN'
      return { ok: false, code, dir: target }
    }
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      dir: target,
      reason: `probe could not create a file in ${target}: ${error?.message ?? error}`,
    }
  } finally {
    rmSync(link, { force: true })
    rmSync(source, { force: true })
  }
}

/**
 * Which publication patch a route needs.
 *
 * `in-process` runs on the host mount, so the probe is authoritative.
 * `guest` goes through 9p, where a host mount that *does* support links can still
 * be exported without link support — a positive probe there proves nothing, so we
 * stay conservative and patch.
 *
 * @param {'in-process'|'guest'} route
 * @param {{ ok: boolean }} probe
 */
export function linkPolicyFor(route, probe) {
  if (route === 'guest') return 'apply'
  if (probe.ok) return 'skip'
  return 'apply'
}

/**
 * One-line summary for the doctor / plan output.
 * @param {{ ok: boolean, code?: string, dir?: string }} probe
 */
export function describeLinkProbe(probe) {
  if (probe.ok) return `link(2) works in ${probe.dir}`
  return `link(2) refused in ${probe.dir} (${probe.code ?? 'unknown'})`
}
