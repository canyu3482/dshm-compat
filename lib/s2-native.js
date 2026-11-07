/**
 * Generic S2 native adapter (dsh-ops is the first fixture).
 *
 * A native plugin usually ships a worker plus JS that (a) gates a PLATFORMS
 * matrix, (b) interpolates `${platform}-${arch}` into runtime paths, and
 * (c) spawns a worker argv array. This adapter normalizes those three patterns
 * and stages an externally built AArch64 musl worker. It is package-name
 * agnostic; dsh-ops remains the reference sample and test fixture.
 *
 * @module dshm-compat/s2-native
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.js'
import { elfArch } from './elf.js'
import { loadArchive, resolveSpec } from './fetch.js'
import { packTarGz } from './pack.js'
import { findReleaseWorker } from './release.js'
import { compatDir } from './state.js'
import { extractTar, findRootPrefix } from './tar.js'
import { validateTarball } from './validate.js'

const BUILD_COMMAND = 'cargo build --release --locked --manifest-path native/Cargo.toml --target aarch64-unknown-linux-musl'
const TARGET = 'aarch64-unknown-linux-musl'
const QEMU_ROOT = fileURLToPath(new URL('../assets/qemu-x86_64/', import.meta.url))

/** @param {import('../tar.js').TarEntry[]} entries */
function selectRoot(entries) {
  const candidates = entries
    .filter(entry => entry.type === 'file' && (entry.path === 'package.json' || entry.path.endsWith('/package.json')))
    .map(entry => ({ dir: entry.path === 'package.json' ? '' : entry.path.slice(0, -'/package.json'.length), depth: entry.path.split('/').length }))
    .sort((a, b) => a.depth - b.depth)
  return candidates.length === 0 ? '' : (candidates[0].dir === '' ? '' : `${candidates[0].dir}/`)
}

/**
 * @param {string} spec
 * @param {{ report?: any, workerPath?: string, workerBinary?: Buffer, signal?: AbortSignal }} [options]
 */
export async function convertS2Native(spec, options = {}) {
  const report = options.report ?? await analyze(spec, { textScan: false, signal: options.signal })
  const packageName = report.package?.name ?? report.resolved?.name ?? 'native-plugin'
  const packageVersion = report.package?.version ?? report.resolved?.version ?? '0.0.0'
  const resolved = await resolveSpec(spec, { signal: options.signal })
  const archive = await loadArchive(resolved, { signal: options.signal })
  const { entries } = extractTar(archive)
  const prefix = findRootPrefix(entries)
  const top = entries
    .filter(entry => entry.type === 'file')
    .map(entry => ({ ...entry, path: prefix !== '' && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path }))
  const root = selectRoot(top)
  const files = top
    .filter(entry => entry.path.startsWith(root))
    .map(entry => ({ ...entry, path: entry.path.slice(root.length) }))
  const byPath = new Map(files.map(file => [file.path, file]))
  const getText = path => byPath.get(path)?.data?.toString('utf8')

  const manifestEntry = byPath.get('package.json')
  let manifest
  try { manifest = manifestEntry?.data === undefined ? undefined : JSON.parse(manifestEntry.data.toString('utf8')) } catch { manifest = undefined }
  const main = typeof manifest?.main === 'string' ? manifest.main.replace(/^\.\//, '') : undefined
  const hasMain = main !== undefined && files.some(file => file.path === main)
  const buildScript = typeof manifest?.scripts?.build === 'string'
    ? manifest.scripts.build
    : typeof manifest?.scripts?.prepack === 'string' ? manifest.scripts.prepack : undefined
  if (!hasMain && buildScript !== undefined) {
    return {
      status: 'needs-build',
      sourcePackage: true,
      message: `${packageName} is a source package (main ${main ?? '<missing>'} is absent, build script ${JSON.stringify(buildScript)}); build it outside DSHM, then pass the produced tarball to compat_convert`,
      build: {
        command: 'npm ci && npm run build && npm pack',
        output: 'the produced .tgz',
        then: 'compat_convert { spec: "<produced.tgz>" }',
      },
    }
  }

  let workerBinary = options.workerBinary
  let workerName = options.workerName
  if (workerBinary === undefined && typeof options.workerPath === 'string') {
    try {
      workerBinary = readFileSync(options.workerPath)
      workerName ??= basename(options.workerPath)
    } catch (error) {
      return { status: 'needs-native-build', target: TARGET, command: BUILD_COMMAND, message: `cannot read worker: ${String(error?.message ?? error)}` }
    }
  }
  if (workerBinary === undefined) {
    const candidates = files
      .filter(file => file.type === 'file'
        && /^runtime\/linux-(?:arm64|x64)\//.test(file.path)
        && !file.path.endsWith('/provenance.json')
        && elfArch(file.data) !== undefined)
      .sort((a, b) => (elfArch(a.data) === 'arm64' ? 0 : 1) - (elfArch(b.data) === 'arm64' ? 0 : 1))
    if (candidates.length > 0) {
      workerBinary = candidates[0].data
      workerName = basename(candidates[0].path)
    }
  }
  let acquiredAsset
  let acquisition
  if (workerBinary === undefined) {
    acquisition = await findReleaseWorker(report, { signal: options.signal })
    if (acquisition.ok === true) {
      workerBinary = acquisition.buffer
      workerName = acquisition.name
      acquiredAsset = acquisition.asset
    }
  }
  if (workerBinary === undefined) {
    return {
      status: 'needs-native-build',
      target: TARGET,
      command: BUILD_COMMAND,
      message: `${packageName} needs a Linux arm64 or x64 worker; build one or pass workerPath to compat_convert`,
      notes: [
        'install a Rust toolchain and a musl aarch64 cross linker, or use cross/cargo-zigbuild',
        'stage the result at runtime/linux-arm64/<worker> or runtime/linux-x64/<worker>, or pass it as workerPath',
      ],
      ...(acquisition === undefined ? {} : { acquisition }),
    }
  }
  const workerArch = elfArch(workerBinary)
  if (workerArch === undefined) {
    return { status: 'invalid-worker', message: 'worker is not an AArch64 or x86_64 ELF image' }
  }
  const runtimeTarget = workerArch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  workerName ??= 'worker'

  const runtimeEntry = files.find(file => file.type === 'file'
    && file.path.endsWith('.js')
    && file.data?.toString('utf8').includes('export const PLATFORMS = Object.freeze(['))
  if (runtimeEntry === undefined) {
    const manifestEntry = byPath.get('package.json')
    let manifest
    try { manifest = manifestEntry?.data === undefined ? undefined : JSON.parse(manifestEntry.data.toString('utf8')) } catch { manifest = undefined }
    const main = typeof manifest?.main === 'string' ? manifest.main.replace(/^\.\//, '') : undefined
    const hasMain = main !== undefined && files.some(file => file.path === main)
    const buildScript = typeof manifest?.scripts?.build === 'string'
      ? manifest.scripts.build
      : typeof manifest?.scripts?.prepack === 'string' ? manifest.scripts.prepack : undefined
    if (!hasMain && buildScript !== undefined) {
      return {
        status: 'needs-build',
        sourcePackage: true,
        message: `${packageName} is a source package (main ${main ?? '<missing>'} is absent, build script ${JSON.stringify(buildScript)}); build it outside DSHM, then pass the produced tarball to compat_convert`,
        build: {
          command: 'npm ci && npm run build && npm pack',
          output: 'the produced .tgz',
          then: 'compat_convert { spec: "<produced.tgz>" }',
        },
      }
    }
    return { status: 'recipe-mismatch', message: `${packageName} has no JS file exposing the PLATFORMS matrix` }
  }
  const runtime = runtimeEntry.data.toString('utf8')
  const platformsMatch = runtime.match(/export const PLATFORMS = Object\.freeze\(\[([^\]]*)\]\)/)
  const platforms = platformsMatch[1]
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(item => item !== '')
  if (!platforms.includes(runtimeTarget)) platforms.push(runtimeTarget)
  const platformLine = `export const PLATFORMS = Object.freeze([${platforms.map(item => `'${item}'`).join(', ')}])`
  const targetHelper = "\nconst resolveTarget = (platform, arch) => (platform === 'openharmony' || (platform === 'linux' && arch === 'arm64')) ? '" + runtimeTarget + "' : `${platform}-${arch}`\n"
  let patchedRuntime = runtime.replaceAll('${platform}-${arch}', '${resolveTarget(platform, arch)}')
  patchedRuntime = patchedRuntime.replace(platformsMatch[0], `${platformLine}${targetHelper}`)
  const signature = 'export function resolveWorker(config = {}, { packageRoot = PACKAGE_ROOT, env = process.env, platform = process.platform, arch = process.arch } = {}) {'
  if (!patchedRuntime.includes(signature)) return { status: 'recipe-mismatch', message: 'resolveWorker signature changed' }

  const patchedSources = new Map()
  for (const file of files) {
    if (file.type !== 'file' || !file.path.endsWith('.js') || file.data === undefined) continue
    let text = file.data.toString('utf8')
    const before = text
    text = text
      .replaceAll('const argv = [file]', "const argv = ['bash', file]")
      .replaceAll('let argv = [file]', "let argv = ['bash', file]")
      .replaceAll("[file, '-c', command]", "['bash', '-c', command]")
      .replaceAll('[file, scriptPath]', "['bash', scriptPath]")
    if (text !== before) patchedSources.set(file.path, text)
  }
  if (patchedSources.size === 0) {
    return { status: 'recipe-mismatch', message: `${packageName} has no standard native worker spawn (const/let argv = [file])` }
  }

  const pkgFile = byPath.get('package.json')
  if (pkgFile?.data === undefined) return { status: 'invalid-package', message: 'package.json is missing' }
  const pkg = JSON.parse(pkgFile.data.toString('utf8'))
  delete pkg.os
  delete pkg.cpu
  if (pkg.engines !== null && typeof pkg.engines === 'object' && !Array.isArray(pkg.engines)) {
    delete pkg.engines.dsh
    if (Object.keys(pkg.engines).length === 0) delete pkg.engines
  }
  // DSHM core is a prerelease (e.g. 0.2.1-alpha.4+dshm.56). The upstream
  // ^0.2.0-rc.2 range does not match 0.2.1-*, and the bundle loader would throw
  // on the next boot. "workspace:*" follows the running core instead.
  if (pkg.peerDependencies !== null && typeof pkg.peerDependencies === 'object' && !Array.isArray(pkg.peerDependencies)) {
    if (typeof pkg.peerDependencies['@deepseek-ai/dsh'] === 'string') {
      pkg.peerDependencies['@deepseek-ai/dsh'] = 'workspace:*'
    }
  }
  if (pkg.optionalDependencies !== null && typeof pkg.optionalDependencies === 'object') {
    for (const name of Object.keys(pkg.optionalDependencies)) {
      if (/(?:^|[-/])(?:win32|darwin)(?:[-/]|$)/i.test(name)) delete pkg.optionalDependencies[name]
    }
  }

  const pluginFile = byPath.get('dsh-plugin.json')
  if (pluginFile?.data !== undefined) {
    const manifest = JSON.parse(pluginFile.data.toString('utf8'))
    const components = manifest?.contributes?.['x-components']
    if (Array.isArray(components)) {
      for (const component of components) {
        if (component === null || typeof component !== 'object') continue
        if (Array.isArray(component.platforms) && !component.platforms.includes('openharmony')) component.platforms.push('openharmony')
        if (Array.isArray(component.targets) && !component.targets.includes(runtimeTarget)) component.targets.push(runtimeTarget)
        if (Array.isArray(component.architectures) && !component.architectures.includes('arm64')) component.architectures.push('arm64')
      }
    }
    pluginFile.data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  const runtimeDir = `runtime/${runtimeTarget}`
  const workerPath = `${runtimeDir}/${workerName}`
  const provenancePath = `${runtimeDir}/provenance.json`
  /** @type {{ path: string, data: Buffer, mode?: number }[]} */
  const extraEntries = []
  let stagedWorker
  let workerSource
  try {
    const hostFilesLink = [
      '# DSHM host app-files prefix -> guest 9p mount',
      'if [ -d /mnt/share ] && [ ! -e /data/storage/el2/base/haps/entry/files ] && [ ! -L /data/storage/el2/base/haps/entry/files ]; then',
      '  mkdir -p /data/storage/el2/base/haps/entry 2>/dev/null || true',
      '  ln -s /mnt/share /data/storage/el2/base/haps/entry/files 2>/dev/null || true',
      'fi',
    ]
    if (workerArch === 'x64') {
      const realName = `${workerName}-x64`
      stagedWorker = Buffer.from([
        '#!/bin/sh',
        'set -e',
        ...hostFilesLink,
        'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'ROOTFS="$DIR/rootfs"',
        'if mkdir -p /lib64 /lib/x86_64-linux-gnu 2>/dev/null \\',
        '   && cp -f "$ROOTFS/lib64/ld-linux-x86-64.so.2" /lib64/ld-linux-x86-64.so.2 2>/dev/null \\',
        '   && cp -f "$ROOTFS/lib/x86_64-linux-gnu/libc.so.6" /lib/x86_64-linux-gnu/libc.so.6 2>/dev/null \\',
        '   && cp -f "$ROOTFS/lib/x86_64-linux-gnu/libgcc_s.so.1" /lib/x86_64-linux-gnu/libgcc_s.so.1 2>/dev/null \\',
        '   && cp -f "$ROOTFS/lib/x86_64-linux-gnu/libm.so.6" /lib/x86_64-linux-gnu/libm.so.6 2>/dev/null; then',
        '  ln -sf libc.so.6 /lib/x86_64-linux-gnu/libpthread.so.0 2>/dev/null || true',
        '  ln -sf libc.so.6 /lib/x86_64-linux-gnu/libdl.so.2 2>/dev/null || true',
        '  ln -sf libc.so.6 /lib/x86_64-linux-gnu/librt.so.1 2>/dev/null || true',
        `  exec "$DIR/qemu-x86_64" -E "LD_PRELOAD=$ROOTFS/lib/x86_64-linux-gnu/libdshmchmod.so" "$DIR/${realName}" "$@"`,
        'fi',
        'for d in storage mnt data; do [ -e "$ROOTFS/$d" ] || ln -s "/$d" "$ROOTFS/$d" 2>/dev/null || true; done',
        `exec "$DIR/qemu-x86_64" -E "LD_PRELOAD=$ROOTFS/lib/x86_64-linux-gnu/libdshmchmod.so" -L "$ROOTFS" "$DIR/${realName}" "$@"`,
        '',
      ].join('\n'))
      workerSource = 'x86_64 worker executed through the bundled qemu-x86_64 and glibc rootfs'
      extraEntries.push({ path: `${runtimeDir}/${realName}`, data: workerBinary, mode: 0o755 })
      extraEntries.push({ path: `${runtimeDir}/qemu-x86_64`, data: readFileSync(join(QEMU_ROOT, 'qemu-x86_64')), mode: 0o755 })
      extraEntries.push({ path: `${runtimeDir}/rootfs/lib64/ld-linux-x86-64.so.2`, data: readFileSync(join(QEMU_ROOT, 'rootfs', 'lib64', 'ld-linux-x86-64.so.2')), mode: 0o644 })
      extraEntries.push({ path: `${runtimeDir}/rootfs/lib/x86_64-linux-gnu/libc.so.6`, data: readFileSync(join(QEMU_ROOT, 'rootfs', 'lib', 'x86_64-linux-gnu', 'libc.so.6')), mode: 0o644 })
      extraEntries.push({ path: `${runtimeDir}/rootfs/lib/x86_64-linux-gnu/libgcc_s.so.1`, data: readFileSync(join(QEMU_ROOT, 'rootfs', 'lib', 'x86_64-linux-gnu', 'libgcc_s.so.1')), mode: 0o644 })
      extraEntries.push({ path: `${runtimeDir}/rootfs/lib/x86_64-linux-gnu/libm.so.6`, data: readFileSync(join(QEMU_ROOT, 'rootfs', 'lib', 'x86_64-linux-gnu', 'libm.so.6')), mode: 0o644 })
      extraEntries.push({ path: `${runtimeDir}/rootfs/lib/x86_64-linux-gnu/libdshmchmod.so`, data: readFileSync(join(QEMU_ROOT, 'rootfs', 'lib', 'x86_64-linux-gnu', 'libdshmchmod.so')), mode: 0o755 })
    } else {
      const realName = `${workerName}-bin`
      stagedWorker = Buffer.from([
        '#!/bin/sh',
        'set -e',
        ...hostFilesLink,
        'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        `exec "$DIR/${realName}" "$@"`,
        '',
      ].join('\n'))
      workerSource = 'external aarch64-unknown-linux-musl build supplied by the caller'
      extraEntries.push({ path: `${runtimeDir}/${realName}`, data: workerBinary, mode: 0o755 })
    }
  } catch (error) {
    return { status: 'invalid-output', error: `cannot stage the native worker wrapper: ${String(error?.message ?? error)}` }
  }
  const sha256 = createHash('sha256').update(stagedWorker).digest('hex')
  const provenance = {
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    target: runtimeTarget,
    executable: workerName,
    sha256,
    source: workerSource,
  }

  /** @type {string[]} */
  const changed = [
    `added ${runtimeTarget} to PLATFORMS and mapped openharmony/arm64 to it`,
    `rewrote ${patchedSources.size} native worker spawn(s) to ['bash', file] so dshm-vm-bash preserves argv`,
    'removed package.json os/cpu gates and non-Linux optional payloads',
    'removed engines.dsh when present so the DSHM bundle loader does not reject the prerelease core',
    'relaxed @deepseek-ai/dsh peer range to workspace:* for the DSHM core',
    `added dsh-plugin.json openharmony/${runtimeTarget} targets`,
    ...(acquiredAsset === undefined ? [] : [`acquired ${workerName} from GitHub release asset ${acquiredAsset}`]),
    workerArch === 'x64'
      ? `staged ${workerName} as a shell wrapper over qemu-x86_64 + glibc rootfs`
      : `staged ${workerName} as a shell wrapper over ${workerName}-bin`,
    'mapped /data/storage/el2/base/haps/entry/files to the guest /mnt/share mount',
    ...(workerArch === 'x64' ? ['loaded a chmod/fchmod EPERM compatibility shim in the guest'] : []),
  ]

  const output = files.filter(file => file.path !== workerPath).map(file => {
    if (file.path === runtimeEntry.path) return { path: file.path, data: Buffer.from(patchedRuntime, 'utf8'), mode: file.mode }
    if (patchedSources.has(file.path)) return { path: file.path, data: Buffer.from(patchedSources.get(file.path), 'utf8'), mode: file.mode }
    if (file.path === 'package.json') return { path: file.path, data: Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`, 'utf8'), mode: file.mode }
    return { path: file.path, data: file.data, mode: file.mode }
  })
  output.push({ path: workerPath, data: stagedWorker, mode: 0o755 })
  output.push(...extraEntries)
  output.push({ path: provenancePath, data: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8'), mode: 0o644 })

  const packed = packTarGz(output)
  const outputDir = join(compatDir(process.env), 'builds')
  mkdirSync(outputDir, { recursive: true })
  const safeName = String(packageName).replace(/^@/, '').replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_')
  const tarball = join(outputDir, `${safeName}-${pkg.version ?? '0.0.0'}-dshm.tgz`)
  writeFileSync(tarball, packed)
  const validation = validateTarball(tarball)
  if (!validation.ok) return { status: 'invalid-output', tarball, errors: validation.errors }
  return {
    status: 'ok',
    tarball,
    bytes: packed.length,
    sha256: createHash('sha256').update(packed).digest('hex'),
    changed,
    warnings: [
      ...(workerArch === 'x64' ? ['the worker runs under QEMU; no-follow stat on 9p mountpoints can return ELOOP. Prefer an AArch64 worker when one is available.'] : []),
      ...(validation.warnings ?? []),
    ],
    validation,
    worker: { target: workerArch === 'arm64' ? TARGET : 'x86_64-linux-gnu', arch: workerArch, sha256 },
    ...(acquisition?.ok === true ? { acquisition: { asset: acquisition.asset, sha256: acquisition.sha256 } } : {}),
  }
}

