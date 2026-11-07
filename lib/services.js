/**
 * Service-dependency analysis: the check that would have caught `dsh-rewind`.
 *
 * A DSH plugin row declares which cordis services it needs:
 *
 *     export const inject = ["commands"]                       // host half
 *     const inject = ["commandUi", "sessions", "conversation"] // client half
 *
 * If one of those names is not provided by the deployment, cordis leaves the row
 * `pending` and never activates it. On DSHM that is not a soft failure — the web
 * boot reports `1 entry did not activate … pending (waiting for service: X)` and
 * the plugin is simply dead, with the whole boot looking broken to the user.
 *
 * `dsh-rewind@0.11.12` is the worked example: its client half needs
 * `conversationEvents`, which does not exist anywhere in core
 * `0.2.1-alpha.4+dshm.56` (a full-tree scan finds zero occurrences), so installing
 * it takes the deployment down. `0.11.8` and earlier do not ask for it.
 *
 * This module answers three questions without guessing:
 *
 *   1. what does this package *ask for*            → declaredServices()
 *   2. what does this deployment actually provide  → hostServiceNames() / clientServiceNames()
 *   3. what is currently stuck, and on what        → pendingFromLogs()
 *
 * The client inventory is obtained by reading the core tree's own client bundles
 * for `super(ctx, "<name>")` — the constructor call every service provider makes.
 * It is a heuristic, so its result is always reported as `source`, never presented
 * as ground truth, and it is cached per core version because the scan is not cheap.
 *
 * @module dshm-compat/services
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadArchive, resolveSpec } from './fetch.js'
import { existingHostLogs, hostLogCandidates } from './hostfiles.js'
import { compatDir } from './state.js'
import { extractTar, findRootPrefix } from './tar.js'

/**
 * Ways a client bundle can put a service on the registry. Only the first is the
 * usual `Service` subclass; `@deepseek-ai/dsh-api-session-controller` provides
 * `sessions` with a bare `provide("sessions", …)`, which is why a scan that only
 * looked for `super(ctx, …)` reported a false "missing" and would have blocked a
 * perfectly good install.
 *
 * Deliberately over-inclusive: a name wrongly counted as available costs a missed
 * warning, while a name wrongly counted as missing blocks a working plugin.
 */
const PROVIDER_PATTERNS = [
  /super\(\s*(?:ctx|this\.ctx)\s*,\s*["']([\w.$@-]+)["']/g,
  /\bprovide\(\s*["']([\w.$@-]+)["']/g,
  /\baccessor\(\s*["']([\w.$@-]+)["']/g,
]

/** Files larger than this are skipped during the client scan (minified bundles get big). */
const MAX_CLIENT_BYTES = 6 * 1024 * 1024

/** The cheap pass: the conventional name of a client half. */
const CLIENT_BUNDLE_NAME = /^client\.[cm]?js$/

/** Anything that could be a script, for the fallback pass. */
const SCRIPT_FILE = /\.[cm]?js$/

/**
 * Every client half is wrapped by DSH's loader (the same wrapper `dsh.client.inject`
 * addresses). Its presence is what makes a file a client bundle, independent of
 * how the build named it.
 */
const MODULE_LOADER_MARK = '__ModuleLoader__.load'

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * Services the host actually provides. `ctx.reflect.props` is the live cordis
 * registry, so this is exact rather than inferred.
 *
 * @param {any} ctx
 * @returns {string[]}
 */
export function hostServiceNames(ctx) {
  try {
    const props = record(ctx?.reflect?.props)
    if (props === undefined) return []
    return Object.entries(props)
      .filter(([, definition]) => record(definition)?.type === 'service')
      .map(([key]) => key)
      .sort()
  } catch {
    return []
  }
}

/**
 * Parse a module's `inject` declaration out of its source text.
 *
 * Handles the three shapes that occur in practice:
 *   const inject = ["a", "b"]
 *   const inject = { required: [...], optional: [...] }
 *   ctx.inject(["a"], …)          ← dynamic requirement, treated as required
 *
 * @param {string} text
 * @returns {{ required: string[], optional: string[] }}
 */
export function declaredServices(text) {
  const required = new Set()
  const optional = new Set()

  const arrayForm = /(?:export\s+)?(?:const|let|var)\s+inject\s*=\s*\[([^\]]*)\]/g
  for (const match of text.matchAll(arrayForm)) {
    for (const name of match[1].matchAll(/["']([\w.$@/-]+)["']/g)) required.add(name[1])
  }

  const objectForm = /(?:export\s+)?(?:const|let|var)\s+inject\s*=\s*\{([\s\S]{0,600}?)\}/g
  for (const match of text.matchAll(objectForm)) {
    for (const section of match[1].matchAll(/(required|optional)\s*:\s*\[([^\]]*)\]/g)) {
      const bucket = section[1] === 'optional' ? optional : required
      for (const name of section[2].matchAll(/["']([\w.$@/-]+)["']/g)) bucket.add(name[1])
    }
  }

  const dynamicForm = /ctx\.inject\s*\(\s*\[([^\]]*)\]/g
  for (const match of text.matchAll(dynamicForm)) {
    for (const name of match[1].matchAll(/["']([\w.$@/-]+)["']/g)) required.add(name[1])
  }

  for (const name of optional) required.delete(name)
  return { required: [...required].sort(), optional: [...optional].sort() }
}

/**
 * What one package asks for, split by half.
 *
 * @param {{ name?: string, version?: string, tarball?: string, kind?: string }} resolved
 * @param {{ signal?: AbortSignal, maxBytes?: number }} [options]
 */
export async function packageServiceDeps(resolved, options = {}) {
  const full = resolved?.kind === undefined
    ? await resolveSpec(String(resolved?.tarball ?? resolved?.name ?? ''), { signal: options.signal })
    : resolved
  const archive = await loadArchive(full, { maxBytes: options.maxBytes, signal: options.signal, cacheDir: options.cacheDir })
  const { entries } = extractTar(archive)
  const prefix = findRootPrefix(entries)
  const files = entries
    .filter(entry => entry.type === 'file' && entry.data !== undefined)
    .map(entry => ({ path: prefix !== '' && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path, data: entry.data }))

  const pick = path => files.find(file => file.path === path)?.data?.toString('utf8')
  const hostText = pick('lib/index.js') ?? pick('index.js') ?? pick('dist/index.js') ?? ''
  const clientText = pick('lib/client.js') ?? pick('dist/client.js') ?? pick('client.js') ?? ''

  return {
    host: hostText === '' ? undefined : declaredServices(hostText),
    client: clientText === '' ? undefined : declaredServices(clientText),
    filesScanned: [hostText === '' ? undefined : 'host', clientText === '' ? undefined : 'client'].filter(Boolean),
  }
}

/**
 * Services the browser half can consume, by reading client bundles for
 * `super(ctx, "<name>")` / `provide("<name>")` / `accessor("<name>")`.
 *
 * Heuristic and therefore labelled: `source` says how it was obtained.
 *
 * Two ways this used to answer "not provided" when the service was in fact right
 * there — both cost a plugin its install (`lib/market.js` blocks on any gap it
 * cannot shim), so both are fixed here:
 *
 *   1. **It only looked in the core tree.** `@deepseek-ai/dsh-client-connection`
 *      is resolved for a plugin that names it in `dsh.client.inject`, so it can
 *      live in the *profile's* `node_modules`. dsh-pet@0.3.8 was blocked on
 *      `client:connection` while `dsh-client-connection/lib/client.js` contains
 *      `ctx.provide("connection", handle)`. Roots are now core **and** profile.
 *   2. **It only opened files named exactly `client.js`.** One build rename
 *      (`dist/client.mjs`, `client/index.js`) zeroed the whole inventory. The
 *      cheap name pass now falls back, per root that yielded nothing, to reading
 *      scripts and accepting anything carrying the client-bundle marker
 *      `__ModuleLoader__.load`.
 *
 * And when nothing was read at all it now says so (`ok:false`) instead of
 * returning an empty inventory as if it were a verified one: an empty list is
 * "we could not look", never "this deployment provides nothing" — the same
 * distinction the host half already makes with `hostAvailable.size > 0`.
 *
 * @param {{ nodeModules: string, version?: string } | undefined} core
 * @param {{ env?: NodeJS.ProcessEnv, profileDir?: string, refresh?: boolean, skip?: boolean }} [options]
 */
export function clientServiceNames(core, options = {}) {
  const env = options.env ?? process.env
  if (options.skip === true || env.DSHM_COMPAT_SKIP_CLIENT_SCAN === '1') {
    return { ok: false, source: 'skipped', names: [], reason: 'client scan disabled' }
  }

  const roots = []
  if (core !== undefined && typeof core.nodeModules === 'string' && existsSync(core.nodeModules)) {
    roots.push({ label: 'core', dir: core.nodeModules })
  }
  const profileDir = options.profileDir
  if (typeof profileDir === 'string' && profileDir !== '') {
    const profileModules = join(profileDir, 'node_modules')
    if (existsSync(profileModules) && !roots.some(root => root.dir === profileModules)) {
      roots.push({ label: 'profile', dir: profileModules })
    }
  }
  if (roots.length === 0) {
    return { ok: false, source: 'unavailable', names: [], reason: 'no core tree or profile node_modules located' }
  }

  const rootLabels = roots.map(root => root.label).join('+')
  const cacheFile = join(
    compatDir(env),
    `client-services-${String(core?.version ?? 'unknown').replace(/[^\w.+-]/g, '_')}-${rootLabels}${rootsFingerprint(roots)}.json`,
  )
  if (options.refresh !== true && existsSync(cacheFile)) {
    try {
      const cached = record(JSON.parse(readFileSync(cacheFile, 'utf8')))
      if (Array.isArray(cached?.names) && cached.names.length > 0) {
        return { ok: true, source: `cache:${cacheFile}`, names: cached.names, scanned: cached.scanned ?? 0, roots: cached.roots ?? rootLabels }
      }
    } catch {
      /* fall through to a fresh scan */
    }
  }

  const names = new Set()
  let scanned = 0
  let pass2 = false

  /** @param {string} text */
  const harvest = text => {
    for (const pattern of PROVIDER_PATTERNS) {
      for (const match of text.matchAll(pattern)) names.add(match[1])
    }
  }

  /**
   * @param {string} dir
   * @param {'name'|'marker'} mode `name` = only `client.*js`; `marker` = any script
   *        carrying the client-bundle marker (the fallback when the name pass found
   *        nothing at all).
   */
  const walkRoot = (dir, mode) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        // The root itself is a node_modules; nested ones belong to other packages.
        if (entry.name === 'node_modules') continue
        walkRoot(path, mode)
        continue
      }
      if (!SCRIPT_FILE.test(entry.name)) continue
      if (mode === 'name' && !CLIENT_BUNDLE_NAME.test(entry.name)) continue
      let text
      try {
        if (statSync(path).size > MAX_CLIENT_BYTES) continue
        text = readFileSync(path, 'utf8')
      } catch {
        /* unreadable bundle: skip, the count reports how many were actually read */
        continue
      }
      if (mode === 'marker' && !text.includes(MODULE_LOADER_MARK)) continue
      scanned += 1
      harvest(text)
    }
  }

  for (const root of roots) {
    const before = names.size
    walkRoot(root.dir, 'name')
    if (names.size === before) {
      // Nothing found by name in this root: it may name its bundles differently.
      pass2 = true
      walkRoot(root.dir, 'marker')
    }
  }

  const rootReport = roots.map(root => ({ label: root.label, dir: root.dir }))
  if (scanned === 0) {
    return {
      ok: false,
      source: `scan:0 bundles (${rootLabels})`,
      names: [],
      scanned: 0,
      roots: rootReport,
      reason: `no client bundle read under ${roots.map(root => `${root.label}:${root.dir}`).join(' / ')}`,
    }
  }

  const sorted = [...names].sort()
  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({ version: core?.version, scanned, roots: rootLabels, names: sorted }, null, 2))
  } catch {
    /* caching is an optimisation */
  }
  return { ok: true, source: `scan:${scanned} client bundles (${rootLabels}${pass2 ? ', name-fallback' : ''})`, names: sorted, scanned, roots: rootReport, pass2 }
}

/**
 * Cheap "did the tree change" fingerprint: the sorted top-level names of each
 * root. Installing or removing a plugin changes it, so a cache built before that
 * install cannot keep answering for it — the failure mode this cache just caused.
 *
 * @param {{ dir: string }[]} roots
 */
function rootsFingerprint(roots) {
  const parts = roots.map(root => {
    try {
      return createHash('sha256').update(readdirSync(root.dir).sort().join(',')).digest('hex').slice(0, 8)
    } catch {
      return 'noread'
    }
  })
  return parts.length === 0 ? '' : `-${parts.join('-')}`
}

/**
 * Compare what a package asks for against what the deployment provides.
 *
 * Optional requirements are reported but never block: cordis activates the row
 * without them.
 *
 * @param {{ host?: { required: string[], optional: string[] }, client?: { required: string[], optional: string[] } }} declared
 * @param {{ host?: string[], client?: { ok: boolean, names: string[], source: string } }} available
 */
export function compareServices(declared, available) {
  const hostAvailable = new Set(available.host ?? [])
  const clientAvailable = new Set(available.client?.ok === true ? available.client.names : [])
  const clientKnown = available.client?.ok === true
  /*
   * An empty host inventory means "we could not read the registry", not "the host
   * provides nothing" — a distinction that matters a lot: treating it as the
   * latter blocks every plugin, including ones that install fine today.
   */
  const hostKnown = hostAvailable.size > 0

  const missingHost = hostKnown
    ? (declared.host?.required ?? []).filter(name => !hostAvailable.has(name))
    : []
  const missingClient = clientKnown
    ? (declared.client?.required ?? []).filter(name => !clientAvailable.has(name))
    : []
  /*
   * Required client services we could not check at all. They are reported instead of
   * being counted as missing: an inventory we failed to build must not veto an
   * install. `dsh-pet@0.3.8` was blocked exactly this way — its six required client
   * services included `connection`, which the deployment does provide.
   */
  const unknownClient = clientKnown ? [] : (declared.client?.required ?? [])
  const missingOptional = [
    ...(declared.host?.optional ?? []).filter(name => !hostAvailable.has(name)).map(name => `host:${name}`),
    ...(clientKnown
      ? (declared.client?.optional ?? []).filter(name => !clientAvailable.has(name)).map(name => `client:${name}`)
      : []),
  ]

  return {
    ok: missingHost.length === 0 && missingClient.length === 0,
    missingHost,
    missingClient,
    unknownClient,
    missingOptional,
    clientInventory: available.client?.source ?? 'unknown',
    clientInventoryReason: available.client?.ok === true ? undefined : (available.client?.reason ?? 'client inventory unavailable'),
    // The count that matters for a trust decision: if we could not inventory the
    // client half, a clean result only means "nothing known to be missing".
    verified: { host: hostKnown, client: clientKnown },
  }
}

/**
 * Boot failures already recorded on this device.
 *
 * DSHM writes `pending (waiting for service: X)` into the host log; that is the
 * machine-readable form of "this plugin will never activate".
 *
 * The log is *not* inside `$DSH_HOME` — see `hostfiles.js`. Locating it there
 * instead of at `join(home, 'dshm-host.log')` is what makes `compat_verify` able
 * to settle a pending install at all: with the log unreadable every verdict was
 * `unknown`, which is indistinguishable from "nothing to report".
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function pendingFromLogs(env = process.env) {
  const home = env.DSHM_HOME || env.DSH_HOME
  if (typeof home !== 'string' || home === '') return { ok: false, pending: [], reason: 'DSHM_HOME/DSH_HOME is not set' }
  const candidates = existingHostLogs(env)
  if (candidates.length === 0) {
    // Say where we looked: "no host log found" sent the last reader hunting for a
    // file that was two directories away, so the miss has to be actionable.
    const looked = hostLogCandidates(env)
    const shown = looked.slice(0, 3).join(', ')
    return {
      ok: false,
      pending: [],
      reason: looked.length === 0 ? 'no host log found' : `no host log found (looked in ${looked.length} place(s): ${shown}${looked.length > 3 ? ', …' : ''})`,
      looked,
    }
  }

  const pending = []
  for (const file of candidates) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const pendingMatch = /([\w@/.-]+)\s*:\s*pending\s*\(waiting for service:\s*([\w.$@-]+)\)/.exec(line)
      if (pendingMatch !== null) {
        pending.push({ file, plugin: pendingMatch[1], service: pendingMatch[2], line: line.trim().slice(0, 300) })
        continue
      }
      const failedMatch = /Failed to load plugins/.exec(line)
      if (failedMatch !== null) pending.push({ file, plugin: undefined, service: undefined, line: line.trim().slice(0, 300) })
    }
  }
  const deduped = []
  const seen = new Set()
  for (const item of pending) {
    const key = `${item.plugin ?? ''}|${item.service ?? ''}|${item.line}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }
  return { ok: true, pending: deduped, files: candidates }
}

/** @param {string} value */
export function fingerprintOf(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}
