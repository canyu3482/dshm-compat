/**
 * Manual profile installation for converted artifacts.
 *
 * DSHM's host installer accepts npm names and GitHub repositories, but rejects
 * local tarballs, `file:` and `http://` specs. A converted package has to land
 * in the profile another way: unpack it under `<profile>/node_modules/<name>`,
 * record the dependency, and append the bundle so the next boot composes its
 * patch. This mirrors the manual installation the DSHM agent performed for
 * `dshm-compat` itself.
 *
 * @module dshm-compat/local-install
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './state.js'
import { extractTar } from './tar.js'
import { validateTarball } from './validate.js'

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/** @param {string} file @param {unknown} value */
function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, text, 'utf8')
  try { renameSync(temporary, file) } catch {
    writeFileSync(file, text, 'utf8')
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
}

/** @param {string} candidate */
function looksLikeProfile(candidate) {
  return existsSync(join(candidate, 'package.json'))
}

/** @param {NodeJS.ProcessEnv} env */
function profileFromModule() {
  let current = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(current) === 'node_modules') return dirname(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Resolve the profile that owns this plugin.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
export function resolveProfileDir(env = process.env) {
  if (typeof env.DSH_PROFILE_DIR === 'string' && looksLikeProfile(env.DSH_PROFILE_DIR)) return env.DSH_PROFILE_DIR
  const fromModule = profileFromModule()
  if (fromModule !== undefined && looksLikeProfile(fromModule)) return fromModule
  const name = env.DSH_PROFILE
  if (typeof name === 'string' && name !== '') {
    const candidate = join(dshHome(env), 'profiles', name)
    if (looksLikeProfile(candidate)) return candidate
  }
  return undefined
}

/** @param {string} spec */
export function isLocalSpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return false
  const raw = spec.trim()
  if (/^(?:file|link):/i.test(raw)) return true
  if (isAbsolute(raw)) return true
  return /\.(?:tgz|tar\.gz)(?:[?#].*)?$/i.test(raw)
}

/** @param {string} target @param {import('./tar.js').TarEntry[]} entries */
function writeEntries(target, entries) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const relative = entry.path.replace(/^package\//, '')
    if (relative === '' || relative.startsWith('/') || relative.split('/').includes('..')) continue
    const file = join(target, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, entry.data, { mode: entry.mode === 0 ? 0o644 : entry.mode & 0o777 })
  }
}

/**
 * @param {string} tarball
 * @param {{ profileDir?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function installLocalTarball(tarball, options = {}) {
  const env = options.env ?? process.env
  if (typeof tarball !== 'string' || !existsSync(tarball)) {
    return { ok: false, error: `tarball not found: ${String(tarball)}` }
  }
  const validation = validateTarball(tarball)
  if (!validation.ok) return { ok: false, error: `converted tarball is invalid: ${validation.errors.join('; ')}` }

  const profileDir = typeof options.profileDir === 'string' && options.profileDir !== ''
    ? resolve(options.profileDir)
    : resolveProfileDir(env)
  if (profileDir === undefined || !looksLikeProfile(profileDir)) {
    return { ok: false, error: 'cannot locate the DSH profile that owns this plugin; pass profileDir explicitly' }
  }

  const { entries } = extractTar(readFileSync(tarball))
  const packageEntry = entries.find(entry => entry.path === 'package/package.json')
  if (packageEntry?.data === undefined) return { ok: false, error: 'converted tarball has no package/package.json' }
  const pkg = record(JSON.parse(packageEntry.data.toString('utf8')))
  const name = typeof pkg?.name === 'string' ? pkg.name : undefined
  const version = typeof pkg?.version === 'string' ? pkg.version : '0.0.0'
  if (name === undefined || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name)) {
    return { ok: false, error: 'converted tarball has no valid package name' }
  }

  const destination = join(profileDir, 'node_modules', ...name.split('/'))
  const manifestPath = join(profileDir, 'package.json')
  const manifest = readJson(manifestPath)
  if (record(manifest) === undefined) return { ok: false, error: `profile manifest is not an object: ${manifestPath}` }

  const staging = `${destination}.staging-${process.pid}-${Date.now()}`
  const backup = `${destination}.backup-${process.pid}-${Date.now()}`
  let movedOld = false
  try {
    writeEntries(staging, entries)
    if (existsSync(destination)) {
      renameSync(destination, backup)
      movedOld = true
    }
    renameSync(staging, destination)

    const dependencies = record(manifest.dependencies) ?? {}
    dependencies[name] = version
    manifest.dependencies = dependencies
    const dsh = record(manifest.dsh) ?? {}
    const profile = record(dsh.profile) ?? {}
    const bundles = Array.isArray(profile.bundles) ? profile.bundles.filter(item => typeof item === 'string') : []
    if (!bundles.includes(name)) bundles.push(name)
    profile.bundles = bundles
    dsh.profile = profile
    manifest.dsh = dsh
    writeJsonAtomic(manifestPath, manifest)

    if (movedOld) {
      try { rmSync(backup, { recursive: true, force: true }) } catch { /* keep the backup if it is locked */ }
    }
    return {
      ok: true,
      method: 'local-profile',
      profileDir,
      name,
      version,
      destination,
      restartRequired: true,
      warnings: validation.warnings,
    }
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }) } catch { /* staging may be gone */ }
    let restored = false
    try {
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true })
      if (movedOld && existsSync(backup)) {
        renameSync(backup, destination)
        restored = true
      }
    } catch { /* report the original error; recovery is best effort */ }
    return {
      ok: false,
      error: `local install failed: ${String(error?.message ?? error)}`
        + (movedOld ? (restored ? '; previous files restored' : `; RESTORE FAILED — previous files remain at ${backup}`) : ''),
    }
  }
}
