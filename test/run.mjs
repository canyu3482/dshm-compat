/**
 * Offline regression harness for the compatibility plugin.
 *
 * Run with `node test/run.mjs`. It builds synthetic npm-style tarballs under
 * `_tmp`, so it needs no network and never touches a real DSH profile.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyze } from '../lib/analyze.js'
import { auditAssets, repairAssetNames, repairedName, scanAssetNames } from '../lib/asset-names.js'
import { scan } from '../lib/batch.js'
import { convert } from '../lib/convert.js'
import { runDoctor } from '../lib/doctor.js'
import { archiveCachePlan, defaultRegistry, loadArchive, resolveSpec, parseGithubSpec } from '../lib/fetch.js'
import { probeGuest, provisionGuest, runGuestFile } from '../lib/guest.js'
import { enqueueInstall } from '../lib/install.js'
import { installLocalTarball } from '../lib/local-install.js'
import { uninstallLocalPackage } from '../lib/uninstall.js'
import { buildPlan } from '../lib/plan.js'
import { convertS2Native } from '../lib/s2-native.js'
import { callSidecar, listSidecars, stageSidecar } from '../lib/sidecar.js'
import { buildSource, detectSourceBuild } from '../lib/source-build.js'
import { PATCH_ID, patchPublicationSources } from '../lib/publish-patch.js'
import { linkPolicyFor, probeLinkSupport, readHostFacts, readHostLogFacts, readHostReady } from '../lib/hostcap.js'
import { marketAdapt, marketBrowse, marketVerdict, verificationStepsFor } from '../lib/market.js'
import { loadCatalog, marketShelf, searchShelf, shelfState } from '../lib/catalog.js'
import { clientServiceNames, compareServices, declaredServices, packageServiceDeps, pendingFromLogs } from '../lib/services.js'
import { SERVICE_SHIMS, shimmableServices } from '../lib/service-shims.js'
import { isScannableSource, scanText, summariseHostRisk } from '../lib/host-risk.js'
import { categoryCounts, compactEntry, dedupeByName, searchIndex } from '../lib/index-source.js'
import { classifyInput, resolveIntake, specFor } from '../lib/intake.js'
import { patchRows } from '../lib/reach.js'
import { retryViaIndex } from '../lib/market.js'
import { guardInstalled, quarantineRow } from '../lib/quarantine.js'
import { probeNative, resolveNeeded } from '../lib/native-probe.js'
import { scanWorker, verdictAdvice } from '../lib/worker-scan.js'
import { applyVerdicts, evaluatePending, listPendingVerify, markPendingVerify } from '../lib/verify.js'
import { vendorDependencies } from '../lib/vendor.js'
import { apply as applyPlugin } from '../index.js'
import { packTarGz } from '../lib/pack.js'
import { PACKAGE_RULES, lookupPackageRule } from '../lib/rules.js'
import { extractTar } from '../lib/tar.js'

const ROOT = 'D:/dsh/dsh-26-09-30/_tmp/dshm-compat-test'
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
process.env.DSHM_COMPAT_DIR = join(ROOT, 'compat')

/** @param {string} path @param {string} text */
function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** @param {string} name @param {Record<string, Buffer | string>} files */
function tarball(name, files) {
  const entries = Object.entries(files).map(([path, data]) => ({
    path,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'),
  }))
  const target = join(ROOT, name)
  writeFileSync(target, packTarGz(entries))
  return target
}

function syntheticPackage(overrides = {}) {
  const pkg = {
    name: 'fixture-js',
    version: '1.0.0',
    main: 'lib/index.js',
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'desktop' },
    },
    scripts: {
      prepare: 'node build.mjs',
      postinstall: 'node postinstall.mjs',
      test: 'node test.mjs',
    },
    os: ['win32'],
    cpu: ['x64'],
    ...overrides,
  }
  return tarball(`${pkg.name}-${pkg.version}.tgz`, {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'cordis.patch.yml': '- insert:\n    - id: fixture-js\n      name: fixture-js\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/client.js': 'export const x = 1\n',
  })
}

function hasUndefined(value) {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.some(hasUndefined)
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasUndefined)
  return false
}

const results = []
/** @param {string} name @param {() => Promise<void> | void} body */
async function test(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error(`FAIL ${name}: ${error?.stack ?? error}`)
  }
}

await test('pure JS package classifies as S0 and converts its manifest', async () => {
  const file = syntheticPackage()
  const report = await analyze(file, { textScan: false })
  assert.equal(report.strategy, 'S0')
  assert.equal(report.signals.client.platform, 'desktop')
  assert.deepEqual(report.signals.installScripts, { prepare: 'node build.mjs', postinstall: 'node postinstall.mjs' })
  const converted = await convert(file, { report })
  assert.equal(converted.status, 'ok')
  assert.ok(converted.tarball.endsWith('.tgz'))
  const { entries } = extractTar(readFileSync(converted.tarball))
  const entry = entries.find(item => item.path === 'package/package.json')
  const pkg = JSON.parse(entry.data.toString('utf8'))
  assert.equal(pkg.os, undefined)
  assert.equal(pkg.cpu, undefined)
  assert.equal(pkg.scripts.prepare, undefined)
  assert.equal(pkg.scripts.postinstall, undefined)
  assert.equal(pkg.scripts.test, 'node test.mjs')
  assert.equal(pkg.dsh.client.platform, 'web')
})

await test('win32 binary with source classifies as S2', async () => {
  const file = tarball('fixture-native-1.0.0.tgz', {
    'package.json': `${JSON.stringify({ name: 'fixture-native', version: '1.0.0', main: 'lib/index.js' }, null, 2)}\n`,
    'lib/index.js': 'export function apply() {}\n',
    'runtime/win32-x64/worker.exe': Buffer.from('MZ fake binary'),
    'native/src/lib.rs': 'pub fn main() {}\n',
  })
  const report = await analyze(file, { textScan: false })
  assert.equal(report.strategy, 'S2')
  assert.ok(report.files.native.some(item => item.path.endsWith('.exe')))
  assert.ok(report.reasons.some(reason => reason.includes('native file')))
})

await test('win32-only binary without source classifies as S4', async () => {
  const file = tarball('fixture-win32-1.0.0.tgz', {
    'package.json': `${JSON.stringify({ name: 'fixture-win32', version: '1.0.0' }, null, 2)}\n`,
    'runtime/win32-x64/worker.exe': Buffer.from('MZ fake binary'),
  })
  const report = await analyze(file, { textScan: false })
  assert.equal(report.strategy, 'S4')
})

await test('dependency preflight reads a fake DSHM core', async () => {
  const home = join(ROOT, 'home')
  const core = join(home, 'cores', '0.0.1')
  write(join(core, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), '{"name":"@deepseek-ai/dsh-base"}\n')
  write(join(core, 'node_modules', 'foo', 'package.json'), '{"name":"foo"}\n')
  write(join(core, 'dshm-core.json'), '{"coreVersion":"0.0.1"}\n')
  const file = syntheticPackage({
    name: 'fixture-deps',
    version: '1.0.0',
    dependencies: { foo: '1.0.0', bar: '1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  const report = await analyze(file, { textScan: false, env: { DSHM_HOME: home } })
  assert.equal(report.signals.dependencies.core.available, true)
  assert.deepEqual(report.signals.dependencies.present, ['foo'])
  assert.deepEqual(report.signals.dependencies.missing, ['bar'])
})

await test('S1 conversion removes a native dependency backed by the core', async () => {
  const home = join(ROOT, 'home-s1')
  const core = join(home, 'cores', '0.0.1')
  write(join(core, 'node_modules', 'sharp', 'package.json'), '{"name":"sharp","version":"0.34.5"}\n')
  write(join(core, 'dshm-core.json'), '{"coreVersion":"0.0.1"}\n')
  const file = syntheticPackage({
    name: 'fixture-sharp',
    version: '1.0.0',
    dependencies: { sharp: '^0.33.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  const report = await analyze(file, { textScan: false, env: { DSHM_HOME: home } })
  assert.equal(report.strategy, 'S1')
  const converted = await convert(file, { report })
  assert.equal(converted.status, 'ok')
  assert.ok(converted.changed.some(item => item.includes('removed native dependency sharp')))
  const { entries } = extractTar(readFileSync(converted.tarball))
  const entry = entries.find(item => item.path === 'package/package.json')
  const pkg = JSON.parse(entry.data.toString('utf8'))
  assert.equal(pkg.dependencies?.sharp, undefined)
  assert.equal(pkg.dshmCompat.nativeSubstitutions[0].to, '@ohos-ports/sharp')
})

await test('custom registry rules override heuristics', async () => {
  const registry = join(ROOT, 'registry.json')
  writeFileSync(registry, JSON.stringify({
    packages: {
      'fixture-custom': { strategy: 'S4', reason: 'fixture-only unsupported rule', next: ['report to the fixture author'] },
    },
  }))
  const file = syntheticPackage({ name: 'fixture-custom', version: '1.0.0' })
  const report = await analyze(file, { textScan: false, env: { DSHM_COMPAT_REGISTRY: registry } })
  assert.equal(report.strategy, 'S4')
  assert.equal(report.rule.reason, 'fixture-only unsupported rule')
})

await test('plans distinguish S0, S2 and source-driven native builds', async () => {
  const js = syntheticPackage()
  const jsReport = await analyze(js, { textScan: false })
  assert.equal(buildPlan(jsReport).kind, 'manifest-and-bundle')

  const native = tarball('dsh-ops-9.9.9.tgz', {
    'package.json': `${JSON.stringify({ name: 'dsh-ops', version: '9.9.9', main: 'lib/index.js' }, null, 2)}\n`,
    'lib/index.js': 'export function apply() {}\n',
    'runtime/win32-x64/worker.exe': Buffer.from('MZ fake'),
    'native/Cargo.toml': '[package]\nname = "dsh-ops-core"\n',
    'native/src/lib.rs': 'pub fn main() {}\n',
  })
  const nativeReport = await analyze(native, { textScan: false })
  assert.equal(nativeReport.strategy, 'S2')
  const nativePlan = buildPlan(nativeReport)
  assert.equal(nativePlan.kind, 'guest-sidecar')
  assert.equal(nativePlan.nativeBuild.language, 'rust')
  assert.equal(nativePlan.guest.alpine, '3.22')
})

await test('guest probe parses a routed bash result', async () => {
  const output = [
    'DSHM_COMPAT_PROBE_BEGIN',
    'Linux 6.6.0 aarch64',
    '3.22.1',
    '/bin/bash',
    '/sbin/apk',
    '/usr/bin/node',
    '/usr/bin/npm',
    '/usr/bin/python3',
    'DSHM_COMPAT_PROBE_END',
  ].join('\n')
  const handle = {
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text: output }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  }
  const ctx = { get: name => name === 'subprocess' ? { spawn: () => handle } : undefined }
  const result = await probeGuest(ctx)
  assert.equal(result.status, 'ok')
  assert.equal(result.run.bash, true)
  assert.equal(result.run.node, true)
  assert.equal(result.run.alpine, '3.22.1')
})

await test('vendor lays out a transitive dependency tree', async () => {
  const depB = tarball('dep-b-2.0.0.tgz', {
    'package.json': '{"name":"dep-b","version":"2.0.0","main":"index.js"}\n',
    'index.js': 'module.exports = 2\n',
  })
  const depA = tarball('dep-a-1.0.0.tgz', {
    'package.json': '{"name":"dep-a","version":"1.0.0","main":"index.js","dependencies":{"dep-b":"^2.0.0"}}\n',
    'index.js': 'module.exports = 1\n',
  })
  const archives = {
    'dep-a@^1.0.0': { name: 'dep-a', version: '1.0.0', buffer: readFileSync(depA) },
    'dep-b@^2.0.0': { name: 'dep-b', version: '2.0.0', buffer: readFileSync(depB) },
  }
  const result = await vendorDependencies(
    { dependencies: { 'dep-a': '^1.0.0' } },
    { resolve: async spec => archives[spec], load: async resolved => resolved.buffer },
  )
  assert.equal(result.packages.length, 2)
  assert.ok(result.files.some(file => file.path === 'node_modules/dep-a/package.json'))
  assert.ok(result.files.some(file => file.path === 'node_modules/dep-b/package.json'))
})

await test('vendor refuses a native payload', async () => {
  const native = tarball('dep-native-1.0.0.tgz', {
    'package.json': '{"name":"dep-native","version":"1.0.0"}\n',
    'index.js': 'module.exports = 1\n',
    'build/Release/addon.node': Buffer.from('native'),
  })
  const result = await vendorDependencies(
    { dependencies: { 'dep-native': '^1.0.0' } },
    { resolve: async () => ({ name: 'dep-native', version: '1.0.0', buffer: readFileSync(native) }), load: async resolved => resolved.buffer },
  )
  assert.equal(result.packages.length, 0)
  assert.ok(result.warnings.some(warning => warning.includes('native payload')))
})

await test('S0 conversion vendors a missing dependency into the tarball', async () => {
  const dep = tarball('dep-simple-1.0.0.tgz', {
    'package.json': '{"name":"dep-simple","version":"1.0.0","main":"index.js"}\n',
    'index.js': 'module.exports = 1\n',
  })
  const file = syntheticPackage({
    name: 'fixture-vendored',
    version: '1.0.0',
    dependencies: { 'dep-simple': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  const report = await analyze(file, { textScan: false })
  assert.ok(report.signals.dependencies.missing.includes('dep-simple'))
  const converted = await convert(file, {
    report,
    resolve: async () => ({ name: 'dep-simple', version: '1.0.0', buffer: readFileSync(dep) }),
    load: async resolved => resolved.buffer,
  })
  assert.equal(converted.status, 'ok')
  assert.ok(converted.vendored.includes('dep-simple@1.0.0'))
  const { entries } = extractTar(readFileSync(converted.tarball))
  assert.ok(entries.some(entry => entry.path === 'package/node_modules/dep-simple/package.json'))
  const pkg = JSON.parse(entries.find(entry => entry.path === 'package/package.json').data.toString('utf8'))
  assert.equal(pkg.dependencies['dep-simple'], undefined)
})

await test('guest provisioning stays inside the package allowlist', async () => {
  let script = ''
  const handle = {
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text: 'ok\n' }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  }
  const ctx = {
    get: name => name === 'subprocess' ? { spawn: spec => { script = spec.argv[2]; return handle } } : undefined,
  }
  const result = await provisionGuest(ctx, ['nodejs', 'npm'])
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.packages, ['nodejs', 'npm'])
  assert.ok(script.includes('apk add --no-cache nodejs npm'))
  const invalid = await provisionGuest(ctx, ['rm -rf /'])
  assert.equal(invalid.status, 'invalid')
})

await test('install queue rejects option-like specs', async () => {
  process.env.DSHM_COMPAT_QUEUE_DIR = join(ROOT, 'queue-invalid')
  await assert.rejects(() => enqueueInstall('-rf'), error => error.code === 'INVALID_SPEC')
  await assert.rejects(() => enqueueInstall('a\nb'), error => error.code === 'INVALID_SPEC')
})

await test('batch scan counts strategies and isolates failures', async () => {
  const js = syntheticPackage()
  const native = tarball('fixture-native-scan-1.0.0.tgz', {
    'package.json': '{"name":"fixture-native-scan","version":"1.0.0"}\n',
    'runtime/win32-x64/worker.exe': Buffer.from('MZ'),
    'native/src/lib.rs': 'pub fn main() {}\n',
  })
  const result = await scan([js, native, join(ROOT, 'missing.tgz')], { concurrency: 2 })
  assert.equal(result.counts.total, 3)
  assert.equal(result.counts.S0, 1)
  assert.equal(result.counts.S2, 1)
  assert.equal(result.counts.error, 1)
})

await test('guest worker runner passes argv and stdin without shell quoting', async () => {
  let captured
  const handle = {
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text: '{"ok":true}' }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  }
  const ctx = { get: name => name === 'subprocess' ? { spawn: spec => { captured = spec; return handle } } : undefined }
  const result = await runGuestFile(ctx, '/opt/dsh-ops-worker', ['--version'], '{"request":1}')
  assert.equal(result.status, 'ok')
  assert.deepEqual(captured.argv, ['bash', '/opt/dsh-ops-worker', '--version'])
  assert.equal(captured.stdio.stdin.data, '{"request":1}')
})

await test('convert routes an S2 fixture into the generic native adapter', async () => {
  const file = tarball('native-fixture-dispatch-0.3.0.tgz', {
    'package.json': `${JSON.stringify({
      name: 'native-fixture',
      version: '0.3.0',
      main: 'lib/index.js',
      peerDependencies: { '@deepseek-ai/dsh': '^0.2.0-rc.2' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`,
    'cordis.patch.yml': '- insert:\n    - id: native-fixture\n      name: native-fixture\n',
    'lib/index.js': 'export function apply() {}\n',
    'runtime/win32-x64/worker.exe': Buffer.from('MZ fake'),
    'native/Cargo.toml': '[package]\nname = "native-fixture-worker"\n',
  })
  const result = await convert(file, { workerPath: join(ROOT, 'does-not-exist') })
  assert.equal(result.status, 'needs-native-build')
})

await test('generic S2 adapter stages an AArch64 worker and patches the spawn path', async () => {
  const runtime = [
    "export const PLATFORMS = Object.freeze(['win32-x64', 'linux-x64', 'darwin-arm64'])",
    'export function tryResolveWorker(config = {}, options = {}) {',
    '  const platform = options.platform ?? process.platform',
    '  const arch = options.arch ?? process.arch',
    '  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`bad ${platform}-${arch}`)',
    '}',
    'export function resolveWorker(config = {}, { packageRoot = PACKAGE_ROOT, env = process.env, platform = process.platform, arch = process.arch } = {}) {',
    '  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`bad ${platform}-${arch}`)',
    "  const candidates = [path.join(packageRoot, 'runtime', `${platform}-${arch}`, workerName(platform))]",
    '  if (receipt.target !== `${platform}-${arch}`) throw new Error(`bad ${platform}-${arch}`)',
    '  throw new Error(`Native worker unavailable for ${platform}-${arch}`)',
    '}',
  ].join('\n')
  const pkg = {
    name: 'dsh-ops',
    version: '0.3.0',
    main: 'lib/index.js',
    os: ['win32'],
    cpu: ['x64'],
    optionalDependencies: { '@dsh-ops/bash-win32-x64': '0.2.1', '@dsh-ops/pwsh-win32-x64': '0.2.1' },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.4', '@deepseek-ai/dsh': '^0.2.0-rc.2' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const manifest = { id: 'dsh-ops.native', name: 'dsh-ops', contributes: { 'x-components': [{ id: 'file', platforms: ['win32', 'linux'], targets: ['win32-x64', 'linux-x64'] }] } }
  const archive = tarball('dsh-ops-0.3.0-synthetic.tgz', {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'dsh-plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'cordis.patch.yml': '- insert:\n    - id: dsh-ops-file\n      name: dsh-ops/file\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/ptc/runtime.js': runtime,
    'lib/file/worker.js': 'const argv = [file]\n',
    'lib/ptc/worker.js': 'let argv = [file]\n',
    'lib/shells/tool.js': "const argv = hasCommand ? [file, '-c', command] : [file, scriptPath]\n",
  })
  const missing = await convertS2Native(archive, {})
  assert.equal(missing.status, 'needs-native-build')

  const elf = Buffer.alloc(64)
  elf[0] = 0x7f; elf[1] = 0x45; elf[2] = 0x4c; elf[3] = 0x46
  elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(183, 18)
  const converted = await convertS2Native(archive, { workerBinary: elf })
  assert.equal(converted.status, 'ok')
  const { entries } = extractTar(readFileSync(converted.tarball))
  const paths = new Set(entries.map(entry => entry.path))
  assert.ok(paths.has('package/runtime/linux-arm64/worker'))
  assert.ok(paths.has('package/runtime/linux-arm64/worker-bin'))
  const patchedRuntime = entries.find(entry => entry.path === 'package/lib/ptc/runtime.js').data.toString()
  assert.ok(patchedRuntime.includes("'linux-arm64'"))
  assert.ok(patchedRuntime.includes('const resolveTarget ='))
  assert.ok(patchedRuntime.includes('`${resolveTarget(platform, arch)}`'))
  assert.ok(!patchedRuntime.includes('`resolveTarget(platform, arch)`'))
  const patchedWorker = entries.find(entry => entry.path === 'package/lib/file/worker.js').data.toString()
  assert.ok(patchedWorker.includes("['bash', file]"))
  const patchedShell = entries.find(entry => entry.path === 'package/lib/shells/tool.js').data.toString()
  assert.ok(patchedShell.includes("['bash', '-c', command]"))
  assert.ok(patchedShell.includes("['bash', scriptPath]"))
  const patchedPkg = JSON.parse(entries.find(entry => entry.path === 'package/package.json').data.toString())
  assert.equal(patchedPkg.os, undefined)
  assert.equal(patchedPkg.cpu, undefined)
  assert.equal(patchedPkg.peerDependencies['@deepseek-ai/dsh'], 'workspace:*')
})

await test('generic S2 adapter auto-detects an AArch64 worker in the package', async () => {
  const elf = Buffer.alloc(64)
  elf[0] = 0x7f; elf[1] = 0x45; elf[2] = 0x4c; elf[3] = 0x46
  elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(183, 18)
  const runtime = [
    "export const PLATFORMS = Object.freeze(['win32-x64'])",
    'export function tryResolveWorker(config = {}, options = {}) {',
    '  const platform = options.platform ?? process.platform',
    '  const arch = options.arch ?? process.arch',
    '  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`bad ${platform}-${arch}`)',
    '}',
    'export function resolveWorker(config = {}, { packageRoot = PACKAGE_ROOT, env = process.env, platform = process.platform, arch = process.arch } = {}) {',
    '  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`bad ${platform}-${arch}`)',
    '  return `${packageRoot}/runtime/${platform}-${arch}/native-worker`',
    '}',
  ].join('\n')
  const archive = tarball('auto-native-1.0.0.tgz', {
    'package.json': '{"name":"auto-native","version":"1.0.0","main":"lib/index.js","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}\n',
    'cordis.patch.yml': '- insert:\n    - id: auto-native\n      name: auto-native\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/ptc/runtime.js': runtime,
    'lib/file/worker.js': 'const argv = [file]\n',
    'runtime/linux-arm64/native-worker': elf,
  })
  const result = await convertS2Native(archive, { env: { DSHM_COMPAT_DIR: join(ROOT, 'auto-s2') } })
  assert.equal(result.status, 'ok')
  const { entries } = extractTar(readFileSync(result.tarball))
  assert.ok(entries.some(entry => entry.path === 'package/runtime/linux-arm64/native-worker'))
  assert.ok(entries.some(entry => entry.path === 'package/runtime/linux-arm64/native-worker-bin'))
  assert.ok(entries.some(entry => entry.path === 'package/lib/file/worker.js' && entry.data.toString().includes("['bash', file]")))
})

await test('generic S2 adapter wraps a linux-x64 worker with the bundled qemu runtime', async () => {
  const elf = Buffer.alloc(64)
  elf[0] = 0x7f; elf[1] = 0x45; elf[2] = 0x4c; elf[3] = 0x46
  elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18)
  const runtime = [
    "export const PLATFORMS = Object.freeze(['win32-x64', 'linux-x64'])",
    'export function tryResolveWorker(config = {}, options = {}) {',
    '  const platform = options.platform ?? process.platform',
    '  const arch = options.arch ?? process.arch',
    '  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`bad ${platform}-${arch}`)',
    '}',
    'export function resolveWorker(config = {}, { packageRoot = PACKAGE_ROOT, env = process.env, platform = process.platform, arch = process.arch } = {}) {',
    '  if (!PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`bad ${platform}-${arch}`)',
    '  return `${packageRoot}/runtime/${platform}-${arch}/native-worker`',
    '}',
  ].join('\n')
  const archive = tarball('qemu-native-1.0.0.tgz', {
    'package.json': '{"name":"qemu-native","version":"1.0.0","main":"lib/index.js","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}\n',
    'cordis.patch.yml': '- insert:\n    - id: qemu-native\n      name: qemu-native\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/ptc/runtime.js': runtime,
    'lib/file/worker.js': 'const argv = [file]\n',
    'runtime/linux-x64/native-worker': elf,
  })
  const result = await convertS2Native(archive, { env: { DSHM_COMPAT_DIR: join(ROOT, 'qemu-s2') } })
  assert.equal(result.status, 'ok')
  assert.equal(result.worker.arch, 'x64')
  const { entries } = extractTar(readFileSync(result.tarball))
  const paths = new Set(entries.map(entry => entry.path))
  assert.ok(paths.has('package/runtime/linux-x64/native-worker'))
  assert.ok(paths.has('package/runtime/linux-x64/native-worker-x64'))
  assert.ok(paths.has('package/runtime/linux-x64/qemu-x86_64'))
  assert.ok(paths.has('package/runtime/linux-x64/rootfs/lib/x86_64-linux-gnu/libc.so.6'))
  const wrapper = entries.find(entry => entry.path === 'package/runtime/linux-x64/native-worker').data.toString()
  assert.ok(wrapper.includes('qemu-x86_64'))
  assert.ok(wrapper.includes('native-worker-x64'))
  assert.ok(wrapper.includes('/mnt/share'))
  assert.ok(wrapper.includes('cp -f'))
  assert.ok(wrapper.includes('/lib64/ld-linux-x86-64.so.2'))
  assert.ok(wrapper.includes('LD_PRELOAD'))
})

await test('generic S2 adapter reports a source package as needs-build', async () => {
  const archive = tarball('source-only-0.4.0.tgz', {
    'package.json': `${JSON.stringify({
      name: 'source-only',
      version: '0.4.0',
      main: 'lib/index.js',
      scripts: { build: 'node scripts/build.mjs', prepack: 'npm run build' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`,
    'cordis.patch.yml': '- insert:\n    - id: source-only\n      name: source-only\n',
    'src/index.ts': 'export function apply() {}\n',
    'scripts/build.mjs': 'console.log("build")\n',
  })
  const result = await convertS2Native(archive, {})
  assert.equal(result.status, 'needs-build')
  assert.equal(result.sourcePackage, true)
  assert.ok(result.build.command.includes('npm run build'))
})

await test('source build planner detects Rust and Node packages', async () => {
  const rust = detectSourceBuild([{ path: 'native/Cargo.toml', data: Buffer.from('[package]\nname = "demo-worker"\n') }])
  assert.equal(rust.kind, 'rust')
  assert.equal(rust.output, 'target/release/demo-worker')
  const node = detectSourceBuild([{ path: 'package.json', data: Buffer.from('{"scripts":{"build":"tsc"}}') }])
  assert.equal(node.kind, 'node')
  assert.ok(node.command.includes('npm run build'))
})

await test('source build plan prepares a local source archive without building', async () => {
  const archive = tarball('source-build-1.0.0.tgz', {
    'package.json': '{"name":"source-build","version":"1.0.0","scripts":{"build":"tsc"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}\n',
    'cordis.patch.yml': '- insert:\n    - id: source-build\n      name: source-build\n',
    'src/index.ts': 'export const x = 1\n',
  })
  const planned = await buildSource({}, archive, {
    backend: 'plan',
    env: { DSHM_COMPAT_DIR: join(ROOT, 'source-build-compat') },
  })
  assert.equal(planned.status, 'planned')
  assert.ok(planned.plan.commands.includes('npm run build'))
})

await test('generic S2 adapter prefers an AArch64 worker over an x86_64 one', async () => {
  const arm = Buffer.alloc(64)
  arm[0] = 0x7f; arm[1] = 0x45; arm[2] = 0x4c; arm[3] = 0x46
  arm[4] = 2; arm[5] = 1; arm.writeUInt16LE(183, 18)
  const x64 = Buffer.alloc(64)
  x64[0] = 0x7f; x64[1] = 0x45; x64[2] = 0x4c; x64[3] = 0x46
  x64[4] = 2; x64[5] = 1; x64.writeUInt16LE(62, 18)
  const runtime = [
    "export const PLATFORMS = Object.freeze(['win32-x64', 'linux-x64', 'linux-arm64'])",
    'export function resolveWorker(config = {}, { packageRoot = PACKAGE_ROOT, env = process.env, platform = process.platform, arch = process.arch } = {}) {',
    '  return `${packageRoot}/runtime/${platform}-${arch}/native-worker`',
    '}',
  ].join('\n')
  const archive = tarball('both-arch-1.0.0.tgz', {
    'package.json': '{"name":"both-arch","version":"1.0.0","main":"lib/index.js","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}\n',
    'cordis.patch.yml': '- insert:\n    - id: both-arch\n      name: both-arch\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/ptc/runtime.js': runtime,
    'lib/file/worker.js': 'const argv = [file]\n',
    'runtime/linux-arm64/native-worker': arm,
    'runtime/linux-x64/native-worker': x64,
  })
  const result = await convertS2Native(archive, { env: { DSHM_COMPAT_DIR: join(ROOT, 'both-arch') } })
  assert.equal(result.status, 'ok')
  assert.equal(result.worker.arch, 'arm64')
  const { entries } = extractTar(readFileSync(result.tarball))
  assert.ok(entries.some(entry => entry.path === 'package/runtime/linux-arm64/native-worker-bin'))
  assert.ok(!entries.some(entry => entry.path.includes('qemu-x86_64')))
})

await test('source build rewrites the 9p hardlink publication and records what it weakened', async () => {
  const archive = tarball('9p-source-1.0.0.tgz', {
    'package.json': '{"name":"9p-source","version":"1.0.0","main":"lib/index.js"}\n',
    'native/Cargo.toml': '[package]\nname = "9p-source-worker"\n',
    'native/src/file_single.rs': 'let published = checked\n    .parent\n    .hard_link(&temporary, &checked.parent, &checked.name);\n',
  })
  const planned = await buildSource({}, archive, {
    backend: 'plan',
    env: { DSHM_COMPAT_DIR: join(ROOT, 'source-9p-compat') },
  })
  assert.equal(planned.status, 'planned')
  assert.equal(planned.patches.length, 1)
  assert.equal(planned.patches[0].from, 'hard_link')
  assert.equal(planned.patches[0].patternId, PATCH_ID)
  assert.deepEqual(planned.patches[0].evidence, { errorKind: false, stat: false })
  // This file carries no proof that the error type has kind() or that the receiver
  // can stat, so the rewrite degrades — and must say so instead of pretending.
  assert.equal(planned.patches[0].form, 'rename')
  assert.deepEqual(planned.patches[0].semantics, ['weakened-no-clobber', 'weakened-errno-filter'])
  assert.equal(planned.patchSummary.weakened, 1)
  assert.equal(planned.warnings.length, 1)
  const patched = readFileSync(join(planned.directory, 'native', 'src', 'file_single.rs'), 'utf8')
  assert.ok(patched.includes('.rename('))
  assert.ok(!patched.includes('.hard_link('))
})

await test('source build keeps hard_link as the primary path when the file proves it can stat and inspect errno', async () => {
  const archive = tarball('9p-guarded-1.0.0.tgz', {
    'package.json': '{"name":"9p-guarded","version":"1.0.0","main":"lib/index.js"}\n',
    'native/Cargo.toml': '[package]\nname = "9p-guarded-worker"\n',
    'native/src/file_single.rs': [
      'use std::io;',
      '',
      'pub fn publish(checked: &State, temporary: &str) -> io::Result<()> {',
      '    let _warm = checked.parent.symlink_metadata(&checked.name).is_ok();',
      '    let published = checked',
      '        .parent',
      '        .hard_link(&temporary, &checked.parent, &checked.name);',
      '    published',
      '}',
      '',
    ].join('\n'),
  })
  const planned = await buildSource({}, archive, {
    backend: 'plan',
    env: { DSHM_COMPAT_DIR: join(ROOT, 'source-9p-guarded') },
  })
  assert.equal(planned.status, 'planned')
  assert.equal(planned.patches[0].form, 'guarded')
  assert.deepEqual(planned.patches[0].semantics, [])
  assert.equal(planned.patchSummary.weakened, 0)
  assert.equal(planned.warnings, undefined)
  const patched = readFileSync(join(planned.directory, 'native', 'src', 'file_single.rs'), 'utf8')
  // The primary path must survive: on a filesystem that does support links we want
  // the original semantics, not a copy.
  assert.ok(patched.includes('.hard_link('))
  assert.ok(patched.includes('std::io::ErrorKind::PermissionDenied'))
  assert.ok(patched.includes('std::io::ErrorKind::AlreadyExists'))
  assert.ok(patched.includes('symlink_metadata('))
  assert.ok(patched.includes('.rename('))
})

await test('requireNoClobber refuses a rewrite that would weaken publication semantics', async () => {
  const archive = tarball('9p-strict-1.0.0.tgz', {
    'package.json': '{"name":"9p-strict","version":"1.0.0","main":"lib/index.js"}\n',
    'native/Cargo.toml': '[package]\nname = "9p-strict-worker"\n',
    'native/src/file_single.rs': 'let published = checked\n    .parent\n    .hard_link(&temporary, &checked.parent, &checked.name);\n',
  })
  const planned = await buildSource({}, archive, {
    backend: 'plan',
    requireNoClobber: true,
    env: { DSHM_COMPAT_DIR: join(ROOT, 'source-9p-strict') },
  })
  assert.equal(planned.status, 'patch-unsafe')
  assert.ok(planned.error.includes('weaken'))
  assert.equal(planned.patches.length, 1)
})

await test('a hard_link call the patcher cannot rewrite is reported, never silently skipped', async () => {
  const dir = join(ROOT, 'anchor-missing')
  const file = join(dir, 'src', 'file_single.rs')
  write(file, 'let published = build_dir(&checked).hard_link(&temporary, &checked.parent, &checked.name);\n')
  const result = patchPublicationSources(dir, [{ path: 'src/file_single.rs' }])
  assert.equal(result.ok, true)
  assert.equal(result.patches.length, 0)
  assert.equal(result.summary.anchorsMissing, 1)
  assert.equal(result.anchorsMissing[0].line, 1)
  assert.ok(result.anchorsMissing[0].reason.includes('did not match'))

  const strict = patchPublicationSources(dir, [{ path: 'src/file_single.rs' }], { strict: true })
  assert.equal(strict.ok, false)
  assert.equal(strict.reason, 'anchor-missing')
  // The file must be untouched when nothing matched.
  assert.ok(readFileSync(file, 'utf8').includes('.hard_link('))
})

await test('hostcap reads the runtime facts the host publishes', () => {
  const home = join(ROOT, 'host-home')
  write(join(home, 'host-ready.json'), JSON.stringify({
    url: 'http://127.0.0.1:3120/?token=x',
    pid: 4242,
    runtime: {
      nodeVersion: '24.2.0',
      platform: 'openharmony',
      jitless: true,
      zstd: true,
      natives: ['koffi', 'node-pty'],
      exec: { summary: 'spawn=ok' },
      terminal: { realShell: false, libsExec: true, hostDomain: 'appspawn:s0' },
      python: { selftest: 'ok', bridge: true, stdlib: 'ready' },
    },
  }, null, 2))
  const facts = readHostReady({ DSHM_HOME: home })
  assert.equal(facts.source, 'host-ready.json')
  assert.equal(facts.runtime.nodeVersion, '24.2.0')
  assert.equal(facts.runtime.jitless, true)
  assert.deepEqual(facts.runtime.natives, ['koffi', 'node-pty'])
  assert.equal(facts.runtime.terminal.libsExec, true)
  assert.equal(readHostFacts({ DSHM_HOME: home }).available, true)
})

await test('hostcap falls back to the one-line log readout when host-ready.json is unreadable', () => {
  const home = join(ROOT, 'host-log-home')
  write(join(home, 'dshm-host.log'), [
    '[dshm-host] boot BOOT_60 port=3120',
    '[dshm-host] 探针读数（日志副本）：runtime={exec,terminal} exec=spawn=ok | realShell=false，libsExec=true，hostDomain=appspawn:s0',
    '',
  ].join('\n'))
  const ready = readHostReady({ DSHM_HOME: home })
  assert.equal(ready, undefined)
  const log = readHostLogFacts({ DSHM_HOME: home })
  assert.equal(log.source, 'dshm-host.log')
  assert.deepEqual(log.probes, ['exec', 'terminal'])
  assert.equal(log.fields.realShell, 'false')
  assert.equal(log.fields.libsExec, 'true')
})

await test('hostcap probes link support directly and leaves nothing behind', () => {
  const dir = join(ROOT, 'link-probe')
  mkdirSync(dir, { recursive: true })
  const probe = probeLinkSupport(dir)
  assert.equal(typeof probe.ok, 'boolean')
  assert.equal(probe.dir, dir)
  if (!probe.ok) assert.equal(typeof probe.code, 'string')
  const leftovers = readdirSync(dir).filter(name => name.includes('dshm-compat-link-probe'))
  assert.deepEqual(leftovers, [])
})

await test('link policy patches in-process only when link really fails, and always patches the guest', () => {
  assert.equal(linkPolicyFor('in-process', { ok: true }), 'skip')
  assert.equal(linkPolicyFor('in-process', { ok: false, code: 'EPERM' }), 'apply')
  // A host that supports links says nothing about how 9p exports it.
  assert.equal(linkPolicyFor('guest', { ok: true }), 'apply')
  assert.equal(linkPolicyFor('guest', { ok: false, code: 'EACCES' }), 'apply')
})

await test('local tarball install writes the profile node_modules and bundle list', async () => {
  const profile = join(ROOT, 'profile')
  write(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2) + '\n')
  const file = tarball('fixture-local-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'fixture-local',
      version: '1.0.0',
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: fixture-local\n      name: fixture-local\n',
    'index.js': 'export function apply() {}\n',
  })
  const result = installLocalTarball(file, { profileDir: profile })
  assert.equal(result.ok, true)
  assert.equal(result.method, 'local-profile')
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['fixture-local'], '1.0.0')
  assert.ok(manifest.dsh.profile.bundles.includes('fixture-local'))
  assert.ok(readFileSync(join(profile, 'node_modules', 'fixture-local', 'index.js'), 'utf8').includes('apply'))

  const removed = uninstallLocalPackage('fixture-local', { profileDir: profile })
  assert.equal(removed.ok, true)
  assert.equal(removed.removedDependency, true)
  assert.equal(removed.removedBundle, true)
  assert.equal(existsSync(join(profile, 'node_modules', 'fixture-local')), false)
  const after = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.equal(after.dependencies['fixture-local'], undefined)
  assert.equal(after.dsh.profile.bundles.includes('fixture-local'), false)
})

await test('tool wrapper returns lossless JSON values', async () => {
  const tools = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    effect(callback) { return callback() },
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {} },
  }
  applyPlugin(ctx)
  const tool = tools.find(item => item.name === 'compat_analyze')
  assert.ok(tool !== undefined)
  const file = syntheticPackage()
  const value = await tool.execute({ spec: file, textScan: false }, {})
  assert.equal(value.status, 'ok')
  assert.equal(hasUndefined(value), false)
})

await test('local reinstall replaces the old version and keeps the profile consistent', async () => {
  const profile = join(ROOT, 'profile-reinstall')
  write(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2) + '\n')
  const make = version => tarball(`fixture-swap-${version}.tgz`, {
    'package.json': JSON.stringify({
      name: 'fixture-swap',
      version,
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: fixture-swap\n      name: fixture-swap\n',
    'index.js': `export const version = '${version}'\n`,
  })
  assert.equal(installLocalTarball(make('1.0.0'), { profileDir: profile }).ok, true)
  assert.equal(installLocalTarball(make('2.0.0'), { profileDir: profile }).ok, true)
  assert.ok(readFileSync(join(profile, 'node_modules', 'fixture-swap', 'index.js'), 'utf8').includes('2.0.0'))
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['fixture-swap'], '2.0.0')
})

await test('doctor reports core, profile and queue checks', async () => {
  const home = join(ROOT, 'doctor-home')
  const core = join(home, 'cores', '0.0.1')
  write(join(core, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), '{"name":"@deepseek-ai/dsh-base"}\n')
  write(join(core, 'dshm-core.json'), '{"coreVersion":"0.0.1"}\n')
  write(join(home, 'profiles', 'test', 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshm-compat'] } },
  }, null, 2) + '\n')
  const env = { DSHM_HOME: home, DSHM_PLATFORM: 'ohos', DSH_PROFILE: 'test', DSHM_COMPAT_DIR: join(ROOT, 'doctor-compat') }
  const result = await runDoctor({ get: () => undefined }, env)
  assert.equal(result.pluginVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  const byName = Object.fromEntries(result.checks.map(check => [check.name, check]))
  assert.equal(byName.core.status, 'ok')
  assert.equal(byName.profile.status, 'ok')
  assert.equal(byName.guest.status, 'warn')
})

await test('GitHub specs carry codeload fallbacks', async () => {
  const resolved = await resolveSpec('https://github.com/T-Auto/dsh-ops')
  assert.equal(resolved.kind, 'github')
  assert.equal(resolved.tarballUrl, 'https://api.github.com/repos/T-Auto/dsh-ops/tarball')
  assert.ok(resolved.fallbackUrls.some(url => url.startsWith('https://codeload.github.com/T-Auto/dsh-ops/tar.gz/')))
})

await test('sidecar stages an AArch64 worker and calls it in the guest', async () => {
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'sidecar-compat') }
  const elf = Buffer.alloc(64)
  elf[0] = 0x7f; elf[1] = 0x45; elf[2] = 0x4c; elf[3] = 0x46
  elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(183, 18)
  const archive = tarball('sidecar-worker-1.0.0.tgz', {
    'package.json': '{"name":"sidecar-worker","version":"1.0.0"}\n',
    'runtime/linux-arm64/worker': elf,
  })
  const staged = stageSidecar(archive, 'runtime/linux-arm64/worker', { id: 'demo', env })
  assert.equal(staged.ok, true)
  assert.equal(staged.elf.machine, 'AArch64')
  assert.equal(readFileSync(staged.worker).length, 64)
  assert.equal(listSidecars(env).length, 1)

  const handle = {
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text: '{"ok":true,"echo":{"x":1}}' }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  }
  const ctx = { get: name => name === 'subprocess' ? { spawn: () => handle } : undefined }
  const called = await callSidecar(ctx, 'demo', { x: 1 }, { env })
  assert.equal(called.ok, true)
  assert.deepEqual(called.value, { ok: true, echo: { x: 1 } })

  const bad = tarball('sidecar-bad-1.0.0.tgz', { 'runtime/worker': Buffer.from('not-elf') })
  assert.equal(stageSidecar(bad, 'runtime/worker', { env }).ok, false)
})

await test('install queue polls a mock host', async () => {
  const queue = join(ROOT, 'queue')
  mkdirSync(queue, { recursive: true })
  process.env.DSHM_COMPAT_QUEUE_DIR = queue
  const timer = setInterval(() => {
    const req = readdirSync(queue).find(name => name.endsWith('.req'))
    if (req !== undefined) {
      const base = req.slice(0, -4)
      writeFileSync(join(queue, `${base}.done`), JSON.stringify({ ok: true, name: 'fixture-js', version: '1.0.0' }))
      clearInterval(timer)
    }
  }, 50)
  try {
    const outcome = await enqueueInstall('file:/tmp/fixture.tgz', { timeoutMs: 3000 })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.name, 'fixture-js')
  } finally {
    clearInterval(timer)
  }
})

await test('there are no built-in per-package rules', async () => {
  assert.deepEqual(Object.keys(PACKAGE_RULES), [])
  assert.equal(lookupPackageRule('dsh-ops', {
    DSHM_COMPAT_DIR: join(ROOT, 'no-rules'),
    DSHM_COMPAT_REGISTRY: join(ROOT, 'no-rules.json'),
  }), undefined)
})

await test('market dry-run classifies, converts and stops before touching the profile', async () => {
  const file = syntheticPackage({ name: 'market-dry', version: '2.0.0' })
  const result = await marketAdapt(file, { dryRun: true, env: { DSHM_COMPAT_DIR: join(ROOT, 'market-dry') } })
  assert.equal(result.status, 'dry-run')
  assert.equal(result.card.name, 'market-dry')
  assert.equal(result.card.strategy, 'S0')
  assert.equal(result.card.label.includes('纯 JS'), true)
  assert.equal(typeof result.artifact.sha256, 'string')
  assert.deepEqual(result.steps.map(step => step.step), ['resolve', 'classify', 'services', 'transform', 'install'])
  assert.equal(result.steps.at(-1).status, 'skipped')
  assert.ok(result.verification.length >= 2)
  // The success payload repeats across one install's calls, so it carries the
  // outcome (artifact.changed), not the prediction: plan stays with compat_plan.
  assert.equal(result.plan, undefined)
  // nothing installed, nothing written outside the compat dir
  assert.equal(result.install, undefined)
})

await test('market installs into the profile when confirmed, and says a restart is needed', async () => {
  const profile = join(ROOT, 'market-profile')
  write(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-market',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2) + '\n')
  const file = syntheticPackage({ name: 'market-install', version: '1.1.0' })
  const result = await marketAdapt(file, {
    confirm: true,
    profileDir: profile,
    env: { DSHM_COMPAT_DIR: join(ROOT, 'market-install') },
  })
  assert.equal(result.status, 'installed')
  assert.equal(result.install.method, 'local-profile')
  assert.equal(result.install.restartRequired, true)
  assert.ok(result.nextSteps[0].includes('重启'))
  // The installed turn repeats in the same context as the ready turn one message
  // earlier: no plan, and no standalone verification field — nextSteps carries it.
  assert.equal(result.plan, undefined)
  assert.equal(result.verification, undefined)
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['market-install'], '1.1.0')
  assert.ok(manifest.dsh.profile.bundles.includes('market-install'))
  assert.ok(existsSync(join(profile, 'node_modules', 'market-install', 'lib', 'index.js')))
})

await test('market refuses a package with no dsh manifest instead of installing dead weight', async () => {
  const file = tarball('plain-lib-1.0.0.tgz', {
    'package.json': '{"name":"plain-lib","version":"1.0.0","main":"index.js"}\n',
    'index.js': 'module.exports = 1\n',
  })
  const result = await marketAdapt(file, { env: { DSHM_COMPAT_DIR: join(ROOT, 'market-plain') } })
  assert.equal(result.status, 'blocked')
  assert.ok(result.message.includes('不是 DSH 插件'))
  assert.equal(result.steps.at(-1).step, 'check')
  assert.ok(result.nextSteps.length >= 1)
})

await test('market browse reads packument signals only, and labels them as hints', async () => {
  const packuments = {
    'blocked-os': {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name: 'blocked-os', version: '1.0.0', description: 'desktop only', os: ['win32'], cpu: ['x64'], dsh: { bundle: {} } } },
    },
    'gate-peer': {
      'dist-tags': { latest: '2.3.4' },
      versions: { '2.3.4': { name: 'gate-peer', version: '2.3.4', dsh: { client: {} }, peerDependencies: { '@deepseek-ai/dsh': '^0.1.0' } } },
    },
    'native-optional': {
      'dist-tags': { latest: '0.1.0' },
      versions: { '0.1.0': { name: 'native-optional', version: '0.1.0', dsh: { bundle: {} }, optionalDependencies: { 'thing-win32-x64': '1.0.0', 'thing-linux-arm64': '1.0.0' } } },
    },
    'not-a-plugin': { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'not-a-plugin', version: '1.0.0' } } },
  }
  const fakeFetch = async url => {
    for (const [name, doc] of Object.entries(packuments)) {
      if (url.endsWith(`/${name}`)) return doc
    }
    throw new Error(`unexpected url ${url}`)
  }
  const browsed = await marketBrowse({ names: Object.keys(packuments), fetchJsonImpl: fakeFetch })
  assert.equal(browsed.status, 'ok')
  assert.equal(browsed.source, 'names')
  assert.equal(browsed.entries.length, 4)
  assert.ok(browsed.note.includes('不是分类结论'))
  const byName = Object.fromEntries(browsed.entries.map(entry => [entry.name, entry]))
  assert.equal(byName['blocked-os'].quick.foreignOs, true)
  assert.ok(byName['blocked-os'].hint.includes('平台门'))
  assert.equal(byName['gate-peer'].quick.peerGate, '^0.1.0')
  assert.deepEqual(byName['native-optional'].quick.platformOptional.length, 2)
  assert.ok(byName['native-optional'].hint.includes('optionalDependencies'))
  assert.equal(byName['not-a-plugin'].isDshPlugin, false)
  assert.ok(byName['not-a-plugin'].hint.includes('不是插件'))
  for (const entry of browsed.entries) assert.equal(entry.needsAnalysis, true)
})

await test('market verification steps name the create-new-file path for native plugins', () => {
  const s2 = verificationStepsFor('S2').join(' ')
  assert.ok(s2.includes('CREATE a new file'))
  assert.ok(s2.includes('expectedRevision'))
  const s0 = verificationStepsFor('S0').join(' ')
  assert.equal(s0.includes('CREATE a new file'), false)
})

await test('loadArchive caches by integrity, re-verifies, and refuses tampered entries', async () => {
  const file = tarball('cache-me-1.0.0.tgz', { 'package.json': '{"name":"cache-me","version":"1.0.0"}\n' })
  const body = readFileSync(file)
  const { createHash } = await import('node:crypto')
  const integrity = 'sha512-' + createHash('sha512').update(body).digest('base64')
  const resolved = { kind: 'npm', name: 'cache-me', version: '1.0.0', tarballUrl: 'https://registry.example/cache-me.tgz', integrity }
  const cacheDir = join(ROOT, 'archive-cache')
  let downloads = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    downloads += 1
    return { ok: true, status: 200, headers: { get: () => String(body.length) }, body: null, arrayBuffer: async () => body }
  }
  try {
    const first = await loadArchive(resolved, { cacheDir })
    assert.equal(downloads, 1)
    const second = await loadArchive(resolved, { cacheDir })
    assert.equal(downloads, 1, 'second read must come from the cache')
    assert.ok(second.equals(first))
    // Tampered cache entry: verified out, deleted, re-downloaded — never served.
    writeFileSync(archiveCachePlan(resolved, cacheDir).file, Buffer.from('tampered'))
    const third = await loadArchive(resolved, { cacheDir })
    assert.equal(downloads, 2, 'a tampered entry is discarded, not served')
    assert.ok(third.equals(body))
  } finally {
    globalThis.fetch = realFetch
  }
})

await test('the L2 verdict cache records adapt outcomes and repeat checks skip the tarball', async () => {
  // a) a blocked adapt is recorded under the package's own identity
  const file = tarball('plain-lib-1.0.0.tgz', {
    'package.json': '{"name":"plain-lib","version":"1.0.0","main":"index.js"}\n',
    'index.js': 'module.exports = 1\n',
  })
  const blocked = await marketAdapt(file, { env: { DSHM_COMPAT_DIR: join(ROOT, 'verdicts-a') } })
  assert.equal(blocked.status, 'blocked')
  const stored = JSON.parse(readFileSync(join(ROOT, 'verdicts-a', 'verdicts.json'), 'utf8'))
  const entry = stored.entries['plain-lib@1.0.0']
  assert.ok(entry !== undefined, 'verdict missing for plain-lib@1.0.0')
  assert.equal(entry.outcome, 'blocked')
  assert.equal(entry.blockedReason, 'no-dsh-manifest')
  assert.equal(entry.hasDsh, false)
  assert.ok(typeof entry.analyzedAt === 'string')

  // b) an npm input is analyzed once; the repeat check reuses the verdict and
  //    only pays the packument — never the tarball again.
  const fixture = tarball('verdict-pkg-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'verdict-pkg', version: '1.0.0', dsh: { bundle: {} }, main: 'index.js' }) + '\n',
    'index.js': 'module.exports = 1\n',
  })
  const body = readFileSync(fixture)
  const { createHash } = await import('node:crypto')
  const integrity = 'sha512-' + createHash('sha512').update(body).digest('base64')
  const packument = {
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'verdict-pkg', version: '1.0.0', dsh: { bundle: {} },
        dist: { tarball: 'https://registry.example/verdict-pkg/-/verdict-pkg-1.0.0.tgz', integrity },
      },
    },
  }
  let downloads = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async url => {
    downloads += 1
    if (String(url).endsWith('/verdict-pkg')) {
      return { ok: true, status: 200, headers: { get: () => String(JSON.stringify(packument).length) }, body: null, arrayBuffer: async () => Buffer.from(JSON.stringify(packument)) }
    }
    if (String(url) === packument.versions['1.0.0'].dist.tarball) {
      return { ok: true, status: 200, headers: { get: () => String(body.length) }, body: null, arrayBuffer: async () => body }
    }
    throw new Error(`unexpected url ${url}`)
  }
  try {
    const envB = { DSHM_COMPAT_DIR: join(ROOT, 'verdicts-b') }
    const first = await marketVerdict('verdict-pkg', { env: envB })
    assert.equal(first.status, 'analyzed')
    assert.equal(first.strategy, 'S0')
    assert.equal(first.outcome, 'ok')
    const once = downloads
    const second = await marketVerdict('verdict-pkg', { env: envB })
    assert.equal(second.status, 'cached')
    assert.equal(downloads, once + 1, 'a cache hit pays one packument, never the tarball')
    assert.equal(second.verdict.strategy, 'S0')
    const fresh = await marketVerdict('verdict-pkg', { env: envB, refresh: true })
    assert.equal(fresh.status, 'analyzed')
    // From the cached state: one packument for the cache lookup, then two for the
    // re-analysis (intake + analyze) — and zero tarball downloads.
    assert.equal(downloads, once + 3, 'refresh re-reads packuments but reuses the cached tarball')
  } finally {
    globalThis.fetch = realFetch
  }
})

await test('shelf states keep conclusions and descriptions apart: verdict wins, expect says 预期', () => {
  // 本机结论（verdict）优先于目录描述（expect）——同一行两种话不能混。
  assert.equal(shelfState({ expect: 'S0' }, { verdict: { outcome: 'blocked', blockedReason: 'services', analyzedAt: 't' } }).label, '服务缺失')
  assert.equal(shelfState({ expect: 'S0' }, { verdict: { outcome: 'blocked', blockedReason: 'services' } }).source, 'verdict')
  // 目录里的 expect 只是描述，标签带"预期"。
  assert.equal(shelfState({ expect: 'S0' }, {}).label, '预期可直装')
  assert.equal(shelfState({ expect: 'S2' }, {}).label, '预期需 worker')
  assert.equal(shelfState({ expect: 'S4' }, {}).source, 'expect')
  // 判定的各个结局各得一句话。
  assert.equal(shelfState({}, { verdict: { outcome: 'ok', strategy: 'S0' } }).label, '可装')
  assert.equal(shelfState({}, { verdict: { outcome: 'ok', strategy: 'S4' } }).label, '不支持')
  assert.equal(shelfState({}, { verdict: { outcome: 'needs-worker' } }).label, '需 worker')
  assert.equal(shelfState({}, { verdict: { outcome: 'blocked', blockedReason: 'host-killing' } }).label, '会杀宿主')
  assert.equal(shelfState({}, { verdict: { hostRisk: { level: 'host-killing' }, outcome: 'ok' } }).label, '会杀宿主')
  assert.equal(shelfState({}, { verdict: { outcome: 'blocked', blockedReason: 'no-dsh-manifest' } }).label, '不是插件')
  // 安装账本 + 待复核清单。
  assert.equal(shelfState({}, { installedOk: true }).label, '已装')
  assert.equal(shelfState({}, { installedOk: true, pendingVerify: true }).label, '已装·待复核')
  // 旧账本（有分析无 L2 判定）说"可适配"，不敢替本机承诺"可装"。
  assert.equal(shelfState({ analyzed: true, lastVerdict: 'S0' }, {}).label, '可适配（未装）')
  assert.equal(shelfState({ analyzed: true, lastVerdict: 'S2' }, {}).source, 'ledger')
  // 什么都没有：未分析，不编。
  assert.deepEqual(shelfState({}, {}), { id: 'unanalyzed', label: '未分析', source: 'none' })
})

await test('marketShelf attaches device states from verdicts, installs and pendingVerify', async () => {
  const { recordInstall } = await import('../lib/state.js')
  const { writeVerdict } = await import('../lib/verdicts.js')
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'shelf-states') }
  // dsh-context：有过 L2 判定（S0 可装）→ 本机结论
  writeVerdict(
    { package: { name: 'dsh-context', version: '2.0.0' }, strategy: 'S0', confidence: 0.9, signals: { hasDsh: true }, fingerprint: 'fp-shelf' },
    { name: 'dsh-context', version: '2.0.0' },
    { outcome: 'ok' },
    env,
  )
  // dsh-pet：装过且还在待复核 → 已装·待复核
  recordInstall({ spec: 'dsh-pet', ok: true, name: 'dsh-pet', version: '0.3.8', method: 'local-profile', at: new Date().toISOString() }, env)
  markPendingVerify({ name: 'dsh-pet', version: '0.3.8', profileDir: join(ROOT, 'shelf-states'), source: 'test', autoRollback: false }, env)

  const shelf = marketShelf({ env, limit: 50 })
  const byName = Object.fromEntries(shelf.entries.map(entry => [entry.name, entry]))
  assert.equal(byName['dsh-context'].state.label, '可装')
  assert.equal(byName['dsh-context'].state.source, 'verdict')
  assert.equal(byName['dsh-pet'].state.label, '已装·待复核')
  assert.equal(byName['dsh-pet'].state.source, 'ledger')
  // 没有本机事实的目录条目：诚实的"预期"，不冒充结论。
  assert.equal(byName['dshm-boot-rescue'].state.label, '预期可直装')
  assert.equal(byName['dshm-boot-rescue'].state.source, 'expect')
  assert.equal(byName['dsh-ops'].state.label, '预期需 worker')
})

await test('a sidecar-verified TTL cache entry is discarded when its bytes no longer match', async () => {
  const file = tarball('ttl-pkg-1.0.0.tgz', { 'package.json': '{"name":"ttl-pkg","version":"1.0.0"}\n' })
  const body = readFileSync(file)
  // No registry integrity → moving TTL + write-time sha256 sidecar.
  const resolved = { kind: 'npm', name: 'ttl-pkg', version: '1.0.0', tarballUrl: 'https://registry.example/ttl.tgz' }
  const cacheDir = join(ROOT, 'archive-cache-ttl')
  let downloads = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    downloads += 1
    return { ok: true, status: 200, headers: { get: () => String(body.length) }, body: null, arrayBuffer: async () => body }
  }
  try {
    await loadArchive(resolved, { cacheDir })
    assert.equal(downloads, 1)
    const plan = archiveCachePlan(resolved, cacheDir)
    assert.ok(plan?.shaFile !== undefined, 'a no-integrity spec must carry a sidecar plan')
    writeFileSync(plan.file, Buffer.from('corrupted bytes on disk'))
    const again = await loadArchive(resolved, { cacheDir })
    assert.equal(downloads, 2, 'a corrupted TTL entry is re-downloaded, never served')
    assert.ok(again.equals(body))
    // The repair rewrote a matching sidecar: the next read is a cache hit again.
    const third = await loadArchive(resolved, { cacheDir })
    assert.equal(downloads, 2)
    assert.ok(third.equals(body))
  } finally {
    globalThis.fetch = realFetch
  }
})

await test('the archive cache evicts its oldest entries past the bound', async () => {
  const { utimesSync } = await import('node:fs')
  const { boundArchiveCache } = await import('../lib/fetch.js')
  const cacheDir = join(ROOT, 'archive-cache-bound')
  mkdirSync(cacheDir, { recursive: true })
  const total = 70
  for (let index = 0; index < total; index += 1) {
    const name = `archive-${String(index).padStart(3, '0')}.tgz`
    writeFileSync(join(cacheDir, name), Buffer.alloc(16))
    // Distinct increasing mtimes: archive-000 is the oldest, archive-069 the newest.
    const at = new Date(Date.UTC(2026, 0, 1 + index))
    utimesSync(join(cacheDir, name), at, at)
  }
  boundArchiveCache(cacheDir)
  const kept = readdirSync(cacheDir).filter(name => name.endsWith('.tgz'))
  assert.equal(kept.length, 64, 'eviction keeps exactly the newest 64')
  assert.equal(existsSync(join(cacheDir, 'archive-000.tgz')), false, 'the oldest entry goes first')
  assert.equal(existsSync(join(cacheDir, 'archive-005.tgz')), false)
  assert.equal(existsSync(join(cacheDir, 'archive-006.tgz')), true, 'everything inside the bound stays')
  assert.equal(existsSync(join(cacheDir, 'archive-069.tgz')), true)
})

await test('packTarGz emits pax records for long paths and repacks byte-for-byte deterministically', () => {
  // A vendored node_modules tree crosses ustar's 100-byte name limit regularly;
  // before 0.1.32 this threw "tar path is too long" and failed the conversion.
  const deep = 'node_modules/@scope/some-package/dist/deeply/nested/folder-structure/that-exceeds/ustar-limits/entry-' + 'x'.repeat(60) + '.js'
  assert.ok(Buffer.byteLength(deep, 'utf8') > 100)
  const files = [
    { path: 'package.json', data: Buffer.from('{"name":"pax-test"}') },
    { path: deep, data: Buffer.from('hello pax') },
  ]
  const first = packTarGz(files, { mtime: 0 })
  const second = packTarGz(files, { mtime: 0 })
  assert.ok(first.equals(second), 'same input + mtime must produce identical bytes')

  const { entries, truncated } = extractTar(first)
  assert.equal(truncated, false)
  assert.equal(entries.some(entry => entry.path.includes('PaxHeader')), false, 'the x record must not leak as an entry')
  const roundTripped = entries.find(entry => entry.path === `package/${deep}`)
  assert.ok(roundTripped !== undefined, 'long path survived the round trip')
  assert.equal(roundTripped.data.toString('utf8'), 'hello pax')
  // Short paths keep the plain ustar shape (no pax record).
  assert.ok(entries.some(entry => entry.path === 'package/package.json'))
})

await test('a wildcard os/cpu gate is not reported as platform-blocked', () => {
  // npm allows `os: ["*"]`; the gate only blocks when it excludes the host
  // target AND the wildcard — same reading as market.js quickSignals.
  const s0 = { name: 'wild', version: '1.0.0', os: ['*'], cpu: ['*'], dsh: { bundle: {} }, main: 'index.js' }
  const tar = tarball('wild-1.0.0.tgz', {
    'package.json': JSON.stringify(s0) + '\n',
    'index.js': 'module.exports = 1\n',
  })
  return analyze(tar, { textScan: false }).then(report => {
    assert.equal(report.strategy, 'S0')
    assert.equal(report.signals.platformBlocked, false)
    assert.ok(!report.reasons.some(reason => reason.includes('os/cpu excludes')))
  })
})

await test('quarantineRow flips an existing row in place and reports honestly when it cannot', () => {
  const dir = join(ROOT, 'quarantine-flip')
  mkdirSync(dir, { recursive: true })
  assert.deepEqual(quarantineRow(dir, ''), { ok: false, reason: 'empty row id' })

  writeFileSync(join(dir, '.dshm-plugin-rows.yml'), '- id: dsh-b\n  disabled: false\n', 'utf8')
  const flip = quarantineRow(dir, 'dsh-b')
  assert.equal(flip.ok, true)
  assert.equal(flip.changed, true)
  const flipped = readFileSync(join(dir, '.dshm-plugin-rows.yml'), 'utf8')
  assert.ok(flipped.includes('disabled: true'))
  assert.ok(!flipped.includes('disabled: false'), 'no contradictory pair may remain')

  // Idempotent: the already-disabled row is reported, not rewritten.
  assert.deepEqual(quarantineRow(dir, 'dsh-b'), { ok: true, changed: false, reason: 'already disabled' })

  // A hand-edited flag the reader cannot parse (trailing YAML comment) must be
  // reported as NOT changed — a silent ok:true here would lie about the boot.
  writeFileSync(join(dir, '.dshm-plugin-rows.yml'), '- id: dsh-c\n  disabled: false # keep off until fixed\n', 'utf8')
  const stuck = quarantineRow(dir, 'dsh-c')
  assert.equal(stuck.ok, false)
  assert.equal(stuck.changed, false)
  assert.equal(readFileSync(join(dir, '.dshm-plugin-rows.yml'), 'utf8'), '- id: dsh-c\n  disabled: false # keep off until fixed\n')
})

await test('default registry follows the host: mirror on DSHM, official on PC, override everywhere', () => {
  assert.equal(defaultRegistry({}), 'https://registry.npmjs.org/')
  assert.equal(defaultRegistry({ DSHM_PLATFORM: 'ohos' }), 'https://registry.npmmirror.com/')
  assert.equal(defaultRegistry({ DSHM_PLATFORM: 'ohos', DSHM_COMPAT_REGISTRY: 'https://x.example' }), 'https://x.example')
  assert.equal(defaultRegistry({ DSHM_COMPAT_REGISTRY: 'https://y.example' }), 'https://y.example')
})

await test('market steps carry wall time and the card names the download source', async () => {
  // 真机复盘（0.1.33）：31 MB 下载 2–3 分钟，卡片却看不出慢在哪。现在：
  // ① verdict 的报告落盘路径进判定缓存；② 结果/卡片携带 download 元数据。
  const file = tarball('dl-meta-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'dl-meta', version: '1.0.0', dsh: { bundle: {} }, main: 'index.js' }) + '\n',
    'index.js': 'module.exports = 1\n',
  })
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'dl-meta') }
  const result = await marketVerdict(file, { env })
  assert.equal(result.status, 'analyzed')
  assert.equal(result.verdict.reportFile !== undefined, true, 'verdict must record the stored report path')
  assert.ok(existsSync(result.verdict.reportFile), 'the stored report file must exist')
  // 本地文件不走网络下载，不产 download 元数据——npm 路径的下载标注由卡片渲染消费
  // （index.js renderMarketCard），此处钉住元数据不冒充本地文件。
  assert.equal(result.verdict.kind, 'file')
})

await test('market home screen is the shelf, and works with no network at all', async () => {
  const shelf = await marketBrowse({ env: { DSHM_COMPAT_DIR: join(ROOT, 'shelf-empty') } })
  assert.equal(shelf.browse, 'shelf')
  assert.equal(shelf.status, 'ok')
  assert.equal(shelf.catalog.ok, true)
  assert.ok(shelf.entries.length >= 2)
  const names = shelf.entries.map(entry => entry.name)
  assert.ok(names.includes('dsh-ops'))
  assert.ok(names.includes('dshm-compat'))
  assert.equal(shelf.entries.every(entry => entry.origin === 'catalog'), true)
  assert.equal(shelf.entries.every(entry => entry.analyzed === false), true)
})

await test('the shelf shows the verdict a plugin already got, instead of asking again', async () => {
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'shelf-ledger') }
  const file = syntheticPackage({ name: 'dsh-ops', version: '0.3.2' })
  await marketAdapt(file, { dryRun: true, env })
  const shelf = await marketBrowse({ env })
  const ops = shelf.entries.find(entry => entry.name === 'dsh-ops')
  assert.ok(ops !== undefined)
  assert.equal(ops.analyzed, true)
  // The ledger verdict wins over the catalog's guess.
  assert.equal(ops.lastVerdict, 'S0')
  assert.equal(ops.version, '0.3.2')
  assert.equal(typeof ops.lastSeen, 'string')
  // Catalog copy is not lost by the merge.
  assert.equal(typeof ops.desc, 'string')

  /*
   * The shelf is a list, not a review: a description that needs two lines pushes the
   * names off the screen. Pin the length so "just add a sentence" cannot creep back.
   */
  const shelfCatalog = loadCatalog({ DSHM_COMPAT_DIR: join(ROOT, 'shelf-copy') })
  for (const entry of shelfCatalog.entries) {
    assert.equal(typeof entry.desc, 'string', `${entry.name} has no desc`)
    assert.ok(entry.desc.length <= 28, `${entry.name} desc too long: ${entry.desc}`)
  }
})

await test('shelf search finds catalog copy, so a typo lands on a suggestion', async () => {
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'shelf-search') }
  const hit = searchShelf('运维', { env })
  assert.equal(hit.source, 'shelf-search')
  assert.ok(hit.entries.some(entry => entry.name === 'dsh-ops'))
  const miss = searchShelf('zzz-not-there', { env })
  assert.deepEqual(miss.entries, [])
})

await test('market renderers print a card and a shelf, not raw JSON', async () => {
  const tools = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    effect(callback) { return callback() },
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {} },
  }
  applyPlugin(ctx)
  const market = tools.find(item => item.name === 'compat_market')
  const browse = tools.find(item => item.name === 'compat_market_browse')
  assert.equal(market.output.render.name, 'renderMarketCard')
  assert.equal(browse.output.render.name, 'renderShelf')

  const file = syntheticPackage({ name: 'render-probe', version: '3.1.4' })
  const value = await market.execute({ input: file, dryRun: true }, {})
  const cardText = market.output.render({}, value)[0].text
  assert.ok(cardText.includes('[DRY-RUN]'))
  assert.ok(cardText.includes('render-probe@3.1.4'))
  assert.ok(cardText.includes('[S0]'))
  assert.ok(cardText.includes('流程'))
  assert.equal(cardText.trim().startsWith('{'), false)

  const shelfValue = await browse.execute({}, {})
  const shelfText = browse.output.render({}, shelfValue)[0].text
  assert.ok(shelfText.includes('货架'))
  assert.ok(shelfText.includes('dsh-ops'))
  assert.equal(shelfText.trim().startsWith('{'), false)
})

await test('client half registers a tab into the Plugins page and stays in sync with the catalog', async () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  const windowStub = { __ModuleLoader__: { load: mod => { loaded = mod } } }
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
  }
  const requireStub = name => {
    if (name === 'react') return reactStub
    throw new Error(`client required an undeclared package: ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'window', source)(requireStub, windowStub)

  assert.ok(loaded !== undefined, 'client bundle did not register through __ModuleLoader__')
  assert.equal(loaded.id, 'dshm-compat')
  const client = loaded.factory(requireStub)
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'locale', 'remote'])

  // The inlined catalog must not drift from the shelf file the host half reads.
  const catalogFile = JSON.parse(readFileSync(new URL('../assets/catalog.json', import.meta.url), 'utf8'))
  assert.equal(client.CATALOG.length, catalogFile.entries.length)
  assert.deepEqual(client.CATALOG.map(item => item.name), catalogFile.entries.map(item => item.name))

  const registrations = []
  const provided = []
  const ctx = {
    effect(callback) { return callback() },
    get(name) { return provided.some(item => item.name === name) ? item.value : undefined },
    reflect: {
      props: {},
      provide(name, value) { provided.push({ name, value }) },
    },
    locale: {
      register(namespace, dictionaries) { registrations.push({ kind: 'locale', namespace, keys: Object.keys(dictionaries) }) },
      bind() { return key => (key === 'tab' ? '兼容市场' : key) },
    },
    slots: {
      inject(name, register) { register() },
      register(spec, Component) { registrations.push({ kind: 'slot', spec, Component }) },
    },
    remote: { pluginInventory: { list: async () => ({ ok: true, value: [{ name: 'dshm-compat' }] }) } },
    logger: { info() {}, warn() {}, error() {} },
  }
  client.apply(ctx)

  /*
   * The shim is what turns "we told you it would break" into "it runs": without a
   * provider the row stays pending forever. It must be narrow (only names in the
   * table), guarded (never shadow a real provider) and callable by consumers.
   */
  const shimTable = Object.keys(SERVICE_SHIMS)
  assert.deepEqual([...client.SHIM_NAMES].sort(), shimTable.sort())
  assert.deepEqual(provided.map(item => item.name), shimTable)
  const events = provided.find(item => item.name === 'conversationEvents').value
  assert.deepEqual(events.entries(), [])
  assert.equal(typeof events.subscribe(() => {}), 'function')

  // Already provided → hands off, so a future real service is not shadowed.
  const secondApply = []
  client.apply({
    ...ctx,
    get: name => ({ entries: () => [] }),
    reflect: { props: {}, provide(name, value) { secondApply.push({ name, value }) } },
    slots: { inject() {}, register() {} },
    locale: ctx.locale,
  })
  assert.deepEqual(secondApply, [])

  const slots = registrations.filter(item => item.kind === 'slot')
  // Two pages, one panel: the Plugins page in the left rail (`plugins.tab`, owned
  // by dsh-client-ui-plugin-manager) and Settings → Plugins. Either may be absent
  // on a given build, so both are registered independently.
  assert.equal(slots.length, 2)
  const bySlot = Object.fromEntries(slots.map(item => [item.spec.name, item]))
  assert.ok(bySlot['plugins.tab'] !== undefined, 'missing registration for the Plugins page')
  assert.ok(bySlot['settings.plugins.tab'] !== undefined, 'missing registration for Settings → Plugins')
  assert.equal(bySlot['plugins.tab'].spec.order, 30)
  assert.equal(bySlot['settings.plugins.tab'].spec.order, 20)
  for (const slot of slots) {
    assert.equal(slot.spec.id, 'dshm-compat-market')
    assert.equal(slot.spec.label(), '兼容市场')
    assert.equal(typeof slot.Component, 'function')
    assert.deepEqual(await slot.spec.inject().listInstalled(), ['dshm-compat'])
  }
  const slot = bySlot['plugins.tab']

  // Regression guard: `dsh.client.inject` once named a package that does not
  // exist in this build (`@deepseek-ai/dsh-client-ui-slots`), which is enough to
  // keep the whole bundle from loading.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'), false)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'))
  assert.equal(manifest.exports['./client'], './lib/client.js')

  // The injected loader really reaches the inventory namespace.
  const injected = slot.spec.inject()
  assert.deepEqual(await injected.listInstalled(), ['dshm-compat'])

  // Rendering must not depend on any dsh-ui primitive: only plain elements.
  const tree = slot.Component({ listInstalled: injected.listInstalled })
  assert.equal(tree.type, 'div')
  const flat = JSON.stringify(tree)
  // 离线空态只有 ★ 精选（+ 已安装段）：手写目录段已按需求移除。
  assert.ok(flat.includes('dshm-boot-rescue'))
  assert.ok(flat.includes('dsh-ops') === false)
  assert.ok(flat.includes('目录') === false)
  assert.ok(flat.includes('兼容市场') === false) // the tab label lives on the slot, not the body
  assert.equal(client.commandFor('dsh-ops'), 'compat_market { input: "dsh-ops" }')
})

await test('the market tab follows the dshmarket pattern: categories, sort, pages, honest badges', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  const windowStub = { __ModuleLoader__: { load: mod => { loaded = mod } } }
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
  }
  const requireStub = name => {
    if (name === 'react') return reactStub
    throw new Error(`client required an undeclared package: ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'window', source)(requireStub, windowStub)
  const client = loaded.factory(requireStub)

  // 策略标签是描述不是结论：未知策略原样透传，空值不发明文案。
  assert.equal(client.strategyLabel('S0'), '预期可直装')
  assert.equal(client.strategyLabel('S2'), '需原生 worker')
  assert.equal(client.strategyLabel('S4'), '预计不支持')
  assert.equal(client.strategyLabel('S9'), 'S9')
  assert.equal(client.strategyLabel(undefined), undefined)
  assert.equal(client.categoryLabel('tool'), '工具')
  assert.equal(client.categoryLabel('brand-new-slug'), 'brand-new-slug')
  assert.equal(typeof client.PAGE_SIZE, 'number')
  assert.ok(client.PAGE_SIZE > 0)

  // 分类 chips：全部置顶、按计数降序；无分类的行不编造桶。
  const rows = [
    { name: 'a', category: 'ui', stars: 10, published: '2026-01-01' },
    { name: 'b', category: 'tool', published: '2026-03-01' },
    { name: 'c', stars: 99 },
  ]
  const chips = client.categoryChips(rows)
  assert.deepEqual(chips.map(chip => chip.id), ['', 'tool', 'ui'])
  assert.equal(chips[0].count, 3)

  // 排序：缺席的 stars/published 垫底，但不冒充 0（dshmarket 对 downloads 的纪律）。
  assert.deepEqual(client.sortRows(rows, 'hot').map(row => row.name), ['c', 'a', 'b'])
  assert.deepEqual(client.sortRows(rows, 'new').map(row => row.name), ['b', 'a', 'c'])
  assert.deepEqual(client.sortRows(rows, undefined).map(row => row.name), ['a', 'b', 'c'])
  assert.equal(client.pageSlice([1, 2, 3], 2).length, 2)
  assert.equal(client.pageSlice([1, 2, 3], 99).length, 3)

  // 初始渲染（离线）：只有精选段（含预期策略徽章）；「未分析」只属于全量索引条目；
  // 分类 chips、排序和浏览网格只在全量索引就绪后出现。
  const tree = client.CompatMarketTab({})
  const flat = JSON.stringify(tree)
  assert.ok(flat.includes('dshm-boot-rescue'))
  assert.ok(flat.includes('预期可直装'))
  assert.ok(flat.includes('未分析') === false)
  assert.ok(flat.includes('最热') === false)
  assert.ok(flat.includes('加载更多') === false)
  assert.ok(flat.includes('目录') === false)

  // 搜索框：IME 组合保护（中文输入期间不提交）+ 关闭拼写检查（插件名不是散文）。
  const inputs = []
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || typeof node !== 'object') return
    if (node.type === 'input') inputs.push(node)
    walk(node.children)
  }
  walk(tree)
  assert.equal(inputs.length, 1)
  assert.equal(typeof inputs[0].props.onCompositionStart, 'function')
  assert.equal(typeof inputs[0].props.onCompositionEnd, 'function')
  assert.equal(inputs[0].props.spellCheck, false)
})

await test('service declarations are read from all three inject shapes', () => {
  const arrayForm = declaredServices('const inject = ["commands", "sessions"];')
  assert.deepEqual(arrayForm, { required: ['commands', 'sessions'], optional: [] })

  const objectForm = declaredServices('const inject = { required: ["slots"], optional: ["conversationEvents"] };')
  assert.deepEqual(objectForm, { required: ['slots'], optional: ['conversationEvents'] })

  const dynamic = declaredServices('ctx.inject(["sessionProjections"], (c) => {})')
  assert.deepEqual(dynamic, { required: ['sessionProjections'], optional: [] })

  // The real shape that broke the boot: one required service this core lacks.
  const rewind = declaredServices('const inject = ["commandUi", "sessions", "slots", "conversation", "conversationEvents"];')
  assert.equal(rewind.required.includes('conversationEvents'), true)
})

await test('a package is split into host and client service requirements', async () => {
  const file = tarball('svc-pkg-1.0.0.tgz', {
    'package.json': '{"name":"svc-pkg","version":"1.0.0","main":"lib/index.js"}\n',
    'lib/index.js': 'export const name = "svc-pkg";\nexport const inject = ["commands"];\n',
    'lib/client.js': 'window.__ModuleLoader__.load({});\nconst inject = ["slots", "conversationEvents"];\n',
  })
  const deps = await packageServiceDeps({ tarball: file })
  assert.deepEqual(deps.host.required, ['commands'])
  // sorted, so the output is deterministic whatever order the source declares
  assert.deepEqual(deps.client.required, ['conversationEvents', 'slots'])
  assert.deepEqual(deps.filesScanned, ['host', 'client'])
})

await test('a missing required service is reported, a missing optional one is not', () => {
  const declared = {
    host: { required: ['commands', 'sessionProjections'], optional: [] },
    client: { required: ['slots', 'conversationEvents'], optional: ['telemetry'] },
  }
  const known = compareServices(declared, {
    host: ['commands', 'sessions'],
    client: { ok: true, names: ['slots', 'conversation'], source: 'scan:2 client bundles' },
  })
  assert.equal(known.ok, false)
  assert.deepEqual(known.missingHost, ['sessionProjections'])
  assert.deepEqual(known.missingClient, ['conversationEvents'])
  assert.deepEqual(known.missingOptional, ['client:telemetry'])
  assert.deepEqual(known.verified, { host: true, client: true })

  // With no client inventory, absence is unknown — not a pass we can claim.
  const blind = compareServices(declared, { host: ['commands', 'sessionProjections'], client: { ok: false, names: [], source: 'skipped' } })
  assert.equal(blind.ok, true)
  assert.deepEqual(blind.verified, { host: true, client: false })
  assert.deepEqual(blind.missingClient, [])
})

await test('the client service inventory is scanned from provider bundles and cached', () => {
  const core = join(ROOT, 'svc-core')
  write(join(core, 'node_modules', 'a', 'lib', 'client.js'), 'class S extends Service { constructor(ctx) { super(ctx, "slots") } }\n')
  write(join(core, 'node_modules', 'b', 'lib', 'client.js'), 'super(ctx, "conversation"); super(ctx, "commandUi")\n')
  write(join(core, 'node_modules', 'c', 'lib', 'index.js'), 'super(ctx, "notAClientBundle")\n')
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'svc-compat') }
  const first = clientServiceNames({ nodeModules: join(core, 'node_modules'), version: 'test-1' }, { env })
  assert.equal(first.ok, true)
  assert.deepEqual(first.names, ['commandUi', 'conversation', 'slots'])
  assert.ok(first.source.startsWith('scan:'))
  const second = clientServiceNames({ nodeModules: join(core, 'node_modules'), version: 'test-1' }, { env })
  assert.ok(second.source.startsWith('cache:'))

  const skipped = clientServiceNames({ nodeModules: join(core, 'node_modules'), version: 'test-1' }, { env, skip: true })
  assert.equal(skipped.ok, false)
})

await test('a boot failure in the host log is read back as "which row waits on what"', () => {
  const home = join(ROOT, 'svc-home')
  write(join(home, 'dshm-host.log'), [
    '[dshm-host] boot BOOT_60',
    'HARNESSFailed to load pluginsweb boot: 1 entry did not activate',
    'dsh-rewind: pending (waiting for service: conversationEvents)',
    '',
  ].join('\n'))
  const pending = pendingFromLogs({ DSHM_HOME: home })
  assert.equal(pending.ok, true)
  const row = pending.pending.find(item => item.plugin === 'dsh-rewind')
  assert.ok(row !== undefined)
  assert.equal(row.service, 'conversationEvents')
})

await test('a shimmable missing service does not block the install, and says what it degrades', async () => {
  const core = join(ROOT, 'svc-core-shim')
  write(join(core, 'node_modules', 'x', 'lib', 'client.js'), 'super(ctx, "slots")\n')
  const file = tarball('needs-shimmed-svc-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'needs-shimmed-svc',
      version: '1.0.0',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: needs-shimmed-svc\n      name: needs-shimmed-svc\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/client.js': 'const inject = ["slots", "conversationEvents"];\n',
  })
  const result = await marketAdapt(file, {
    dryRun: true,
    env: { DSHM_COMPAT_DIR: join(ROOT, 'svc-shim-compat'), DSHM_CORE_DIR: core },
  })
  assert.notEqual(result.status, 'blocked')
  assert.deepEqual(result.services.shimmable, ['conversationEvents'])
  assert.deepEqual(result.services.unshimmable, [])
  // Declared lists and inventories live in the verdict ledger; the repeat
  // payload keeps only the gaps a follow-up decision can act on.
  assert.equal(result.services.declared, undefined)
  assert.ok(result.warnings.some(text => text.includes('conversationEvents') && text.includes('空实现')))
})

await test('a missing service compat cannot supply still blocks the install', async () => {
  const core = join(ROOT, 'svc-core-block')
  write(join(core, 'node_modules', 'x', 'lib', 'client.js'), 'super(ctx, "slots")\n')
  const file = tarball('needs-missing-svc-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'needs-missing-svc',
      version: '1.0.0',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: needs-missing-svc\n      name: needs-missing-svc\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/client.js': 'const inject = ["slots", "captureTheFlag"];\n',
  })
  const result = await marketAdapt(file, {
    env: {
      DSHM_COMPAT_DIR: join(ROOT, 'svc-block-compat'),
      DSHM_CORE_DIR: core,
    },
  })
  assert.equal(result.status, 'blocked')
  assert.ok(result.message.includes('captureTheFlag'))
  assert.deepEqual(result.services.missingClient, ['captureTheFlag'])
  assert.deepEqual(result.services.unshimmable, ['captureTheFlag'])
  assert.ok(result.nextSteps[0].includes('停用') || result.nextSteps[0].includes('卸载'))
})

await test('one unfillable gap blocks the row even when another gap is shimmable', async () => {
  const core = join(ROOT, 'svc-core-mixed')
  write(join(core, 'node_modules', 'x', 'lib', 'client.js'), 'super(ctx, "slots")\n')
  const file = tarball('mixed-gaps-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'mixed-gaps',
      version: '1.0.0',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: mixed-gaps\n      name: mixed-gaps\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/client.js': 'const inject = ["slots", "conversationEvents", "captureTheFlag"];\n',
  })
  const result = await marketAdapt(file, {
    env: { DSHM_COMPAT_DIR: join(ROOT, 'svc-mixed-compat'), DSHM_CORE_DIR: core },
  })
  assert.equal(result.status, 'blocked')
  // Shim-able gaps are still recorded, so the user can see what compat *could* do.
  assert.deepEqual(result.services.shimmable, ['conversationEvents'])
  assert.deepEqual(result.services.unshimmable, ['captureTheFlag'])
  assert.ok(result.message.includes('captureTheFlag'))
  assert.equal(result.message.includes('conversationEvents'), false, 'the message names only what blocks')
  assert.ok(result.nextSteps.some(step => step.includes('conversationEvents') && step.includes('本来能补')))
})

await test('S0 plan tells the truth about vendoring instead of calling it unimplemented', () => {
  const plan = buildPlan({
    spec: 'x', fingerprint: 'f', strategy: 'S0', confidence: 'high',
    resolved: { name: 'x', version: '1.0.0' }, reasons: [],
    signals: { dependencies: { core: { available: true }, present: ['a'], missing: ['b', 'c'] } },
  })
  assert.equal(plan.warnings.length, 1)
  assert.equal(plan.warnings[0].includes('not implemented'), false)
  assert.ok(plan.warnings[0].includes('vendored during conversion'))
  // The limit has to be stated, otherwise "vendored" reads as "always works".
  assert.ok(plan.warnings[0].includes('pure-JS only'))
})

/**
 * Build a minimal little-endian ELF64 with a real `.dynsym`/`.dynstr` pair and an
 * optional executable section. Enough for the scanner to parse honestly, so the
 * "symbol table available" path is exercised rather than the string fallback.
 */
function buildElf({ machine = 183, imports = [], text = Buffer.alloc(0) } = {}) {
  const chunks = []
  let offset = 64
  const place = (buffer, align = 8) => {
    const pad = (align - (offset % align)) % align
    if (pad > 0) { chunks.push(Buffer.alloc(pad)); offset += pad }
    const at = offset
    chunks.push(buffer)
    offset += buffer.length
    return at
  }

  // .dynstr
  const names = ['\0']
  const nameOffsets = []
  for (const name of imports) { nameOffsets.push(names.join('').length); names.push(`${name}\0`) }
  const dynstr = Buffer.from(names.join(''), 'latin1')
  const dynstrOffset = place(dynstr, 1)

  // .dynsym: null symbol + one undefined entry per import
  const dynsym = Buffer.alloc(24 * (imports.length + 1))
  imports.forEach((_, index) => {
    const base = 24 * (index + 1)
    dynsym.writeUInt32LE(nameOffsets[index], base)   // st_name
    dynsym.writeUInt8(0x12, base + 4)                // st_info: GLOBAL FUNC
    dynsym.writeUInt16LE(0, base + 6)                // st_shndx: UNDEF
  })
  const dynsymOffset = place(dynsym, 8)

  // .text
  const textOffset = place(text.length === 0 ? Buffer.alloc(4) : text, 8)

  // .shstrtab
  const shNames = ['\0', '.dynstr\0', '.dynsym\0', '.text\0', '.shstrtab\0']
  const shOffsets = []
  let running = 0
  for (const name of shNames) { shOffsets.push(running); running += name.length }
  const shstrtab = Buffer.from(shNames.join(''), 'latin1')
  const shstrtabOffset = place(shstrtab, 1)

  // section headers
  const shoff = offset
  const shnum = 5
  const shdrs = Buffer.alloc(64 * shnum)
  const write = (index, { name = 0, type = 0, flags = 0n, at = 0, size = 0, link = 0, entsize = 0 }) => {
    const base = 64 * index
    shdrs.writeUInt32LE(name, base)
    shdrs.writeUInt32LE(type, base + 4)
    shdrs.writeBigUInt64LE(flags, base + 8)
    shdrs.writeBigUInt64LE(BigInt(at), base + 24)
    shdrs.writeBigUInt64LE(BigInt(size), base + 32)
    shdrs.writeUInt32LE(link, base + 40)
    shdrs.writeBigUInt64LE(BigInt(entsize), base + 56)
  }
  write(1, { name: shOffsets[1], type: 3, at: dynstrOffset, size: dynstr.length })
  write(2, { name: shOffsets[2], type: 11, flags: 2n, at: dynsymOffset, size: dynsym.length, link: 1, entsize: 24 })
  write(3, { name: shOffsets[3], type: 1, flags: 0x6n, at: textOffset, size: Math.max(text.length, 4) })
  write(4, { name: shOffsets[4], type: 3, at: shstrtabOffset, size: shstrtab.length })

  const header = Buffer.alloc(64)
  header.write('\u007fELF', 0, 'latin1')
  header[4] = 2
  header[5] = 1
  header[6] = 1
  header.writeUInt16LE(3, 16)                 // ET_DYN
  header.writeUInt16LE(machine, 18)
  header.writeUInt32LE(1, 20)
  header.writeBigUInt64LE(BigInt(shoff), 0x28)
  header.writeUInt16LE(64, 0x3a)
  header.writeUInt16LE(shnum, 0x3c)
  header.writeUInt16LE(4, 0x3e)               // shstrndx

  return Buffer.concat([header, ...chunks, shdrs])
}

await test('worker scan proves a libc-based worker can be shimmed, and a raw-syscall one cannot', () => {
  const imported = scanWorker(buildElf({ imports: ['linkat', 'chmod', 'write'] }))
  assert.equal(imported.ok, true)
  assert.equal(imported.arch, 'arm64')
  assert.equal(imported.symtab, 'dynsym')
  assert.equal(imported.publication.linkat, true)
  assert.equal(imported.metadata.chmod, true)
  assert.equal(imported.rawSyscall.instructions, 0)
  assert.equal(imported.verdict, 'preload-viable')

  // svc #0 in an executable section: interposition cannot reach it.
  const raw = scanWorker(buildElf({ imports: ['linkat'], text: Buffer.from([0x01, 0x00, 0x00, 0xd4, 0x1f, 0x20, 0x03, 0xd5]) }))
  assert.equal(raw.rawSyscall.instructions, 1)
  assert.equal(raw.verdict, 'needs-ptrace')
  assert.ok(raw.why.some(line => line.includes('svc #0')))

  // x86_64 uses the 0f 05 encoding.
  const x64 = scanWorker(buildElf({ machine: 62, imports: ['rename'], text: Buffer.from([0x48, 0x89, 0xc0, 0x0f, 0x05]) }))
  assert.equal(x64.arch, 'x64')
  assert.equal(x64.rename.rename, true)
  assert.equal(x64.verdict, 'needs-ptrace')

  // Nothing publication-related: the failure is elsewhere.
  const clean = scanWorker(buildElf({ imports: ['write', 'read'] }))
  assert.equal(clean.verdict, 'no-publication')
  assert.ok(verdictAdvice(clean.verdict).includes('别处'))

  // Not an ELF at all.
  assert.equal(scanWorker(Buffer.from('#!/bin/sh\n')).ok, false)
})

await test('a boot that never activated the plugin is proven from the log, not guessed', () => {
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'verify-compat'), DSHM_HOME: join(ROOT, 'verify-home') }
  write(join(env.DSHM_HOME, 'dshm-host.log'), 'dsh-rewind: pending (waiting for service: conversationEvents)\n')
  markPendingVerify({ name: 'dsh-rewind', version: '0.11.12', autoRollback: true }, env)
  markPendingVerify({ name: 'quiet-plugin', version: '1.0.0' }, env)

  const evaluation = evaluatePending({ env })
  assert.equal(evaluation.logsAvailable, true)
  assert.equal(evaluation.inventoryAvailable, false)
  const stuck = evaluation.verdicts.find(item => item.name === 'dsh-rewind')
  assert.equal(stuck.verdict, 'failed')
  assert.ok(stuck.reason.includes('conversationEvents'))
  // No pending line and no inventory: unknown, not "active".
  assert.equal(evaluation.verdicts.find(item => item.name === 'quiet-plugin').verdict, 'unknown')

  // Inventory present → a listed plugin is confirmed, an unlisted one failed.
  const withInventory = evaluatePending({ env, inventory: ['quiet-plugin'] })
  assert.equal(withInventory.verdicts.find(item => item.name === 'quiet-plugin').verdict, 'active')
  assert.equal(withInventory.verdicts.find(item => item.name === 'dsh-rewind').verdict, 'failed')
})

await test('rollback only touches what the evidence proved, and only when it was opted into', () => {
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'verify-apply-compat'), DSHM_HOME: join(ROOT, 'verify-apply-home') }
  write(join(env.DSHM_HOME, 'dshm-host.log'), [
    'dsh-rewind: pending (waiting for service: conversationEvents)',
    'careful-plugin: pending (waiting for service: somethingElse)',
    '',
  ].join('\n'))
  markPendingVerify({ name: 'dsh-rewind', autoRollback: true }, env)
  markPendingVerify({ name: 'careful-plugin', autoRollback: false }, env)
  markPendingVerify({ name: 'healthy-plugin' }, env)

  const removed = []
  const applied = applyVerdicts(evaluatePending({ env, inventory: ['healthy-plugin'] }), {
    env,
    rollback: name => { removed.push(name); return { ok: true } },
  })
  assert.deepEqual(removed, ['dsh-rewind'])
  const actions = Object.fromEntries(applied.actions.map(item => [item.name, item.action]))
  assert.equal(actions['dsh-rewind'], 'rolled-back')
  assert.equal(actions['careful-plugin'], 'report-only')
  assert.equal(actions['healthy-plugin'], 'confirmed-active')
  // Settled entries leave the ledger; the report-only one stays for the user.
  const remaining = listPendingVerify(env).map(item => item.name)
  assert.deepEqual(remaining, ['careful-plugin'])
})

await test('shims are opted in per side, and the host half provides its own', async () => {
  // Client-only by default: a name is not assumed safe on both halves.
  assert.deepEqual(shimmableServices(['conversationEvents'], 'client').covered, ['conversationEvents'])
  assert.deepEqual(shimmableServices(['conversationEvents'], 'host').covered, ['conversationEvents'])
  assert.deepEqual(shimmableServices(['captureTheFlag'], 'host').uncovered, ['captureTheFlag'])

  const tools = []
  const provided = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    effect(callback) { return callback() },
    get() { return undefined },
    reflect: { props: {}, provide(name, value) { provided.push({ name, value }) } },
    logger: { info() {}, warn() {}, error() {} },
  }
  applyPlugin(ctx)
  const hostShims = provided.filter(item => item.name === 'conversationEvents')
  assert.equal(hostShims.length, 1)
  assert.deepEqual(hostShims[0].value.entries(), [])
  assert.equal(typeof hostShims[0].value.subscribe(() => {}), 'function')

  // Already provided on the host → leave it alone.
  const second = []
  applyPlugin({
    ...ctx,
    get: () => ({ entries: () => [] }),
    reflect: { props: {}, provide(name, value) { second.push({ name, value }) } },
  })
  assert.deepEqual(second, [])
})

await test('a host-side gap that the shim covers does not block the install either', async () => {
  const core = join(ROOT, 'svc-core-host')
  write(join(core, 'node_modules', 'x', 'lib', 'client.js'), 'super(ctx, "slots")\n')
  const file = tarball('needs-host-svc-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'needs-host-svc',
      version: '1.0.0',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: needs-host-svc\n      name: needs-host-svc\n',
    'lib/index.js': 'export const inject = ["commands", "conversationEvents"];\nexport function apply() {}\n',
  })
  // A host that provides `commands` but not `conversationEvents`.
  const ctx = { reflect: { props: { commands: { type: 'service' } } } }
  const result = await marketAdapt(file, {
    dryRun: true,
    ctx,
    env: { DSHM_COMPAT_DIR: join(ROOT, 'svc-host-compat'), DSHM_CORE_DIR: core },
  })
  assert.notEqual(result.status, 'blocked')
  assert.deepEqual(result.services.missingHost, ['conversationEvents'])
  assert.deepEqual(result.services.unshimmable, [])
})
await test('a stripped worker whose symbols came from a string sweep is not called shimmable', () => {
  // No section headers at all: names are visible, attribution is not.
  const stripped = Buffer.concat([Buffer.from('\u007fELF', 'latin1'), Buffer.from([2, 1, 1, 0, 0, 0]), Buffer.alloc(56), Buffer.from('linkat\0chmod\0', 'latin1')])
  stripped.writeUInt16LE(183, 18)
  const scan = scanWorker(stripped)
  assert.equal(scan.ok, true)
  assert.equal(scan.symtab, 'strings')
  assert.equal(scan.verdict, 'unknown')
  assert.ok(scan.why.some(line => line.includes('string sweep')))
})

/**
 * Minimal shared object: PT_INTERP + real .dynamic/.dynstr sections, so the probe's
 * two independent sources (loader string, dependency list) are both exercised.
 */
function buildSo({ machine = 183, needed = [], interp } = {}) {
  const chunks = []
  const base = 64 + 2 * 56                     // header + two program headers
  let offset = base
  const place = (buffer, align = 8) => {
    const pad = (align - (offset % align)) % align
    if (pad > 0) { chunks.push(Buffer.alloc(pad)); offset += pad }
    const at = offset
    chunks.push(buffer)
    offset += buffer.length
    return at
  }

  const interpBuffer = interp === undefined ? undefined : Buffer.concat([Buffer.from(interp, 'latin1'), Buffer.from([0])])
  const interpOffset = interpBuffer === undefined ? 0 : place(interpBuffer, 1)

  // .dynstr
  const parts = ['\0']
  const offsets = []
  for (const name of needed) { offsets.push(parts.join('').length); parts.push(`${name}\0`) }
  const dynstr = Buffer.from(parts.join(''), 'latin1')
  const dynstrOffset = place(dynstr, 1)

  // .dynamic: one DT_NEEDED per library, then DT_NULL
  const dynamic = Buffer.alloc(16 * (needed.length + 1))
  needed.forEach((_, index) => {
    dynamic.writeBigInt64LE(1n, index * 16)
    dynamic.writeBigUInt64LE(BigInt(offsets[index]), index * 16 + 8)
  })
  const dynamicOffset = place(dynamic, 8)

  // .shstrtab
  const shNames = ['\0', '.dynstr\0', '.dynamic\0', '.shstrtab\0']
  const shOffsets = []
  let running = 0
  for (const name of shNames) { shOffsets.push(running); running += name.length }
  const shstrtab = Buffer.from(shNames.join(''), 'latin1')
  const shstrtabOffset = place(shstrtab, 1)

  const shoff = offset
  const shnum = 4
  const shdrs = Buffer.alloc(64 * shnum)
  const writeSection = (index, { name = 0, type = 0, at = 0, size = 0, link = 0, entsize = 0 }) => {
    const at64 = 64 * index
    shdrs.writeUInt32LE(name, at64)
    shdrs.writeUInt32LE(type, at64 + 4)
    shdrs.writeBigUInt64LE(BigInt(at), at64 + 24)
    shdrs.writeBigUInt64LE(BigInt(size), at64 + 32)
    shdrs.writeUInt32LE(link, at64 + 40)
    shdrs.writeBigUInt64LE(BigInt(entsize), at64 + 56)
  }
  writeSection(1, { name: shOffsets[1], type: 3, at: dynstrOffset, size: dynstr.length })
  writeSection(2, { name: shOffsets[2], type: 6, at: dynamicOffset, size: dynamic.length, link: 1, entsize: 16 })
  writeSection(3, { name: shOffsets[3], type: 3, at: shstrtabOffset, size: shstrtab.length })

  const header = Buffer.alloc(64)
  header.write('\u007fELF', 0, 'latin1')
  header[4] = 2
  header[5] = 1
  header[6] = 1
  header.writeUInt16LE(3, 16)
  header.writeUInt16LE(machine, 18)
  header.writeUInt32LE(1, 20)
  header.writeBigUInt64LE(64n, 0x20)           // e_phoff
  header.writeBigUInt64LE(BigInt(shoff), 0x28)
  header.writeUInt16LE(56, 0x36)
  header.writeUInt16LE(interpBuffer === undefined ? 0 : 1, 0x38)
  header.writeUInt16LE(64, 0x3a)
  header.writeUInt16LE(shnum, 0x3c)
  header.writeUInt16LE(3, 0x3e)

  const phdrs = Buffer.alloc(2 * 56)
  if (interpBuffer !== undefined) {
    phdrs.writeUInt32LE(3, 0)                  // PT_INTERP
    phdrs.writeBigUInt64LE(BigInt(interpOffset), 8)
    phdrs.writeBigUInt64LE(BigInt(interpOffset), 16)
    phdrs.writeBigUInt64LE(BigInt(interpBuffer.length), 32)
    phdrs.writeBigUInt64LE(BigInt(interpBuffer.length), 40)
  }

  return Buffer.concat([header, phdrs, ...chunks, shdrs])
}

await test('a native addon failure is attributed to the right cause, not to the named file', () => {
  // glibc build: needs libc.so.6 and a glibc interpreter. OHOS is musl.
  const glibc = probeNative(buildSo({ needed: ['libc.so.6', 'libgcc_s.so.1'], interp: '/lib/ld-linux-aarch64.so.1' }))
  assert.equal(glibc.ok, true)
  assert.equal(glibc.arch, 'arm64')
  assert.equal(glibc.interpreter, '/lib/ld-linux-aarch64.so.1')
  assert.deepEqual(glibc.needed, ['libc.so.6', 'libgcc_s.so.1'])
  assert.equal(glibc.verdict, 'glibc-on-musl')
  assert.ok(glibc.cause.includes('libc.so.6'))

  // musl build: libc.so is the right name, so the failure is a different dependency.
  const musl = probeNative(buildSo({ needed: ['libc.so', 'libz.so'], interp: '/lib/ld-musl-aarch64.so.1' }))
  assert.equal(musl.verdict, 'musl-ok')
  assert.deepEqual(musl.needed, ['libc.so', 'libz.so'])

  // x64 addon in an arm64 tree.
  const wrong = probeNative(buildSo({ machine: 62, needed: ['libc.so'] }))
  assert.equal(wrong.arch, 'x64')
  assert.equal(wrong.verdict, 'wrong-arch')

  assert.equal(probeNative(Buffer.from('not an elf')).ok, false)
})

await test('dependency resolution says which NEEDED entry is actually absent', () => {
  const dir = join(ROOT, 'addon-dir')
  write(join(dir, 'libz.so'), 'x')
  const resolution = resolveNeeded(['libc.so', 'libz.so'], [dir, join(ROOT, 'nowhere')])
  assert.deepEqual(resolution.resolved.map(item => item.name), ['libz.so'])
  assert.deepEqual(resolution.missing, ['libc.so'])
})

await test('a plugin that would kill the host is refused before install, with file and line', () => {
  // The v04-throw-async shape: async apply that throws. Returning a rejected promise
  // the loader never awaits ends the host process — no failure page, no rescue hook.
  const throwing = scanText([
    'export const name = "brick"',
    'export async function apply(ctx) {',
    '  throw new Error("brick")',
    '}',
  ].join('\n'), 'lib/index.js')
  assert.equal(throwing.length, 1)
  assert.equal(throwing[0].kind, 'async-apply-throws')
  assert.equal(throwing[0].line, 2)
  const verdict = summariseHostRisk(throwing, { scanned: 1 })
  assert.equal(verdict.level, 'host-killing')

  // The exact `dshm-brickpack/v04-throw-async` source, verbatim. Not `async`, so it
  // is only caught by the returned-rejection rule.
  const v04 = summariseHostRisk(scanText([
    "export const name = 'v04-throw-async';",
    'export function apply(ctx) {',
    "  return Promise.reject(new Error('dshm-brickpack deliberate async throw'));",
    '}',
  ].join('\n'), 'lib/index.js'))
  assert.equal(v04.level, 'host-killing')
  assert.ok(v04.kinds.includes('apply-returns-rejection'))

  // process.exit inside a plugin.
  const exits = summariseHostRisk(scanText('export function apply() { process.exit(1) }', 'lib/index.js'))
  assert.equal(exits.level, 'host-killing')
  assert.ok(exits.kinds.includes('kills-host'))

  // A promise nobody settles parks the install forever.
  const parked = summariseHostRisk(scanText('await new Promise(() => {})', 'lib/index.js'))
  assert.equal(parked.level, 'host-killing')
  assert.ok(parked.kinds.includes('parks-forever'))

  // False positives are the expensive failure mode here: a rule that disables a working
  // plugin is worse than no rule. `dsh-pet` carries process.exit in an Electron helper,
  // a standalone CLI and a build script — none of them runs in the host.
  assert.equal(isScannableSource('src/standalone/cli.ts'), false)
  assert.equal(isScannableSource('src/host/routes.test.ts'), false)
  assert.equal(isScannableSource('runtime/electron-helper/main.js'), false)
  assert.equal(isScannableSource('lib/index.js'), true)
  // `r.ok ? r.json() : Promise.reject(...)` inside a .then is idiomatic when the chain
  // has a catch — not a finding.
  assert.deepEqual(scanText('fetch(u).then(r => r.ok ? r.json() : Promise.reject(new Error("x"))).catch(() => {})', 'lib/index.js'), [])
  assert.equal(scanText('Promise.reject(new Error("x"))', 'lib/index.js').length, 1)

  // Ordinary plugins stay installable: suspicion is not a refusal.
  const clean = summariseHostRisk(scanText('export function apply(ctx) { ctx.on("x", () => {}) }', 'lib/index.js'))
  assert.equal(clean.level, 'safe')
  const suspect = summariseHostRisk(scanText('throw new Error("boom")', 'lib/index.js'))
  assert.equal(suspect.level, 'suspect')
  assert.equal(suspect.note.includes('没有命中致命项'), true)
})

await test('host-risk scans only what the bundle can load: skills, server subprocesses and disabled rows are out', async () => {
  // a) Skill bundle assets (bundledSkillDir style): prompt packs + skill CLIs that the
  //    host never imports. process.exit there is a CLI's correct lifecycle.
  const skillsPkg = tarball('reach-skills-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'reach-skills', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: reach-skills\n      name: reach-skills\n      config:\n        bundledSkillDir: skills\n',
    'lib/index.js': 'export function apply() {}\n',
    'skills/reach/renderers/danger.mjs': 'export function render() { process.exit(1) }\n',
  })
  const skillsReport = await analyze(skillsPkg, { textScan: true })
  // Reachable-or-not only changes the WEIGHT, never the visibility: the CLI's
  // process.exit still surfaces, as a hint that does not block the install.
  assert.equal(skillsReport.signals.hostRisk.level, 'suspect', JSON.stringify(skillsReport.signals.hostRisk))
  assert.equal(skillsReport.signals.hostRisk.fatalCount, 0)

  // b) A row shipped `disabled: true` never loads: the async-apply-throw behind it is out.
  const disabledRow = tarball('reach-disabled-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'reach-disabled', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
    'cordis.patch.yml': "- insert:\n    - id: scope\n      name: 'reach-disabled/scope-limits'\n      disabled: true\n",
    'lib/index.js': 'export function apply() {}\n',
    'scope-limits.mjs': 'export async function apply(ctx) { throw new Error("boom") }\n',
  })
  const disabledReport = await analyze(disabledRow, { textScan: true })
  assert.equal(disabledReport.signals.hostRisk.level, 'suspect', JSON.stringify(disabledReport.signals.hostRisk))
  assert.equal(disabledReport.signals.hostRisk.fatalCount, 0)
  assert.ok(disabledReport.signals.hostRisk.findings.every(f => f.why.includes('降级为提示')))

  // c) A stdio server subprocess the host never imports: process.exit is its lifecycle.
  const serverPkg = tarball('reach-server-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'reach-server', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: reach-server\n      name: reach-server\n',
    'lib/index.js': 'export function apply() {}\n',
    'servers/mcp-proxy.mjs': 'import { run } from "../shared/mcp-proxy-core.mjs"\nrun()\n',
    'shared/mcp-proxy-core.mjs': 'export async function run() { process.exit(0) }\n',
  })
  const serverReport = await analyze(serverPkg, { textScan: true })
  assert.equal(serverReport.signals.hostRisk.level, 'suspect', JSON.stringify(serverReport.signals.hostRisk))
  assert.equal(serverReport.signals.hostRisk.fatalCount, 0)

  // d) Negative control: reachability must not LOSE a killer the host really loads.
  const livePkg = tarball('reach-live-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'reach-live', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: reach-live\n      name: reach-live\n',
    'lib/index.js': 'import { die } from "./danger.js"\nexport function apply() { die() }\n',
    'lib/danger.js': 'export function die() { process.exit(1) }\n',
  })
  const liveReport = await analyze(livePkg, { textScan: true })
  assert.equal(liveReport.signals.hostRisk.level, 'host-killing')

  // e2) No `main` at all — the entry lives in package exports, and the disabled
  //     row's subpath resolves through `./scope-limits` there (the dsh-aris shape).
  const exportsPkg = tarball('reach-exports-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'reach-exports', version: '1.0.0',
      exports: { '.': './dsh/index.mjs', './scope-limits': './dsh/scope-limits.mjs' },
      dsh: { bundle: { patch: './dsh/cordis.patch.yml' } },
    }) + '\n',
    'dsh/cordis.patch.yml': "- insert:\n    - id: main\n      name: 'reach-exports'\n    - id: scope\n      name: 'reach-exports/scope-limits'\n      disabled: true\n",
    'dsh/index.mjs': 'export function apply() {}\n',
    'dsh/scope-limits.mjs': 'export async function apply(ctx) { throw new Error("boom") }\n',
  })
  const exportsReport = await analyze(exportsPkg, { textScan: true })
  assert.equal(exportsReport.signals.hostRisk.level, 'suspect', JSON.stringify(exportsReport.signals.hostRisk))
  assert.equal(exportsReport.signals.hostRisk.fatalCount, 0)
  // …and the exports-resolved main is genuinely scanned: a killer there is caught.
  const exportsLivePkg = tarball('reach-exports-live-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'reach-exports-live', version: '1.0.0',
      exports: { '.': './dsh/index.mjs' },
      dsh: { bundle: { patch: './dsh/cordis.patch.yml' } },
    }) + '\n',
    'dsh/cordis.patch.yml': "- insert:\n    - id: main\n      name: 'reach-exports-live'\n",
    'dsh/index.mjs': 'export async function apply(ctx) { throw new Error("boom") }\n',
  })
  const exportsLiveReport = await analyze(exportsLivePkg, { textScan: true })
  assert.equal(exportsLiveReport.signals.hostRisk.level, 'host-killing')

  // e) No resolvable entry ⇒ fell back to the path-based scan, never to scanning nothing.
  const barePkg = tarball('reach-bare-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'reach-bare', version: '1.0.0', dsh: { bundle: {} } }) + '\n',
    'lib/index.js': 'export function apply() { process.exit(1) }\n',
  })
  const bareReport = await analyze(barePkg, { textScan: true })
  assert.equal(bareReport.signals.hostRisk.level, 'host-killing')
})

await test('patchRows reads name and disabled from flat cordis row blocks', () => {
  const rows = patchRows([
    '- insert:',
    '    - id: a',
    "      name: 'pkg/entry'",
    '    - id: b',
    "      name: 'pkg/gone'",
    '      disabled: true',
  ].join('\n'))
  assert.deepEqual(rows, [
    { name: 'pkg/entry', disabled: false },
    { name: 'pkg/gone', disabled: true },
  ])
})

await test('conversion warns about bare imports the boot will not resolve', async () => {
  const offline = Object.assign(async () => { throw new Error('offline fixture') }, {})
  const gapPkg = tarball('gap-warn-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'gap-warn', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: gap-warn\n      name: gap-warn\n',
    'lib/index.js': 'import { x } from "totally-missing-bare-dep"\nexport function apply() { return x }\n',
  })
  // The orphan-vendor pass must degrade to a warning when the registry cannot help —
  // and must not reach the real network while doing it.
  const gapConverted = await convert(gapPkg, {
    report: await analyze(gapPkg, { textScan: false }),
    resolve: offline,
    load: offline,
  })
  assert.equal(gapConverted.status, 'ok')
  assert.ok(
    gapConverted.warnings.some(w => w.includes('闭包缺口') && w.includes('totally-missing-bare-dep')),
    JSON.stringify(gapConverted.warnings),
  )

  // A declared peer dependency is the runtime's job — never a gap.
  const peerPkg = tarball('gap-peer-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'gap-peer', version: '1.0.0', main: 'lib/index.js',
      peerDependencies: { react: '^18.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: gap-peer\n      name: gap-peer\n',
    'lib/index.js': 'export function apply() {}\n',
    'lib/client.js': 'import { h } from "react"\nexport const el = h("p")\n',
  })
  const peerConverted = await convert(peerPkg, { report: await analyze(peerPkg, { textScan: false }) })
  assert.equal(peerConverted.status, 'ok')
  assert.equal(peerConverted.warnings.some(w => w.includes('react')), false, JSON.stringify(peerConverted.warnings))

  // A carried (vendored) dependency resolves in the tree — not a gap either.
  const vendoredPkg = tarball('gap-vendored-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'gap-vendored', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: gap-vendored\n      name: gap-vendored\n',
    'lib/index.js': 'export { one } from "carried-dep/index.js"\nfunction one() { return 1 }\n',
    'node_modules/carried-dep/package.json': '{"name":"carried-dep","version":"1.0.0","main":"index.js"}\n',
    'node_modules/carried-dep/index.js': 'export const one = 1\n',
  })
  const vendoredConverted = await convert(vendoredPkg, { report: await analyze(vendoredPkg, { textScan: false }) })
  assert.equal(vendoredConverted.status, 'ok')
  assert.equal(vendoredConverted.warnings.some(w => w.includes('carried-dep')), false, JSON.stringify(vendoredConverted.warnings))
})

await test('a catalog name missing from npm retries through the recorded repository', async () => {
  // The index is the community catalog; entries it harvests from GitHub carry a repo
  // even when the npm name was never published (or was unpublished since).
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'index-fallback') }
  write(join(env.DSHM_COMPAT_DIR, 'index', 'current.json'), JSON.stringify({
    version: 1, count: 1,
    entries: [{ name: 'catalog-only', repo: 'https://github.com/o/catalog-only' }],
  }))
  const calls = []
  const retry = await retryViaIndex(
    { kind: 'npm', text: 'catalog-only' },
    { env, resolve: async text => { calls.push(text); return { kind: 'github', name: 'o/catalog-only', version: '' } } },
  )
  assert.deepEqual(calls, ['https://github.com/o/catalog-only'])
  assert.equal(retry?.viaIndex, 'https://github.com/o/catalog-only')
  assert.equal(retry?.resolved.kind, 'github')

  // No index on the device, or an entry without a repo, or a non-GitHub repo:
  // all fall through to the ordinary not-found path.
  assert.equal(await retryViaIndex({ kind: 'npm', text: 'catalog-only' }, { env: {}, resolve: async () => ({}) }), undefined)
  const emptyDirEnv = { DSHM_COMPAT_DIR: join(ROOT, 'index-fallback-empty') }
  write(join(emptyDirEnv.DSHM_COMPAT_DIR, 'index', 'current.json'), JSON.stringify({ version: 1, count: 0, entries: [] }))
  assert.equal(await retryViaIndex({ kind: 'npm', text: 'catalog-only' }, { env: emptyDirEnv, resolve: async () => ({}) }), undefined)
  // A URL or a local path is already a spec — the retry never applies to them.
  assert.equal(await retryViaIndex({ kind: 'github', text: 'github.com/o/r' }, { env, resolve: async () => ({}) }), undefined)
})

await test('orphan imports the registry can satisfy are vendored automatically', async () => {
  const dep = tarball('orphan-dep-1.0.0.tgz', {
    'package.json': '{"name":"orphan-dep","version":"1.0.0","main":"index.js"}\n',
    'index.js': 'module.exports = { x: 1 }\n',
  })
  const file = tarball('orphan-importer-1.0.0.tgz', {
    'package.json': JSON.stringify({ name: 'orphan-importer', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: orphan-importer\n      name: orphan-importer\n',
    'lib/index.js': 'import { x } from "orphan-dep"\nexport function apply() { return x }\n',
  })
  const converted = await convert(file, {
    report: await analyze(file, { textScan: false }),
    resolve: async spec => {
      assert.equal(spec, 'orphan-dep@*')
      return { name: 'orphan-dep', version: '1.0.0', buffer: readFileSync(dep) }
    },
    load: async resolved => resolved.buffer,
  })
  assert.equal(converted.status, 'ok')
  assert.ok(converted.changed.some(item => item.includes('auto-vendored undeclared import orphan-dep@1.0.0')), JSON.stringify(converted.changed))
  assert.ok(converted.warnings.some(w => w.includes('自动携带') && w.includes('orphan-dep@1.0.0')), JSON.stringify(converted.warnings))
  // The gap is gone: the vendored tree now resolves the bare import.
  assert.equal(converted.warnings.some(w => w.includes('闭包缺口') && w.includes('orphan-dep')), false, JSON.stringify(converted.warnings))
  const { entries } = extractTar(readFileSync(converted.tarball))
  assert.ok(entries.some(entry => entry.path === 'package/node_modules/orphan-dep/package.json'))
})

await test('the market blocks a host-killing plugin and names the evidence', async () => {
  const file = tarball('brick-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'brick',
      version: '1.0.0',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: brick\n      name: brick\n',
    'lib/index.js': 'export const name = "brick"\nexport async function apply(ctx) {\n  throw new Error("brick")\n}\n',
  })
  const result = await marketAdapt(file, { dryRun: true, env: { DSHM_COMPAT_DIR: join(ROOT, 'brick-compat') } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.hostRisk.level, 'host-killing')
  assert.ok(result.message.includes('宿主进程'))
  assert.ok(result.message.includes('lib/index.js:2'))
  assert.ok(result.nextSteps[0].includes('作者'))
})

await test('npm subdirectory specs resolve to the subtree, not the repository root', () => {
  const spec = parseGithubSpec('github:huangshou1/dshm-brickpack#main&path:/v04-throw-async')
  assert.deepEqual(spec, { owner: 'huangshou1', repo: 'dshm-brickpack', ref: 'main', subdir: 'v04-throw-async' })

  assert.deepEqual(parseGithubSpec('github:owner/repo'), { owner: 'owner', repo: 'owner'.length ? 'repo' : '' })
  assert.deepEqual(parseGithubSpec('https://github.com/owner/repo.git#v1'), { owner: 'owner', repo: 'repo', ref: 'v1' })
  assert.deepEqual(parseGithubSpec('github:owner/repo#path:/packages/a'), { owner: 'owner', repo: 'repo', subdir: 'packages/a' })

  // A github.com URL typed without the scheme must parse the same as with it.
  assert.deepEqual(parseGithubSpec('github.com/owner/repo'), { owner: 'owner', repo: 'repo' })
  assert.deepEqual(parseGithubSpec('www.github.com/owner/repo#v2'), { owner: 'owner', repo: 'repo', ref: 'v2' })

  // Scoped npm packages must never be mistaken for GitHub specs.
  assert.equal(parseGithubSpec('@scope/name'), undefined)

  // Dot segments would build an API URL that silently normalizes to a
  // different path — refuse them instead of resolving a lie.
  assert.equal(parseGithubSpec('github.com/../etc'), undefined)
  assert.equal(parseGithubSpec('github.com/o/..'), undefined)
})

await test('an installed host-killing bundle is quarantined in the rows file, idempotently', () => {
  const profile = join(ROOT, 'guard-profile')
  const pkgDir = join(profile, 'node_modules', 'brick')
  write(join(pkgDir, 'package.json'), JSON.stringify({ name: 'brick', version: '1.0.0', main: 'lib/index.js' }))
  write(join(pkgDir, 'cordis.patch.yml'), '- insert:\n    - id: brick\n      name: brick\n')
  write(join(pkgDir, 'lib', 'index.js'), [
    "export const name = 'brick'",
    'export function apply(ctx) {',
    "  return Promise.reject(new Error('boom'))",
    '}',
  ].join('\n'))
  // A second, harmless bundle must survive the sweep untouched.
  write(join(profile, 'node_modules', 'quiet', 'package.json'), JSON.stringify({ name: 'quiet', version: '1.0.0' }))
  write(join(profile, 'node_modules', 'quiet', 'cordis.patch.yml'), '- insert:\n    - id: quiet\n      name: quiet\n')
  write(join(profile, 'node_modules', 'quiet', 'lib', 'index.js'), 'export function apply() {}\n')

  const report = guardInstalled({ profileDir: profile })
  assert.equal(report.status, 'ok')
  assert.equal(report.counts.bundles, 2)
  assert.equal(report.counts.dangerous, 1)
  assert.equal(report.packages[0].package, 'brick')
  assert.ok(report.note.includes('apply:true'))

  const applied = guardInstalled({ profileDir: profile, apply: true })
  const rowWritten = applied.actions.find(item => item.package === 'brick')
  assert.equal(rowWritten.changed, true)
  const rows = readFileSync(join(profile, '.dshm-plugin-rows.yml'), 'utf8')
  assert.ok(rows.includes('- id: brick'))
  assert.ok(rows.includes('disabled: true'))
  assert.equal(rows.includes('quiet'), false, 'a safe bundle must not be disabled')

  // Second run: already disbled → no duplicate entry, no change.
  const again = guardInstalled({ profileDir: profile, apply: true })
  assert.equal(again.actions[0].changed, false)
  assert.equal(readFileSync(join(profile, '.dshm-plugin-rows.yml'), 'utf8').match(/- id: brick/g).length, 1)
})

await test('quarantine flips an existing enabled row instead of adding a contradictory one', () => {
  const profile = join(ROOT, 'guard-flip')
  write(join(profile, '.dshm-plugin-rows.yml'), '# user rows\n- id: brick\n  disabled: false\n')
  const flipped = quarantineRow(profile, 'brick')
  assert.equal(flipped.changed, true)
  const text = readFileSync(join(profile, '.dshm-plugin-rows.yml'), 'utf8')
  assert.equal(text.match(/- id: brick/g).length, 1)
  assert.ok(text.includes('disabled: true'))
  assert.equal(quarantineRow(profile, 'brick').changed, false)
})

await test('the host log is found beside $DSH_HOME, not only inside it', () => {
  /*
   * The layout that made every install verdict "unknown": on the phone profile
   * `$DSH_HOME` is `<…>/files/dsh/home` and the log is `<…>/files/dshm-host.log`.
   * A reader that joins `home + 'dshm-host.log'` reports "no host log found" while
   * the file sits two directories up.
   */
  const files = join(ROOT, 'el2', 'haps', 'some-module', 'files')
  const home = join(files, 'dsh', 'home')
  write(join(home, 'host-ready.json'), JSON.stringify({ runtime: {} }) + '\n')
  write(join(files, 'dshm-host.log'), [
    'dsh-rewind: pending (waiting for service: conversationEvents)',
    '探针读数（日志副本）：runtime={terminal} realShell=true，libsExec=false',
    '',
  ].join('\n'))

  const pending = pendingFromLogs({ DSHM_HOME: home })
  assert.equal(pending.ok, true, 'the sibling log must be found from $DSH_HOME')
  assert.equal(pending.files[0], join(files, 'dshm-host.log'))
  assert.equal(pending.pending[0].service, 'conversationEvents')

  const readout = readHostLogFacts({ DSHM_HOME: home })
  assert.equal(readout?.file, join(files, 'dshm-host.log'))

  // The same-name-inside-home layout must keep working (it is what every older
  // test fixture and any desktop checkout writes).
  const inline = join(ROOT, 'inline-home')
  write(join(inline, 'dshm-host.log'), 'x: pending (waiting for service: y)\n')
  assert.equal(pendingFromLogs({ DSHM_HOME: inline }).ok, true)

  // The miss has to say where it looked; "no host log found" alone sent the last
  // reader hunting for a file that was in the same tree.
  const empty = join(ROOT, 'empty-home', 'dsh', 'home')
  mkdirSync(empty, { recursive: true })
  const miss = pendingFromLogs({ DSHM_HOME: empty })
  assert.equal(miss.ok, false)
  assert.ok(miss.reason.includes('looked in'), miss.reason)
  assert.ok(Array.isArray(miss.looked) && miss.looked.length > 1)
})

await test('a log path declared by the host wins over the derived candidates', () => {
  const home = join(ROOT, 'declared-home')
  const declared = join(ROOT, 'declared-elsewhere', 'dshm-host.log')
  write(declared, 'dsh-rewind: pending (waiting for service: declaredService)\n')
  // $DSH_HOME has no log of its own; only the declaration points at one.
  write(join(home, 'host-ready.json'), JSON.stringify({ runtime: {}, log: declared }) + '\n')
  const pending = pendingFromLogs({ DSHM_HOME: home })
  assert.equal(pending.ok, true)
  assert.equal(pending.files[0], declared)
  assert.equal(pending.pending[0].service, 'declaredService')
})

await test('asset names keep exactly the part before the appended pax metadata', () => {
  // Every string below is copied from a device readout of the broken installer, so
  // this pins the *actual* damage, not a paraphrase of it.
  assert.equal(repairedName('三球抛接.webm\n19 mtim'), '三球抛接.webm')
  assert.equal(repairedName('中秋赏月吃月饼.webm\n19 mtime=4991'), '中秋赏月吃月饼.webm')
  assert.equal(repairedName('余额-分文不剩.webm\n19 mtime=49'), '余额-分文不剩.webm')
  assert.equal(repairedName('上首软糖体.ttf\n19 mtime='), '上首软糖体.ttf')
  assert.equal(repairedName('token给妈妈保管.png\n19 mtime='), 'token给妈妈保管.png')
  // A clean name is not a repair candidate — inventing one would rename real files.
  assert.equal(repairedName('Ciallo.png'), undefined)
  assert.equal(repairedName('cursor-grab.png'), undefined)
  // Nothing before the control character: cannot be proven, so it is left alone.
  assert.equal(repairedName('\n19 mtime='), undefined)
})

await test('the asset repair renames by name only, never overwrites, and is idempotent', () => {
  /*
   * Windows cannot hold a control character in a file name, so the tree is injected
   * through the module's filesystem seam. The logic under test — which entries count
   * as broken, what the target is, what happens on a collision — is identical either
   * way, and the real-fs path is covered by the clean-profile test below.
   */
  const root = join(ROOT, 'asset-fake', 'node_modules')
  const pkg = join(root, 'sample-plugin')
  const webm = join(pkg, 'assets', 'webm')
  const dirs = new Set([root, pkg, join(pkg, 'assets'), webm])
  const entries = {
    [root]: ['sample-plugin'],
    [pkg]: ['assets'],
    [join(pkg, 'assets')]: ['webm'],
    [webm]: [
      '东张西望.webm\n19 mtime=499162500',
      'Ciallo.png',
      'collide.webm',
      'collide.webm\n19 mtim',
    ],
  }
  const readdir = dir => (entries[dir] ?? []).map(name => ({
    name,
    isDirectory: () => dirs.has(join(dir, name)),
    isSymbolicLink: () => false,
  }))
  const exists = candidate => dirs.has(candidate)
    || Object.entries(entries).some(([dir, names]) => names.some(name => join(dir, name) === candidate))
  const rename = (from, to) => {
    const dir = Object.keys(entries).find(candidate => entries[candidate].some(name => join(candidate, name) === from))
    assert.ok(dir !== undefined, `rename source not in the fixture: ${from}`)
    entries[dir] = entries[dir].map(name => (join(dir, name) === from ? to.slice(dir.length + 1) : name))
  }

  const scan = scanAssetNames(root, { readdir, exists })
  assert.equal(scan.status, 'ok')
  assert.equal(scan.broken.length, 2)
  assert.equal(scan.broken.every(item => item.shouldBe === item.name.split('\n')[0]), true)

  // A dry run reports the rename and performs none of it.
  const dry = repairAssetNames(root, { readdir, exists, rename, dryRun: true })
  assert.equal(dry.counts.repaired, 1)
  assert.equal(dry.repaired[0].dryRun, true)
  assert.ok(entries[webm].includes('东张西望.webm\n19 mtime=499162500'), 'a dry run must not touch the disk')

  const repaired = repairAssetNames(root, { readdir, exists, rename })
  assert.equal(repaired.counts.repaired, 1, 'only the non-colliding name may be renamed')
  assert.equal(repaired.counts.skipped, 1, 'a name whose target exists is reported, never overwritten')
  assert.ok(repaired.skipped[0].reason.includes('already exists'))
  assert.deepEqual(entries[webm].slice(0, 2).sort(), ['Ciallo.png', '东张西望.webm'])
  // The clean file and the colliding one are still where they were.
  assert.ok(entries[webm].includes('collide.webm'))
  assert.ok(entries[webm].includes('collide.webm\n19 mtim'))

  const again = repairAssetNames(root, { readdir, exists, rename })
  assert.equal(again.counts.repaired, 0, 'a second run must not rename anything')
})

await test('a clean profile audits as clean instead of as "nothing checked"', () => {
  const profile = join(ROOT, 'asset-clean-profile')
  write(join(profile, 'node_modules', 'quiet', 'assets', 'Ciallo.png'), 'png')
  write(join(profile, 'node_modules', 'quiet', 'package.json'), '{"name":"quiet"}\n')
  const audit = auditAssets(profile)
  assert.equal(audit.status, 'ok')
  assert.equal(audit.verdict, 'clean')
  assert.equal(audit.broken.length, 0)
  assert.ok(audit.scanned > 0)
  // The result must say what a clean scan does *not* prove.
  assert.ok(audit.limits.includes('100 bytes'))
})

await test('compat_audit reports a profile through the tool surface', async () => {
  const tools = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    effect(callback) { return callback() },
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {} },
  }
  applyPlugin(ctx)
  const tool = tools.find(item => item.name === 'compat_audit')
  assert.ok(tool !== undefined, 'compat_audit must be registered')

  const profile = join(ROOT, 'asset-tool-profile')
  write(join(profile, 'node_modules', 'quiet', 'assets', 'ok.webm'), 'webm')
  const value = await tool.execute({ profileDir: profile }, {})
  assert.equal(value.status, 'ok')
  assert.equal(value.verdict, 'clean')
  assert.equal(value.broken.length, 0)
  assert.equal(hasUndefined(value), false, 'tool output must not carry undefined values')

  const missing = await tool.execute({ profileDir: join(ROOT, 'asset-tool-missing') }, {})
  assert.equal(missing.status, 'missing')
})


await test('a client service provided from the profile is found, not called missing', () => {
  /*
   * dsh-pet@0.3.8 was blocked on `client:connection` while
   * `@deepseek-ai/dsh-client-connection/lib/client.js` contains
   * `ctx.provide("connection", handle)`. The package is resolved for the plugin that
   * names it in `dsh.client.inject`, so it sits in the *profile's* node_modules — and
   * the scan only ever looked at the core tree.
   */
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'svc-roots-compat') }
  const core = join(ROOT, 'svc-roots-core')
  write(join(core, 'node_modules', 'ui', 'lib', 'client.js'), 'super(ctx, "slots")\n')
  const profile = join(ROOT, 'svc-roots-profile')
  write(join(profile, 'node_modules', 'conn', 'lib', 'client.js'), 'ctx.provide("connection", handle)\n')

  const coreOnly = clientServiceNames({ nodeModules: join(core, 'node_modules'), version: 'roots-1' }, { env })
  assert.deepEqual(coreOnly.names, ['slots'], 'the core tree alone cannot see the profile provider')

  const both = clientServiceNames({ nodeModules: join(core, 'node_modules'), version: 'roots-1' }, { env, profileDir: profile })
  assert.ok(both.names.includes('connection'), 'the profile node_modules must be scanned too')
  assert.ok(both.names.includes('slots'))

  const compared = compareServices(
    { client: { required: ['connection', 'remote'], optional: [] } },
    { host: ['tools'], client: both },
  )
  assert.deepEqual(compared.missingClient, ['remote'])
  assert.deepEqual(compared.unknownClient, [])
})

await test('an inventory it could not build is reported, never counted as "provides nothing"', () => {
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'svc-empty-compat') }
  const bare = join(ROOT, 'svc-empty-core')
  write(join(bare, 'node_modules', 'plain', 'index.js'), 'export const a = 1\n')

  const none = clientServiceNames({ nodeModules: join(bare, 'node_modules'), version: 'empty-1' }, { env })
  assert.equal(none.ok, false, 'zero bundles read must not be presented as a verified empty inventory')
  assert.ok(none.reason.includes('no client bundle'), none.reason)

  const compared = compareServices(
    { client: { required: ['connection', 'remote'], optional: [] } },
    { host: ['tools'], client: none },
  )
  assert.deepEqual(compared.missingClient, [], 'an unread inventory must not veto the install')
  assert.deepEqual(compared.unknownClient, ['connection', 'remote'], 'but it must be reported as unchecked')
  assert.equal(compared.ok, true)
  assert.equal(compared.verified.client, false)
})

await test('a client bundle named something else is still found by its loader marker', () => {
  const env = { DSHM_COMPAT_DIR: join(ROOT, 'svc-marker-compat') }
  const odd = join(ROOT, 'svc-marker-core')
  // No file named client.js anywhere: only the cheap name pass fails, the marker pass must catch it.
  write(join(odd, 'node_modules', 'p', 'dist', 'bundle.mjs'),
    'window.__ModuleLoader__.load({ id: "p", factory: () => { ctx.provide("xfade", handle) } })\n')

  const found = clientServiceNames({ nodeModules: join(odd, 'node_modules'), version: 'marker-1' }, { env })
  assert.equal(found.ok, true)
  assert.deepEqual(found.names, ['xfade'])
  assert.equal(found.pass2, true, 'the fallback pass has to be reported, not silent')
})

await test('the market warns about an unread client inventory instead of blocking', async () => {
  const file = tarball('svc-unknown-1.0.0.tgz', {
    'package.json': JSON.stringify({
      name: 'svc-unknown',
      version: '1.0.0',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: svc-unknown\n      name: svc-unknown\n',
    'lib/index.js': 'export const name = "svc-unknown"\nexport function apply() {}\n',
    'lib/client.js': 'const inject = ["connection"];\n',
  })
  // No core tree and no profile → the client inventory cannot be built.
  const result = await marketAdapt(file, { dryRun: true, env: { DSHM_COMPAT_DIR: join(ROOT, 'svc-unknown-compat') } })
  assert.notEqual(result.status, 'blocked', 'unverified is not the same as broken')
  assert.deepEqual(result.services.unknownClient, ['connection'])
  assert.deepEqual(result.services.missingClient, [])
  assert.ok(result.warnings.some(warning => warning.includes('无法验证')), JSON.stringify(result.warnings))
})


await test('the full index compacts, de-dupes and searches without touching the network', () => {
  const base = {
    version: '1.0.0',
    repository: 'https://github.com/o/r',
    publishedAt: '2026-11-01T00:00:00Z',
    unpackedSize: 1024,
    catalog: { category: 'ui', summary: { zh: '中文摘要', en: 'english' }, capabilities: ['net', 'fs'] },
  }
  // Stars live under three key shapes upstream; all three must resolve.
  assert.equal(compactEntry({ name: 'x', ...base }, { 'o/r': 7 }).stars, 7)
  assert.equal(compactEntry({ name: 'x', ...base }, { x: 3 }).stars, 3)
  assert.equal(compactEntry({ name: 'x', ...base }, {}).stars, 0)
  assert.equal(compactEntry({ name: 'x', ...base }, { 'o/r': 7 }).desc, '中文摘要')

  /*
   * Duplicate rows come from commit-hash versions harvested off tarballs: they look
   * newer and carry no repository. Keeping them blindly set stars to 0 — `dsh-pet`
   * with 5,493 stars fell out of the "pet" search until the evidenced row won.
   */
  const deduped = dedupeByName([
    { name: 'p', repo: 'https://github.com/o/r', desc: 'real', published: '2026-10-01' },
    { name: 'p', published: '2026-11-02' },
  ])
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].repo, 'https://github.com/o/r')

  const index = {
    entries: [
      { name: 'a', desc: '搜索 插件', category: 'ui', stars: 5, caps: [] },
      { name: 'b', desc: 'tool', category: 'tool', stars: 9, caps: ['net'] },
    ],
  }
  assert.equal(searchIndex(index, { query: '搜索' }).total, 1)
  assert.equal(searchIndex(index, { category: 'tool' }).entries[0].name, 'b')
  assert.equal(searchIndex(index, { limit: 1 }).entries[0].name, 'b')
  assert.deepEqual(categoryCounts(index).map(item => item.category).sort(), ['tool', 'ui'])
})

await test('the single input box accepts names, URLs and phrases without erroring', async () => {
  assert.equal(classifyInput('https://github.com/o/r/tree/main/pack').kind, 'github')
  assert.equal(classifyInput('github.com/o/r').kind, 'github')
  assert.equal(classifyInput('github:o/r#main').kind, 'github')
  assert.equal(classifyInput('o/r').kind, 'github')
  assert.equal(classifyInput('dsh-pet').kind, 'npm')
  assert.equal(classifyInput('@michengai/dsh-archive-manager').kind, 'npm')
  // Version-pinned specs are npm specs (parseNpmSpec accepts the range), not phrases.
  assert.equal(classifyInput('dsh-pet@0.3.8').kind, 'npm')
  assert.equal(classifyInput('@scope/pkg@1.2.3').kind, 'npm')
  assert.equal(classifyInput('pkg@').kind, 'npm') // empty range = latest, as parseNpmSpec reads it
  assert.equal(classifyInput('pkg@1.0 beta').kind, 'phrase') // whitespace cannot be a range
  assert.equal(classifyInput('@avenue').kind, 'phrase') // '@' without a name half is not a spec
  assert.equal(classifyInput('https://example.com/x.tgz').kind, 'url')
  assert.equal(classifyInput('D:\\tmp\\x.tgz').kind, 'path')
  assert.equal(classifyInput('桌宠 插件').kind, 'phrase')
  assert.equal(classifyInput('   ').kind, 'empty')

  const env = { DSHM_COMPAT_DIR: join(ROOT, 'intake-compat') }
  write(join(env.DSHM_COMPAT_DIR, 'index', 'current.json'), JSON.stringify({
    version: 'test', count: 2,
    entries: [
      { name: 'dsh-pet', desc: '桌宠', category: 'ui', stars: 5493 },
      { name: 'dsh-pet-lite', desc: '轻量桌宠', category: 'ui', stars: 12 },
    ],
  }))

  // A phrase never touches the resolver: it is a search, not a spec.
  let resolveCalls = 0
  const phrase = await resolveIntake('桌宠', { env, resolve: async () => { resolveCalls += 1 } })
  assert.equal(phrase.status, 'suggest')
  assert.equal(resolveCalls, 0)

  /*
   * A spec that cannot resolve says so and stops. Deliberate: the first version offered
   * fuzzy candidates, and `dsh-pett` came back headed by an unrelated popular package —
   * which reads as "this exists, try it". dshmarket answers the same way, and its own
   * local-match module is built to "refuse the same wrong guesses".
   */
  const missing = await resolveIntake('dsh-pett', {
    env,
    resolve: async () => { throw new Error('404 Not Found') },
  })
  assert.equal(missing.status, 'not-found')
  assert.equal(missing.message, '未找到该项目：dsh-pett')
  assert.equal(missing.reason, '404 Not Found')
  assert.equal(missing.suggestions, undefined)

  // A bad URL gets the same sentence, not the registry's wording.
  const badUrl = await resolveIntake('https://github.com/o', {
    env,
    resolve: async () => { throw new Error('unsupported GitHub spec') },
  })
  assert.equal(badUrl.status, 'not-found')
  assert.ok(badUrl.message.startsWith('未找到该项目'))
  assert.ok(badUrl.hint.includes('确认地址能打开'))

  // A real search phrase still searches — strictly, by substring.
  const phraseHit = await resolveIntake('桌宠', { env })
  assert.equal(phraseHit.status, 'suggest')
  assert.ok(phraseHit.suggestions.entries.length >= 1)

  // Nothing found for a phrase is the same "not found", not an empty list.
  const phraseMiss = await resolveIntake('不存在的关键词', { env })
  assert.equal(phraseMiss.status, 'not-found')

  // Empty input is a prompt for input, not a failure.
  const empty = await resolveIntake('  ')
  assert.equal(empty.status, 'empty')
})

await test('market returns need-input for an empty box instead of an error page', async () => {
  const result = await marketAdapt('   ', { dryRun: true, env: { DSHM_COMPAT_DIR: join(ROOT, 'empty-compat') } })
  assert.equal(result.status, 'need-input')
  assert.equal(result.stage, 'resolve')
  assert.deepEqual(result.steps.map(step => `${step.step}:${step.status}`), ['resolve:waiting'])
})

await test('the browser-side compaction keeps the same rule as the host', () => {
  /*
   * The tab cannot import host code (it is a separate bundle), so `compactRows` is a
   * port. A port that drifts silently is worse than no port: the page would rank
   * plugins differently from the tool. Pull the function out of the bundle and run the
   * same fixtures the host test uses.
   */
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('function compactRows(')
  assert.ok(start > 0, 'compactRows not found in the client bundle')
  let depth = 0
  let end = start
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) { end = index + 1; break }
    }
  }
  const compactRows = new Function(`${source.slice(start, end)}; return compactRows`)()
  const rows = compactRows([
    {
      name: 'p', version: '1.0.0', repository: 'https://github.com/o/r', publishedAt: '2026-10-01T00:00:00Z',
      catalog: { category: 'ui', summary: { zh: '有仓库的那条' } },
    },
    { name: 'p', version: 'abc123', publishedAt: '2026-11-02T00:00:00Z', catalog: { summary: {} } },
  ], { 'o/r': 7 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].repo, 'https://github.com/o/r', 'commit-hash row must not win')
  assert.equal(rows[0].stars, 7, 'stars come from the repo key')
  assert.equal(rows[0].desc, '有仓库的那条')
})

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1

