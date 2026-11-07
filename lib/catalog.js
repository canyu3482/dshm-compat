/**
 * The shelf: what this plugin's own market shows before you type anything.
 *
 * Two sources, deliberately kept apart:
 *
 *   · **curated** — `assets/catalog.json` (overridable with
 *     `DSHM_COMPAT_CATALOG`). Descriptions written by hand.
 *   · **recent** — the ledger this plugin already keeps (`state.json`). Every
 *     plugin the user ever analyzed is here with the verdict it got. This is the
 *     half that makes the shelf useful offline and on a fresh device: no network,
 *     no invented data, just "what you already tried, and how it went".
 *
 * A catalog entry is a *description*. It must never become a branch: adaptation
 * still goes through `analyze`/`convert`/`s2-native`. A test pins that
 * `PACKAGE_RULES` stays empty; this file must not quietly re-introduce per-package
 * behaviour under another name.
 *
 * @module dshm-compat/catalog
 */
import { existsSync, readFileSync } from 'node:fs'
import { readState } from './state.js'
import { readLatestVerdictByName, readVerdictIndex } from './verdicts.js'

const DEFAULT_CATALOG = new URL('../assets/catalog.json', import.meta.url)

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: boolean, source: string, entries: any[], error?: string }}
 */
export function loadCatalog(env = process.env) {
  const override = typeof env.DSHM_COMPAT_CATALOG === 'string' && env.DSHM_COMPAT_CATALOG !== ''
    ? env.DSHM_COMPAT_CATALOG
    : undefined
  const source = override ?? fileURLToPathSafe(DEFAULT_CATALOG)
  if (override !== undefined && !existsSync(override)) {
    return { ok: false, source, entries: [], error: `catalog file not found: ${override}` }
  }
  try {
    const parsed = record(JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, '')))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    return {
      ok: true,
      source,
      entries: entries
        .map(entry => record(entry))
        .filter(entry => entry !== undefined && typeof entry.name === 'string')
        .map(entry => ({
          name: entry.name,
          // One line, one sentence. The shelf is a list of "what this thing does", not a
          // review: longer copy pushed the names off the screen and made scanning slow.
          desc: typeof entry.desc === 'string'
            ? entry.desc
            : (typeof entry.why === 'string' ? entry.why : (typeof entry.title === 'string' ? entry.title : undefined)),
          expect: typeof entry.expect === 'string' ? entry.expect : undefined,
          verified: typeof entry.verified === 'string'
            ? entry.verified
            : (typeof entry.note === 'string' ? entry.note : undefined),
          // Optional install source override: an entry whose recommended source is
          // not its npm name (e.g. pinned to a GitHub repo) carries the spec the
          // market tool should receive. `name` stays the display/installed key.
          ...(typeof entry.spec === 'string' && entry.spec !== '' ? { spec: entry.spec } : {}),
          recommend: entry.recommend === true,
          origin: 'catalog',
        })),
    }
  } catch (error) {
    return { ok: false, source, entries: [], error: `catalog is not valid JSON: ${String(error?.message ?? error)}` }
  }
}

/** `fileURLToPath` without importing node:url at module scope for one call. */
function fileURLToPathSafe(url) {
  try {
    return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  } catch {
    return String(url)
  }
}

/**
 * The device-side state of one shelf entry, synthesised from facts already on
 * this machine. Two strictly different kinds of sentence live here, and the
 * `source` field says which one a badge is:
 *
 *   · `verdict` / `ledger` — THIS device's conclusion (the L2 verdict cache, the
 *     install ledger, the pending-verify list). A real answer about this device.
 *   · `expect` — what the analyzer would probably try (the catalog's `expect`
 *     field). A description, never a conclusion; its labels say 预期.
 *
 * The handoff doc's six states plus the honest extras the ledger forces: a
 * host-killing verdict and a services block are conclusions too, and pretending
 * they are "不支持" would send the user to the wrong next step.
 *
 * @param {{ analyzed?: boolean, lastVerdict?: string, expect?: string }} entry
 * @param {{ verdict?: any, installedOk?: boolean, pendingVerify?: boolean }} facts
 * @returns {{ id: string, label: string, source: 'verdict'|'ledger'|'expect'|'none', analyzedAt?: string }}
 */
export function shelfState(entry, facts = {}) {
  if (facts.installedOk === true) {
    return facts.pendingVerify === true
      ? { id: 'installed-pending', label: '已装·待复核', source: 'ledger' }
      : { id: 'installed', label: '已装', source: 'ledger' }
  }
  const verdict = facts.verdict
  if (verdict !== null && typeof verdict === 'object') {
    const base = { source: 'verdict', ...(typeof verdict.analyzedAt === 'string' ? { analyzedAt: verdict.analyzedAt } : {}) }
    if (verdict.hostRisk?.level === 'host-killing' || verdict.blockedReason === 'host-killing') {
      return { ...base, id: 'host-killing', label: '会杀宿主' }
    }
    if (verdict.outcome === 'blocked') {
      const reason = String(verdict.blockedReason ?? '')
      if (reason === 'services') return { ...base, id: 'blocked-services', label: '服务缺失' }
      if (reason === 'no-dsh-manifest') return { ...base, id: 'not-plugin', label: '不是插件' }
      if (reason === 'strategy-S3') return { ...base, id: 'needs-build', label: '需源码构建' }
      if (reason === 'strategy-S4') return { ...base, id: 'unsupported', label: '不支持' }
      return { ...base, id: 'blocked', label: '适配受阻' }
    }
    if (verdict.outcome === 'needs-worker') return { ...base, id: 'needs-worker', label: '需 worker' }
    if (verdict.outcome === 'needs-review') return { ...base, id: 'needs-review', label: '需复核' }
    if (verdict.outcome === 'ok' || verdict.outcome === 'installed') {
      const strategy = String(verdict.strategy ?? '')
      if (strategy === 'S0' || strategy === 'S1') return { ...base, id: 'ready', label: '可装' }
      if (strategy === 'S2') return { ...base, id: 'needs-worker', label: '需 worker' }
      if (strategy === 'S3') return { ...base, id: 'needs-build', label: '需源码构建' }
      if (strategy === 'S4') return { ...base, id: 'unsupported', label: '不支持' }
    }
  }
  // A ledger report without an L2 verdict (pre-0.1.29 history): the strategy is a
  // real classification this device produced, so it speaks like a verdict — but
  // without an outcome it cannot claim 可装, only 可适配.
  if (entry?.analyzed === true && typeof entry?.lastVerdict === 'string') {
    const ledgerMap = {
      S0: ['ready', '可适配（未装）'],
      S1: ['ready', '可适配（未装）'],
      S2: ['needs-worker', '需 worker'],
      S3: ['needs-build', '需源码构建'],
      S4: ['unsupported', '不支持'],
    }
    const hit = ledgerMap[entry.lastVerdict]
    if (hit !== undefined) return { id: hit[0], label: hit[1], source: 'ledger' }
  }
  const expectMap = {
    S0: ['expect-ready', '预期可直装'],
    S1: ['expect-ready', '预期可直装'],
    S2: ['expect-worker', '预期需 worker'],
    S3: ['expect-build', '预期需源码构建'],
    S4: ['expect-unsupported', '预计不支持'],
  }
  const expect = expectMap[entry?.expect]
  if (expect !== undefined) return { id: expect[0], label: expect[1], source: 'expect' }
  return { id: 'unanalyzed', label: '未分析', source: 'none' }
}

/**
 * The home screen: catalog + everything already seen, newest first, deduped by
 * name so a catalog entry you already analyzed shows its real verdict.
 *
 * Every entry carries a `state` badge (see `shelfState`): this device's
 * conclusion where one exists, an honest 预期 description where only the
 * catalog speaks.
 *
 * @param {{ env?: NodeJS.ProcessEnv, limit?: number }} [options]
 */
export function marketShelf(options = {}) {
  const env = options.env ?? process.env
  const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 50)
  const catalog = loadCatalog(env)
  const state = readState(env)
  const reports = Array.isArray(state.reports) ? state.reports : []

  /** @type {Map<string, any>} */
  const byName = new Map()
  for (const entry of catalog.entries) byName.set(entry.name, { ...entry, analyzed: false })

  for (const report of reports) {
    const name = typeof report?.name === 'string' ? report.name : undefined
    if (name === undefined) continue
    const previous = byName.get(name)
    byName.set(name, {
      ...(previous ?? { name, origin: 'ledger' }),
      origin: previous === undefined ? 'ledger' : previous.origin,
      analyzed: true,
      lastVerdict: typeof report?.strategy === 'string' ? report.strategy : undefined,
      version: typeof report?.version === 'string' ? report.version : undefined,
      spec: typeof report?.spec === 'string' ? report.spec : undefined,
      lastSeen: typeof report?.createdAt === 'string' ? report.createdAt : undefined,
    })
  }

  const entries = [...byName.values()]
    .sort((a, b) => String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')))
    .slice(0, limit)

  const allInstalls = Array.isArray(state.installs) ? state.installs : []
  const pendingNames = new Set((Array.isArray(state.pendingVerify) ? state.pendingVerify : [])
    .filter(row => row !== null && typeof row === 'object' && typeof row.name === 'string')
    .map(row => row.name))
  // One verdict-index read for the whole shelf, not one file read per entry.
  const verdictIndex = readVerdictIndex(env)
  for (const entry of entries) {
    let installedOk = false
    for (const install of allInstalls) {
      if (install?.ok !== true) continue
      if (install.name === entry.name || (install.name === undefined && typeof install.spec === 'string' && install.spec === entry.name)) {
        installedOk = true
        break
      }
    }
    entry.state = shelfState(entry, {
      installedOk,
      pendingVerify: pendingNames.has(entry.name),
      verdict: readLatestVerdictByName(entry.name, env, verdictIndex),
    })
  }

  const installs = allInstalls.slice(0, 5)
  return {
    status: 'ok',
    source: 'shelf',
    catalog: { ok: catalog.ok, file: catalog.source, error: catalog.error },
    counts: { catalog: catalog.entries.length, analyzed: [...byName.values()].filter(entry => entry.analyzed).length },
    entries,
    recentInstalls: installs.map(install => ({
      spec: install?.spec,
      ok: install?.ok,
      method: install?.method,
      at: install?.at,
    })),
    hint: '输入插件名或地址即可适配安装：compat_market { input }。dryRun:true 只看成本不落盘。',
  }
}

/**
 * Filter the shelf (or a name list) by a free-text query. Used when the user
 * types something that is not a resolvable spec — e.g. "office" — so a typo lands
 * on "did you mean" instead of a hard error.
 *
 * @param {string} query
 * @param {{ env?: NodeJS.ProcessEnv, limit?: number }} [options]
 */
export function searchShelf(query, options = {}) {
  const text = String(query ?? '').trim().toLowerCase()
  if (text === '') return marketShelf(options)
  const shelf = marketShelf({ ...options, limit: 50 })
  const matched = shelf.entries.filter(entry =>
    [entry.name, entry.desc, entry.verified]
      .filter(value => typeof value === 'string')
      .some(value => value.toLowerCase().includes(text)))
  return { ...shelf, source: 'shelf-search', query: String(query), entries: matched.slice(0, shelf.entries.length) }
}
