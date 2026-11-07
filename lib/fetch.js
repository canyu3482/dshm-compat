/**
 * Resolve a npm/GitHub/local plugin spec and download its source archive.
 *
 * The compatibility analyzer runs on the DSHM host, which has network access but
 * no package manager. Everything here uses the global fetch and Node fs only.
 *
 * @module dshm-compat/fetch
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const MIRROR_REGISTRY = 'https://registry.npmmirror.com/'
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/**
 * Default registry for a run. The host this runs on is a phone on a mainland
 * network (0.1.33 device review: 31 MB from registry.npmjs.org cost 2–3
 * minutes), so on DSHM the npmmirror mirror is the default — it serves the
 * identical tarballs and mirrors the same integrity hashes, so every
 * downstream verification still holds. `DSHM_COMPAT_REGISTRY` overrides
 * everywhere, PC keeps the official source.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function defaultRegistry(env = process.env) {
  const override = typeof env.DSHM_COMPAT_REGISTRY === 'string' ? env.DSHM_COMPAT_REGISTRY.trim() : ''
  if (override !== '') return override
  return env.DSHM_PLATFORM === 'ohos' ? MIRROR_REGISTRY : DEFAULT_REGISTRY
}
const MAX_METADATA_BYTES = 32 * 1024 * 1024

/**
 * How long a cached archive may be reused when its content is NOT pinned by an
 * integrity hash or an immutable ref. Moving GitHub refs (`main`) and plain URLs
 * can change under the same name, so their cache is an hour — enough to kill the
 * analyze→convert double download inside one adapt run, not enough to serve a
 * moved branch as if it were the same code.
 */
const CACHE_TTL_MOVING_MS = 60 * 60 * 1000

/**
 * The archive cache runs on phones (this plugin's host is DSHM on HarmonyOS):
 * disk is small and the app sandbox may quota it, so the cache is bounded and
 * evicts oldest-first. Generous enough that a working set of real plugins fits;
 * small enough that a runaway never matters.
 */
const ARCHIVE_CACHE_MAX_BYTES = 256 * 1024 * 1024
const ARCHIVE_CACHE_MAX_FILES = 64

/**
 * Best-effort eviction. Any failure here only means the cache stays one run
 * larger; nothing about the answer changes.
 * @param {string} cacheDir
 */
export function boundArchiveCache(cacheDir) {
  try {
    const entries = readdirSync(cacheDir)
      .filter(name => name.startsWith('archive-') && name.endsWith('.tgz'))
      .map(name => {
        try {
          const file = join(cacheDir, name)
          const stats = statSync(file)
          return { file, shaFile: `${file}.sha`, size: stats.size, mtimeMs: stats.mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter(entry => entry !== undefined)
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (total <= ARCHIVE_CACHE_MAX_BYTES && entries.length <= ARCHIVE_CACHE_MAX_FILES) return
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let remaining = entries.length
    for (const entry of entries) {
      if (total <= ARCHIVE_CACHE_MAX_BYTES && remaining <= ARCHIVE_CACHE_MAX_FILES) break
      try { rmSync(entry.file, { force: true }) } catch { /* keep counting; it will go next run */ }
      try { rmSync(entry.shaFile, { force: true }) } catch { /* ditto */ }
      total -= entry.size
      remaining -= 1
    }
  } catch { /* best effort */ }
}

/** @param {string} text */
function cacheKeyHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * The cache plan for one resolved spec: where its archive would be cached, whether
 * the cached bytes must re-verify against an integrity hash, and for how long the
 * entry may be reused. `undefined` means "do not cache this" (local files are
 * already local).
 *
 * Immutability rules, stated once: an npm dist tarball with a sha512 integrity is
 * content-addressed — the same bytes forever, so no TTL. A GitHub ref that is a
 * full commit sha is equally pinned. Everything else (moving refs, plain URLs,
 * npm entries that shipped without integrity) gets the moving TTL.
 *
 * @param {Awaited<ReturnType<typeof resolveSpec>>} resolved
 * @param {string|undefined} cacheDir
 */
export function archiveCachePlan(resolved, cacheDir) {
  if (cacheDir === undefined || cacheDir === '' || resolved === undefined || resolved.kind === 'file') return undefined
  /** @param {string} key */
  const fileFor = key => join(cacheDir, `archive-${cacheKeyHash(key)}.tgz`)
  if (resolved.kind === 'npm') {
    const key = `npm:${resolved.name}@${resolved.version}`
    const file = fileFor(key)
    if (typeof resolved.integrity === 'string' && resolved.integrity.startsWith('sha512-')) {
      return { key, file, verify: resolved.integrity, ttlMs: undefined }
    }
    // No registry integrity to check against, so the write records its own
    // sha256 sidecar — corruption on disk is caught on read, not served.
    return { key, file, verify: undefined, ttlMs: CACHE_TTL_MOVING_MS, shaFile: `${file}.sha` }
  }
  if (resolved.kind === 'github') {
    const ref = typeof resolved.version === 'string' ? resolved.version : ''
    const pinned = /^[0-9a-f]{40}$/i.test(ref)
    const file = fileFor(`github:${resolved.name}@${ref}`)
    return pinned
      ? { key: `github:${resolved.name}@${ref}`, file, verify: undefined, ttlMs: undefined }
      : { key: `github:${resolved.name}@${ref}`, file, verify: undefined, ttlMs: CACHE_TTL_MOVING_MS, shaFile: `${file}.sha` }
  }
  if (resolved.kind === 'url' && typeof resolved.tarballUrl === 'string') {
    const file = fileFor(`url:${resolved.tarballUrl}`)
    return { key: `url:${resolved.tarballUrl}`, file, verify: undefined, ttlMs: CACHE_TTL_MOVING_MS, shaFile: `${file}.sha` }
  }
  return undefined
}

/** @param {Buffer} buffer */
function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Does this cached file's content still match what the cache promised when it
 * was written? Registry integrity when we have it, the write-time sha256 sidecar
 * when we don't. A missing sidecar on a sidecar entry counts as a mismatch: the
 * cache only ever answers for bytes it can prove.
 * @param {Buffer} buffer @param {{ verify?: string, shaFile?: string }} plan
 */
function cacheContentMatches(buffer, plan) {
  if (plan.verify !== undefined) return integrityMatches(buffer, plan.verify)
  if (plan.shaFile !== undefined) {
    if (!existsSync(plan.shaFile)) return false
    try {
      const expected = readFileSync(plan.shaFile, 'utf8').trim()
      return expected !== '' && expected === sha256Hex(buffer)
    } catch {
      return false
    }
  }
  return true
}

/** @param {Buffer} buffer @param {string} integrity */
function integrityMatches(buffer, integrity) {
  try {
    return createHash('sha512').update(buffer).digest('base64') === integrity.slice('sha512-'.length)
  } catch {
    return false
  }
}

/** @param {string} text */
function trimSlash(text) {
  return text.endsWith('/') ? text.slice(0, -1) : text
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {string} url
 * @param {{ maxBytes?: number, timeoutMs?: number, signal?: AbortSignal, headers?: Record<string,string> }} [options]
 * @returns {Promise<Buffer>}
 */
export async function downloadBuffer(url, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES
  // 5 min: a 31 MB tarball on a mainland phone network took ~2–3 min in the
  // 0.1.33 device review — the old 120 s default aborted mid-download and read
  // as a classify failure instead of a slow network.
  const timeout = options.timeoutMs ?? 300000
  const signals = [AbortSignal.timeout(timeout)]
  if (options.signal) signals.push(options.signal)
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.any(signals),
    headers: { 'user-agent': 'dshm-compat/0.1', ...(options.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}`)
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`archive is ${declared} bytes, above the ${maxBytes} byte limit`)
  }
  if (response.body === null) return Buffer.from(await response.arrayBuffer())
  const reader = response.body.getReader()
  /** @type {Buffer[]} */
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`archive exceeded the ${maxBytes} byte limit`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<unknown>}
 */
export async function fetchJson(url, options = {}) {
  const buffer = await downloadBuffer(url, {
    maxBytes: MAX_METADATA_BYTES,
    timeoutMs: options.timeoutMs ?? 30000,
    signal: options.signal,
    headers: { accept: 'application/json' },
  })
  return JSON.parse(buffer.toString('utf8'))
}

/** @param {string} name */
function packumentUrl(name, registry) {
  const base = trimSlash(registry)
  // The registry expects the scope separator percent-encoded, but not the '@'.
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : encodeURIComponent(name)
  return `${base}/${encoded}`
}

/**
 * @param {string} spec
 * @returns {{ name: string, requested: string }}
 */
export function parseNpmSpec(spec) {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    const at = spec.indexOf('@', slash + 1)
    if (at === -1) return { name: spec, requested: 'latest' }
    return { name: spec.slice(0, at), requested: spec.slice(at + 1) || 'latest' }
  }
  const at = spec.lastIndexOf('@')
  if (at > 0) return { name: spec.slice(0, at), requested: spec.slice(at + 1) || 'latest' }
  return { name: spec, requested: 'latest' }
}

/** @param {string} version */
function versionParts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Minimal range support for the common npm forms. Anything unrecognized falls
 * back to latest; the report records that approximation.
 * @param {string} version
 * @param {string} range
 */
function satisfies(version, range) {
  const value = versionParts(version)
  if (value === undefined) return false
  const text = range.trim()
  if (text === '' || text === '*' || text === 'latest' || text === 'x') return true
  if (text.startsWith('^') || text.startsWith('~')) {
    const base = versionParts(text.slice(1))
    if (base === undefined) return false
    if (value[0] !== base[0]) return false
    if (text.startsWith('~')) return value[1] === base[1] && value[2] >= base[2]
    return value[1] > base[1] || (value[1] === base[1] && value[2] >= base[2])
  }
  if (text.startsWith('>=')) {
    const base = versionParts(text.slice(2))
    if (base === undefined) return false
    for (let i = 0; i < 3; i += 1) {
      if (value[i] > base[i]) return true
      if (value[i] < base[i]) return false
    }
    return true
  }
  const exact = versionParts(text)
  return exact !== undefined && exact[0] === value[0] && exact[1] === value[1] && exact[2] === value[2]
}

/**
 * @param {Record<string, unknown>} packument
 * @param {string} requested
 * @returns {{ version: string, approximated: boolean }}
 */
function pickVersion(packument, requested) {
  const versions = isRecord(packument.versions) ? Object.keys(packument.versions) : []
  const distTags = isRecord(packument['dist-tags']) ? packument['dist-tags'] : {}
  const tag = typeof distTags[requested] === 'string' ? distTags[requested] : undefined
  if (tag !== undefined) return { version: tag, approximated: false }
  if (versions.includes(requested)) return { version: requested, approximated: false }
  const matched = versions.filter(version => satisfies(version, requested))
  if (matched.length > 0) {
    matched.sort((a, b) => {
      const pa = versionParts(a) ?? [0, 0, 0]
      const pb = versionParts(b) ?? [0, 0, 0]
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
    })
    return { version: matched[0], approximated: requested !== matched[0] }
  }
  const latest = typeof distTags.latest === 'string' ? distTags.latest : versions.at(-1)
  if (latest === undefined) throw new Error(`no published version for ${String(packument.name)}`)
  return { version: latest, approximated: true }
}

/**
 * @param {string} spec
 * @param {{ registry?: string, signal?: AbortSignal }} [options]
 */
/**
 * Parse a GitHub spec, including npm's subdirectory form **and GitHub's own URL form**:
 *
 *     github:owner/repo
 *     github:owner/repo#ref
 *     github:owner/repo#ref&path:/sub      ← npm workspace subdirectory
 *     github:owner/repo#path:/sub
 *     https://github.com/owner/repo/tree/main/sub   ← what a browser's copy button gives
 *     https://github.com/owner/repo/blob/main/…
 *     github.com/owner/repo                          ← typed by hand, scheme omitted
 *
 * The `tree/main/dsh-pet` form is what users paste, and before this change it failed
 * `resolveSpec` outright — the one spec shape the report at hand started with. The
 * scheme-less form failed the same way: it is not an npm name (it has slashes) and
 * not `owner/repo` shorthand (two slashes), so it fell through to a registry lookup
 * that could only end in NOTFOUND.
 *
 * @param {string} raw
 * @returns {{ owner: string, repo: string, ref?: string, subdir?: string } | undefined}
 */
export function parseGithubSpec(raw) {
  const stripped = String(raw).replace(/^(?:github:|(?:https?:\/\/)?(?:www\.)?github\.com\/)/i, '')
  const [base, fragment] = stripped.split('#')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/
    .exec((base ?? '').replace(/\/+$/, ''))
  if (match === null) return undefined
  const owner = match[1]
  const repo = match[2].replace(/\.git$/, '')
  // `github.com/../etc` parses to owner ".." — the API URL would silently
  // normalize the dot segment into a different path. A repo owner named "."
  // or ".." does not exist; refuse rather than build a lying URL.
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return undefined
  let ref
  let subdir
  if (match[3] !== undefined) {
    ref = match[3]
    if (match[4] !== undefined && match[4] !== '') subdir = match[4].replace(/^\/+|\/+$/g, '')
  }
  if (typeof fragment === 'string' && fragment !== '') {
    const pathMatch = /(?:^|&)path:\/?([^&]+)/.exec(fragment)
    if (pathMatch !== null) subdir = pathMatch[1].replace(/^\/+|\/+$/g, '')
    const beforePath = fragment.split('&')[0]
    if (beforePath !== '' && !beforePath.startsWith('path:')) ref = beforePath
  }
  return {
    owner,
    repo,
    ...(ref === undefined || ref === '' ? {} : { ref }),
    ...(subdir === undefined || subdir === '' ? {} : { subdir }),
  }
}

export async function resolveSpec(spec, options = {}) {
  const raw = String(spec ?? '').trim()
  if (raw === '') throw new Error('spec is empty')
  const registry = trimSlash(options.registry ?? defaultRegistry())

  // Local file: absolute, or an existing relative path.
  if (isAbsolute(raw) || (existsSync(raw) && !raw.includes('://'))) {
    const file = isAbsolute(raw) ? raw : resolve(raw)
    if (!existsSync(file)) throw new Error(`file not found: ${file}`)
    const stat = statSync(file)
    if (!stat.isFile()) throw new Error(`not a regular file: ${file}`)
    return { kind: 'file', name: file, version: '', tarballUrl: file, file, buffer: readFileSync(file) }
  }

  // GitHub shorthand or URL.
  const parsedGithub = (!raw.startsWith('@') && (
    raw.startsWith('github:')
    || /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(raw)
    || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[#].*)?$/.test(raw)))
    ? parseGithubSpec(raw)
    : undefined
  if (parsedGithub !== undefined) {
    const { owner, repo, ref, subdir } = parsedGithub
    const suffix = ref === undefined ? '' : `/${ref}`
    return {
      kind: 'github',
      name: `${owner}/${repo}`,
      version: ref ?? '',
      // npm's own subdirectory form: `github:owner/repo#ref&path:/sub`. Without
      // carrying `subdir` up, the analyzer reads the repository root and never sees
      // the package that is actually being installed.
      ...(subdir === undefined ? {} : { subdir }),
      tarballUrl: `https://api.github.com/repos/${owner}/${repo}/tarball${suffix}`,
      fallbackUrls: [
        `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`,
        `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/main`,
        `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/master`,
        ...(ref === undefined ? [] : [`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`]),
      ],
    }
  }

  // Direct tarball URL.
  if (/^https?:\/\//i.test(raw)) {
    if (!/\.(?:tgz|tar\.gz)(?:[?#].*)?$/i.test(raw)) {
      throw new Error('only GitHub repositories and .tgz/.tar.gz URLs are supported')
    }
    return { kind: 'url', name: raw, version: '', tarballUrl: raw }
  }

  // npm package spec.
  const { name, requested } = parseNpmSpec(raw)
  const packument = await fetchJson(packumentUrl(name, registry), { signal: options.signal })
  if (!isRecord(packument)) throw new Error(`invalid packument for ${name}`)
  const { version, approximated } = pickVersion(packument, requested)
  const versionEntry = isRecord(packument.versions) && isRecord(packument.versions[version])
    ? packument.versions[version]
    : undefined
  const dist = versionEntry !== undefined && isRecord(versionEntry.dist) ? versionEntry.dist : undefined
  const tarballUrl = dist !== undefined && typeof dist.tarball === 'string' ? dist.tarball : undefined
  if (tarballUrl === undefined) throw new Error(`no tarball for ${name}@${version}`)
  return {
    kind: 'npm',
    name,
    requested,
    version,
    approximated,
    tarballUrl,
    integrity: typeof dist?.integrity === 'string' ? dist.integrity : undefined,
    packument,
  }
}

/**
 * Download the archive for a resolved spec, reusing an already-read local file.
 *
 * With `cacheDir` the archive is cached on disk between runs (see
 * `archiveCachePlan` for the immutability rules). A cache hit is trusted only
 * within its TTL and, when the spec carries an integrity hash, only after the
 * cached bytes re-verify — a tampered or truncated entry is deleted and
 * re-downloaded, never served.
 *
 * @param {Awaited<ReturnType<typeof resolveSpec>>} resolved
 * @param {{ maxBytes?: number, signal?: AbortSignal, cacheDir?: string }} [options]
 */
export async function loadArchive(resolved, options = {}) {
  if (resolved.buffer !== undefined) return resolved.buffer
  const plan = archiveCachePlan(resolved, options.cacheDir)
  if (plan !== undefined) {
    // Cache hits are labelled too, so a report can always say where its bytes
    // came from and what they cost.
    resolved.downloadMs = 0
    resolved.downloadBytes = null
    resolved.downloadSource = 'cache'
    /*
     * The read path is wrapped end to end: a cache entry that is missing,
     * locked (Windows), truncated by a concurrent writer, stale, or simply not
     * the bytes the cache promised must never break the download that follows —
     * any doubt here means "no cache", never an error.
     */
    try {
      if (existsSync(plan.file)) {
        let stale = false
        try {
          stale = plan.ttlMs !== undefined && Date.now() - statSync(plan.file).mtimeMs > plan.ttlMs
        } catch { stale = false }
        if (!stale) {
          const cached = readFileSync(plan.file)
          if (cacheContentMatches(cached, plan)) {
            return cached
          }
          // The cached bytes are not what this entry promised: drop them and
          // fall through to a fresh download.
          try { rmSync(plan.file, { force: true }) } catch { /* re-downloading anyway */ }
          if (plan.shaFile !== undefined) {
            try { rmSync(plan.shaFile, { force: true }) } catch { /* ditto */ }
          }
        }
      }
    } catch { /* unreadable cache = no cache */ }
  }
  const urls = [resolved.tarballUrl, ...(Array.isArray(resolved.fallbackUrls) ? resolved.fallbackUrls : [])]
  let lastError
  for (const url of urls) {
    try {
      // Download timing lands on the resolved spec, so every report can say
      // plainly: "the wait was the network, not the analysis" (0.1.33 device
      // review — a 31 MB win32-payload plugin read as if IT were slow).
      const startedAt = Date.now()
      const buffer = await downloadBuffer(url, {
        maxBytes: options.maxBytes,
        signal: options.signal,
        headers: resolved.kind === 'github' ? { accept: 'application/vnd.github+json' } : {},
      })
      resolved.downloadMs = Date.now() - startedAt
      resolved.downloadBytes = buffer.length
      resolved.downloadSource = new URL(url).host
      if (plan !== undefined) {
        // A body that fails its own integrity hash is a bad response, not a cache
        // candidate — fail the run instead of pinning the bad bytes for later.
        if (plan.verify !== undefined && !integrityMatches(buffer, plan.verify)) {
          throw new Error(`archive from ${url} does not match its ${plan.verify.slice(0, 6)}… integrity hash`)
        }
        try {
          mkdirSync(options.cacheDir, { recursive: true })
          /*
           * Atomic publish: a concurrent reader must never observe a half-written
           * tarball (a partial file would fail verification and cost a re-download
           * at best, or serve as a "valid" moving-TTL entry at worst). Windows can
           * refuse a replacing rename while another handle is open — fall back to
           * a direct write there.
           */
          const temporary = `${plan.file}.tmp-${process.pid}-${Date.now()}`
          writeFileSync(temporary, buffer)
          try {
            renameSync(temporary, plan.file)
          } catch {
            writeFileSync(plan.file, buffer)
            try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
          }
          if (plan.shaFile !== undefined) {
            writeFileSync(plan.shaFile, `${sha256Hex(buffer)}\n`, 'utf8')
          }
          boundArchiveCache(options.cacheDir)
        } catch { /* cache is best-effort; the download itself is the answer */ }
      }
      return buffer
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`no archive URL for ${resolved.name ?? 'spec'}`)
}
