/**
 * Profile-local uninstall.
 *
 * Removes a package from the owning profile: its `node_modules` directory, the
 * `dependencies` entry, and the `dsh.profile.bundles` entry. The profile
 * manifest is only changed after the files are moved aside, so a failed delete
 * can be rolled back.
 *
 * @module dshm-compat/uninstall
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfileDir } from './local-install.js'

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {string} file */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return undefined }
}

/** @param {string} file @param {unknown} value */
function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/**
 * @param {string} name
 * @param {{ profileDir?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function uninstallLocalPackage(name, options = {}) {
  const env = options.env ?? process.env
  if (typeof name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name)) {
    return { ok: false, error: `invalid package name: ${String(name)}` }
  }
  const profileDir = typeof options.profileDir === 'string' && options.profileDir !== ''
    ? options.profileDir
    : resolveProfileDir(env)
  if (profileDir === undefined) return { ok: false, error: 'cannot locate the DSH profile; pass profileDir explicitly' }
  const manifestPath = join(profileDir, 'package.json')
  const manifest = record(readJson(manifestPath))
  if (manifest === undefined) return { ok: false, error: `profile manifest is not an object: ${manifestPath}` }

  const destination = join(profileDir, 'node_modules', ...name.split('/'))
  const dependencies = record(manifest.dependencies) ?? {}
  const hadDependency = Object.prototype.hasOwnProperty.call(dependencies, name)
  const dsh = record(manifest.dsh) ?? {}
  const profile = record(dsh.profile) ?? {}
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.filter(item => typeof item === 'string') : []
  const hadBundle = bundles.includes(name)
  if (!hadDependency && !hadBundle && !existsSync(destination)) {
    return { ok: true, name, removed: false, profileDir, restartRequired: false, message: 'not installed in this profile' }
  }

  const backup = `${destination}.uninstall-${process.pid}-${Date.now()}`
  const originalManifest = JSON.parse(JSON.stringify(manifest))
  let moved = false
  try {
    if (existsSync(destination)) {
      renameSync(destination, backup)
      moved = true
    }
    delete dependencies[name]
    manifest.dependencies = dependencies
    profile.bundles = bundles.filter(item => item !== name)
    dsh.profile = profile
    manifest.dsh = dsh
    writeJsonAtomic(manifestPath, manifest)
    if (moved) {
      try { rmSync(backup, { recursive: true, force: true }) } catch { /* keep the backup if it is locked */ }
    }
    return {
      ok: true,
      name,
      removed: true,
      profileDir,
      destination,
      removedDependency: hadDependency,
      removedBundle: hadBundle,
      restartRequired: true,
    }
  } catch (error) {
    try { writeJsonAtomic(manifestPath, originalManifest) } catch { /* best effort */ }
    if (moved && existsSync(backup)) {
      try { renameSync(backup, destination) } catch { /* best effort */ }
    }
    return { ok: false, error: `uninstall failed: ${String(error?.message ?? error)}` }
  }
}
