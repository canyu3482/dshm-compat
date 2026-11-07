/**
 * Minimal ustar writer used to repack a converted plugin.
 *
 * npm tarballs are gzipped ustar archives with a `package/` prefix. This writer
 * emits the same shape without a dependency, so the converter works on DSHM
 * where no package manager or build tool is available.
 *
 * @module dshm-compat/pack
 */
import { gzipSync } from 'node:zlib'

const BLOCK = 512

/** @param {Buffer} buffer @param {number} offset @param {number} length @param {number} value */
function writeOctal(buffer, offset, length, value) {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0')
  buffer.write(text.slice(-(length - 1)), offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

/** @param {Buffer} buffer @param {number} offset @param {number} length @param {string} text */
function writeString(buffer, offset, length, text) {
  const bytes = Buffer.from(text, 'utf8')
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, length))
}

/**
 * @param {string} path
 * @returns {{ name: string, prefix: string } | undefined}
 */
function splitName(path) {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' }
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) return { name, prefix }
  }
  return undefined
}

/**
 * A pax extended header carrying the full path, for names that ustar's
 * 100+155-byte split cannot hold — vendored `node_modules` trees hit this
 * regularly, and failing the whole conversion over a filename is the wrong
 * outcome. The reader (and the DSHM host, and npm) consumes `x` records.
 *
 * Caveat, stated because it is a real one: the host's pax parser measured
 * record lengths in bytes but once sliced by character index, which corrupts
 * non-ASCII names. Long paths emitted here are module/file names (ASCII), so
 * bytes equal characters and the record is safe; a non-ASCII path over the
 * ustar limit still throws rather than landing as a mangled name.
 *
 * @param {string} path
 * @returns {Buffer | undefined} the pax record blocks, or undefined when ustar suffices
 */
function paxHeader(path) {
  if (Buffer.byteLength(path, 'utf8') <= 100) return undefined
  const content = `path=${path}\n`
  // POSIX: the record length counts itself (digits + space + key=value + \n).
  // Prepending the digits can change their count, so iterate until stable.
  let length = Buffer.byteLength(content, 'utf8') + 2
  for (;;) {
    const actual = Buffer.byteLength(`${length} ${content}`, 'utf8')
    if (actual === length) break
    length = actual
  }
  const data = Buffer.from(`${length} ${content}`, 'utf8')
  const padded = (BLOCK - (data.length % BLOCK)) % BLOCK
  const body = Buffer.concat([data, Buffer.alloc(padded)])
  const block = Buffer.alloc(BLOCK)
  const name = Buffer.from(`PaxHeader/${path.slice(path.lastIndexOf('/') + 1) || 'header'}`, 'utf8')
  name.copy(block, 0, 0, Math.min(name.length, 100))
  writeOctal(block, 100, 8, 0o644)
  writeOctal(block, 124, 12, data.length)
  writeOctal(block, 136, 12, 0)
  block.fill(0x20, 148, 156)
  block[156] = 0x78 // 'x'
  let checksum = 0
  for (const byte of block) checksum += byte
  writeOctal(block, 148, 8, checksum)
  return Buffer.concat([block, body])
}

/**
 * @param {string} name ustar name field (≤100 bytes)
 * @param {string} namePrefix ustar prefix field (≤155 bytes, '' when unused)
 * @param {Buffer} data
 * @param {number} mode
 * @param {number} mtime
 */
function headerWith(name, namePrefix, data, mode, mtime) {
  const block = Buffer.alloc(BLOCK)
  writeString(block, 0, 100, name)
  writeOctal(block, 100, 8, mode)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  writeOctal(block, 124, 12, data.length)
  writeOctal(block, 136, 12, mtime)
  block.fill(0x20, 148, 156)
  block[156] = 0x30
  writeString(block, 157, 100, '')
  writeString(block, 257, 6, 'ustar')
  block[262] = 0
  writeString(block, 263, 2, '00')
  writeString(block, 265, 32, 'root')
  writeString(block, 297, 32, 'root')
  writeString(block, 345, 155, namePrefix)
  let checksum = 0
  for (const byte of block) checksum += byte
  writeOctal(block, 148, 8, checksum)
  return block
}

/**
 * @param {{ path: string, data: Buffer, mode?: number }[]} entries
 * @param {{ prefix?: string, mtime?: number }} [options]
 * @returns {Buffer} gzipped tarball
 */
export function packTarGz(entries, options = {}) {
  const prefix = options.prefix ?? 'package'
  const mtime = options.mtime ?? Math.floor(Date.now() / 1000)
  /** @type {Buffer[]} */
  const blocks = []
  /*
   * Sort by code point, NOT localeCompare: the same input must produce the same
   * bytes (and therefore the same sha256) on every machine and ICU version —
   * locale collation is environment-dependent and quietly breaks that.
   */
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const entry of sorted) {
    const path = `${prefix}/${entry.path.replace(/^\/+/, '')}`
    const pax = paxHeader(path)
    if (pax !== undefined) {
      /*
       * The host's pax parser once corrupted non-ASCII names (bytes-measured
       * length, character-indexed slice). ASCII long paths are safe — bytes equal
       * characters — but a non-ASCII name over the ustar limit is refused rather
       * than landing as a mangled entry on the device.
       */
      if (/[^\x20-\x7e]/.test(path)) {
        throw new Error(`tar path is too long for a safe pax record (non-ASCII): ${path}`)
      }
      blocks.push(pax)
    }
    const split = splitName(path)
    const name = split === undefined ? path.slice(path.lastIndexOf('/') + 1) : split.name
    const namePrefix = split === undefined ? '' : split.prefix
    blocks.push(headerWith(name, namePrefix, entry.data, entry.mode ?? 0o644, mtime))
    blocks.push(entry.data)
    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}
