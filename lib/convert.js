/**
 * Code-level conversion for S0 plugins.
 *
 * Phase 1 does the manifest rewrite and repack that a registry tarball needs to
 * survive DSHM's host installer: remove foreign `os`/`cpu` gates and install
 * lifecycle scripts, normalize a client platform to `web`, then pack the same
 * files as a new tarball. Dependency bundling and source transpilation belong to
 * the next phase; this module reports those gaps instead of hiding them.
 *
 * @module dshm-compat/convert
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyze } from './analyze.js'
import { loadArchive, resolveSpec } from './fetch.js'
import { packTarGz } from './pack.js'
import { hostReach, importGaps } from './reach.js'
import { compatDir } from './state.js'
import { extractTar, findRootPrefix } from './tar.js'
import { validateTarball } from './validate.js'
import { vendorDependencies } from './vendor.js'

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

/** @param {string} name */
function safeName(name) {
  return String(name).replace(/^@/, '').replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * A GitHub source checkout may have no built `main`. Prefer the package's
 * published npm build instead of stopping at needs-build; this is generic and
 * keeps the source version only when the registry has nothing newer/built.
 *
 * @param {any} report
 * @param {any} options
 */
async function registryFallback(report, options) {
  const name = report.package?.name
  if (typeof name !== 'string' || name === '' || options.registryFallback === true) return undefined
  let resolved
  try {
    resolved = await resolveSpec(`${name}@latest`, { registry: options.registry, signal: options.signal })
  } catch {
    return undefined
  }
  const version = typeof resolved.version === 'string' ? resolved.version : undefined
  if (version === undefined || version === report.package.version) return undefined
  let fallbackReport
  try {
    fallbackReport = await analyze(`${name}@latest`, { textScan: false, signal: options.signal, registry: options.registry })
  } catch {
    return undefined
  }
  if (fallbackReport.strategy !== 'S2') return undefined
  const { convertS2Native } = await import('./s2-native.js')
  const converted = await convertS2Native(`${name}@latest`, {
    report: fallbackReport,
    workerPath: options.workerPath,
    workerBinary: options.workerBinary,
    workerName: options.workerName,
    signal: options.signal,
    registryFallback: true,
  })
  if (converted.status !== 'ok') return undefined
  return {
    ...converted,
    fallback: { from: report.spec, to: `${name}@${version}`, version },
    changed: [...(converted.changed ?? []), `replaced source checkout with published ${name}@${version}`],
  }
}

/**
 * @param {string} spec
 * @param {{ report?: any, registry?: string, signal?: AbortSignal, maxBytes?: number, workerPath?: string, workerBinary?: Buffer, workerName?: string, registryFallback?: boolean, buildNative?: boolean, ctx?: any }} [options]
 */
export async function convert(spec, options = {}) {
  const report = options.report ?? await analyze(spec, { textScan: false, signal: options.signal, registry: options.registry })
  if (report.strategy === 'S2') {
    const { convertS2Native } = await import('./s2-native.js')
    if (options.buildNative === true) {
      const { buildSource } = await import('./source-build.js')
      if (options.ctx === undefined) return { status: 'error', error: { code: 'NO_CONTEXT', message: 'buildNative requires the plugin context' } }
      const built = await buildSource(options.ctx, spec, { backend: 'guest', requireNoClobber: options.requireNoClobber === true, signal: options.signal })
      if (built.status !== 'ok') return built
      if (built.plan?.kind === 'rust') {
        const result = await convertS2Native(spec, {
          report,
          workerPath: built.artifact,
          signal: options.signal,
        })
        return { ...result, build: { source: built.source, patches: built.patches, patchSummary: built.patchSummary, warnings: built.warnings, artifact: built.artifact } }
      }
      return await convert(built.artifact, {
        ...options,
        report: undefined,
        buildNative: false,
        ctx: undefined,
      })
    }
    const result = await convertS2Native(spec, {
      report,
      workerPath: options.workerPath,
      workerBinary: options.workerBinary,
      workerName: options.workerName,
      signal: options.signal,
    })
    if (result.status === 'needs-build' && result.sourcePackage === true) {
      const fallback = await registryFallback(report, options)
      if (fallback !== undefined) return fallback
    }
    return result
  }
  if (report.strategy !== 'S0' && report.strategy !== 'S1') {
    return {
      status: 'skipped',
      strategy: report.strategy,
      reasons: report.reasons,
      next: report.next,
      message: `strategy ${report.strategy} needs a recipe or an external native build; see next`,
    }
  }
  if (report.signals?.hasDsh !== true) {
    return { status: 'not-a-dsh-plugin', message: 'the package has no dsh.bundle or dsh.client manifest; conversion cannot invent a DSH entry point' }
  }

  const resolved = await resolveSpec(spec, { registry: options.registry, signal: options.signal })
  const archive = await loadArchive(resolved, { maxBytes: options.maxBytes, signal: options.signal, cacheDir: options.cacheDir })
  const { entries } = extractTar(archive)
  const prefix = findRootPrefix(entries)
  const top = entries
    .filter(entry => entry.type === 'file')
    .map(entry => ({ ...entry, path: prefix !== '' && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path }))
  /*
   * Same subtree narrowing the analyzer applies for `github:…&path:/sub` specs
   * (monorepo plugins). Without it, selectRoot would pick the REPOSITORY-root
   * package.json and the conversion would pack a package the user never asked
   * for — the analyzer classified the subtree, so the converter must rewrite it.
   */
  const scoped = typeof resolved?.subdir === 'string' && resolved.subdir !== ''
    ? top
      .filter(entry => entry.path.startsWith(`${resolved.subdir}/`))
      .map(entry => ({ ...entry, path: entry.path.slice(resolved.subdir.length + 1) }))
    : top
  const root = selectRoot(scoped)
  const files = scoped
    .filter(entry => entry.path.startsWith(root))
    .map(entry => ({ ...entry, path: entry.path.slice(root.length) }))
  const packageEntry = files.find(file => file.path === 'package.json')
  if (packageEntry?.data === undefined) return { status: 'invalid-package', message: 'package.json is missing' }

  let pkg
  try { pkg = JSON.parse(packageEntry.data.toString('utf8')) } catch (error) {
    return { status: 'invalid-package', message: `package.json is not valid JSON: ${String(error?.message ?? error)}` }
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return { status: 'invalid-package', message: 'package.json is not an object' }

  /** @type {string[]} */
  const changed = []
  /** @type {string[]} */
  const warnings = []

  if (pkg.os !== undefined) { delete pkg.os; changed.push('removed package.json os gate') }
  if (pkg.cpu !== undefined) { delete pkg.cpu; changed.push('removed package.json cpu gate') }
  if (pkg.engines !== null && typeof pkg.engines === 'object' && !Array.isArray(pkg.engines) && pkg.engines.dsh !== undefined) {
    delete pkg.engines.dsh
    if (Object.keys(pkg.engines).length === 0) delete pkg.engines
    changed.push('removed engines.dsh gate')
  }
  if (pkg.scripts !== null && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) {
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (typeof pkg.scripts[name] === 'string') { delete pkg.scripts[name]; changed.push(`removed scripts.${name}`) }
    }
    if (Object.keys(pkg.scripts).length === 0) delete pkg.scripts
  }

  const client = pkg.dsh !== null && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh) ? pkg.dsh.client : undefined
  if (client !== null && typeof client === 'object' && !Array.isArray(client)) {
    if (client.platform !== 'web') {
      warnings.push(`client platform was ${String(client.platform ?? 'unset')}; rewrote it to web for DSHM's ArkWeb UI`)
      client.platform = 'web'
      changed.push('normalized dsh.client.platform to web')
    }
  }

  const patch = pkg.dsh !== null && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh)
    && pkg.dsh.bundle !== null && typeof pkg.dsh.bundle === 'object' && !Array.isArray(pkg.dsh.bundle)
    ? pkg.dsh.bundle.patch
    : undefined
  if (typeof patch === 'string' && !files.some(file => file.path === patch.replace(/^\.\//, ''))) {
    return { status: 'invalid-package', message: `dsh.bundle.patch names a missing file: ${patch}` }
  }
  if (typeof patch !== 'string' && client === undefined) {
    return { status: 'not-a-dsh-plugin', message: 'the package has no dsh.bundle.patch and no dsh.client entry' }
  }

  if (report.strategy === 'S1') {
    const substitutions = report.signals?.nativeDeps ?? []
    const manual = substitutions.filter(dep => dep.ohos === undefined)
    if (manual.length > 0) {
      return {
        status: 'manual-required',
        strategy: 'S1',
        reasons: manual.map(dep => `${dep.name} has no drop-in OHOS package; ${dep.js ?? 'a code change'} is required`),
        next: report.next,
      }
    }
    const core = report.signals?.dependencies?.core
    if (core?.available !== true) {
      return {
        status: 'skipped',
        strategy: 'S1',
        message: 'cannot verify that the DSHM core exposes the substitute packages; refusing to remove native dependencies',
        next: report.next,
      }
    }
    const missing = new Set(report.signals?.dependencies?.missing ?? [])
    const unavailable = substitutions.filter(dep => missing.has(dep.name))
    if (unavailable.length > 0) {
      return {
        status: 'skipped',
        strategy: 'S1',
        message: `the DSHM core does not expose: ${unavailable.map(dep => dep.name).join(', ')}; install a core with the OHOS ports first`,
        next: report.next,
      }
    }
    for (const dep of substitutions) {
      let removed = false
      for (const field of ['dependencies', 'optionalDependencies']) {
        const block = pkg[field]
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
        if (block[dep.name] !== undefined) {
          delete block[dep.name]
          removed = true
          changed.push(`removed native dependency ${dep.name}; the DSHM core provides ${dep.ohos}`)
        }
      }
      if (!removed) warnings.push(`${dep.name} was reported as a native dependency but is absent from package.json`)
    }
    pkg.dshmCompat = {
      ...(pkg.dshmCompat !== null && typeof pkg.dshmCompat === 'object' && !Array.isArray(pkg.dshmCompat) ? pkg.dshmCompat : {}),
      nativeSubstitutions: substitutions.map(dep => ({ from: dep.name, to: dep.ohos, note: dep.note })),
    }
  }

  /** @type {Awaited<ReturnType<typeof vendorDependencies>> | undefined} */
  let vendored
  if (report.strategy === 'S0' && options.vendor !== false) {
    const dependencySignals = report.signals?.dependencies ?? {}
    const core = dependencySignals.core
    const candidates = core?.available === true
      ? (dependencySignals.missing ?? [])
      : Object.keys(pkg.dependencies !== null && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {})
    const names = candidates.filter(name => pkg.dependencies !== null && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) && pkg.dependencies[name] !== undefined)
    if (names.length > 0) {
      try {
        vendored = await vendorDependencies(pkg, {
          names,
          corePackages: new Set(dependencySignals.present ?? []),
          resolve: options.resolve,
          load: options.load,
          // Vendored tarballs go through the same disk cache as the main
          // package — a repeat conversion must not re-download the tree.
          cacheDir: options.cacheDir,
          signal: options.signal,
        })
      } catch (error) {
        return {
          status: 'vendor-failed',
          strategy: 'S0',
          message: String(error?.message ?? error),
          code: error?.code ?? 'VENDOR_FAILED',
        }
      }
      for (const name of vendored.removed) {
        if (pkg.dependencies !== null && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) && pkg.dependencies[name] !== undefined) {
          delete pkg.dependencies[name]
          changed.push(`vendored dependency ${name}`)
        }
      }
      warnings.push(...vendored.warnings)
      if (vendored.packages.length === 0) {
        return { status: 'vendor-failed', strategy: 'S0', warnings, message: 'none of the missing runtime dependencies could be vendored' }
      }
    }
  }

  if (pkg.dependencies !== null && typeof pkg.dependencies === 'object' && Object.keys(pkg.dependencies).length > 0) {
    warnings.push('runtime dependencies are not bundled by phase 1; verify they exist in the DSHM core or bundle them before installing')
  }
  if (pkg.optionalDependencies !== null && typeof pkg.optionalDependencies === 'object' && Object.keys(pkg.optionalDependencies).length > 0) {
    warnings.push('optionalDependencies may install foreign-platform payloads; phase 1 leaves them untouched')
  }
  if (report.signals?.platformBlocked) warnings.push('the original package declared a non-Linux platform gate; it was removed')

  const outputDir = join(compatDir(process.env), 'builds')
  mkdirSync(outputDir, { recursive: true })
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  const baseName = `${safeName(String(pkg.name ?? 'plugin'))}-${version}-dshm`
  const tarball = join(outputDir, `${baseName}.tgz`)

  const packedFiles = files.map(file => ({ path: file.path, data: file.data, mode: file.mode }))
  /*
   * The validator and the installer re-extract this tarball through a reader
   * capped at 20,000 entries; a vendored tree crossing that cap would produce
   * an artifact compat itself cannot read back. Refuse before packing instead.
   */
  if (packedFiles.length >= 19000) {
    return {
      status: 'too-many-files',
      strategy: report.strategy,
      message: `the package (with vendored dependencies) has ${packedFiles.length} files; the tarball reader caps at 20,000 — trim the dependency set or vendor fewer packages`,
      changed,
      warnings,
    }
  }
  const packageJsonEntry = packedFiles.find(file => file.path === 'package.json')
  packageJsonEntry.data = Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  if (vendored !== undefined) {
    const existing = new Set(packedFiles.map(file => file.path))
    for (const file of vendored.files) {
      if (existing.has(file.path)) continue
      packedFiles.push(file)
      existing.add(file.path)
    }
  }
  /*
   * Import-closure audit on the final tree (post-vendor, pre-pack): a bare import
   * that is neither built-in, host-provided, declared, nor carried throws the moment
   * its module loads — the wallpaper-engine failure class that used to surface only
   * at device boot. Gaps the registry can satisfy are vendored right here (the
   * author imported the package but never declared it — `dsh-pet`'s undici); what
   * cannot be resolved stays a warning. Warning-level on purpose: the static walk
   * cannot know everything the host provides beyond the @deepseek-ai namespace, so
   * it informs where it cannot fix, and vendoring itself never fails a conversion.
   */
  const reach = hostReach(packedFiles, { pkg })
  if (reach.fellBack === false) {
    const declared = new Set([String(pkg.name ?? '')])
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const block = pkg[field]
      if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
        for (const name of Object.keys(block)) declared.add(name)
      }
    }
    let gaps = importGaps(packedFiles, reach, { declared })
    if (gaps.length > 0 && options.vendor !== false && report.strategy === 'S0') {
      const orphanNames = []
      for (const gap of gaps) {
        const segments = gap.spec.split('/')
        const name = gap.spec.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
        if (name === '' || declared.has(name) || orphanNames.includes(name)) continue
        orphanNames.push(name)
        if (orphanNames.length >= 8) break
      }
      if (orphanNames.length > 0) {
        const dependenciesBlock = pkg.dependencies !== null && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {}
        const orphanPkg = { ...pkg, dependencies: { ...dependenciesBlock, ...Object.fromEntries(orphanNames.map(name => [name, '*'])) } }
        try {
          const orphaned = await vendorDependencies(orphanPkg, {
            names: orphanNames,
            corePackages: new Set(report.signals?.dependencies?.present ?? []),
            resolve: options.resolve,
            load: options.load,
            cacheDir: options.cacheDir,
            signal: options.signal,
          })
          const existing = new Set(packedFiles.map(file => file.path))
          for (const file of orphaned.files) {
            if (existing.has(file.path)) continue
            packedFiles.push(file)
            existing.add(file.path)
          }
          if (orphaned.packages.length > 0) {
            for (const item of orphaned.packages) changed.push(`auto-vendored undeclared import ${item.name}@${item.version}`)
            warnings.push(`作者未声明但代码引用的依赖已按 registry 最新版自动携带：${orphaned.packages.map(item => `${item.name}@${item.version}`).join('、')}（来源：import 闭包审计）`)
          }
          warnings.push(...orphaned.warnings)
          gaps = importGaps(packedFiles, reach, { declared })
        } catch (error) {
          warnings.push(`orphan-import vendoring failed: ${String(error?.message ?? error).slice(0, 120)}`)
        }
      }
    }
    for (const gap of gaps.slice(0, 6)) {
      warnings.push(`import 闭包缺口：${gap.path} 引用 ${gap.spec} —— 未声明且未随包携带；若宿主运行时也未提供，加载时报错`)
    }
    if (gaps.length > 6) warnings.push(`import 闭包缺口共 ${gaps.length} 处，已列前 6 处`)
  }
  const packed = packTarGz(packedFiles)

  writeFileSync(tarball, packed)
  const sha256 = createHash('sha256').update(packed).digest('hex')
  const validation = validateTarball(tarball, { corePackages: new Set(report.signals?.dependencies?.present ?? []) })
  warnings.push(...validation.warnings)
  if (!validation.ok) {
    return {
      status: 'invalid-output',
      strategy: report.strategy,
      tarball,
      sha256,
      errors: validation.errors,
      warnings,
      changed,
    }
  }

  if (warnings.length > 0) {
    for (const warning of warnings) report.warnings = [...(report.warnings ?? []), warning]
  }

  return {
    status: 'ok',
    tarball,
    bytes: packed.length,
    sha256,
    changed,
    warnings,
    validation,
    vendored: vendored === undefined ? [] : vendored.packages.map(item => `${item.name}@${item.version}`),
    source: {
      kind: resolved.kind,
      name: resolved.name,
      version: resolved.version,
      fingerprint: report.fingerprint,
    },
    next: 'review the report, then call compat_install with the tarball path and confirm:true',
  }
}
