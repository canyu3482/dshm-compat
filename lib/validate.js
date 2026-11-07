/**
 * Post-conversion tarball validation.
 *
 * The converter can produce a structurally valid tarball that still cannot
 * load: a missing patch file, a foreign client platform, or a bare import that
 * is neither vendored nor present in the core. This module checks those
 * contracts before the package reaches the install queue.
 *
 * @module dshm-compat/validate
 */
import { readFileSync } from 'node:fs'
import { extractTar } from './tar.js'

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * @param {string} tarball
 * @param {{ corePackages?: Set<string> }} [options]
 */
export function validateTarball(tarball, options = {}) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  let entries
  try { entries = extractTar(readFileSync(tarball)).entries } catch (error) {
    return { ok: false, errors: [`tarball is not readable: ${String(error?.message ?? error)}`], warnings }
  }
  const packageEntry = entries.find(entry => entry.path === 'package/package.json')
  if (packageEntry?.data === undefined) return { ok: false, errors: ['package/package.json is missing'], warnings }
  let pkg
  try { pkg = JSON.parse(packageEntry.data.toString('utf8')) } catch (error) {
    return { ok: false, errors: [`package.json is not valid JSON: ${String(error?.message ?? error)}`], warnings }
  }
  const manifest = record(pkg)
  if (manifest === undefined) return { ok: false, errors: ['package.json is not an object'], warnings }

  const paths = new Set(entries.filter(entry => entry.type === 'file').map(entry => entry.path))
  const relative = path => `package/${path.replace(/^\.\//, '')}`

  if (typeof manifest.main === 'string' && !paths.has(relative(manifest.main))) {
    errors.push(`main entry is missing: ${manifest.main}`)
  }

  const dsh = record(manifest.dsh)
  const bundle = record(dsh?.bundle)
  const patch = typeof bundle?.patch === 'string' ? bundle.patch : undefined
  if (patch !== undefined && !paths.has(relative(patch))) errors.push(`dsh.bundle.patch is missing: ${patch}`)
  if (patch === undefined && record(dsh?.client) === undefined) errors.push('package has neither dsh.bundle.patch nor dsh.client')
  const client = record(dsh?.client)
  if (client !== undefined && client.platform !== 'web') errors.push(`dsh.client.platform is ${String(client.platform ?? 'unset')}, not web`)

  const corePackages = options.corePackages ?? new Set()
  for (const name of Object.keys(record(manifest.dependencies) ?? {})) {
    if (corePackages.has(name)) continue
    const vendored = paths.has(`package/node_modules/${name}/package.json`)
    if (!vendored) warnings.push(`dependency ${name} is neither vendored nor present in the DSHM core`)
  }

  return { ok: errors.length === 0, errors, warnings }
}
