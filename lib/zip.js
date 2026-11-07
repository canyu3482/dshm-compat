/**
 * Minimal ZIP reader for GitHub release assets.
 *
 * Supports stored (0) and deflate (8) entries and the classic EOCD layout.
 * It intentionally rejects ZIP64 and encrypted archives: release worker
 * payloads are small, and a missing worker is better than guessing.
 *
 * @module dshm-compat/zip
 */
import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** @param {Buffer} buffer */
export function extractZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('not a ZIP archive')
  let eocd = -1
  const start = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory not found')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 is not supported')

  /** @type {{ path: string, data: Buffer }[]} */
  const entries = []
  let offset = centralOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) throw new Error('invalid ZIP central directory')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`unsafe ZIP path: ${name}`)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error(`invalid ZIP local header: ${name}`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
    let data
    if (method === 0) data = compressed
    else if (method === 8) data = inflateRawSync(compressed)
    else throw new Error(`unsupported ZIP compression method ${method} for ${name}`)
    if (data.length !== uncompressedSize) throw new Error(`ZIP size mismatch for ${name}`)
    entries.push({ path: normalized, data })
  }
  return entries
}
