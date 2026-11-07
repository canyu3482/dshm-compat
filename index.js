/**
 * dshm-compat host half.
 *
 * Phase 1 exposes the read-only compatibility analyzer and the DSHM install
 * queue transport. The converter and guest sidecar are added behind the same
 * service/tool surface in later phases.
 *
 * @module dshm-compat
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { analyze } from './lib/analyze.js'
import { auditAssets, repairAssetNames, repairedName, scanAssetNames } from './lib/asset-names.js'
import { scan } from './lib/batch.js'
import { convert } from './lib/convert.js'
import { runDoctor } from './lib/doctor.js'
import { resolveSpec } from './lib/fetch.js'
import { probeGuest, provisionGuest } from './lib/guest.js'
import { enqueueInstall } from './lib/install.js'
import { installLocalTarball, isLocalSpec, resolveProfileDir } from './lib/local-install.js'
import { marketAdapt, marketBrowse, marketTarget, marketVerdict } from './lib/market.js'
import { uninstallLocalPackage } from './lib/uninstall.js'
import { buildPlan } from './lib/plan.js'
import { callSidecar, listSidecars, probeSidecar, stageSidecar } from './lib/sidecar.js'
import { buildSource } from './lib/source-build.js'
import { recordInstall, recordReport, status } from './lib/state.js'
import { readVerdict } from './lib/verdicts.js'
import { findAddons, probeNative, resolveNeeded, summariseAddons } from './lib/native-probe.js'
import { scanWorker, verdictAdvice } from './lib/worker-scan.js'
import { categoryCounts, fetchIndex, loadIndex, searchIndex } from './lib/index-source.js'
import { guardInstalled } from './lib/quarantine.js'
import { SERVICE_SHIMS } from './lib/service-shims.js'
import { applyVerdicts, evaluatePending, inventoryFromContext, listPendingVerify, markPendingVerify } from './lib/verify.js'

export const name = 'dshm-compat'
export const inject = ['tools']

const OUTPUT = { type: 'object', additionalProperties: true }
const RESULT_NOTE = ' Returns a JSON result; failures are values with status:"error", not thrown.'

/** @param {unknown} value */
function errorResult(error) {
  return {
    status: 'error',
    error: {
      code: typeof error?.code === 'string' ? error.code : 'COMPAT_ERROR',
      message: String(error?.message ?? error),
    },
  }
}

/** @param {unknown} _args @param {unknown} value */
function renderJson(_args, value) {
  let text
  try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
  if (text.length > 60000) text = `${text.slice(0, 60000)}\n... [truncated]`
  return [{ type: 'text', text }]
}

/** @param {string} text */
function textResult(text) {
  const clipped = text.length > 60000 ? `${text.slice(0, 60000)}\n... [truncated]` : text
  return [{ type: 'text', text: clipped }]
}

const STATUS_MARK = {
  installed: 'INSTALLED',
  ready: 'READY',
  'dry-run': 'DRY-RUN',
  'needs-worker': 'NEEDS-WORKER',
  'needs-review': 'NEEDS-REVIEW',
  blocked: 'BLOCKED',
  error: 'ERROR',
}

/** @param {unknown} value */
function humanBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Post-install asset note, or `undefined` when there is nothing to say.
 *
 * An install that the host unpacked with its own tar reader can succeed and still
 * produce files nobody can fetch: the name carries appended pax metadata, so
 * `<video src="…/东张西望.webm">` 404s and the host log stays clean. Checking right
 * after the install is the only moment the reporter is still looking.
 *
 * @param {string | undefined} profileDir
 */
function installedAssetsNote(profileDir) {
  try {
    const resolved = profileDir ?? resolveProfileDir(process.env)
    if (typeof resolved !== 'string' || resolved === '') return undefined
    const audit = auditAssets(resolved)
    if (audit.status === 'missing' || audit.broken.length === 0) return undefined
    return {
      broken: audit.broken.length,
      sample: audit.broken.slice(0, 3).map(item => ({ name: item.name, shouldBe: item.shouldBe })),
      fix: audit.fix,
    }
  } catch {
    // Reporting is a courtesy here; never turn it into an install failure.
    return undefined
  }
}

/**
 * Market card for one adaptation result. Prose, not JSON: the point of the
 * market surface is that a user can read what happened without parsing fields.
 * @param {unknown} _args @param {any} value
 */
function renderMarketCard(_args, value) {
  if (value === null || typeof value !== 'object') return renderJson(_args, value)
  const card = value.card ?? {}
  const mark = STATUS_MARK[value.status] ?? String(value.status ?? 'UNKNOWN').toUpperCase()
  const lines = []
  const title = `${card.name ?? value.input ?? '?'}${card.version === undefined ? '' : `@${card.version}`}`
  lines.push(`[${mark}] ${title}${card.strategy === undefined ? '' : `  [${card.strategy}]`}${card.label === undefined ? '' : `  ${card.label}`}`)
  if (value.message !== undefined) lines.push(`  ${value.message}`)
  // 状态为 error 时原因住在 value.error 里——不画出来，设备 agent 只能看到一行
  // 没有任何信息的标记（0.1.33 真机复盘的第一条教训）。
  if (value.error !== null && typeof value.error === 'object') {
    lines.push(`  错误   ${value.error.code ?? ''} ${value.error.message ?? ''}`.trimEnd())
  }
  if (card.size !== undefined) lines.push(`  产物   ${humanBytes(card.size) ?? card.size}  sha256 ${String(card.sha256 ?? '').slice(0, 12)}`)
  if (value.install !== undefined) lines.push(`  安装   ${value.install.method ?? '?'} → ${value.install.profileDir ?? '?'}${value.install.restartRequired === true ? '（需重启）' : ''}`)
  // 下载来源/体积/耗时单列一行：慢是网络还是插件，一眼可辨（0.1.33 真机复盘）。
  if (card.download !== undefined) {
    const t = card.download.ms >= 1000 ? `${(card.download.ms / 1000).toFixed(1)}s` : `${card.download.ms}ms`
    const size = card.download.bytes === null || card.download.bytes === undefined ? '' : ` · ${humanBytes(card.download.bytes)}`
    lines.push(`  下载   ${card.download.source ?? '?'}${size} · ${t}${card.download.ms === 0 ? '（缓存命中）' : ''}`)
  }
  if (Array.isArray(value.artifact?.changed) && value.artifact.changed.length > 0) {
    lines.push(`  改动   ${value.artifact.changed.join('; ')}`)
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('  注意')
    for (const warning of value.warnings.slice(0, 4)) lines.push(`    - ${warning}`)
  }
  if (Array.isArray(value.steps) && value.steps.length > 0) {
    const stepText = value.steps
      .map(step => `${step.step}:${step.status}${step.ms === undefined ? '' : `(${step.ms >= 1000 ? `${(step.ms / 1000).toFixed(1)}s` : `${step.ms}ms`})`}`)
      .join(' → ')
    lines.push(`  流程   ${stepText}`)
  }
  if (Array.isArray(value.nextSteps) && value.nextSteps.length > 0) {
    lines.push('  下一步')
    value.nextSteps.slice(0, 5).forEach((step, index) => lines.push(`    ${index + 1}. ${step}`))
  }
  return textResult(lines.join(String.fromCharCode(10)))
}

/**
 * Shelf listing: the market home screen.
 * @param {unknown} _args @param {any} value
 */
function renderShelf(_args, value) {
  if (value === null || typeof value !== 'object') return renderJson(_args, value)
  const entries = Array.isArray(value.entries) ? value.entries : []
  const lines = []
  const counts = value.counts ?? {}
  lines.push(`货架 · ${entries.length} 条（目录 ${counts.catalog ?? 0} / 已分析 ${counts.analyzed ?? 0}）`)
  if (value.degraded === true) lines.push(`  ! registry 不可达：${value.error?.message ?? 'unknown'}`)
  if (value.catalog?.ok === false) lines.push(`  ! 目录读取失败：${value.catalog.error}`)
  for (const entry of entries) {
    // The state badge is this device's conclusion (verdict/ledger) or an honest
    // 预期 description — never the two blurred together (lib/catalog.js shelfState).
    const badge = entry.state?.label ?? entry.lastVerdict ?? entry.expect ?? '?'
    const title = typeof entry.desc === 'string' ? `  ${entry.desc}` : ''
    const seen = entry.analyzed === true ? '（已分析）' : ''
    /*
     * 一行一个：把"已验证"压到首行末尾，不再单占一行。十条都带同一句日期时，那一行
     * 只是把列表拉长一倍，读者要的是"这是什么、能不能用"。
     */
    const verified = typeof entry.verified !== 'string'
      ? ''
      : entry.verified.includes('通过') ? ' ✓' : ` · ${entry.verified}`
    lines.push(`  [${badge}] ${entry.name}${entry.recommend === true ? ' ★建议人手一个' : ''}${title}${seen}${verified}`)

    if (typeof entry.hint === 'string') lines.push(`        ${entry.hint}`)
    if (typeof entry.lastSeen === 'string') lines.push(`        最近 ${entry.lastSeen.slice(0, 10)}  ${entry.spec ?? ''}`)
  }
  if (Array.isArray(value.recentInstalls) && value.recentInstalls.length > 0) {
    lines.push('  最近安装')
    for (const install of value.recentInstalls) {
      lines.push(`    ${install.ok === false ? 'FAILED' : 'OK'}  ${install.spec ?? '?'}  ${install.at?.slice(0, 19) ?? ''}`)
    }
  }
  if (typeof value.hint === 'string') lines.push(`\n  ${value.hint}`)
  return textResult(lines.join('\n'))
}

/** @param {string} name @param {string} description @param {Record<string, unknown>} parameters @param {(args: any, exec: any) => Promise<unknown>} execute @param {Function} [render] */
function definition(name, description, parameters, execute, render = renderJson) {
  return {
    name,
    description: description + RESULT_NOTE,
    parameters,
    output: { schema: OUTPUT, render },
    // DSH validates tool results as lossless JSON; undefined-valued fields are
    // rejected. Strip them once at the boundary so every tool is safe.
    execute: async (args, exec) => {
      const value = await execute(args, exec)
      if (value === undefined) return null
      try { return JSON.parse(JSON.stringify(value)) } catch (error) { return errorResult(error) }
    },
  }
}

/**
 * Host-side service shims. Same narrow table as the client half, same rule: only a
 * name whose empty implementation means "no data" rather than "wrong data", and
 * only when nothing already provides it.
 *
 * @param {any} ctx
 * @returns {string[]} names actually provided
 */
function provideHostServiceShims(ctx) {
  const provided = []
  try {
    const reflect = ctx?.reflect
    if (reflect === undefined || typeof reflect.provide !== 'function') return provided
    for (const [name, entry] of Object.entries(SERVICE_SHIMS)) {
      if (!Array.isArray(entry.sides) || !entry.sides.includes('host')) continue
      if (typeof ctx.get === 'function' && ctx.get(name) !== undefined) continue
      if (reflect.props !== undefined && reflect.props[name] !== undefined) continue
      reflect.provide(name, { entries: () => [], subscribe: () => () => {} }, undefined)
      provided.push(name)
    }
  } catch {
    // 补不上就退回「缺服务」的诚实行为，不假装成功
  }
  return provided
}

export function apply(ctx) {
  const hostShimmed = provideHostServiceShims(ctx)
  if (hostShimmed.length > 0) ctx.logger?.info?.(`dshm-compat: host-side services provided: ${hostShimmed.join(', ')}`)

  const register = (tool, label) => {
    ctx.effect(() => ctx.tools.register(tool), `dshm-compat: ${label}`)
  }

  register(definition(
    'compat_analyze',
    'Download one DSH plugin package (npm name[@version], a GitHub repository URL, or a local .tgz) and classify why it may not install or run on HarmonyOS DSHM. '
      + 'Read-only: it does not execute install scripts and does not modify any profile. '
      + 'The report names a strategy (S0 pure JS/TS, S1 known native substitute, S2 guest Alpine sidecar, S3 WASM/remote, S4 unsupported), the evidence, and the next action.',
    {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'npm package name with optional @version, a GitHub repository URL, or an absolute/relative .tgz path.' },
        textScan: { type: 'boolean', description: 'Scan JavaScript text for platform/Electron/child_process references. Default true; set false for a fast structural report.' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        if (typeof args?.spec !== 'string' || args.spec.trim() === '') throw Object.assign(new Error('spec is required'), { code: 'INVALID_SPEC' })
        const spec = args.spec.trim()
        /*
         * Cache-first: an earlier compat_verdict / compat_market run on the same
         * npm version already paid the download + full scan, and its verdict
         * points at the stored report. Answer from it instead of re-downloading
         * a 31 MB tarball and rescanning (0.1.33 device review, step 3).
         */
        try {
          const resolved = await resolveSpec(spec, { signal: exec?.signal })
          if (resolved.kind === 'npm') {
            const cached = readVerdict(resolved.name, resolved.version)
            if (typeof cached?.reportFile === 'string' && existsSync(cached.reportFile)) {
              const report = JSON.parse(readFileSync(cached.reportFile, 'utf8'))
              if (report !== null && typeof report === 'object' && typeof report.strategy === 'string') {
                return {
                  status: 'ok',
                  entry: { fingerprint: report.fingerprint, reportFile: cached.reportFile },
                  report,
                  cached: true,
                  note: `命中报告缓存（analyzedAt ${cached.analyzedAt ?? '?'}），未重新下载或扫描。`,
                }
              }
            }
          }
        } catch { /* cache probe failure must not block the real analysis */ }
        const report = await analyze(spec, { textScan: args.textScan !== false, signal: exec?.signal })
        const entry = recordReport(report)
        return { status: 'ok', entry, report }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_analyze')

  register(definition(
    'compat_plan',
    'Analyze one plugin and return a concrete conversion plan without changing anything: manifest rewrite steps for S0, dependency substitutions for S1, guest provisioning and native build targets for S2, or an explicit unsupported result for S4.',
    {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'npm package name with optional @version, a GitHub repository URL, or an absolute/relative .tgz path.' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        if (typeof args?.spec !== 'string' || args.spec.trim() === '') throw Object.assign(new Error('spec is required'), { code: 'INVALID_SPEC' })
        const report = await analyze(args.spec.trim(), { textScan: true, signal: exec?.signal })
        recordReport(report)
        return { status: 'ok', plan: buildPlan(report), report }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_plan')

  register(definition(
    'compat_scan',
    'Analyze up to 50 plugin specs in parallel (3 at a time) and return a per-strategy compatibility table. Use this to triage a market list before converting individual packages; full reports are stored under $DSH_HOME/dshm-compat/reports and summarized here.',
    {
      type: 'object',
      properties: {
        specs: { type: 'array', items: { type: 'string' }, description: 'npm names, GitHub URLs, or local .tgz paths. At most 50; duplicates are removed.' },
        textScan: { type: 'boolean', description: 'Scan JavaScript text too. Default false for batch speed.' },
      },
      required: ['specs'],
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        const result = await scan(args?.specs, { textScan: args?.textScan === true, signal: exec?.signal })
        for (const item of result.items) if (item.ok && item.report !== undefined) recordReport(item.report)
        return {
          status: 'ok',
          counts: result.counts,
          items: result.items.map(({ report: _report, ...item }) => item),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_scan')

  register(definition(
    'compat_convert',
    'Convert one S0 (pure JS/TS) plugin into a DSHM-installable tarball: remove foreign os/cpu gates and install lifecycle scripts, normalize the client platform to web, and repack. '
      + 'It does not execute install scripts and does not bundle runtime dependencies yet. S1/S2/S3/S4 reports are returned with the next action instead of pretending to convert.',
    {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'npm package name with optional @version, a GitHub repository URL, or an absolute/relative .tgz path.' },
        install: { type: 'boolean', description: 'When true, submit the converted tarball to the DSHM install queue after a successful conversion.' },
        profileDir: { type: 'string', description: 'Absolute DSHM profile directory for install:true. Omit to let the host choose.' },
        confirm: { type: 'boolean', description: 'Required when install is true. Confirms that installing the converted package runs third-party code.' },
        vendor: { type: 'boolean', description: 'Vendor missing pure-JS runtime dependencies into the tarball. Default true.' },
        workerPath: { type: 'string', description: 'Absolute path to a prebuilt AArch64 Linux worker for an S2 plugin. Omit to let the generic adapter return the build command.' },
        buildNative: { type: 'boolean', description: 'For a source package, build a patched AArch64 worker in the guest and convert with it. Requires confirm:true because it provisions a toolchain and runs build scripts.' },
        allowLocal: { type: 'boolean', description: 'When install is true, unpack the converted tarball into the profile instead of the host queue. Default true; set false to force the queue.' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        if (typeof args?.spec !== 'string' || args.spec.trim() === '') throw Object.assign(new Error('spec is required'), { code: 'INVALID_SPEC' })
        if (args.buildNative === true && args.confirm !== true) {
          return { status: 'confirmation-required', message: 'Re-run with buildNative:true and confirm:true to provision a guest toolchain and run build scripts.' }
        }
        const report = await analyze(args.spec.trim(), { textScan: false, signal: exec?.signal })
        const result = await convert(args.spec.trim(), { report, signal: exec?.signal, vendor: args.vendor !== false, workerPath: args.workerPath, buildNative: args.buildNative === true, ctx })
        if (result.status !== 'ok') return result
        recordReport({ ...report, convertedAt: new Date().toISOString(), tarball: result.tarball })
        if (args.install !== true) return result
        if (args.confirm !== true) {
          return { ...result, install: { status: 'confirmation-required', message: 'Re-run with install:true and confirm:true to submit the tarball.' } }
        }
        const local = args.allowLocal === false ? undefined : installLocalTarball(result.tarball, { profileDir: args.profileDir })
        const installed = local === undefined
          ? await enqueueInstall(`file:${result.tarball}`, { profileDir: args.profileDir, signal: exec?.signal })
          : { status: local.ok ? 'ok' : 'error', ...local }
        recordInstall({ spec: args.spec, tarball: result.tarball, at: new Date().toISOString(), ...installed })
        return { ...result, install: installed }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_convert')

  register(definition(
    'compat_status',
    'Show the compatibility analyzer reports and install attempts stored under $DSH_HOME/dshm-compat, plus whether the current host looks like DSHM.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      try { return { status: 'ok', ...status() } } catch (error) { return errorResult(error) }
    },
  ), 'compat_status')

  register(definition(
    'compat_doctor',
    'One-shot diagnosis of the DSHM environment: whether this is DSHM, the core version, the owning profile and bundle registration, the install queue, stored state, and the Alpine guest (bash/apk/node). Read-only.',
    { type: 'object', properties: {}, additionalProperties: false },
    async (_args, exec) => {
      try { return { status: 'ok', ...(await runDoctor(ctx, process.env)) } } catch (error) { return errorResult(error) }
    },
  ), 'compat_doctor')

  register(definition(
    'compat_guest_probe',
    'Probe the DSHM guest Linux runtime through the host subprocess service: reports the guest kernel, Alpine version, and whether bash/apk/node/npm/python3 are present. '
      + 'Read-only; it does not install packages or start a VM explicitly (DSHM may route bash -c to its guest).',
    { type: 'object', properties: {}, additionalProperties: false },
    async (_args, exec) => {
      try { return { status: 'ok', ...(await probeGuest(ctx, { signal: exec?.signal })) } } catch (error) { return errorResult(error) }
    },
  ), 'compat_guest_probe')

  register(definition(
    'compat_guest_provision',
    'Install a reviewed allowlist of Alpine packages in the DSHM guest (bash, nodejs, npm, python3, build-base, linux-headers, git, ffmpeg). '
      + 'Requires confirm:true because it modifies the guest root filesystem. It reports the exact apk output; no success is assumed when the guest has no network.',
    {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subset of the allowlist. Omit for bash, nodejs, npm, python3, build-base, linux-headers.',
        },
        confirm: { type: 'boolean', description: 'Must be true to modify the guest root filesystem.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    async (args, exec) => {
      if (args?.confirm !== true) return { status: 'confirmation-required', message: 'Re-run with confirm:true after reviewing the package list.' }
      try { return { status: 'ok', ...(await provisionGuest(ctx, args.packages, { signal: exec?.signal })) } } catch (error) { return errorResult(error) }
    },
  ), 'compat_guest_provision')

  register(definition(
    'compat_sidecar',
    'Stage and call a native Linux/AArch64 worker in the DSHM Alpine guest. Actions: stage (extract a worker from a converted tarball into $DSH_HOME/dshm-compat/sidecars/<id>), list, probe (run --version), call (one JSON request on stdin, one JSON value on stdout; requires confirm:true). '
      + 'This is the generic S2 bridge; the worker runs through bash -c and is routed to the guest by dshm-vm-bash.',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['stage', 'list', 'probe', 'call'] },
        id: { type: 'string', description: 'Sidecar id (letters, digits, dot, underscore, dash).' },
        tarball: { type: 'string', description: 'Converted package tarball containing the worker.' },
        workerPath: { type: 'string', description: 'Worker path inside the tarball, e.g. runtime/linux-arm64/<worker>.' },
        input: { type: 'object', additionalProperties: true, description: 'JSON request for action=call. Default {}.' },
        timeoutMs: { type: 'integer', description: 'Per-call timeout. Default 120000.' },
        confirm: { type: 'boolean', description: 'Required for action=call: confirms that the worker runs native code in the guest.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        if (args?.action === 'stage') {
          if (typeof args.tarball !== 'string' || typeof args.workerPath !== 'string') {
            return { status: 'error', error: { code: 'INVALID_ARGUMENT', message: 'stage requires tarball and workerPath' } }
          }
          const result = stageSidecar(args.tarball, args.workerPath, { id: args.id })
          return result.ok ? { status: 'ok', ...result } : { status: 'error', ...result }
        }
        if (args?.action === 'list') return { status: 'ok', sidecars: listSidecars() }
        if (args?.action === 'probe') {
          if (typeof args.id !== 'string') return { status: 'error', error: { code: 'INVALID_ARGUMENT', message: 'probe requires id' } }
          return { status: 'ok', ...(await probeSidecar(ctx, args.id, { timeoutMs: args.timeoutMs, signal: exec?.signal })) }
        }
        if (args?.action === 'call') {
          if (typeof args.id !== 'string') return { status: 'error', error: { code: 'INVALID_ARGUMENT', message: 'call requires id' } }
          if (args.confirm !== true) return { status: 'confirmation-required', message: 'Re-run with confirm:true to execute the worker in the guest.' }
          return { status: 'ok', ...(await callSidecar(ctx, args.id, args.input ?? {}, { timeoutMs: args.timeoutMs, signal: exec?.signal })) }
        }
        return { status: 'error', error: { code: 'INVALID_ACTION', message: `unknown sidecar action: ${String(args?.action)}` } }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_sidecar')

  register(definition(
    'compat_build',
    'Plan or attempt a source build. backend:"plan" returns the exact PC/CI commands; backend:"guest" provisions Node/Rust in the Alpine guest and tries the build there (slow, needs guest network/disk; requires confirm:true). Returns the artifact path on success.',
    {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Source package: npm name, GitHub URL, or local .tgz.' },
        backend: { type: 'string', enum: ['plan', 'guest'], description: 'plan (default) or guest.' },
        timeoutMs: { type: 'integer', description: 'Guest build timeout. Default 30 minutes.' },
        requireNoClobber: { type: 'boolean', description: 'Refuse a 9p hard_link→rename rewrite unless the patch can prove it keeps "target must not exist" semantics. Default false: the rewrite still happens, but each weakened site is reported in patches[].semantics and warnings.' },
        confirm: { type: 'boolean', description: 'Required for backend:"guest". Confirms provisioning a toolchain and running build scripts in the guest.' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        if (args?.backend === 'guest' && args.confirm !== true) {
          return { status: 'confirmation-required', message: 'Re-run with confirm:true to provision a toolchain and run source build scripts in the guest.' }
        }
        return await buildSource(ctx, args.spec, {
          backend: args.backend === 'guest' ? 'guest' : 'plan',
          timeoutMs: args.timeoutMs,
          requireNoClobber: args.requireNoClobber === true,
          signal: exec?.signal,
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_build')

  register(definition(
    'compat_uninstall',
    'Remove a profile-local plugin: delete profiles/<profile>/node_modules/<name>, remove its dependency entry, and remove it from dsh.profile.bundles. Requires confirm:true and a DSHM restart.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Installed package name, e.g. @scope/plugin.' },
        profileDir: { type: 'string', description: 'Absolute DSHM profile directory. Omit to infer it.' },
        confirm: { type: 'boolean', description: 'Must be true. Confirms removing the package from the profile.' },
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    async args => {
      if (args?.confirm !== true) {
        return { status: 'confirmation-required', message: 'Re-run with confirm:true to remove the package from the profile.' }
      }
      try {
        const result = uninstallLocalPackage(args.name, { profileDir: args.profileDir })
        return result.ok ? { status: 'ok', ...result } : { status: 'error', ...result }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_uninstall')

  register(definition(
    'compat_market',
    'The one-stop entry point: give it a plugin name (pkg, pkg@1.2.3, @scope/pkg), a GitHub repository URL, a tarball URL, or a local .tgz, and it does the whole adaptation itself — classify, rewrite, install — then returns a card: what the plugin is, which strategy it took, what changed, whether a restart is needed, and what to run afterwards. '
      + 'Pass dryRun:true to see the cost without touching the profile; installation always needs confirm:true. '
      + 'Native (S2) plugins need an AArch64 worker: without workerPath it prepares the source and hands back the exact PC/CI build command instead of guessing.',
    {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Plugin name, npm spec (pkg@version), GitHub URL, http(s) tarball URL, or local path / file: spec.' },
        dryRun: { type: 'boolean', description: 'Convert but do not install. Default false.' },
        confirm: { type: 'boolean', description: 'Required to install: confirms writing into the profile and needing a DSHM restart.' },
        workerPath: { type: 'string', description: 'For an S2 plugin: absolute path to a linux-arm64 worker you already built.' },
        profileDir: { type: 'string', description: 'Absolute DSHM profile directory. Omit to infer it.' },
        requireNoClobber: { type: 'boolean', description: 'Refuse a source rewrite that weakens "target must not exist" semantics.' },
        autoRollback: { type: 'boolean', description: 'If the next boot shows this plugin stuck or absent, remove it automatically. Default false: it is only reported by compat_verify.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        return await marketAdapt(String(args.input), {
          ctx,
          confirm: args.confirm === true,
          dryRun: args.dryRun === true,
          workerPath: args.workerPath,
          profileDir: args.profileDir,
          requireNoClobber: args.requireNoClobber === true,
          autoRollback: args.autoRollback === true,
          signal: exec?.signal,
        })
      } catch (error) {
        return errorResult(error)
      }
    },
    renderMarketCard,
  ), 'compat_market')

  register(definition(
    'compat_verdict',
    'One-shot compatibility verdict for one input (npm name[@version], GitHub URL, tarball URL, or local .tgz): strategy (S0–S4), host-risk level, dsh-manifest presence, and the device-side service gate — without converting or installing anything. '
      + 'Answers from the L2 verdict cache when this name@version was analyzed before (the tarball is not re-downloaded; only the registry packument is read to confirm the version). Otherwise downloads the tarball once, records the verdict, and answers. Repeat checks and re-tests from the market index should start here, not at compat_market. '
      + 'For the full adapt pipeline (convert + install) use compat_market.',
    {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Plugin name, npm spec (pkg@version), GitHub URL, http(s) tarball URL, or local path.' },
        refresh: { type: 'boolean', description: 'Re-analyze even when a cached verdict exists. Default false.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        if (typeof args?.input !== 'string' || args.input.trim() === '') throw Object.assign(new Error('input is required'), { code: 'INVALID_INPUT' })
        return await marketVerdict(args.input.trim(), {
          ctx,
          refresh: args.refresh === true,
          signal: exec?.signal,
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_verdict')

  register(definition(
    'compat_market_index',
    'Search the full community plugin index (23.5k plugins) instead of the curated shelf. The index is published on npm by `dsh-plugin-shop-catalog` — 21,402 distinct plugins after de-duplication, with category, localized summary, capability tags, repo and star counts — and is cached locally (~9 MB, sha256-checked) so searches stay offline. '
      + 'Entries here are descriptions only: the index says "this exists", never "this runs here". Compatibility still comes from compat_market / compat_analyze on demand. '
      + 'First call downloads the catalog (a few seconds on a good link); pass refresh:true to update it.',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match against name, summary, category, capability tags and publisher.' },
        category: { type: 'string', description: 'Exact category filter: tool / ui / integration / workflow / provider / theme / other.' },
        limit: { type: 'number', description: 'Entries to return, 1-200. Default 20.' },
        stats: { type: 'boolean', description: 'Return index metadata and the category histogram instead of entries.' },
        refresh: { type: 'boolean', description: 'Re-download the catalog even if a cache exists.' },
      },
      additionalProperties: false,
    },
    async args => {
      try {
        const cached = loadIndex(process.env)
        let index = cached
        let fetched = undefined
        if (index === undefined || args?.refresh === true) {
          const fresh = await fetchIndex({ env: process.env, force: args?.refresh === true })
          index = fresh
          fetched = {
            version: fresh.version,
            count: fresh.count,
            rows: fresh.rows,
            builtAt: fresh.builtAt,
            downloadedMB: fresh.sizeMB,
            elapsedMs: fresh.elapsedMs,
          }
        }
        if (args?.stats === true) {
          return {
            status: 'ok',
            index: {
              version: index.version,
              builtAt: index.builtAt,
              schemaVersion: index.schemaVersion,
              count: index.count,
              rows: index.rows,
              source: index.source,
              fetchedAt: index.fetchedAt,
              cached: args?.refresh !== true,
            },
            categories: categoryCounts(index),
            fetched,
          }
        }
        const result = searchIndex(index, {
          query: args?.query,
          category: args?.category,
          limit: args?.limit,
        })
        return {
          status: 'ok',
          index: { version: index.version, count: index.count, builtAt: index.builtAt },
          total: result.total,
          entries: result.entries,
          note: '这些是索引条目（未验证能否在本机运行）；要判定就把它交给 compat_market 或 compat_analyze。',
          fetched,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_market_index')

  register(definition(
    'compat_market_browse',
    'The market home screen. With no arguments it returns the shelf: a curated catalog plus every plugin this device has already analyzed, with the verdict each one got — fully offline. '
      + 'Pass query to search the npm registry (falls back to the shelf when the registry is unreachable) or names to describe an explicit list. '
      + 'Registry entries carry packument-level friction signals only — no tarball is downloaded — so each says needsAnalysis:true. Follow up with compat_market to classify and install.',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Registry search text, e.g. "dsh plugin" or "keywords:dsh-plugin". Falls back to the local shelf.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Explicit package names to describe instead of searching.' },
        limit: { type: 'integer', description: 'Max entries (1-50). Default 20.' },
      },
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        const result = await marketBrowse({ query: args?.query, names: args?.names, limit: args?.limit, env: process.env, signal: exec?.signal })
        return { ...result, target: marketTarget() }
      } catch (error) {
        return errorResult(error)
      }
    },
    renderShelf,
  ), 'compat_market_browse')

  register(definition(
    'compat_worker_scan',
    'Read a prebuilt worker binary and say which repair strategies can possibly work on it, without running it. '
      + 'It reports the architecture, which link/metadata/rename symbols the binary imports, whether it also carries the means to bypass the C library (a syscall import or raw svc/syscall instructions), and a verdict: '
      + '"preload-viable" (an LD_PRELOAD shim can rewrite its calls), "needs-ptrace" (only a trap layer can), "no-publication" (it does not publish by linking at all), or "unknown" (symbol table stripped — do not conclude from a string sweep). '
      + 'Use this before attempting a shim: a needs-ptrace binary will not be fixed by one, and that has already cost several releases.',
    {
      type: 'object',
      properties: {
        workerPath: { type: 'string', description: 'Absolute path to the worker binary (from runtime/linux-*, or a build artifact).' },
      },
      required: ['workerPath'],
      additionalProperties: false,
    },
    async args => {
      try {
        const path = String(args.workerPath)
        let buffer
        try {
          buffer = readFileSync(path)
        } catch (error) {
          return { status: 'error', error: { code: 'READ_FAILED', message: `cannot read ${path}: ${String(error?.message ?? error)}` } }
        }
        const scan = scanWorker(buffer)
        if (scan.ok !== true) return { status: 'unsupported', path, ...scan }
        return { status: 'ok', path, ...scan, advice: verdictAdvice(scan.verdict) }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_worker_scan')

  register(definition(
    'compat_install',
    'Install an already-built plugin artifact. Local .tgz paths (or file:/link: paths) are unpacked into the owning DSH profile and its bundle list, because DSHM\'s host queue rejects local specs; npm names and GitHub repositories still go through the host install queue. '
      + 'Requires confirm:true because installing a plugin runs third-party code; a local install needs a DSHM restart to load.',
    {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'A file:/absolute-path .tgz produced by the converter, or an npm/GitHub spec.' },
        profileDir: { type: 'string', description: 'Absolute DSHM profile directory. Omit to infer it from this plugin\'s installation path.' },
        allowLocal: { type: 'boolean', description: 'Allow unpacking a local tarball into the profile. Default true. Set false to force the host install queue.' },
        autoRollback: { type: 'boolean', description: 'If the next boot shows this plugin stuck (pending on a service) or absent, remove it automatically instead of leaving the deployment broken. Default false: it is only reported.' },
        confirm: { type: 'boolean', description: 'Must be true. The caller confirms that installing this package runs third-party code.' },
      },
      required: ['spec', 'confirm'],
      additionalProperties: false,
    },
    async (args, exec) => {
      if (args?.confirm !== true) {
        return { status: 'confirmation-required', message: 'Re-run with confirm:true after reviewing the analyzer report.' }
      }
      try {
        if (args.allowLocal !== false && isLocalSpec(args.spec)) {
          const path = args.spec.trim().replace(/^(?:file|link):/i, '')
          const local = installLocalTarball(path, { profileDir: args.profileDir })
          recordInstall({ spec: args.spec, at: new Date().toISOString(), ...local })
          if (local.ok === true) {
            markPendingVerify({ name: local.name, version: local.version, profileDir: local.profileDir, source: args.spec, autoRollback: args.autoRollback === true })
          }
          const assets = local.ok === true ? installedAssetsNote(local.profileDir ?? args.profileDir) : undefined
          return local.ok
            ? { status: 'ok', ...local, ...(assets === undefined ? {} : { assets }) }
            : { status: 'error', error: { code: 'LOCAL_INSTALL_FAILED', message: local.error ?? 'local install failed' }, ...local }
        }
        const result = await enqueueInstall(args.spec, { profileDir: args.profileDir, signal: exec?.signal })
        recordInstall({ spec: args.spec, at: new Date().toISOString(), ...result })
        const assets = installedAssetsNote(args.profileDir)
        return assets === undefined ? result : { ...result, assets }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_install')

  register(definition(
    'compat_native_probe',
    'Explain why a native addon or shared library fails to load. Reads the ELF without executing it and reports the architecture, the PT_INTERP loader it asks for, every DT_NEEDED entry, SONAME and RPATH/RUNPATH — then names one cause: '
      + '"wrong-arch" (x64 file in an arm64 tree), "glibc-on-musl" (needs libc.so.6 / ld-linux; OHOS is musl and has neither), "musl-ok" (libc dependency is right, so the failure is another library), or "unknown-libc". '
      + 'Loader messages such as "Error loading shared library …: No such file or directory" report ENOENT for a *dependency*, so the named file is usually present — this separates the four causes that look identical in that one line.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the .node / .so file.' },
        searchDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to resolve DT_NEEDED against (the file\'s own directory is always included).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async args => {
      try {
        const path = String(args.path)
        let buffer
        try {
          buffer = readFileSync(path)
        } catch (error) {
          // The loader reports ENOENT for a missing *dependency* too, so a genuinely
          // absent file is worth stating plainly rather than as a link error.
          return { status: 'missing', path, error: { code: 'FILE_NOT_FOUND', message: `cannot read ${path}: ${String(error?.message ?? error)}` } }
        }
        const probe = probeNative(buffer)
        if (probe.ok !== true) return { status: 'unsupported', path, ...probe }
        const dirs = [dirname(path), ...(Array.isArray(args.searchDirs) ? args.searchDirs.map(String) : [])]
        const resolution = resolveNeeded(probe.needed, dirs)
        return { status: 'ok', path, ...probe, searchDirs: dirs, resolution }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_native_probe')

  register(definition(
    'compat_guard',
    'Audit every plugin bundle already installed in the profile and find the ones that would kill the host — a rejected promise from `apply`, `process.exit`, an install that never settles. '
      + 'With apply:true it writes `disabled: true` rows into the profile\'s `.dshm-plugin-rows.yml`, so those rows are not mounted on the next start (that file survives restarts and is not overwritten). '
      + 'This is the only lever a plugin has over "what loads next time": it cannot save the current run — if a row already killed the host, nothing can report it — but it turns "dies on every boot until the user finds it" into "one bad boot, then clean".',
    {
      type: 'object',
      properties: {
        profileDir: { type: 'string', description: 'Absolute profile directory. Omit to infer it.' },
        apply: { type: 'boolean', description: 'Write the disabled rows. Default false: report only.' },
      },
      additionalProperties: false,
    },
    async args => {
      try {
        const profileDir = args?.profileDir ?? resolveProfileDir(process.env)
        const reports = status(process.env).reports ?? []
        const audited = reports.map(item => item?.name).filter(name => typeof name === 'string')
        return guardInstalled({ profileDir, audited, apply: args?.apply === true })
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_guard')

  register(definition(
    'compat_audit',
    'Audit the files already installed in the profile and find the ones the host installer wrote under a broken name. '
      + 'When DSHM unpacks a tarball, a non-ASCII path picks up the pax metadata that followed it (`东张西望.webm\\n19 mtime=499…`); the bytes are fine, but every route that serves an asset by name answers 404, so the plugin looks installed and the screen stays empty while the host log shows nothing. '
      + 'This scans `node_modules` for control characters in file names and reports what each name should be. '
      + 'With apply:true it renames them back — names only, contents are never read, written, or compared, nothing is deleted, and a name whose target already exists is reported instead of overwritten. '
      + 'Limits are stated in the result: a path over 100 bytes can also land under a truncated "?" name, which no rename can recover and therefore gets reported as a limit rather than guessed at.',
    {
      type: 'object',
      properties: {
        profileDir: { type: 'string', description: 'Absolute profile directory. Omit to infer it.' },
        apply: { type: 'boolean', description: 'Rename the broken files back to their original names. Default false: report only.' },
        maxEntries: { type: 'number', description: 'Upper bound on directory entries scanned. Default 20000.' },
      },
      additionalProperties: false,
    },
    async args => {
      try {
        const profileDir = args?.profileDir ?? resolveProfileDir(process.env)
        if (typeof profileDir !== 'string' || profileDir === '') {
          return { status: 'error', error: { code: 'NO_PROFILE', message: 'cannot locate the owning profile; pass profileDir' } }
        }
        const options = Number.isFinite(args?.maxEntries) ? { maxEntries: Number(args.maxEntries) } : {}
        const audit = auditAssets(profileDir, options)
        if (args?.apply !== true || audit.status === 'missing' || audit.broken.length === 0) {
          return audit
        }
        const repaired = repairAssetNames(join(profileDir, 'node_modules'), options)
        return {
          ...audit,
          repaired: repaired.repaired,
          skipped: repaired.skipped,
          counts: repaired.counts,
          note: 'names only: file contents were not modified, and nothing was deleted',
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_audit')

  register(definition(
    'compat_verify',
    'Check whether the plugins installed through this tool actually activated. Reads back what the host already recorded — `pending (waiting for service: X)` lines in the host log, and the plugin inventory when it is exposed — and reports one verdict per pending install: active, failed, or unknown. '
      + 'With rollback:true it removes the ones that provably failed (including, for installs made with autoRollback:true, without asking again). An uninstall based on a guess is never performed: unknown stays unknown.',
    {
      type: 'object',
      properties: {
        rollback: { type: 'boolean', description: 'Remove plugins whose failure is proven by the evidence. Default false: report only.' },
        profileDir: { type: 'string', description: 'Absolute profile directory to use when rolling back. Omit to infer per entry.' },
      },
      additionalProperties: false,
    },
    async (args, exec) => {
      try {
        const inventory = await inventoryFromContext(ctx)
        const evaluation = evaluatePending({ inventory })
        if (args?.rollback !== true) return evaluation
        const applied = applyVerdicts(evaluation, {
          rollback: (name, profileDir) => uninstallLocalPackage(name, { profileDir: profileDir ?? args.profileDir }),
        })
        return { ...evaluation, applied }
      } catch (error) {
        return errorResult(error)
      }
    },
  ), 'compat_verify')

  /*
   * Boot check. An install that breaks the next start is discovered by the user, not
   * by us, unless something looks for it — so one delayed, unref'd timer reads the
   * evidence once the host has finished booting. It never blocks startup and never
   * throws: a broken verifier must not become a broken deployment.
   */
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (listPendingVerify().length === 0) return
          const inventory = await inventoryFromContext(ctx)
          const applied = applyVerdicts(evaluatePending({ inventory }), {
            rollback: (name, profileDir) => uninstallLocalPackage(name, { profileDir }),
          })
          for (const action of applied.actions) {
            ctx.logger?.warn?.(`[dshm-compat] 安装后体检：${action.name} → ${action.action}${action.reason === undefined ? '' : `（${action.reason}）`}`)
          }
        } catch (error) {
          ctx.logger?.warn?.(`[dshm-compat] 安装后体检失败：${String(error?.message ?? error)}`)
        }
      })()
    }, 45_000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, 'dshm-compat: post-install verification')

  /*
   * Opt-in night watchman. A plugin that kills the host gives no failure page, so DSHM's
   * rescue never mounts and the same row kills every boot until someone disables it by
   * hand. With `DSHM_COMPAT_AUTO_QUARANTINE=1` this audits installed bundles once per
   * start and writes the disabled rows, so the *next* start is clean. It cannot save the
   * current run: whatever killed the process already did.
   */
  ctx.effect(() => {
    if (process.env.DSHM_COMPAT_AUTO_QUARANTINE !== '1') return () => {}
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const profileDir = resolveProfileDir(process.env)
          const audited = (status(process.env).reports ?? []).map(item => item?.name).filter(name => typeof name === 'string')
          const result = guardInstalled({ profileDir, audited, apply: true })
          if (result.status !== 'ok') {
            ctx.logger?.warn?.(`[dshm-compat] 守夜人跳过：${result.error?.message ?? 'unknown'}`)
            return
          }
          for (const action of result.actions ?? []) {
            ctx.logger?.warn?.(`[dshm-compat] 守夜人：${action.package} 的 ${action.rowId} 已停用（${action.reason ?? 'host-killing'}）`)
          }
        } catch (error) {
          ctx.logger?.warn?.(`[dshm-compat] 守夜人失败：${String(error?.message ?? error)}`)
        }
      })()
    }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, 'dshm-compat: host-risk watchman')

  ctx.logger?.info?.('dshm-compat: analyzer ready (S0-S4); conversion and guest sidecar are next')
}
