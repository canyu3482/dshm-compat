/**
 * Best-effort source build orchestration.
 *
 * This is deliberately opt-in. The reliable route for a source-only plugin is
 * an external build (PC/CI); this module only attempts the same commands inside
 * the Alpine guest after provisioning a toolchain, and reports the exact
 * failure when the guest cannot do it.
 *
 * @module dshm-compat/source-build
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadArchive, resolveSpec } from './fetch.js'
import { provisionGuest, runGuest } from './guest.js'
import { patchPublicationSources } from './publish-patch.js'
import { compatDir } from './state.js'
import { extractTar, findRootPrefix } from './tar.js'

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {import('./tar.js').TarEntry[]} entries */
function selectRoot(entries) {
  const candidates = entries
    .filter(entry => entry.type === 'file' && (entry.path === 'package.json' || entry.path.endsWith('/package.json')))
    .map(entry => ({ dir: entry.path === 'package.json' ? '' : entry.path.slice(0, -'/package.json'.length), depth: entry.path.split('/').length }))
    .sort((a, b) => a.depth - b.depth)
  return candidates.length === 0 ? '' : (candidates[0].dir === '' ? '' : `${candidates[0].dir}/`)
}

/** @param {string} value */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Detect a generic build plan from package files.
 * @param {{ path: string, data?: Buffer }[]} files
 */
export function detectSourceBuild(files) {
  const byPath = new Map(files.map(file => [file.path, file]))
  const text = path => byPath.get(path)?.data?.toString('utf8')
  const cargoPath = ['native/Cargo.toml', 'Cargo.toml'].find(path => byPath.has(path))
  if (cargoPath !== undefined) {
    const cargo = text(cargoPath) ?? ''
    const packageName = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1]
    const binName = cargo.match(/\[\[bin\]\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m)?.[1]
    const binary = binName ?? packageName ?? 'worker'
    return {
      kind: 'rust',
      manifest: cargoPath,
      binary,
      command: 'cargo build --release',
      output: `target/release/${binary}`,
      packages: ['rust', 'cargo', 'build-base', 'linux-headers'],
      artifact: 'worker',
    }
  }
  const packageText = text('package.json')
  if (packageText !== undefined) {
    let pkg
    try { pkg = JSON.parse(packageText) } catch { pkg = undefined }
    const build = typeof pkg?.scripts?.build === 'string' ? pkg.scripts.build : typeof pkg?.scripts?.prepack === 'string' ? pkg.scripts.prepack : undefined
    if (build !== undefined) {
      const install = byPath.has('package-lock.json') || byPath.has('npm-shrinkwrap.json') ? 'npm ci' : 'npm install'
      return {
        kind: 'node',
        manifest: 'package.json',
        command: `${install} && npm run build && npm pack`,
        output: '*.tgz',
        packages: ['nodejs', 'npm', 'python3', 'build-base', 'linux-headers', 'git'],
        artifact: 'tarball',
      }
    }
  }
  return undefined
}

/**
 * @param {string} spec
 * @param {{ env?: NodeJS.ProcessEnv, signal?: AbortSignal, requireNoClobber?: boolean }} [options]
 */
export async function prepareSource(spec, options = {}) {
  const env = options.env ?? process.env
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
  const plan = detectSourceBuild(files)
  if (plan === undefined) return { ok: false, error: 'no generic build plan (Cargo.toml or package.json build/prepack)' }

  const safe = String(resolved.name ?? 'source').replace(/^@/, '').replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_')
  const fingerprint = createHash('sha256').update(`${resolved.name ?? ''}@${resolved.version ?? ''}`).digest('hex').slice(0, 12)
  const dir = join(compatDir(env), 'builds', 'source', `${safe}-${fingerprint}`)
  rmSync(dir, { recursive: true, force: true })
  for (const file of files) {
    if (file.data === undefined) continue
    const target = join(dir, ...file.path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.data, { mode: file.mode & 0o777 })
  }
  const patched = patchPublicationSources(dir, files, { strict: options.requireNoClobber === true })
  if (patched.ok !== true) {
    const detail = patched.anchorsMissing.length > 0
      ? `hard_link publication sites were found but not rewritten: ${patched.anchorsMissing.map(item => `${item.file}:${item.line}`).join(', ')}`
      : `the rewrite weakens publication semantics (${patched.patches.filter(item => item.semantics.length > 0).map(item => `${item.file}:${item.line} ${item.form}`).join(', ')}); refusing because requireNoClobber is set`
    return {
      ok: false,
      status: 'patch-unsafe',
      error: detail,
      patches: patched.patches,
      anchorsMissing: patched.anchorsMissing,
      patchSummary: patched.summary,
      packageName: resolved.name,
      version: resolved.version,
    }
  }
  return {
    ok: true,
    dir,
    plan,
    patches: patched.patches,
    patchSummary: patched.summary,
    anchorsMissing: patched.anchorsMissing,
    packageName: resolved.name,
    version: resolved.version,
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} spec
 * @param {{ backend?: 'plan'|'guest', env?: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function buildSource(ctx, spec, options = {}) {
  const prepared = await prepareSource(spec, options)
  if (prepared.status === 'patch-unsafe') return prepared
  if (prepared.ok !== true) return { status: 'unsupported', ...prepared }
  const { dir, plan } = prepared
  const base = {
    status: 'planned',
    source: { name: prepared.packageName, version: prepared.version },
    directory: dir,
    patches: prepared.patches,
    patchSummary: prepared.patchSummary,
    anchorsMissing: prepared.anchorsMissing,
    plan: {
      kind: plan.kind,
      commands: plan.command,
      output: plan.output,
      packages: plan.packages,
    },
  }
  const weakened = prepared.patches.filter(patch => patch.semantics.length > 0)
  if (weakened.length > 0) {
    base.warnings = weakened.map(patch =>
      `${patch.file}:${patch.line} rewritten as "${patch.form}" — ${patch.semantics.join(', ')}; `
      + 'confirm the caller does not rely on the weakened guarantee, or pass requireNoClobber:true to refuse')
  }
  if (options.backend !== 'guest') {
    return { ...base, message: 'run this plan on a PC/CI, or pass backend:"guest" to attempt it in the Alpine guest' }
  }

  const provision = await provisionGuest(ctx, plan.packages, { timeoutMs: options.timeoutMs ?? 15 * 60 * 1000, signal: options.signal })
  if (provision.status !== 'ok') {
    return { ...base, status: 'provision-failed', provision }
  }
  const command = `set -e\ncd ${shellQuote(dir)}\n${plan.command}`
  const result = await runGuest(ctx, command, { timeoutMs: options.timeoutMs ?? 30 * 60 * 1000, signal: options.signal })
  if (result.status !== 'ok') {
    return { ...base, status: 'build-failed', provision, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  }

  let artifact
  if (plan.kind === 'rust') artifact = join(dir, plan.output)
  else {
    const packed = result.stdout?.match(/[^\s]+\.tgz/)?.[0]
    artifact = packed !== undefined ? join(dir, packed.replace(/^\.\//, '')) : join(dir, 'package.tgz')
  }
  return {
    ...base,
    status: 'ok',
    artifact,
    provision,
    stdout: result.stdout,
    stderr: result.stderr,
    next: plan.kind === 'rust'
      ? `compat_convert { spec: ${JSON.stringify(spec)}, workerPath: ${JSON.stringify(artifact)} }`
      : `compat_convert { spec: ${JSON.stringify(artifact)} }`,
  }
}
