/**
 * Minimal, dependency-free tar.gz reader.
 *
 * DSHM cannot run `npm install` inside a plugin, so the compatibility analyzer
 * must unpack npm/GitHub tarballs with Node built-ins only. This parser handles
 * the subset those archives use: ustar, GNU long names, and pax extended
 * headers. Paths are normalized and traversal outside the extraction root is
 * rejected; symlinks are recorded but never followed.
 *
 * @module dshm-compat/tar
 */
import { gunzipSync } from 'node:zlib'

const BLOCK = 512
const MAX_ENTRIES = 20000
const MAX_UNPACKED = 256 * 1024 * 1024

/** @param {Buffer} buffer */
function isGzip(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

/** @param {Buffer} buffer */
export function gunzipIfNeeded(buffer) {
  return isGzip(buffer) ? gunzipSync(buffer) : buffer
}

/** @param {Buffer} block */
function cstring(block, offset, length) {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

/** @param {Buffer} block */
function octal(block, offset, length) {
  const text = cstring(block, offset, length).trim()
  if (text === '') return 0
  // GNU base-256 for very large values: the first byte's high bit is the marker,
  // not data — it must be masked off or every value comes out 2^7 too large.
  if ((block[offset] & 0x80) !== 0) {
    let value = block[offset] & 0x7f
    for (let i = offset + 1; i < offset + length; i += 1) value = value * 256 + block[i]
    return value
  }
  const parsed = Number.parseInt(text, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

/** @param {Buffer} block */
function headerChecksum(block) {
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i]
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  return { unsigned, signed }
}

/** @param {string} raw */
function safePath(raw) {
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized === '' || normalized === '.') return ''
  if (normalized.startsWith('/')) return ''
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) return ''
  return parts.join('/')
}

/** @param {Buffer} data */
function parsePax(data) {
  /** @type {Record<string, string>} */
  const fields = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) fields[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return fields
}

/**
 * @typedef {{ path: string, type: string, size: number, mode: number, data?: Buffer, link?: string }} TarEntry
 */

/**
 * Extract a tar or tar.gz buffer into regular-file entries.
 *
 * @param {Buffer} buffer
 * @returns {{ entries: TarEntry[], totalBytes: number, truncated: boolean }}
 */
export function extractTar(buffer, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const maxUnpacked = options.maxUnpacked ?? MAX_UNPACKED
  const tar = gunzipIfNeeded(buffer)
  /** @type {TarEntry[]} */
  const entries = []
  let offset = 0
  let totalBytes = 0
  let truncated = false
  let pendingLongName = ''
  /** @type {Record<string, string>} */
  let pendingPax = {}

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) break
    if (entries.length >= maxEntries) { truncated = true; break }

    const stored = octal(header, 148, 8)
    const { unsigned, signed } = headerChecksum(header)
    if (stored !== 0 && stored !== unsigned && stored !== signed) {
      throw new Error('tar checksum mismatch')
    }

    const name = cstring(header, 0, 100)
    const prefix = cstring(header, 345, 155)
    const rawName = pendingLongName !== '' ? pendingLongName : (prefix !== '' ? `${prefix}/${name}` : name)
    pendingLongName = ''
    const typeflag = String.fromCharCode(header[156] || 0x30)
    const size = octal(header, 124, 12)
    const mode = octal(header, 100, 8)
    const link = cstring(header, 157, 100)
    const dataStart = offset + BLOCK

    if (typeflag === 'L') {
      pendingLongName = cstring(tar, dataStart, Math.min(size, tar.length - dataStart))
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const fields = parsePax(tar.subarray(dataStart, Math.min(dataStart + size, tar.length)))
      if (typeflag === 'x') pendingPax = { ...pendingPax, ...fields }
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }

    const paxPath = pendingPax.path
    const paxSize = pendingPax.size === undefined ? undefined : Number.parseInt(pendingPax.size, 10)
    pendingPax = {}
    const path = safePath(paxPath ?? rawName)
    const finalSize = Number.isFinite(paxSize) ? paxSize : size

    if (path === '') {
      offset = dataStart + Math.ceil(finalSize / BLOCK) * BLOCK
      continue
    }

    if (typeflag === '0' || typeflag === '7' || typeflag === '\0') {
      if (totalBytes + finalSize > maxUnpacked) { truncated = true; break }
      const data = Buffer.from(tar.subarray(dataStart, Math.min(dataStart + finalSize, tar.length)))
      entries.push({ path, type: 'file', size: finalSize, mode, data })
      totalBytes += data.length
    } else if (typeflag === '5') {
      entries.push({ path, type: 'dir', size: 0, mode })
    } else if (typeflag === '2' || typeflag === '1') {
      entries.push({ path, type: 'symlink', size: 0, mode, link })
    } else {
      entries.push({ path, type: 'other', size: finalSize, mode })
    }
    offset = dataStart + Math.ceil(finalSize / BLOCK) * BLOCK
  }

  return { entries, totalBytes, truncated }
}

/**
 * Find the package root inside an archive. npm tarballs use `package/`;
 * GitHub archives use `<repo>-<ref>/`. A flat archive is its own root.
 *
 * @param {TarEntry[]} entries
 * @returns {string} the root prefix ('' for flat archives)
 */
export function findRootPrefix(entries) {
  const files = entries.filter(entry => entry.type === 'file' && entry.path !== '')
  if (files.length === 0) return ''
  const first = files[0].path.split('/')[0]
  if (!files.every(entry => entry.path.split('/')[0] === first)) return ''
  return `${first}/`
}
