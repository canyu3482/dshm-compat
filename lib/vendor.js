/**
 * Minimal dependency vendoring.
 *
 * DSHM's host installer is not a package manager in the pnpm sense. A converted
 * plugin that relies on bare imports must either find them in the DSHM core or
 * carry them in its own `node_modules`. This module resolves only the missing
 * runtime dependencies, downloads their registry tarballs, and lays them out
 * flat. It is deliberately conservative: native payloads and version conflicts
 * are reported instead of being silently flattened.
 *
 * @module dshm-compat/vendor
 */
import { extractTar, findRootPrefix } from './tar.js'
import { loadArchive, resolveSpec } from './fetch.js'

const NATIVE_EXTENSIONS = new Set(['.node', '.so', '.dll', '.dylib', '.exe'])
const DEFAULT_MAX_PACKAGES = 150
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {string} path */
function extension(path) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** @param {import('./tar.js').TarEntry[]} entries */
function selectRoot(entries) {
  const candidates = entries
    .filter(entry => entry.type === 'file' && (entry.path === 'package.json' || entry.path.endsWith('/package.json')))
    .map(entry => ({ dir: entry.path === 'package.json' ? '' : entry.path.slice(0, -'/package.json'.length), depth: entry.path.split('/').length }))
    .sort((a, b) => a.depth - b.depth)
  return candidates.length === 0 ? '' : (candidates[0].dir === '' ? '' : `${candidates[0].dir}/`)
}

/** @param {string} name @param {string} version @param {Buffer} archive */
function readDependencyPackage(name, version, archive) {
  const { entries } = extractTar(archive)
  const prefix = findRootPrefix(entries)
  const top = entries
    .filter(entry => entry.type === 'file')
    .map(entry => ({ ...entry, path: prefix !== '' && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path }))
  const root = selectRoot(top)
  const files = top
    .filter(entry => entry.path.startsWith(root))
    .map(entry => ({ ...entry, path: entry.path.slice(root.length) }))
  const packageEntry = files.find(file => file.path === 'package.json')
  if (packageEntry?.data === undefined) throw new Error(`${name}@${version} has no package.json`)
  const pkg = JSON.parse(packageEntry.data.toString('utf8'))
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error(`${name}@${version} package.json is not an object`)
  return { pkg, files }
}

/**
 * @param {Record<string, unknown>} pkg
 * @param {{
 *   names?: string[],
 *   corePackages?: Set<string>,
 *   resolve?: (spec: string) => Promise<any>,
 *   load?: (resolved: any) => Promise<Buffer>,
 *   cacheDir?: string,
 *   signal?: AbortSignal,
 *   maxPackages?: number,
 *   maxBytes?: number,
 * }} [options]
 */
export async function vendorDependencies(pkg, options = {}) {
  const dependencies = record(pkg.dependencies) ?? {}
  const corePackages = options.corePackages ?? new Set()
  const resolve = options.resolve ?? (spec => resolveSpec(spec, { signal: options.signal }))
  // cacheDir: dependency tarballs share the main package's disk cache, so a
  // repeat conversion never re-downloads the tree.
  const load = options.load ?? (resolved => loadArchive(resolved, { signal: options.signal, cacheDir: options.cacheDir }))
  const maxPackages = options.maxPackages ?? DEFAULT_MAX_PACKAGES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const names = options.names ?? Object.keys(dependencies)
  /** @type {{ path: string, data: Buffer, mode: number }[]} */
  const files = []
  /** @type {{ name: string, version: string }[]} */
  const packages = []
  /** @type {string[]} */
  const warnings = []
  const placed = new Map()
  const visited = new Set()
  let bytes = 0

  const queue = names
    .filter(name => typeof dependencies[name] === 'string')
    .map(name => ({ name, range: dependencies[name] }))

  while (queue.length > 0) {
    if (packages.length >= maxPackages) throw Object.assign(new Error(`vendor limit: more than ${maxPackages} packages`), { code: 'VENDOR_LIMIT' })
    if (bytes > maxBytes) throw Object.assign(new Error(`vendor limit: more than ${maxBytes} bytes`), { code: 'VENDOR_LIMIT' })
    const { name, range } = queue.shift()
    if (corePackages.has(name)) continue
    if (typeof name !== 'string' || name === '' || typeof range !== 'string') continue

    let resolved
    try { resolved = await resolve(`${name}@${range}`) } catch (error) {
      warnings.push(`could not resolve ${name}@${range}: ${String(error?.message ?? error)}`)
      continue
    }
    const version = typeof resolved?.version === 'string' && resolved.version !== '' ? resolved.version : '0.0.0'
    const key = `${name}@${version}`
    if (visited.has(key)) continue
    visited.add(key)
    if (placed.has(name) && placed.get(name) !== version) {
      warnings.push(`version conflict for ${name}: kept ${placed.get(name)}, skipped ${version}`)
      continue
    }

    let archive
    try { archive = await load(resolved) } catch (error) {
      warnings.push(`could not download ${key}: ${String(error?.message ?? error)}`)
      continue
    }
    let parsed
    try { parsed = readDependencyPackage(name, version, archive) } catch (error) {
      warnings.push(`could not unpack ${key}: ${String(error?.message ?? error)}`)
      continue
    }

    const native = parsed.files.find(file => NATIVE_EXTENSIONS.has(extension(file.path)) || file.path.endsWith('/binding.gyp'))
    if (native !== undefined) {
      warnings.push(`${key} contains native payload ${native.path}; it cannot be vendored into a pure-JS conversion`)
      continue
    }

    for (const file of parsed.files) {
      files.push({ path: `node_modules/${name}/${file.path}`, data: file.data, mode: file.mode })
      bytes += file.data.length
    }
    placed.set(name, version)
    packages.push({ name, version })

    for (const [child, childRange] of Object.entries(record(parsed.pkg.dependencies) ?? {})) {
      if (typeof childRange === 'string') queue.push({ name: child, range: childRange })
    }
  }

  return {
    files,
    packages,
    removed: [...placed.keys()],
    warnings,
    bytes,
  }
}
