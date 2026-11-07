/**
 * Minimal AArch64 ELF checks shared by the generic S2 adapter and the generic
 * sidecar staging path.
 *
 * @module dshm-compat/elf
 */

/** @param {Buffer} buffer */
export function isAarch64Elf(buffer) {
  return buffer.length >= 64
    && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46
    && buffer[4] === 2 && buffer[5] === 1
    && buffer.readUInt16LE(18) === 183
}

/** @param {Buffer} buffer */
export function isX64Elf(buffer) {
  return buffer.length >= 64
    && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46
    && buffer[4] === 2 && buffer[5] === 1
    && buffer.readUInt16LE(18) === 62
}

/** @param {Buffer} buffer @returns {'arm64'|'x64'|undefined} */
export function elfArch(buffer) {
  if (isAarch64Elf(buffer)) return 'arm64'
  if (isX64Elf(buffer)) return 'x64'
  return undefined
}

/** @param {Buffer} buffer */
export function elfSummary(buffer) {
  if (!isAarch64Elf(buffer)) return undefined
  return {
    class: 64,
    endian: 'little',
    machine: 'AArch64',
    type: buffer.readUInt16LE(16) === 3 ? 'DYN' : buffer.readUInt16LE(16) === 2 ? 'EXEC' : String(buffer.readUInt16LE(16)),
    bytes: buffer.length,
  }
}
