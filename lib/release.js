/**
 * Generic GitHub Release worker acquisition.
 *
 * Some native plugins do not ship a runtime in their npm tarball but publish
 * per-platform workers as release assets. This module finds a Linux asset,
 * extracts it, and returns the first AArch64/x86_64 ELF. It is repository
 * agnostic; no package name is special-cased.
 *
 * @module dshm-compat/release
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { elfArch } from './elf.js'
import { downloadBuffer } from './fetch.js'
import { extractTar } from './tar.js'
import { extractZip } from './zip.js'

const API = 'https://api.github.com'

/** @param {any} report */
export function githubRepo(report) {
  if (report?.resolved?.kind === 'github' && typeof report.resolved.name === 'string') {
    const [owner, repo] = report.resolved.name.split('/')
    if (owner && repo) return { owner, repo }
  }
  const repository = report?.package?.repository
  const candidates = [
    typeof repository === 'string' ? repository : repository?.url,
    typeof report?.package?.homepage === 'string' ? report.package.homepage : undefined,
    typeof report?.package?.bugs === 'string' ? report.package.bugs : report?.package?.bugs?.url,
  ].filter(value => typeof value === 'string')
  for (const url of candidates) {
    const match = url.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i)
    if (match) return { owner: match[1], repo: match[2].replace(/\.git$/i, '') }
  }
  const tarball = report?.resolved?.tarballUrl
  if (typeof tarball === 'string') {
    const match = tarball.match(/api\.github\.com\/repos\/([^/]+)\/([^/]+)/i)
    if (match) return { owner: match[1], repo: match[2] }
  }
  return undefined
}

/** @param {string} url @param {AbortSignal} [signal] */
async function fetchJson(url, signal) {
  const timeout = AbortSignal.timeout(20000)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(url, {
    signal: combined,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dshm-compat' },
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`)
  return await response.json()
}

/** @param {string} owner @param {string} repo @param {string|undefined} version @param {AbortSignal} [signal] */
async function releaseAssets(owner, repo, version, signal) {
  if (typeof version === 'string' && version !== '') {
    for (const tag of [`v${version}`, version]) {
      try {
        const tagged = await fetchJson(`${API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, signal)
        if (Array.isArray(tagged?.assets) && tagged.assets.length > 0) return tagged.assets
      } catch { /* try the next tag, then the latest release */ }
    }
  }
  try {
    const latest = await fetchJson(`${API}/repos/${owner}/${repo}/releases/latest`, signal)
    if (Array.isArray(latest?.assets) && latest.assets.length > 0) return latest.assets
  } catch { /* fall through to the list endpoint */ }
  const releases = await fetchJson(`${API}/repos/${owner}/${repo}/releases?per_page=5`, signal)
  /** @type {any[]} */
  const assets = []
  for (const release of Array.isArray(releases) ? releases : []) {
    if (Array.isArray(release?.assets)) assets.push(...release.assets)
  }
  return assets
}

/** @param {any} asset */
function assetRank(asset) {
  const name = String(asset?.name ?? '').toLowerCase()
  if (!/\.(?:zip|tgz|tar\.gz)$/.test(name)) return undefined
  if (/win32|windows|darwin|macos|source|checksum|sha256/.test(name)) return undefined
  if (!/linux|musl/.test(name)) return undefined
  if (/aarch64|arm64/.test(name)) return 0
  if (/x86_64|amd64|x64/.test(name)) return 1
  return undefined
}

/** @param {Buffer} archive @param {string} name */
function archiveEntries(archive, name) {
  if (/\.zip$/i.test(name)) return extractZip(archive)
  return extractTar(archive).entries
    .filter(entry => entry.type === 'file')
    .map(entry => ({ path: entry.path, data: entry.data }))
}

/**
 * @param {any} report
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<
 *   | { ok: true, buffer: Buffer, name: string, arch: 'arm64'|'x64', asset: string, sha256: string, attempts: any[] }
 *   | { ok: false, reason: string, attempts: any[] }
 * >}
 */
export async function findReleaseWorker(report, options = {}) {
  const attempts = []
  const repo = githubRepo(report)
  if (repo === undefined) return { ok: false, reason: 'no GitHub repository in the package metadata', attempts }

  let assets
  try {
    assets = await releaseAssets(repo.owner, repo.repo, report?.package?.version ?? report?.resolved?.version, options.signal)
  } catch (error) {
    return { ok: false, reason: `GitHub release lookup failed: ${String(error?.message ?? error)}`, attempts }
  }
  const ranked = assets
    .map(asset => ({ asset, rank: assetRank(asset) }))
    .filter(item => item.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
  if (ranked.length === 0) return { ok: false, reason: 'no Linux worker asset in the latest releases', attempts }

  for (const { asset } of ranked) {
    if (Number(asset.size ?? 0) > 64 * 1024 * 1024) {
      attempts.push({ asset: asset.name, stage: 'size', error: `asset is larger than 64 MiB` })
      continue
    }
    const urls = [asset.browser_download_url]
    if (asset.id !== undefined) urls.push(`${API}/repos/${repo.owner}/${repo.repo}/releases/assets/${asset.id}`)
    let archive
    let downloadedUrl
    for (const url of urls) {
      if (typeof url !== 'string') continue
      try {
        archive = await downloadBuffer(url, {
          maxBytes: 64 * 1024 * 1024,
          signal: options.signal,
          headers: url.includes('/releases/assets/') ? { accept: 'application/octet-stream' } : {},
        })
        downloadedUrl = url
        attempts.push({ asset: asset.name, url, stage: 'download', ok: true })
        break
      } catch (error) {
        attempts.push({ asset: asset.name, url, stage: 'download', error: String(error?.message ?? error) })
      }
    }
    if (archive === undefined || downloadedUrl === undefined) continue

    const digestMatch = typeof asset.digest === 'string' ? asset.digest.match(/^sha256:([a-f0-9]{64})$/i) : null
    if (digestMatch !== null) {
      const actual = createHash('sha256').update(archive).digest('hex')
      if (actual !== digestMatch[1].toLowerCase()) {
        attempts.push({ asset: asset.name, stage: 'sha256', error: `expected ${digestMatch[1]}, got ${actual}` })
        continue
      }
    }

    let entries
    try {
      entries = archiveEntries(archive, asset.name)
    } catch (error) {
      attempts.push({ asset: asset.name, stage: 'extract', error: String(error?.message ?? error) })
      continue
    }
    const candidates = entries
      .filter(entry => elfArch(entry.data) !== undefined)
      .sort((a, b) => b.data.length - a.data.length)
    if (candidates.length === 0) {
      attempts.push({ asset: asset.name, stage: 'worker', error: 'archive contains no AArch64/x86_64 ELF' })
      continue
    }
    const worker = candidates[0]
    attempts.push({ asset: asset.name, url: downloadedUrl, stage: 'worker', ok: true })
    return {
      ok: true,
      buffer: worker.data,
      name: basename(worker.path),
      arch: elfArch(worker.data),
      asset: asset.name,
      sha256: createHash('sha256').update(worker.data).digest('hex'),
      attempts,
    }
  }
  return { ok: false, reason: 'no usable Linux worker asset could be downloaded', attempts }
}
