/**
 * Market layer: one input, one pipeline.
 *
 * The toolset so far is a set of verbs (analyze, plan, convert, build, install).
 * A user does not want verbs, they want to type a plugin name or a URL and end up
 * with it working. This module is that single entry point:
 *
 *     input ─► resolve ─► classify ─► transform ─► install ─► verify list
 *
 * It adds no new adaptation logic. Every step delegates to the engine that
 * already owns it, and the result is a *card* — what the plugin is, which strategy
 * it took, what changed, whether a restart is needed, and what to run afterwards.
 *
 * Design notes
 * ------------
 * · `dryRun` stops after the transform, so a user can see the cost before touching
 *   their profile. Installation always needs `confirm`.
 * · Every stage is recorded in `steps` with its own status. A failure names the
 *   stage it happened in; nothing is reported as success because a later stage
 *   would have fixed it.
 * · `browse` only reads packuments. It never downloads a tarball, so a browsing
 *   session costs a few JSON requests, and its verdicts are labelled as
 *   *quick* signals rather than a classification — classifying needs the tarball.
 *
 * @module dshm-compat/market
 */
import { analyze } from './analyze.js'
import { marketShelf, searchShelf } from './catalog.js'
import { convert } from './convert.js'
import { inspectCore } from './core.js'
import { defaultRegistry, fetchJson, parseNpmSpec, resolveSpec } from './fetch.js'
import { isDshm } from './install.js'
import { installLocalTarball, resolveProfileDir } from './local-install.js'
import { buildPlan } from './plan.js'
import { SERVICE_SHIMS, shimmableServices } from './service-shims.js'
import { clientServiceNames, compareServices, hostServiceNames, packageServiceDeps } from './services.js'
import { buildSource } from './source-build.js'
import { resolveIntake } from './intake.js'
import { loadIndex } from './index-source.js'
import { markPendingVerify } from './verify.js'
import { compatDir, dshHome, recordInstall, recordReport } from './state.js'
import { readVerdict, readVerdictIndex, writeVerdict } from './verdicts.js'
import { join } from 'node:path'

/** How each strategy is presented to a user who is not reading the report. */
const STRATEGY_UI = {
  S0: { label: '纯 JS/TS — 改写清单即可', compatibility: { manifest: 'rewritten', worker: 'none' } },
  S1: { label: '原生依赖可换成 OHOS 移植版', compatibility: { manifest: 'rewritten', worker: 'core-provided' } },
  S2: { label: '原生 worker — 需要 AArch64 产物或 guest', compatibility: { manifest: 'rewritten', worker: 'staged' } },
  S3: { label: '需要 WASM 或远程执行', compatibility: { manifest: 'unchanged', worker: 'none' } },
  S4: { label: '无法在本机适配', compatibility: { manifest: 'unchanged', worker: 'none' } },
}

/**
 * Post-install checks. Deliberately behavioural and generic: we can name the tool
 * and the exact arguments, but we cannot know what a third-party plugin is supposed
 * to *do*, so the list stops at "prove the host can write, and that the plugin
 * loaded".
 * @param {string} strategy
 */
export function verificationStepsFor(strategy) {
  const common = [
    'restart DSHM, then run compat_status to confirm the plugin row is present',
    'ask the plugin for one harmless operation (its own listing/help tool) — a load failure shows up there first',
  ]
  if (strategy === 'S2') {
    return [
      ...common,
      'call the plugin\'s write tool to CREATE a new file (expectedRevision:"absent") — this is the path 9p hard links used to break',
      'call the plugin\'s write tool to OVERWRITE the same file — overwrite goes through rename and must keep working',
    ]
  }
  return common
}

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * A stable id for a card, so repeated attempts at the same input line up in the
 * ledger instead of looking like different plugins.
 * @param {string} input
 */
function cardId(input) {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0
  }
  return `mkt-${hash.toString(36)}`
}

/**
 * @param {{ kind: string, name: string, version: string }} source
 * @param {any} report
 */
function buildCard(source, report) {
  const strategy = report.strategy
  const ui = STRATEGY_UI[strategy] ?? { label: strategy, compatibility: { manifest: 'unchanged', worker: 'none' } }
  const download = report.resolved?.downloadMs === undefined ? undefined : {
    ms: report.resolved.downloadMs,
    bytes: report.resolved.downloadBytes,
    source: report.resolved.downloadSource,
  }
  return {
    id: cardId(`${source.name}@${source.version}`),
    name: source.name,
    version: source.version,
    strategy,
    label: ui.label,
    confidence: report.confidence,
    compatibility: { ...ui.compatibility },
    why: Array.isArray(report.reasons) ? report.reasons.slice(0, 6) : [],
    ...(download === undefined ? {} : { download }),
  }
}

/**
 * Resolve one user input into a concrete source.
 * Accepts npm names (`pkg`, `pkg@1.2.3`, `@scope/pkg@2`), GitHub URLs, any
 * http(s) tarball URL, and local paths / `file:` specs.
 *
 * @param {string} input
 * @param {{ registry?: string, signal?: AbortSignal }} [options]
 */
export async function resolveInput(input, options = {}) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('input is empty')
  const resolved = await resolveSpec(raw, { registry: options.registry, signal: options.signal })
  const npm = resolved.kind === 'npm' ? parseNpmSpec(raw) : undefined
  return {
    input: raw,
    requested: npm?.requested ?? raw,
    kind: resolved.kind,
    name: String(resolved.name ?? ''),
    version: String(resolved.version ?? ''),
    resolved,
  }
}

/**
 * The whole pipeline for one input.
 *
 * @param {string} input
 * @param {{
 *   ctx?: any, env?: NodeJS.ProcessEnv, confirm?: boolean, dryRun?: boolean,
 *   workerPath?: string, profileDir?: string, requireNoClobber?: boolean,
 *   registry?: string, signal?: AbortSignal,
 * }} [options]
 */
/**
 * A catalog name that is not on npm is not dead: the community index records the
 * repository it came from. Retry once with that repo URL before reporting
 * not-found — roughly fifty index entries resolve only this way. GitHub-only
 * repos, phrases and inputs with no index on the device all fall through.
 *
 * @param {{ kind: string, text: string }} intake a not-found intake result
 * @param {{ env: NodeJS.ProcessEnv, resolve: (text: string) => Promise<any> }} options
 * @returns {Promise<{ resolved: any, viaIndex: string } | undefined>}
 */
export async function retryViaIndex(intake, options = {}) {
  if (intake.kind !== 'npm' && intake.kind !== 'phrase') return undefined
  const index = loadIndex(options.env)
  if (index === undefined || !Array.isArray(index.entries)) return undefined
  const entry = index.entries.find(item => item !== null && typeof item === 'object' && item.name === intake.text)
  const repo = entry?.repo
  if (typeof repo !== 'string' || !/^https?:\/\/(?:www\.)?github\.com\//i.test(repo)) return undefined
  try {
    const resolved = await options.resolve(repo)
    return resolved === undefined ? undefined : { resolved, viaIndex: repo }
  } catch {
    return undefined
  }
}

export async function marketAdapt(input, options = {}) {
  const env = options.env ?? process.env
  const steps = []
  let lastStepAt = Date.now()
  /** Per-step wall time lands in the step, so a slow run names its slow stage. */
  const mark = (step, status, detail) => {
    const now = Date.now()
    const ms = now - lastStepAt
    lastStepAt = now
    steps.push({ step, status, ...(ms >= 500 ? { ms } : {}), ...(detail === undefined ? {} : { detail }) })
  }
  // L2 caches: downloaded archives (kills the analyze→convert double download)
  // and the derived verdict (name@version → strategy/host-risk/services), so a
  // repeat attempt of the same version — or a later compat_verdict — does not
  // re-download to re-derive what is already on disk. Both are best-effort.
  const cacheDir = join(compatDir(env), 'cache')

  let source
  let indexFallbackNote
  const intake = await resolveIntake(input, {
    env,
    limit: 8,
    resolve: text => resolveInput(text, { registry: options.registry, signal: options.signal }),
  })
  if (intake.status !== 'resolved') {
    /*
     * Two shapes, neither an error page:
     *   not-found  we could not find what was typed — say so, do not guess
     *   suggest    a search phrase with hits, or an empty box waiting for input
     */
    if (intake.status === 'not-found') {
      // Last honest rescue: the index may know the repo for this name.
      const retry = await retryViaIndex(intake, { env, resolve: text => resolveInput(text, { registry: options.registry, signal: options.signal }) })
      if (retry !== undefined) {
        source = retry.resolved
        indexFallbackNote = `npm 上没有「${intake.text}」，已按目录收录的仓库地址重试：${retry.viaIndex}`
      } else {
        mark('resolve', 'not-found', String(intake.reason ?? '').slice(0, 120))
        return {
          status: 'not-found',
          stage: 'resolve',
          input: intake.text,
          kind: intake.kind,
          message: intake.message,
          hint: intake.hint,
          candidates: [],
          steps,
        }
      }
    }
    mark('resolve', intake.status === 'empty' ? 'waiting' : 'suggested',
      intake.status === 'empty' ? undefined : intake.kind)
    return {
      status: intake.status === 'empty' ? 'need-input' : 'suggest',
      stage: 'resolve',
      input: intake.text,
      kind: intake.kind,
      candidates: intake.suggestions?.entries ?? [],
      index: intake.suggestions?.index,
      hint: intake.suggestions?.hint ?? intake.hint,
      steps,
    }
  }
  // The index-fallback retry above already assigned `source`; a plain not-found
  // or suggest path returned inside the block, so reaching here means one of the
  // two resolved shapes.
  if (source === undefined) source = intake.resolved
  mark('resolve', 'ok', `${source.kind} ${source.name}@${source.version}`)

  let report
  let reportEntry
  try {
    report = await analyze(source.input, { signal: options.signal, registry: options.registry, cacheDir })
    mark('classify', 'ok', `strategy ${report.strategy} (confidence ${report.confidence})`)
    try { reportEntry = recordReport(report, env) } catch { /* the ledger is diagnostic; never fail a run for it */ }
  } catch (error) {
    mark('classify', 'failed', String(error?.message ?? error))
    return { status: 'error', stage: 'classify', error: { code: 'ANALYZE_FAILED', message: String(error?.message ?? error) }, steps }
  }

  /*
   * L2 verdict persistence. Every terminal point below records what this run
   * concluded about `name@version`, so the next check — a repeat adapt, or
   * compat_verdict from the index — starts from disk instead of the network.
   * A local tarball resolves to its own path, so identity comes from the
   * package.json the analyzer parsed (same authority as buildCard).
   */
  const verdictIdentity = {
    name: typeof report.package?.name === 'string' ? report.package.name : source.name,
    version: typeof report.package?.version === 'string' ? report.package.version : source.version,
  }
  const remember = patch => {
    try {
      writeVerdict(report, verdictIdentity, {
        // A GitHub spec identifies as owner/repo while the verdict is keyed by
        // the package's own name@version; the alias lets a repeat verdict of
        // the same URL find this entry (marketVerdict probes it).
        ...(source.kind === 'github' ? { repo: source.name } : {}),
        ...(reportEntry?.reportFile === undefined ? {} : { reportFile: reportEntry.reportFile }),
        ...patch,
      }, env)
    } catch { /* cache is best-effort */ }
  }
  /** Device-side service summary for the verdict; `undefined` when never assessed. */
  function servicesPatch() {
    if (serviceReport === undefined) return {}
    return {
      services: {
        declared: serviceReport.declared,
        missingHost: serviceReport.missingHost,
        missingClient: serviceReport.missingClient,
        unknownClient: serviceReport.unknownClient,
        shimmable: serviceReport.shimmable,
        unshimmable: serviceReport.unshimmable,
      },
      coreVersion: inspectCore(env)?.version ?? null,
    }
  }
  remember({})

  const card = buildCard({
    // A local tarball resolves to its own path, so the real identity comes from the
    // package.json the analyzer already parsed. Falling back keeps npm/GitHub specs
    // (which do carry a name) unchanged.
    kind: source.kind,
    name: typeof report.package?.name === 'string' ? report.package.name : source.name,
    version: typeof report.package?.version === 'string' ? report.package.version : source.version,
  }, report)
  const plan = buildPlan(report)
  const base = {
    input: source.input,
    card,
    plan: { kind: plan.kind, steps: plan.steps },
    steps,
    ...(indexFallbackNote === undefined ? {} : { note: indexFallbackNote }),
  }

  /*
   * Service dependencies. This is the check that `dsh-rewind@0.11.12` needed:
   * its client half requires `conversationEvents`, which no bundle in this core
   * provides, so cordis leaves the row pending and the web boot reports
   * "1 entry did not activate". Installing it takes the deployment down, and the
   * failure text never reaches the user as a compatibility verdict — it looks
   * like a broken build.
   *
   * A missing service is a hard block regardless of strategy: no amount of
   * manifest rewriting can supply a service the host does not have.
   */
  /*
   * Host-killing shapes are refused before anything else. A plugin that ends the host
   * process (or parks it in an unresolved install) produces no failure page and no
   * rescue hook, so there is nothing downstream that can report or undo it —
   * `dshm-brickpack/v04-throw-async` is exactly that case.
   */
  const hostRisk = report.signals?.hostRisk
  if (hostRisk !== undefined) base.hostRisk = hostRisk
  if (hostRisk?.level === 'host-killing') {
    mark('host-risk', 'failed', hostRisk.kinds.join(', '))
    const first = hostRisk.findings[0]
    remember({ outcome: 'blocked', blockedReason: 'host-killing' })
    return {
      ...base,
      status: 'blocked',
      message: `这个插件的代码会让宿主进程中断或永久卡住（${hostRisk.kinds.join('、')}），`
        + '而且它的失败形态没有失败页、救援脚本也没有挂载条件——装上去只能靠 DSHM 自己恢复。'
        + (first === undefined ? '' : ` 第一处证据：${first.path}:${first.line} —— ${first.why}`),
      nextSteps: [
        '不要安装；先把证据转给插件作者（文件、行号、写法都在 hostRisk.findings 里）',
        '如果只是想试，务必确认你能接受宿主卡死并且无法取消安装',
        '作者把 async apply 改成 await/捕获异常后再装',
      ],
    }
  }
  if (hostRisk?.level === 'suspect') {
    mark('host-risk', 'warn', hostRisk.kinds.join(', '))
  }

  let serviceReport
  let serviceWarnings = []
  try {
    const declared = await packageServiceDeps(source.resolved, { signal: options.signal, cacheDir })
    const inventory = {
      host: hostServiceNames(options.ctx),
      client: clientServiceNames(inspectCore(env), { env, profileDir: resolveProfileDir(env) }),
    }
    const compared = compareServices(declared, inventory)
    const hostShims = shimmableServices(compared.missingHost, 'host')
    const shims = shimmableServices(compared.missingClient, 'client')
    serviceReport = {
      declared,
      ...compared,
      shimmable: [...hostShims.covered, ...shims.covered],
      unshimmable: [...hostShims.uncovered, ...shims.uncovered],
    }
    /*
     * A gap compat can fill (see `lib/service-shims.js`) is not fatal — the row
     * activates and the shim degrades to "no data", which is stated in the
     * warnings. Anything else stays fatal: nothing compat can put in a registry
     * would behave correctly.
     */
    const hard = [...hostShims.uncovered.map(name => `host:${name}`), ...shims.uncovered.map(name => `client:${name}`)]
    if (hard.length > 0) {
      mark('services', 'failed', hard.join(', '))
      /*
       * 拦截是默认行为，shim 是窄表里的例外。这里把两类缺口分开说，因为补救方式
       * 不同：宿主服务补不了（宿主注册表里凭空造一个实现只会给出错答案），
       * 客户端服务只是"不在兜底表里"。
       */
      const reasons = []
      if (hostShims.uncovered.length > 0) {
        reasons.push(`宿主服务 ${hostShims.uncovered.join('、')} 这套 DSHM 没有，也不在兜底表里——宿主侧不能凭空补一个正确实现`)
      }
      if (shims.uncovered.length > 0) {
        reasons.push(`客户端服务 ${shims.uncovered.join('、')} 没有提供者，也不在 compat 的兜底表里`)
      }
      remember({ outcome: 'blocked', blockedReason: 'services', ...servicesPatch() })
      return {
        ...base,
        services: serviceReport,
        status: 'blocked',
        message: `这个插件要求的服务这套 DSHM 没有，compat 也补不了：${hard.join('、')}。装上去它不会被激活，反而会让整次启动报 "did not activate"。原因：${reasons.join('；')}。`,
        nextSteps: [
          '先把它从插件列表里停用（或 compat_uninstall 卸掉），否则每次启动都会带着这条失败',
          serviceReport.shimmable.length > 0
            ? `（${serviceReport.shimmable.join('、')} 这类缺口 compat 本来能补，但同一行里还有上面那些补不了的，所以整行仍然拦下）`
            : undefined,
          '换一个不依赖该服务的版本（版本间的 inject 声明差别很大）',
          '或等 DSHM core 提供该服务后再装',
        ].filter(step => step !== undefined),
      }
    }
    if (serviceReport.shimmable.length > 0) {
      mark('services', 'shimmed', serviceReport.shimmable.join(', '))
      serviceWarnings = serviceReport.shimmable.map(name =>
        `${name}：本部署没有提供者，由 dshm-compat 补空实现 —— ${SERVICE_SHIMS[name].degrade}`)
    } else if (compared.unknownClient.length > 0) {
      /*
       * 客户端清单没取到，就不能把"没找到"当成"没有"。此前这一条会直接走 blocked，
       * 而 dsh-pet@0.3.8 的 `connection` 明明由 `@deepseek-ai/dsh-client-connection`
       * 提供（`ctx.provide("connection", handle)`），只是那个包不在扫描范围内。
       * 结论降级为警告，并说明这是"没验"而不是"判死"。
       */
      mark('services', 'warn', `未验证：${compared.unknownClient.join(', ')}`)
      serviceWarnings = [...serviceWarnings,
        `客户端服务 ${compared.unknownClient.join('、')} 无法验证：${compared.clientInventoryReason ?? '客户端清单未取得'}。`
        + '装上去这些行可能不会激活 —— 装完用 compat_verify 复核，不要据此断定它能用也不能断定它不能用。']
    } else {
      mark('services', 'ok', `host ${inventory.host.length} / client ${inventory.client.names.length}${compared.verified.client ? '' : '（客户端清单未取得，结论仅覆盖已知项）'}`)
    }
  } catch (error) {
    mark('services', 'skipped', String(error?.message ?? error))
  }
  if (serviceReport !== undefined) base.services = serviceReport

  if (report.signals?.hasDsh !== true) {
    mark('check', 'failed', 'no dsh.bundle / dsh.client manifest')
    remember({ outcome: 'blocked', blockedReason: 'no-dsh-manifest' })
    return {
      ...base,
      status: 'blocked',
      message: '这个包不是 DSH 插件（没有 dsh.bundle 或 dsh.client 清单），装进来也不会被加载。',
      nextSteps: ['确认输入的是插件包，而不是它的依赖或同名工具库'],
    }
  }

  if (report.strategy === 'S3' || report.strategy === 'S4' || report.strategy === undefined) {
    mark('check', 'blocked', `strategy ${report.strategy} has no local path`)
    remember({ outcome: 'blocked', blockedReason: `strategy-${report.strategy}` })
    return {
      ...base,
      status: 'blocked',
      message: `${report.strategy}: 没有本机可用的适配路径。`,
      nextSteps: Array.isArray(report.next) ? [].concat(report.next) : [String(report.next ?? 'report it to the plugin author')],
    }
  }

  /*
   * S2 without a worker is not a dead end — it is a question with an exact answer.
   * Building from source needs a toolchain that may not exist on the device, so we
   * hand back the command instead of pretending to run it.
   */
  if (report.strategy === 'S2' && options.workerPath === undefined) {
    let sourcePlan
    try {
      sourcePlan = await buildSource(options.ctx, source.input, {
        backend: 'plan',
        env,
        requireNoClobber: options.requireNoClobber === true,
        signal: options.signal,
      })
    } catch (error) {
      mark('source-plan', 'failed', String(error?.message ?? error))
      sourcePlan = undefined
    }
    if (sourcePlan?.status === 'planned' || sourcePlan?.status === 'patch-unsafe') {
      mark('source-plan', sourcePlan.status === 'planned' ? 'ok' : 'blocked', sourcePlan.directory ?? '')
      remember({ outcome: sourcePlan.status === 'planned' ? 'needs-worker' : 'needs-review', ...servicesPatch() })
      return {
        ...base,
        status: sourcePlan.status === 'planned' ? 'needs-worker' : 'needs-review',
        message: sourcePlan.status === 'planned'
          ? '这个插件带原生 worker，自动适配需要一个 AArch64 产物。源码已备好，下面的命令在 PC/CI 上跑完，把产物路径回填给 workerPath。'
          : '源码补丁会给发布语义打折，已按 requireNoClobber 拒绝。',
        sourcePlan: {
          directory: sourcePlan.directory,
          commands: sourcePlan.plan?.commands,
          output: sourcePlan.plan?.output,
          patches: sourcePlan.patches,
          warnings: sourcePlan.warnings,
          anchorsMissing: sourcePlan.anchorsMissing,
        },
        nextSteps: sourcePlan.status === 'planned'
          ? [
            `在 PC/CI 上执行：${sourcePlan.plan?.commands}`,
            `产物：${sourcePlan.plan?.output}`,
            `回到这里重新输入同一个插件，并带上 workerPath=<产物绝对路径>`,
          ]
          : ['检查 anchorsMissing 里列出的调用点，人工确认后放宽 requireNoClobber'],
      }
    }
    mark('source-plan', 'no-plan', sourcePlan?.error ?? 'no generic build plan')
    return {
      ...base,
      status: 'blocked',
      message: '带原生 worker，但没有可用的源码构建计划（无 Cargo.toml / build 脚本），也没有现成 AArch64 产物。',
      nextSteps: [
        '向作者索取 linux-arm64 worker，然后带 workerPath 重新输入',
        '或确认该插件是否真的有原生部分（有时只是 optionalDependencies 里的平台包）',
      ],
    }
  }

  let converted
  try {
    converted = await convert(source.input, {
      report,
      workerPath: options.workerPath,
      requireNoClobber: options.requireNoClobber === true,
      ctx: options.ctx,
      signal: options.signal,
      registry: options.registry,
      cacheDir,
    })
    mark('transform', converted.status === 'ok' ? 'ok' : 'failed', converted.tarball ?? converted.message ?? '')
  } catch (error) {
    mark('transform', 'failed', String(error?.message ?? error))
    return { status: 'error', stage: 'transform', error: { code: 'CONVERT_FAILED', message: String(error?.message ?? error) }, ...base }
  }

  if (converted.status === 'patch-unsafe') {
    remember({ outcome: 'needs-review', blockedReason: 'patch-unsafe', ...servicesPatch() })
    return {
      ...base,
      status: 'needs-review',
      message: '原生 worker 的源码补丁会削弱发布语义，已拒绝。',
      nextSteps: ['去掉 requireNoClobber 重新尝试，或先修上游 worker 的 hard_link 发布'],
      transform: { patches: converted.patches, patchSummary: converted.patchSummary },
    }
  }
  if (converted.status !== 'ok') {
    remember({ outcome: 'blocked', blockedReason: `convert-${converted.status}`, ...servicesPatch() })
    return {
      ...base,
      status: 'blocked',
      message: `转换未完成：${converted.status}`,
      transform: { status: converted.status, message: converted.message, errors: converted.errors },
      nextSteps: [String(converted.next ?? converted.message ?? 'run compat_analyze for the full report')],
    }
  }

  /*
   * Token budget: this payload repeats on every call of one install (ready →
   * confirm), so fields another field already carries stay out — `plan` predicts
   * a conversion that already ran (artifact.changed is the outcome; compat_plan
   * answers plan questions), the services table keeps only the gaps (declared
   * lists and inventories live in the verdict ledger), step details the card or
   * artifact already state are dropped (failure paths keep every detail), and the
   * card shows a 12-char sha prefix (artifact.sha256 stays the full identity).
   */
  const { plan: _plan, ...analysisBase } = base
  const { declared: _declared, ok: _ok, clientInventory: _inventory, clientInventoryReason: _reason, verified: _verified, ...serviceGaps } = serviceReport ?? {}
  const withArtifact = {
    ...analysisBase,
    ...(serviceReport === undefined ? {} : { services: serviceGaps }),
    artifact: {
      tarball: converted.tarball,
      bytes: converted.bytes,
      sha256: converted.sha256,
      changed: converted.changed,
      vendored: converted.vendored,
      patches: converted.patches ?? converted.build?.patches,
      patchSummary: converted.patchSummary ?? converted.build?.patchSummary,
    },
    card: {
      ...card,
      size: converted.bytes,
      sha256: String(converted.sha256 ?? '').slice(0, 12),
      compatibility: { ...card.compatibility, worker: converted.build === undefined ? card.compatibility.worker : 'staged' },
    },
    warnings: [...(converted.warnings ?? []), ...(converted.build?.warnings ?? []), ...serviceWarnings],
    verification: verificationStepsFor(report.strategy),
  }
  /*
   * Applied at return time, not at withArtifact construction: `steps` is a live
   * array and later marks (install: skipped/ok) land after this point. Ok/skipped
   * step details repeat what the card, artifact and install fields already say;
   * failed/blocked/warn steps keep theirs for diagnosis.
   */
  const slimSteps = payload => ({
    ...payload,
    steps: steps.map(step => step.detail !== undefined && (step.status === 'ok' || step.status === 'skipped')
      ? { step: step.step, status: step.status, ...(step.ms === undefined ? {} : { ms: step.ms }) }
      : step),
  })

  if (options.dryRun === true) {
    mark('install', 'skipped', 'dryRun')
    remember({ outcome: 'ok', ...servicesPatch() })
    return slimSteps({
      ...withArtifact,
      status: 'dry-run',
      message: '已转换到本地，尚未安装。确认无误后去掉 dryRun 并带 confirm:true 再跑一次。',
      nextSteps: ['确认 warnings 与 changed 列表', '带 confirm:true 重新输入以安装'],
    })
  }

  if (options.confirm !== true) {
    mark('install', 'confirmation-required', '')
    remember({ outcome: 'ok', ...servicesPatch() })
    return slimSteps({
      ...withArtifact,
      status: 'ready',
      message: '已转换，等待确认安装。',
      nextSteps: ['带 confirm:true 重新输入以安装（会写入 profile 并需要重启 DSHM）'],
    })
  }

  const profileDir = options.profileDir ?? resolveProfileDir(env)
  if (profileDir === undefined) {
    mark('install', 'failed', 'no profile directory')
    return {
      ...withArtifact,
      status: 'error',
      stage: 'install',
      error: { code: 'NO_PROFILE', message: 'cannot locate the owning profile; pass profileDir explicitly' },
      steps,
    }
  }

  try {
    const installed = installLocalTarball(converted.tarball, { profileDir })
    if (installed.ok === true) {
      markPendingVerify({ name: installed.name, version: installed.version, profileDir, source: source.input, autoRollback: options.autoRollback === true }, env)
    }
    mark('install', installed.ok ? 'ok' : 'failed', `${installed.method ?? ''} ${profileDir}`)
    try { recordInstall({ spec: source.input, via: 'market', at: new Date().toISOString(), ...installed }, env) } catch { /* ditto */ }
    if (installed.ok !== true) {
      return {
        ...withArtifact,
        status: 'error',
        stage: 'install',
        error: { code: 'INSTALL_FAILED', message: String(installed.error ?? 'local install failed') },
        steps,
      }
    }
    remember({ outcome: 'installed', ...servicesPatch() })
    // The installed turn follows the ready turn one message later; nextSteps below
    // already carries the verification steps, so the standalone `verification`
    // field would say the same thing twice in the same context.
    const { verification: _verification, ...installedPayload } = withArtifact
    return slimSteps({
      ...installedPayload,
      status: 'installed',
      message: `${installed.name ?? card.name}@${installed.version ?? card.version} 已装进 ${profileDir}，重启 DSHM 后生效。`,
      install: {
        method: installed.method,
        profileDir,
        destination: installed.destination,
        restartRequired: true,
      },
      card: {
        ...withArtifact.card,
        install: { method: installed.method, restartRequired: true },
      },
      nextSteps: [
        '重启 DSHM（插件的行只在 boot 时挂载）',
        ...verificationStepsFor(report.strategy),
      ],
    })
  } catch (error) {
    mark('install', 'failed', String(error?.message ?? error))
    return {
      ...withArtifact,
      status: 'error',
      stage: 'install',
      error: { code: 'INSTALL_FAILED', message: String(error?.message ?? error) },
      steps,
    }
  }
}

/**
 * The "点一下测" entry: one input in, a verdict out — without converting or
 * installing anything.
 *
 * Answers from the L2 verdict cache when this name@version was already analyzed
 * (zero downloads); otherwise it downloads the tarball once, classifies it, runs
 * the device-side service gate, records the verdict, and answers. Package-side
 * fields (strategy, host-risk, dsh manifest) are intrinsic to the tarball and
 * never go stale for a fixed version; the service verdict is recorded against
 * the core version it was computed on, so a core update re-opens the question.
 * Local .tgz inputs skip the cache read — their identity is only known after
 * the archive is opened, so there is nothing to look up beforehand.
 *
 * @param {string} input
 * @param {{
 *   ctx?: any, env?: NodeJS.ProcessEnv, refresh?: boolean,
 *   registry?: string, signal?: AbortSignal,
 * }} [options]
 */
export async function marketVerdict(input, options = {}) {
  const env = options.env ?? process.env
  const steps = []
  let lastStepAt = Date.now()
  /** Per-step wall time lands in the step, so a slow run names its slow stage. */
  const mark = (step, status, detail) => {
    const now = Date.now()
    const ms = now - lastStepAt
    lastStepAt = now
    steps.push({ step, status, ...(ms >= 500 ? { ms } : {}), ...(detail === undefined ? {} : { detail }) })
  }

  const intake = await resolveIntake(input, {
    env,
    limit: 8,
    resolve: text => resolveInput(text, { registry: options.registry, signal: options.signal }),
  })
  let source
  if (intake.status !== 'resolved') {
    if (intake.status === 'not-found') {
      // Same rescue marketAdapt gets: the index may know the repo for this name.
      const retry = await retryViaIndex(intake, { env, resolve: text => resolveInput(text, { registry: options.registry, signal: options.signal }) })
      if (retry === undefined) {
        return {
          status: 'not-found',
          input: intake.text,
          kind: intake.kind,
          message: intake.message,
          hint: intake.hint,
          steps,
        }
      }
      source = retry.resolved
      mark('resolve', 'ok', `${source.kind} ${source.name}@${source.version}（npm 缺失，按目录收录的仓库重试）`)
    } else {
      return {
        status: intake.status === 'empty' ? 'need-input' : 'suggest',
        input: intake.text,
        kind: intake.kind,
        candidates: intake.suggestions?.entries ?? [],
        index: intake.suggestions?.index,
        hint: intake.suggestions?.hint ?? intake.hint,
        steps,
      }
    }
  } else {
    source = intake.resolved
  }

  if (source.kind !== 'file' && options.refresh !== true) {
    let cached = readVerdict(source.name, source.version, env)
    let viaAlias = false
    // A GitHub spec resolves to owner/repo, but verdicts are keyed by the
    // package's own name@version — probe the recorded repo alias before
    // paying download + scan again. Reuse keeps the moving-ref discipline:
    // an hour, like the archive cache, because the ref's bytes are not
    // content-addressed and a pushed commit would otherwise serve stale code.
    if (cached === undefined && source.kind === 'github') {
      const index = readVerdictIndex(env)
      const aliasKey = Object.keys(index).find(key => index[key]?.repo === source.name)
      if (aliasKey !== undefined) {
        const candidate = index[aliasKey]
        const age = Date.now() - Date.parse(String(candidate.analyzedAt ?? ''))
        if (Number.isFinite(age) && age >= 0 && age <= 60 * 60 * 1000) {
          cached = candidate
          viaAlias = true
        }
      }
    }
    if (cached !== undefined) {
      mark('cache', 'hit', `${viaAlias ? source.name : `${source.name}@${source.version}`} analyzedAt ${cached.analyzedAt ?? '?'}`)
      return {
        status: 'cached',
        name: source.name,
        version: source.version,
        kind: source.kind,
        verdict: cached,
        strategy: cached.strategy,
        hostRisk: cached.hostRisk,
        services: cached.services,
        outcome: cached.outcome,
        blockedReason: cached.blockedReason,
        analyzedAt: cached.analyzedAt,
        steps,
        note: viaAlias
          ? '来自 L2 判定缓存（按仓库别名命中，1 小时内）：tarball 没有重新下载。GitHub 分支会移动，超时后自动重新分析；refresh:true 可立即强制。'
          : '来自 L2 判定缓存：tarball 没有重新下载，只查了 registry 元数据确认版本仍是最新的。refresh:true 可强制重新分析。',
      }
    }
  }

  mark('analyze', 'start', `${source.kind} ${source.name}@${source.version}`)
  const cacheDir = join(compatDir(env), 'cache')
  const report = await analyze(source.input, { signal: options.signal, registry: options.registry, cacheDir })
  mark('analyze', 'ok', `strategy ${report.strategy} (confidence ${report.confidence})`)
  let reportEntry
  try { reportEntry = recordReport(report, env) } catch { /* the ledger is diagnostic */ }

  const identity = {
    name: typeof report.package?.name === 'string' ? report.package.name : source.name,
    version: typeof report.package?.version === 'string' ? report.package.version : source.version,
  }

  /*
   * Device-side service gate — the same primitives marketAdapt uses, kept in
   * agreement with it by a test that runs both on the same package.
   */
  let services
  let servicesCoreVersion
  try {
    const declared = await packageServiceDeps(source.resolved, { signal: options.signal, cacheDir })
    const inventory = {
      host: hostServiceNames(options.ctx),
      client: clientServiceNames(inspectCore(env), { env, profileDir: resolveProfileDir(env) }),
    }
    const compared = compareServices(declared, inventory)
    const hostShims = shimmableServices(compared.missingHost, 'host')
    const shims = shimmableServices(compared.missingClient, 'client')
    services = {
      declared,
      missingHost: compared.missingHost,
      missingClient: compared.missingClient,
      unknownClient: compared.unknownClient,
      shimmable: [...hostShims.covered, ...shims.covered],
      unshimmable: [...hostShims.uncovered, ...shims.uncovered],
    }
    servicesCoreVersion = inspectCore(env)?.version ?? null
    mark('services', services.unshimmable.length > 0 ? 'blocked' : 'ok',
      services.unshimmable.length > 0 ? services.unshimmable.join(', ') : `host ${inventory.host.length} / client ${inventory.client.names.length}`)
  } catch (error) {
    mark('services', 'skipped', String(error?.message ?? error))
  }

  /*
   * Outcome, judged from the same facts marketAdapt blocks on: a missing service
   * compat cannot shim, a strategy with no local path, an S2 with no worker.
   * host-killing is already inside the verdict's hostRisk — the caller refuses it.
   */
  const hardGaps = services?.unshimmable ?? []
  let outcome = 'ok'
  let blockedReason
  if (report.signals?.hostRisk?.level === 'host-killing') {
    outcome = 'blocked'
    blockedReason = 'host-killing'
  } else if (hardGaps.length > 0) {
    outcome = 'blocked'
    blockedReason = 'services'
  } else if (report.signals?.hasDsh !== true) {
    outcome = 'blocked'
    blockedReason = 'no-dsh-manifest'
  } else if (report.strategy === 'S3' || report.strategy === 'S4' || report.strategy === undefined) {
    outcome = 'blocked'
    blockedReason = `strategy-${report.strategy}`
  } else if (report.strategy === 'S2' && options.workerPath === undefined) {
    outcome = 'needs-worker'
  }

  const verdict = writeVerdict(report, identity, {
    outcome,
    // Same repo alias marketAdapt records — the repeat-verdict probe needs it.
    ...(source.kind === 'github' ? { repo: source.name } : {}),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    // Same shape marketAdapt records: services summary + the core version it was
    // computed against, side by side at the top level.
    ...(services === undefined ? {} : { services, coreVersion: servicesCoreVersion }),
    // The full analyzer report is already on disk — compat_analyze can answer
    // from it instead of downloading and rescanning.
    ...(reportEntry?.reportFile === undefined ? {} : { reportFile: reportEntry.reportFile }),
  }, env)

  return {
    status: 'analyzed',
    name: identity.name,
    version: identity.version,
    kind: source.kind,
    verdict,
    strategy: report.strategy,
    confidence: report.confidence,
    hostRisk: verdict.hostRisk,
    hasDsh: verdict.hasDsh,
    services,
    outcome,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    analyzedAt: verdict.analyzedAt,
    steps,
    note: '判定只回答"适不适配、卡在哪一步"；转换与安装交给 compat_market。',
  }
}

/**
 * Packument-level signals. Cheap, honest, and explicitly not a classification.
 * @param {any} pkg
 */
function quickSignals(pkg) {
  const os = Array.isArray(pkg?.os) ? pkg.os : undefined
  const cpu = Array.isArray(pkg?.cpu) ? pkg.cpu : undefined
  const optional = record(pkg?.optionalDependencies) ?? {}
  const platformOptional = Object.keys(optional).filter(name => /-(?:win32|darwin|linux|android)-(?:x64|arm64|ia32)$/.test(name))
  return {
    isDshPlugin: record(pkg?.dsh) !== undefined,
    foreignOs: os !== undefined && !os.some(value => value === 'linux' || value === 'openharmony' || value === '*'),
    foreignCpu: cpu !== undefined && !cpu.some(value => value === 'arm64' || value === 'x64' || value === '*'),
    engineGate: typeof pkg?.engines?.dsh === 'string' ? pkg.engines.dsh : undefined,
    peerGate: typeof pkg?.peerDependencies?.['@deepseek-ai/dsh'] === 'string'
      ? pkg.peerDependencies['@deepseek-ai/dsh']
      : undefined,
    platformOptional,
  }
}

/**
 * Browse the registry, or describe an explicit list of names.
 *
 * Only packuments are read — no tarball download — so `needsAnalysis` is always
 * true for entries: the signals below are hints about *where the friction probably
 * is*, not a verdict.
 *
 * @param {{
 *   query?: string, names?: string[], limit?: number,
 *   registry?: string, signal?: AbortSignal, fetchJsonImpl?: typeof fetchJson,
 * }} [options]
 */
export async function marketBrowse(options = {}) {
  const registry = (options.registry ?? defaultRegistry()).replace(/\/+$/, '')
  const getJson = options.fetchJsonImpl ?? fetchJson
  const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 50)
  const names = Array.isArray(options.names) ? options.names.map(name => String(name).trim()).filter(Boolean) : []
  const query = String(options.query ?? '').trim()

  // Home screen: no query and no names means "show me the shelf". Offline by
  // design — the catalog plus this plugin's own ledger.
  if (names.length === 0 && query === '') {
    return { ...marketShelf({ env: options.env, limit }), browse: 'shelf' }
  }

  /** @type {string[]} */
  let targets = names
  let fromSearch = false
  if (targets.length === 0) {
    const url = `${registry}/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`
    let found
    try {
      found = await getJson(url, { signal: options.signal })
    } catch (error) {
      // A registry that cannot be reached must not break browsing: fall back to
      // what is on the shelf, and say so instead of returning an empty page.
      const local = searchShelf(query, { env: options.env, limit })
      return {
        ...local,
        source: 'shelf-fallback',
        degraded: true,
        error: { code: 'REGISTRY_UNAVAILABLE', message: String(error?.message ?? error) },
        note: 'registry 不可达，只显示了本地货架与历史记录。',
      }
    }
    const objects = Array.isArray(found?.objects) ? found.objects : []
    targets = objects
      .map(object => object?.package?.name)
      .filter(name => typeof name === 'string')
      .slice(0, limit)
    fromSearch = true
    if (targets.length === 0) {
      const local = searchShelf(query, { env: options.env, limit })
      return { ...local, source: local.entries.length > 0 ? 'shelf-search' : 'search', query, message: local.entries.length > 0 ? 'registry 无结果，下面是本地匹配。' : 'no package matched' }
    }
  }

  const entries = []
  const failures = []
  for (const name of targets.slice(0, limit)) {
    try {
      const packument = await getJson(`${registry}/${name.replace('/', '%2F')}`, { signal: options.signal })
      const latest = packument?.['dist-tags']?.latest
      const pkg = latest === undefined ? undefined : packument?.versions?.[latest]
      const signals = quickSignals(pkg)
      entries.push({
        name,
        version: latest,
        description: typeof pkg?.description === 'string' ? pkg.description : undefined,
        isDshPlugin: signals.isDshPlugin,
        quick: signals,
        needsAnalysis: true,
        hint: signals.isDshPlugin === false
          ? '没有 dsh 清单，可能不是插件'
          : signals.foreignOs || signals.foreignCpu
            ? '带平台门，需要改写清单（S0 方向）'
            : signals.platformOptional.length > 0
              ? '带平台专属 optionalDependencies，可能含原生部分'
              : '未发现明显门限，可能可直接装',
      })
    } catch (error) {
      failures.push({ name, error: String(error?.message ?? error) })
    }
  }

  return {
    status: 'ok',
    browse: fromSearch ? 'search' : 'names',
    source: fromSearch ? 'search' : 'names',
    query: options.query,
    registry,
    entries,
    failures,
    note: 'packument 级信号，不是分类结论：判定策略要下载 tarball，交给 compat_market。',
  }
}

/**
 * Where a plugin would go, without doing anything. Useful for a UI that shows
 * "install to <profile>" before the user commits.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function marketTarget(env = process.env) {
  return {
    dshm: isDshm(env),
    dshHome: dshHome(env),
    profileDir: resolveProfileDir(env),
  }
}
