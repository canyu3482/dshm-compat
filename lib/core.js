/**
 * DSHM core inventory.
 *
 * A profile plugin resolves bare imports through the host's module router. On
 * DSHM the installation tree under `$DSH_HOME/cores/<version>/node_modules`
 * carries the packages the host itself ships. Knowing which runtime
 * dependencies are already there decides whether a converted plugin can stay a
 * thin repack or must vendor its own dependency tree.
 *
 * @module dshm-compat/core
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** @param {string} path */
function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** @param {string} file */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return undefined }
}

/**
 * Locate the newest DSHM core installation.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ available: boolean, dir?: string, version?: string, nodeModules?: string, packages?: Set<string>, reason?: string }}
 */
export function inspectCore(env = process.env) {
  if (typeof env.DSHM_CORE_DIR === 'string' && env.DSHM_CORE_DIR !== '') {
    const dir = env.DSHM_CORE_DIR
    const nodeModules = join(dir, 'node_modules')
    if (!isDirectory(nodeModules)) return { available: false, reason: `DSHM_CORE_DIR has no node_modules: ${dir}` }
    const manifest = readJson(join(dir, 'dshm-core.json'))
    return {
      available: true,
      dir,
      version: typeof manifest?.coreVersion === 'string' ? manifest.coreVersion : undefined,
      nodeModules,
      packages: listPackages(nodeModules),
    }
  }

  const home = env.DSHM_HOME || env.DSH_HOME
  if (typeof home !== 'string' || home === '') return { available: false, reason: 'DSHM_HOME/DSH_HOME is not set' }
  const cores = join(home, 'cores')
  if (!isDirectory(cores)) return { available: false, reason: `no cores directory under ${home}` }

  const candidates = []
  for (const entry of readdirSync(cores, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(cores, entry.name)
    const nodeModules = join(dir, 'node_modules')
    if (!isDirectory(nodeModules)) continue
    const manifest = readJson(join(dir, 'dshm-core.json'))
    candidates.push({
      dir,
      version: typeof manifest?.coreVersion === 'string' ? manifest.coreVersion : entry.name,
      builtAt: typeof manifest?.builtAt === 'string' ? manifest.builtAt : '',
      nodeModules,
    })
  }
  if (candidates.length === 0) return { available: false, reason: `no core with node_modules under ${cores}` }
  candidates.sort((a, b) => (b.builtAt.localeCompare(a.builtAt) || b.version.localeCompare(a.version)))
  const chosen = candidates[0]
  return { available: true, dir: chosen.dir, version: chosen.version, nodeModules: chosen.nodeModules, packages: listPackages(chosen.nodeModules) }
}

/** @param {string} nodeModules */
function listPackages(nodeModules) {
  /** @type {Set<string>} */
  const names = new Set()
  let entries
  try { entries = readdirSync(nodeModules, { withFileTypes: true }) } catch { return names }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      let scoped
      try { scoped = readdirSync(join(nodeModules, entry.name), { withFileTypes: true }) } catch { continue }
      for (const child of scoped) {
        if (child.isDirectory()) names.add(`${entry.name}/${child.name}`)
      }
    } else {
      names.add(entry.name)
    }
  }
  return names
}

/** @param {string} nodeModules @param {string} name */
export function hasPackage(nodeModules, name) {
  return existsSync(join(nodeModules, name, 'package.json'))
}

/**
 * Compare a package's runtime dependencies with the DSHM core.
 *
 * @param {Record<string, unknown> | undefined} pkg
 * @param {NodeJS.ProcessEnv} env
 */
export function checkDependencies(pkg, env = process.env) {
  /** @type {Record<string, string>} */
  const required = {}
  /** @type {Record<string, string>} */
  const optional = {}
  if (pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)) {
    const dependencies = pkg.dependencies
    if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const [name, range] of Object.entries(dependencies)) if (typeof range === 'string') required[name] = range
    }
    const optionalDependencies = pkg.optionalDependencies
    if (optionalDependencies !== null && typeof optionalDependencies === 'object' && !Array.isArray(optionalDependencies)) {
      for (const [name, range] of Object.entries(optionalDependencies)) if (typeof range === 'string') optional[name] = range
    }
  }
  const names = [...new Set([...Object.keys(required), ...Object.keys(optional)])]
  const core = inspectCore(env)
  if (!core.available) {
    return {
      core: { available: false, reason: core.reason },
      present: [],
      missing: Object.keys(required),
      optionalMissing: Object.keys(optional),
      unknown: true,
      dependencies: { ...required, ...optional },
    }
  }
  const present = []
  const missing = []
  const optionalMissing = []
  for (const name of names) {
    if (hasPackage(core.nodeModules, name)) present.push(name)
    else if (required[name] !== undefined) missing.push(name)
    else optionalMissing.push(name)
  }
  return {
    core: { available: true, version: core.version, dir: core.dir },
    present,
    missing,
    optionalMissing,
    unknown: false,
    dependencies: { ...required, ...optional },
  }
}
