/**
 * The full plugin index, taken from the community catalog instead of crawled here.
 *
 * `dsh-plugin-shop-catalog` publishes a v5 index on npm: `v1/index.json` points at a
 * sharded `plugins.<sha256>.json` and a `stars.<sha256>.json`, each integrity-checked.
 * Roughly 23,500 plugins with category, localized summary, capability tags, peer
 * dependencies, unpacked size and publish date. npm-hosted matters for the same reason
 * dshmarket does it: GitHub Pages and the public GitHub proxies are unusable from
 * mainland China, npm mirrors are not.
 *
 * What this module deliberately does not do:
 *
 *   · **It does not decide compatibility.** An index entry is a description ("this
 *     exists, here is what it claims"), never a verdict. Verdicts come from
 *     `analyze` on demand and are cached per version — see `lib/market-state.js`.
 *   · **It does not keep the 22 MB shard around.** After verifying the sha256 the
 *     entries are compacted to the dozen fields the market actually renders (~4 MB),
 *     and the raw shard is dropped. Parsing 22 MB of nested objects on a phone once is
 *     acceptable; doing it on every open is not.
 *
 * @module dshm-compat/index-source
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_REGISTRY, downloadBuffer, fetchJson } from './fetch.js'
import { compatDir } from './state.js'
import { extractTar, gunzipIfNeeded } from './tar.js'

export const INDEX_PACKAGE = 'dsh-plugin-shop-catalog'

/** Newer schemas may add fields; refusing to read one must degrade, not crash. */
export const SUPPORTED_SCHEMA = 5

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {Buffer} buffer */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** @param {NodeJS.ProcessEnv} env */
export function indexDir(env = process.env) {
  return join(compatDir(env), 'index')
}

/** @param {NodeJS.ProcessEnv} env */
export function indexPath(env = process.env) {
  return join(indexDir(env), 'current.json')
}

/**
 * Pick a human summary: Chinese first (the reader is on a Chinese device), then English.
 * @param {unknown} summary
 */
function pickSummary(summary) {
  const map = record(summary)
  if (map === undefined) return undefined
  for (const key of ['zh', 'zh-CN', 'zh-cn', 'en']) {
    const value = map[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  const first = Object.values(map).find(value => typeof value === 'string' && value.trim() !== '')
  return typeof first === 'string' ? first.trim() : undefined
}

/**
 * GitHub stars are keyed by `owner/repo`, not by package name — verified against the
 * shard itself (`{"stars": {"0131kikimy/dsh-ima": 1, …}}`, 22,802 keys). Looking them up
 * by package name silently returned 0 for everything and, worse, attributed the same
 * number to unrelated packages sharing a name.
 *
 * @param {string | undefined} url
 */
function repoKey(url) {
  if (typeof url !== 'string') return undefined
  const match = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(url)
  if (match === null) return undefined
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`.toLowerCase()
}

/**
 * One index entry → the shape the market renders. Keeps names readable: this file is
 * also what a user opens when they want to know why an entry is missing.
 *
 * @param {any} item
 * @param {Record<string, number>} [stars]
 */
export function compactEntry(item, stars) {
  const catalog = record(item?.catalog)
  const caps = Array.isArray(catalog?.capabilities)
    ? catalog.capabilities.filter(value => typeof value === 'string').slice(0, 4)
    : []
  const name = typeof item?.name === 'string' ? item.name : undefined
  if (name === undefined) return undefined
  const repo = typeof item.repository === 'string' ? item.repository : undefined
  const key = repoKey(repo)
  /*
   * The stars shard mixes three key shapes — `owner/repo` (most rows), a bare package
   * name (`dsh-pet` → 5,493), and scoped npm names (`@hellosz/dsh-pets`). Looking up
   * only `owner/repo` reported 0 stars for a plugin whose stars were sitting right
   * there under its package name. Try in order of specificity.
   */
  const candidates = [key, name.toLowerCase()].filter(value => typeof value === 'string')
  const starCount = candidates.map(candidate => stars?.[candidate]).find(value => typeof value === 'number')
  return {
    name,
    version: typeof item.version === 'string' ? item.version : undefined,
    desc: pickSummary(catalog?.summary),
    category: typeof catalog?.category === 'string' ? catalog.category : undefined,
    caps,
    stars: starCount ?? 0,
    publisher: typeof item.publisher === 'string' ? item.publisher : undefined,
    repo,
    size: typeof item.unpackedSize === 'number' ? item.unpackedSize : undefined,
    published: typeof item.publishedAt === 'string' ? item.publishedAt.slice(0, 10) : undefined,
    tier: typeof item.tier === 'string' ? item.tier : undefined,
  }
}

/**
 * The catalog lists a name once per version (commit-hash versions included), so the raw
 * shard has 23,542 rows for 21,402 distinct names — `dsh-session-delete` alone appears
 * 28 times. The market wants one row per plugin: keep the newest by publish date, and
 * prefer a row that actually carries a summary.
 *
 * @param {{ name: string, published?: string, version?: string, desc?: string }[]} entries
 */
export function dedupeByName(entries) {
  /**
   * Score by evidence first, recency second. Several rows for one name are usually
   * commit-hash versions harvested from tarballs, and those rows carry no `repository`
   * — keeping the newest one blindly set `stars` to 0 for exactly the plugins that
   * matter most (`dsh-pet` with 5.5k stars fell out of the "pet" search entirely).
   */
  const score = entry => (entry.repo === undefined ? 0 : 2) + (entry.desc === undefined ? 0 : 1)
  /** @type {Map<string, any>} */
  const best = new Map()
  for (const entry of entries) {
    const current = best.get(entry.name)
    if (current === undefined) { best.set(entry.name, entry); continue }
    const delta = score(entry) - score(current)
    if (delta > 0) { best.set(entry.name, entry); continue }
    if (delta < 0) continue
    const newer = String(entry.published ?? '') > String(current.published ?? '')
    const sameDay = String(entry.published ?? '') === String(current.published ?? '')
    if (newer || (sameDay && String(entry.version ?? '') > String(current.version ?? ''))) best.set(entry.name, entry)
  }
  return [...best.values()]
}

/**
 * @param {string} [registry]
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function resolveIndexPackage(registry = DEFAULT_REGISTRY, options = {}) {
  const base = registry.replace(/\/+$/, '')
  const manifest = await fetchJson(`${base}/${INDEX_PACKAGE}/latest`, { signal: options.signal })
  const dist = record(manifest?.dist)
  if (typeof dist?.tarball !== 'string') throw new Error(`${INDEX_PACKAGE}: manifest has no tarball`)
  return {
    version: String(manifest?.version ?? ''),
    tarball: dist.tarball,
    unpackedSize: typeof dist.unpackedSize === 'number' ? dist.unpackedSize : undefined,
  }
}

/**
 * Read the cached compact index, if any. Never throws: a missing or half-written cache
 * is simply "no cache" and the caller falls back to fetching.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadIndex(env = process.env) {
  const file = indexPath(env)
  if (!existsSync(file)) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(value?.entries) || value.entries.length === 0) return undefined
    return value
  } catch {
    return undefined
  }
}

/**
 * Download, verify and compact the index. Returns the compacted form and writes it to
 * the cache; the raw 22 MB shard lives only for the duration of this call.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   registry?: string,
 *   signal?: AbortSignal,
 *   force?: boolean,
 * }} [options]
 */
export async function fetchIndex(options = {}) {
  const env = options.env ?? process.env
  const pkg = await resolveIndexPackage(options.registry, { signal: options.signal })

  if (options.force !== true) {
    const cached = loadIndex(env)
    if (cached !== undefined && cached.version === pkg.version) {
      return { ...cached, cached: true, downloaded: false }
    }
  }

  const started = Date.now()
  const tgz = await downloadBuffer(pkg.tarball, { signal: options.signal })
  const { entries } = extractTar(gunzipIfNeeded(tgz))
  const indexEntry = entries.find(entry => entry.type === 'file' && /(?:^|\/)v1\/index\.json$/.test(entry.path))
  if (indexEntry?.data === undefined) throw new Error('catalog: v1/index.json not found in the archive')
  const index = JSON.parse(indexEntry.data.toString('utf8'))

  const schema = Number(index.schemaVersion ?? 0)
  if (schema > SUPPORTED_SCHEMA) {
    throw new Error(`catalog schema ${schema} is newer than supported ${SUPPORTED_SCHEMA}; `
      + 'refusing to guess at the field meanings')
  }

  const shardInfo = record(index.plugins)
  if (typeof shardInfo?.url !== 'string') throw new Error('catalog: index has no plugins shard')
  const shardEntry = entries.find(entry => entry.type === 'file' && entry.path.endsWith(`/v1/${shardInfo.url}`))
  if (shardEntry?.data === undefined) throw new Error(`catalog: shard ${shardInfo.url} not found`)

  const actual = sha256(shardEntry.data)
  if (typeof shardInfo.sha256 === 'string' && shardInfo.sha256 !== actual) {
    throw new Error(`catalog: shard sha256 mismatch (expected ${shardInfo.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`)
  }

  const shard = JSON.parse(shardEntry.data.toString('utf8'))
  const items = Array.isArray(shard?.plugins) ? shard.plugins : (Array.isArray(shard) ? shard : [])
  if (items.length === 0) throw new Error('catalog: plugins shard is empty')

  const stars = readStars(entries, index)
  const rows = items.map(item => compactEntry(item, stars)).filter(entry => entry !== undefined)
  const compact = dedupeByName(rows)

  const value = {
    version: pkg.version,
    builtAt: typeof index.builtAt === 'string' ? index.builtAt : undefined,
    schemaVersion: schema,
    count: compact.length,
    rows: rows.length,
    source: `npm:${INDEX_PACKAGE}`,
    fetchedAt: new Date().toISOString(),
    bytes: tgz.length,
    entries: compact,
  }
  writeCache(value, env)
  return {
    ...value,
    cached: false,
    downloaded: true,
    elapsedMs: Date.now() - started,
    sizeMB: Math.round((tgz.length / 1048576) * 10) / 10,
  }
}

/**
 * Stars live in their own shard and are optional: if it is missing or malformed the
 * index is still usable, just without the popularity ordering.
 *
 * @param {{ path: string, data?: Buffer, type: string }[]} entries
 * @param {any} index
 */
function readStars(entries, index) {
  const info = record(index.stars)
  if (typeof info?.url !== 'string') return undefined
  const entry = entries.find(item => item.type === 'file' && item.path.endsWith(`/v1/${info.url}`))
  if (entry?.data === undefined) return undefined
  if (typeof info.sha256 === 'string' && sha256(entry.data) !== info.sha256) return undefined
  try {
    const parsed = JSON.parse(entry.data.toString('utf8'))
    const source = record(parsed?.stars) ?? record(parsed) ?? {}
    /** @type {Record<string, number>} */
    const out = {}
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === 'number') out[name.toLowerCase()] = value
      else if (record(value) !== undefined && typeof record(value)?.stars === 'number') out[name.toLowerCase()] = record(value).stars
    }
    return out
  } catch {
    return undefined
  }
}

/** @param {any} value @param {NodeJS.ProcessEnv} env */
function writeCache(value, env) {
  const dir = indexDir(env)
  mkdirSync(dir, { recursive: true })
  const file = indexPath(env)
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value), 'utf8')
  try {
    renameSync(temporary, file)
  } catch {
    writeFileSync(file, JSON.stringify(value), 'utf8')
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
}

/**
 * Search the compacted index. Pure and synchronous: 23k entries filter in a few
 * milliseconds, so the UI can call this on every keystroke.
 *
 * @param {any} index
 * @param {{ query?: string, category?: string, limit?: number, offset?: number, sort?: 'stars'|'updated'|'name' }} [options]
 */
export function searchIndex(index, options = {}) {
  const entries = Array.isArray(index?.entries) ? index.entries : []
  const query = String(options.query ?? '').trim().toLowerCase()
  const category = String(options.category ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(Number(options.limit ?? 30), 1), 200)
  const offset = Math.max(Number(options.offset ?? 0), 0)

  const terms = query.split(/\s+/).filter(term => term !== '')
  const matched = entries.filter(entry => {
    if (category !== '' && String(entry.category ?? '').toLowerCase() !== category) return false
    if (terms.length === 0) return true
    const haystack = [
      entry.name,
      entry.desc,
      entry.category,
      ...(Array.isArray(entry.caps) ? entry.caps : []),
      entry.publisher,
    ].filter(value => typeof value === 'string').join(' ').toLowerCase()
    return terms.every(term => haystack.includes(term))
  })

  const sort = options.sort ?? 'stars'
  const ordered = matched.sort((left, right) => {
    if (sort === 'name') return String(left.name).localeCompare(String(right.name))
    if (sort === 'updated') return String(right.published ?? '').localeCompare(String(left.published ?? ''))
    const delta = (right.stars ?? 0) - (left.stars ?? 0)
    return delta !== 0 ? delta : String(left.name).localeCompare(String(right.name))
  })

  return {
    total: ordered.length,
    offset,
    limit,
    entries: ordered.slice(offset, offset + limit),
  }
}

/**
 * Category histogram, for building filters without a second pass in the UI.
 * @param {any} index
 */
export function categoryCounts(index) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const entry of Array.isArray(index?.entries) ? index.entries : []) {
    const key = typeof entry.category === 'string' && entry.category !== '' ? entry.category : 'other'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([category, count]) => ({ category, count }))
}

