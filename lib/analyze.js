/**
 * Compatibility analyzer for DSH plugins aimed at HarmonyOS DSHM.
 *
 * The analyzer is deliberately read-only: it downloads a package archive,
 * inspects its files and manifests, and returns a classification plus the next
 * action. No install script is executed and nothing is written into a profile.
 *
 * Strategy codes:
 *   S0 - pure JS/TS: code-level conversion on the host
 *   S1 - known native dependencies with an OHOS/JS substitute
 *   S2 - native binaries or shell commands: guest Alpine sidecar
 *   S3 - source-available native: WASM or remote build
 *   S4 - unsupported: e.g. a win32-only binary with no source
 *
 * @module dshm-compat/analyze
 */
import { createHash } from 'node:crypto'
import { checkDependencies } from './core.js'
import { isScannableSource, scanText, summariseHostRisk } from './host-risk.js'
import { hostReach } from './reach.js'
import { lookupPackageRule } from './rules.js'
import { findRootPrefix, extractTar } from './tar.js'
import { loadArchive, resolveSpec } from './fetch.js'

/** Runtime dependencies that are native or install a native payload. */
const KNOWN_NATIVE = {
  'sharp': { ohos: '@ohos-ports/sharp', note: 'DSHM already ships an OpenHarmony port' },
  'node-pty': { ohos: '@ohos-ports/node-pty', note: 'DSHM already ships an OpenHarmony port' },
  'koffi': { ohos: '@ohos-ports/koffi', note: 'DSHM already ships an OpenHarmony port' },
  'better-sqlite3': { js: 'node:sqlite', note: 'Node 24 ships node:sqlite; behavior differs' },
  'sqlite3': { js: 'node:sqlite', note: 'Node 24 ships node:sqlite; behavior differs' },
  'canvas': { js: '@napi-rs/canvas / pure JS fallback', note: 'no OHOS build in the package' },
  'bcrypt': { js: 'bcryptjs', note: 'pure-JS replacement' },
  'argon2': { js: 'hash-wasm', note: 'WASM replacement' },
  'esbuild': { js: 'esbuild-wasm', note: 'WASM replacement' },
  'node-gyp': { build: true, note: 'requires a C/C++ toolchain' },
  'prebuild-install': { build: true, note: 'downloads a prebuilt native binary' },
  'node-pre-gyp': { build: true, note: 'downloads or builds a native binary' },
  '@napi-rs/canvas': { js: 'WASM/JS fallback', note: 'native N-API package' },
}

const NATIVE_EXTENSIONS = new Set(['.node', '.so', '.dll', '.dylib', '.exe', '.wasm'])
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json'])
const SCAN_FILE_LIMIT = 512 * 1024
const SCAN_TOTAL_LIMIT = 32 * 1024 * 1024
const SCAN_SAMPLE_LIMIT = 5

/** @param {string} path */
function extname(path) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {unknown} value */
function stringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

/** @param {string} text @param {RegExp} pattern */
function countMatches(text, pattern) {
  const matches = text.match(pattern)
  return matches === null ? 0 : matches.length
}

/** @param {{ path: string, data?: Buffer, size: number }} file */
function isProbablyText(file) {
  if (file.data === undefined) return false
  const probe = file.data.subarray(0, Math.min(file.data.length, 4096))
  return !probe.includes(0)
}

/**
 * Pick the package root: an archive-level top directory is stripped by the tar
 * reader, then the shallowest package.json wins (handles monorepo subpackages).
 *
 * @param {import('./tar.js').TarEntry[]} entries
 */
function selectPackageRoot(entries) {
  const files = entries.filter(entry => entry.type === 'file')
  const candidates = files
    .filter(entry => entry.path === 'package.json' || entry.path.endsWith('/package.json'))
    .map(entry => ({ dir: entry.path === 'package.json' ? '' : entry.path.slice(0, -'/package.json'.length), depth: entry.path.split('/').length }))
    .sort((a, b) => a.depth - b.depth)
  if (candidates.length === 0) return { dir: '', packageFile: undefined }
  const root = candidates[0]
  return { dir: root.dir === '' ? '' : `${root.dir}/`, packageFile: `${root.dir}/package.json` }
}

/**
 * Strip comments (block + line), leaving `://` inside string literals alone.
 * Shared by the Electron counters so large files are stripped once, not twice.
 * @param {string} text
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

/**
 * Remove `try { … }` blocks from comment-stripped text, then count real Electron
 * API imports.
 *
 * The raw count read `dsh-pet` as "needs Electron" from three non-uses: the string
 * `require('electron')` inside doc comments, the same string in a `.d.ts`/test files,
 * and — the only live one — a `try { require('electron') } catch` **probe** that
 * resolves the desktop binary and degrades to pure Node when absent. A probe that is
 * designed to fail silently is the opposite of a hard dependency.
 *
 * @param {string} text comment-stripped source (see `stripComments`)
 */
function electronHardImports(text) {
  let stripped = text
  let out = ''
  let rest = stripped
  for (;;) {
    const start = rest.search(/\btry\s*\{/)
    if (start === -1) { out += rest; break }
    out += rest.slice(0, start)
    const open = rest.indexOf('{', start)
    let depth = 0
    let cursor = open
    for (; cursor < rest.length; cursor += 1) {
      if (rest[cursor] === '{') depth += 1
      else if (rest[cursor] === '}') {
        depth -= 1
        if (depth === 0) { cursor += 1; break }
      }
    }
    rest = rest.slice(cursor)
  }
  return (out.match(/(?:require\(\s*['"]electron['"]\)|from\s+['"]electron['"]|process\.electronBinding)/g) ?? []).length
}

/**
 * @param {string} spec
 * @param {{ registry?: string, signal?: AbortSignal, maxBytes?: number, textScan?: boolean, cacheDir?: string }} [options]
 */
export async function analyze(spec, options = {}) {
  const resolved = await resolveSpec(spec, { registry: options.registry, signal: options.signal })
  const archive = await loadArchive(resolved, { maxBytes: options.maxBytes, signal: options.signal, cacheDir: options.cacheDir })
  const { entries, totalBytes, truncated } = extractTar(archive)
  const archivePrefix = findRootPrefix(entries)
  const topEntries = entries.map(entry => ({
    ...entry,
    path: archivePrefix !== '' && entry.path.startsWith(archivePrefix) ? entry.path.slice(archivePrefix.length) : entry.path,
  }))
  /*
   * `github:owner/repo#ref&path:/sub` (npm's workspace form) asks for a subtree, not
   * the repository root. Without narrowing here the analyzer reads the root manifest
   * and reports on a package the user is not installing.
   */
  const scoped = typeof resolved?.subdir === 'string' && resolved.subdir !== ''
    ? topEntries
        .filter(entry => entry.path.startsWith(`${resolved.subdir}/`))
        .map(entry => ({ ...entry, path: entry.path.slice(resolved.subdir.length + 1) }))
    : topEntries
  const { dir, packageFile } = selectPackageRoot(scoped)
  const files = scoped
    .filter(entry => entry.type === 'file' && entry.path.startsWith(dir))
    .map(entry => ({ ...entry, path: entry.path.slice(dir.length) }))

  /** @type {Buffer | undefined} */
  let packageText
  const packageEntry = packageFile === undefined ? undefined : files.find(file => file.path === 'package.json')
  if (packageEntry?.data !== undefined) packageText = packageEntry.data
  let packageJson
  let packageError
  if (packageText !== undefined) {
    try { packageJson = JSON.parse(packageText.toString('utf8')) } catch (error) { packageError = String(error?.message ?? error) }
  }

  const manifestEntry = files.find(file => file.path === 'dsh-plugin.json')
  let manifest
  let manifestError
  if (manifestEntry?.data !== undefined) {
    try { manifest = JSON.parse(manifestEntry.data.toString('utf8')) } catch (error) { manifestError = String(error?.message ?? error) }
  }

  const pkg = record(packageJson)
  const dsh = pkg === undefined ? undefined : record(pkg.dsh)
  const scripts = pkg === undefined ? undefined : record(pkg.scripts)
  const dependencies = new Set([
    ...Object.keys(record(pkg?.dependencies) ?? {}),
    ...Object.keys(record(pkg?.optionalDependencies) ?? {}),
    ...Object.keys(record(pkg?.peerDependencies) ?? {}),
  ])
  const installScripts = {}
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (typeof scripts?.[name] === 'string') installScripts[name] = scripts[name]
  }

  const nativeFiles = []
  const packageFiles = []
  /*
   * Host-risk scans only what the bundle can load. The reach walk starts from the
   * package entry, the client half and each enabled patch row, and follows the
   * package's own imports — so Skill bundles (`bundledSkillDir` assets), MCP server
   * subprocesses and `disabled: true` rows drop out by construction instead of by
   * directory-name guesswork. No resolvable entry ⇒ fellBack and the old
   * path-based selection applies; reachability narrows the scan, never a miss.
   */
  const reach = hostReach(files, { pkg })
  /** @type {{ path: string, kind: string, fatal: boolean, line: number, why: string, snippet: string }[]} */
  const hostFindings = []
  let scannedBytes = 0
  const scan = {
    files: 0,
    truncated: false,
    processPlatform: 0,
    win32: 0,
    darwin: 0,
    linux: 0,
    childProcess: 0,
    spawn: 0,
    exec: 0,
    electron: 0,
    browserWindow: 0,
    dlopen: 0,
    samples: { processPlatform: [], win32: [], childProcess: [], electron: [] },
  }

  for (const file of files) {
    const extension = extname(file.path)
    if (NATIVE_EXTENSIONS.has(extension) || file.path.endsWith('/binding.gyp') || file.path.startsWith('prebuilds/')) {
      nativeFiles.push({ path: file.path, size: file.size, extension: extension || 'gyp' })
    }
    if (extension === '.json' && file.path !== 'package.json' && file.path !== 'dsh-plugin.json') {
      packageFiles.push(file.path)
    }
    if (options.textScan === false) continue
    if (!TEXT_EXTENSIONS.has(extension) || file.data === undefined) continue
    if (file.size > SCAN_FILE_LIMIT || scannedBytes + file.size > SCAN_TOTAL_LIMIT) { scan.truncated = true; continue }
    if (!isProbablyText(file)) continue
    const text = file.data.toString('utf8')
    scannedBytes += file.size
    const ownSource = isScannableSource(file.path)
    if (ownSource) {
      /*
       * Scan every own-source file, then classify each finding by reachability.
       * A finding in a host-reachable file counts at full weight; one in a file
       * the entries cannot reach (skill CLIs, server subprocesses, disabled rows)
       * is downgraded to a hint instead of vanishing — if the reach walk is ever
       * wrong about a loader convention, the pattern still surfaces, just without
       * blocking the install. Silence would be the one unrecoverable failure mode.
       */
      const inReach = reach.fellBack || reach.files.has(file.path)
      for (const finding of scanText(text, file.path)) {
        hostFindings.push(inReach === true ? finding : { ...finding, fatal: false, why: `${finding.why}（宿主入口不可达，已降级为提示）` })
      }
    }
    scan.files += 1
    for (const [key, pattern] of [
      ['processPlatform', /process\.platform/g],
      ['win32', /\bwin32\b/g],
      ['darwin', /\bdarwin\b/g],
      ['linux', /\blinux\b/g],
      ['childProcess', /child_process/g],
      ['spawn', /\.spawn\s*\(/g],
      ['exec', /\.exec\s*\(/g],
      // `browserWindow` moved next to electron below: both are Electron-API signals and
      // both must ignore comments and optional probes (see electronHardImports).
      ['dlopen', /process\.dlopen|\.node['"]/g],
    ]) {
      const count = countMatches(text, pattern)
      if (count === 0) continue
      scan[key] += count
      if (scan.samples[key] !== undefined && scan.samples[key].length < SCAN_SAMPLE_LIMIT) scan.samples[key].push(file.path)
    }
    if (ownSource) {
      // Strip once, share between the two Electron-side counters — on a large
      // plugin this halves the regex work on its biggest source files.
      const stripped = stripComments(text)
      scan.electron += electronHardImports(stripped)
      // `BrowserWindow` in a doc comment is not a window.
      scan.browserWindow += (stripped.match(/BrowserWindow/g) ?? []).length
    }
  }

  const nativeDeps = [...dependencies]
    .filter(name => KNOWN_NATIVE[name] !== undefined)
    .map(name => ({ name, ...KNOWN_NATIVE[name] }))
  const dependencyCheck = checkDependencies(pkg, options.env ?? process.env)
  const unknownNativeDeps = nativeDeps.filter(dep => dep.ohos === undefined && dep.js === undefined && dep.build !== true)
  /*
   * os/cpu gates, same reading as market.js quickSignals: npm allows `*` and the
   * DSHM host runs linux/arm64, so a gate blocks only when it excludes BOTH the
   * host target and the wildcard. Missing field = no gate, never a block.
   */
  const platformBlocked = pkg !== undefined && (
    (Array.isArray(pkg.os) && !pkg.os.includes('linux') && !pkg.os.includes('openharmony') && !pkg.os.includes('*'))
    || (Array.isArray(pkg.cpu) && !pkg.cpu.includes('arm64') && !pkg.cpu.includes('*'))
  )
  const hasDsh = dsh !== undefined && (record(dsh.bundle) !== undefined || record(dsh.client) !== undefined)
  const client = record(dsh?.client)
  const targets = []
  if (manifest !== undefined && manifest !== null && typeof manifest === 'object' && Array.isArray(manifest.contributes?.['x-components'])) {
    for (const component of manifest.contributes['x-components']) {
      if (record(component) === undefined) continue
      targets.push({
        id: typeof component.id === 'string' ? component.id : undefined,
        platforms: stringArray(component.platforms),
        architectures: stringArray(component.architectures),
        targets: stringArray(component.targets),
      })
    }
  }

  const hasWin32OnlyPayload = nativeFiles.length > 0
    && nativeFiles.every(file => /(?:^|\/)win32-|\.exe$|\.dll$/i.test(file.path))
  const hasNativeSource = files.some(file => (
    file.path === 'native/Cargo.toml'
    || file.path.endsWith('/Cargo.toml')
    || file.path === 'binding.gyp'
    || /(?:^|\/)native\/src\//.test(file.path)
    || /(?:^|\/)src\/.+\.(?:c|cc|cpp|h|hpp|rs)$/.test(file.path)
  ))
  const hasLifecycle = ['preinstall', 'install', 'postinstall'].some(name => typeof scripts?.[name] === 'string')
  const entryCandidates = [
    typeof pkg?.main === 'string' ? pkg.main : undefined,
    typeof dsh?.bundle?.patch === 'string' ? dsh.bundle.patch : undefined,
    typeof pkg?.exports === 'object' && pkg.exports !== null ? pkg.exports['./client'] : undefined,
  ].filter(value => typeof value === 'string').map(value => value.replace(/^\.\//, ''))
  const missingEntries = entryCandidates.filter(entry => !files.some(file => file.path === entry))
  const prepareNeedsBuild = typeof scripts?.prepare === 'string' && missingEntries.length > 0
  const needsBuild = hasLifecycle || prepareNeedsBuild
  const electronSurface = scan.electron > 0 || scan.browserWindow > 0

  let strategy
  let confidence = 'medium'
  const reasons = []
  const next = []

  if (hasWin32OnlyPayload && !hasNativeSource) {
    strategy = 'S4'
    confidence = 'high'
    reasons.push('the archive carries only win32 payloads and no C/C++/Rust source to rebuild')
    next.push('ask the plugin author for source or a linux-arm64 build')
  } else if (nativeFiles.length > 0 || unknownNativeDeps.length > 0 || electronSurface || hasNativeSource) {
    strategy = 'S2'
    confidence = 'medium'
    if (nativeFiles.length > 0) reasons.push(`${nativeFiles.length} native file(s) need a linux-arm64 runtime outside the DSHM host process`)
    if (hasNativeSource && nativeFiles.length === 0) reasons.push('native source needs a Linux/guest build; no prebuilt runtime is present')
    if (unknownNativeDeps.length > 0) reasons.push(`unrecognized native dependencies: ${unknownNativeDeps.map(dep => dep.name).join(', ')}`)
    if (Object.keys(installScripts).length > 0) reasons.push(`install scripts: ${Object.keys(installScripts).join(', ')}`)
    if (electronSurface) reasons.push(`Electron API surface detected (${scan.electron} reference(s)); needs a shim or a sidecar UI`)
    next.push('run the plugin in the Alpine guest sidecar and expose its tools through RPC')
    if (electronSurface) next.push('apply the Electron API shim for app/shell/dialog/clipboard/ipc')
  } else if (nativeDeps.length > 0) {
    strategy = 'S1'
    confidence = 'medium'
    reasons.push(`native dependencies have known substitutes: ${nativeDeps.map(dep => dep.name).join(', ')}`)
    next.push(`substitute ${nativeDeps.map(dep => `${dep.name} -> ${dep.ohos ?? dep.js}`).join(', ')}`)
  } else if (needsBuild) {
    strategy = 'S0'
    confidence = 'medium'
    reasons.push(prepareNeedsBuild
      ? `prepare script is required because built entry files are missing: ${missingEntries.join(', ')}`
      : `install lifecycle script(s): ${Object.keys(installScripts).join(', ')}`)
    next.push('run the pure-JS build recipe in a controlled Node worker, then bundle and pack')
  } else {
    strategy = 'S0'
    confidence = 'high'
    reasons.push('no blocking native files, native dependencies, or install lifecycle scripts found')
    if (typeof scripts?.prepare === 'string') reasons.push('prepare script is present but its built entry files already exist; a registry tarball does not need to run it')
    next.push('rewrite package.json, bundle host/client code, pack and install')
  }

  if (platformBlocked) {
    reasons.push('package.json os/cpu excludes a Linux/arm64 target; the manifest must be rewritten')
    if (strategy === 'S0') confidence = 'medium'
  }
  if (dependencyCheck.missing.length > 0) {
    reasons.push(`runtime dependencies not present in the DSHM core: ${dependencyCheck.missing.slice(0, 30).join(', ')}; vendor or bundle them before install`)
    if (strategy === 'S0') confidence = 'medium'
  }
  if (dependencyCheck.core.available === false && Object.keys(dependencyCheck.dependencies).length > 0) {
    reasons.push(`DSHM core inventory unavailable (${dependencyCheck.core.reason}); dependency availability is unverified`)
  }
  if (unknownNativeDeps.length > 0) {
    reasons.push(`unrecognized native dependency: ${unknownNativeDeps.map(dep => dep.name).join(', ')}`)
    confidence = 'low'
  }
  if (truncated) {
    reasons.push('archive was truncated by the safety limit; the report may be incomplete')
    confidence = 'low'
  }
  if (packageError !== undefined) {
    reasons.push(`package.json could not be parsed: ${packageError}`)
    confidence = 'low'
  }

  const rule = lookupPackageRule(typeof pkg?.name === 'string' ? pkg.name : undefined, options.env ?? process.env)
  if (rule !== undefined) {
    strategy = rule.strategy
    confidence = 'high'
    reasons.push(`package rule: ${rule.reason}`)
    for (const step of rule.next) if (!next.includes(step)) next.push(step)
  }

  const fingerprint = createHash('sha256')
    .update(`${resolved.kind}\0${resolved.name}\0${resolved.version}\0${archive.length}`)
    .digest('hex')

  return {
    spec: String(spec),
    fingerprint,
    resolved: {
      kind: resolved.kind,
      name: resolved.name,
      requested: resolved.requested,
      version: resolved.version,
      approximated: resolved.approximated ?? false,
      tarball: resolved.tarballUrl,
      archiveBytes: archive.length,
      // Where the bytes came from and what they cost — so a slow run reads as
      // "network", not as a property of the plugin (0.1.33 device review).
      ...(resolved.downloadMs === undefined ? {} : {
        downloadMs: resolved.downloadMs,
        downloadBytes: resolved.downloadBytes,
        downloadSource: resolved.downloadSource,
      }),
    },
    package: pkg === undefined ? undefined : {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      type: pkg.type,
      main: pkg.main,
      repository: pkg.repository,
      homepage: pkg.homepage,
      bugs: pkg.bugs,
      os: pkg.os,
      cpu: pkg.cpu,
      scripts,
      dependencies: pkg.dependencies,
      optionalDependencies: pkg.optionalDependencies,
      peerDependencies: pkg.peerDependencies,
      dsh,
      bin: pkg.bin,
    },
    manifest: manifest === undefined ? undefined : {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      targets,
    },
    files: {
      count: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      native: nativeFiles.slice(0, 100),
      json: packageFiles.slice(0, 50),
      truncated,
    },
    signals: {
      hasDsh,
      hostEntry: hasDsh ? (typeof dsh?.bundle?.patch === 'string' ? dsh.bundle.patch : 'inferred from main') : undefined,
      client: client === undefined ? undefined : {
        platform: client.platform,
        inject: stringArray(client.inject),
        external: stringArray(client.external),
      },
      hostRisk: summariseHostRisk(hostFindings, { scanned: scan.files, truncated: scan.truncated }),
      nativeDeps,
      unknownNativeDeps: unknownNativeDeps.map(dep => dep.name),
      nativeSource: hasNativeSource,
      rustSource: files.some(file => /(?:^|\/)Cargo\.toml$/.test(file.path) || /\.rs$/.test(file.path)),
      cSource: files.some(file => /\.(?:c|cc|cpp)$/.test(file.path)),
      nodeGyp: files.some(file => /(?:^|\/)binding\.gyp$/.test(file.path)),
      dependencies: {
        core: dependencyCheck.core,
        present: dependencyCheck.present.slice(0, 100),
        missing: dependencyCheck.missing.slice(0, 100),
        optionalMissing: (dependencyCheck.optionalMissing ?? []).slice(0, 100),
        unknown: dependencyCheck.unknown,
      },
      installScripts,
      platformBlocked,
      scan,
      electronSurface,
    },
    strategy,
    confidence,
    rule: rule === undefined ? undefined : { strategy: rule.strategy, reason: rule.reason, nativeBuild: rule.nativeBuild },
    reasons,
    next,
  }
}
