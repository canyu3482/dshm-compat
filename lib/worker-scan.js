/**
 * Prebuilt-worker triage: can a shim reach this binary at all?
 *
 * The question that cost the project several releases: a worker published its
 * staged temp file with `hard_link`, 9p refused it, and every attempt to fix it
 * with an `LD_PRELOAD` shim failed. The reason was never established up front —
 * whether the binary calls `linkat(2)` through the C library (interposable) or
 * issues the syscall directly (`svc #0` — not interposable) decides which
 * strategies can possibly work, and it is answerable by reading the ELF.
 *
 * This module answers it without running anything:
 *
 *   · which publication / metadata symbols the binary imports (undefined dynsym),
 *   · whether it also carries the machinery to bypass libc (`syscall` import or
 *     raw `svc` / `syscall` instruction bytes),
 *   · and therefore which of the three routes is worth attempting:
 *
 *       preload-viable    imports only, no raw syscall → LD_PRELOAD can rewrite it
 *       needs-ptrace      raw syscall present → only a trap layer can rewrite it
 *       no-publication    neither imported nor raw → it does not publish by linking
 *
 * Limits are stated in the output rather than hidden: the instruction scan looks at
 * executable sections and counts patterns, so its counts are evidence, not a
 * disassembly. `symtab` says whether symbol names came from a real table or from a
 * string sweep.
 *
 * @module dshm-compat/worker-scan
 */

/** Syscalls that decide whether a worker can publish a new file at all. */
const PUBLICATION_SYSCALLS = ['link', 'linkat']

/** Metadata calls that hmdfs refuses or refuses to honour. */
const METADATA_SYSCALLS = [
  'chmod', 'fchmod', 'fchmodat',
  'setxattr', 'lsetxattr', 'fsetxattr',
  'utimensat', 'utimes', 'futimesat',
]

/** Renames are the supported publication path, so they are reported as such. */
const RENAME_SYSCALLS = ['rename', 'renameat', 'renameat2']

const SHF_EXECINSTR = 0x4
const SHT_SYMTAB = 2
const SHT_DYNSYM = 11

/** @param {Buffer} buffer @param {number} offset */
function u64(buffer, offset) {
  return Number(buffer.readBigUInt64LE(offset))
}

/**
 * Parse ELF64 section headers into a usable list. Returns undefined for anything
 * that is not a little-endian ELF64.
 * @param {Buffer} buffer
 */
function parseSections(buffer) {
  if (buffer.length < 64) return undefined
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) return undefined
  if (buffer[4] !== 2 || buffer[5] !== 1) return undefined

  const shoff = u64(buffer, 0x28)
  const shentsize = buffer.readUInt16LE(0x3a)
  const shnum = buffer.readUInt16LE(0x3c)
  const shstrndx = buffer.readUInt16LE(0x3e)
  if (shoff === 0 || shnum === 0 || shentsize < 64 || shoff + shnum * shentsize > buffer.length) return undefined

  const headers = []
  for (let index = 0; index < shnum; index += 1) {
    const base = shoff + index * shentsize
    headers.push({
      nameOffset: buffer.readUInt32LE(base),
      type: buffer.readUInt32LE(base + 4),
      flags: u64(buffer, base + 8),
      offset: u64(buffer, base + 24),
      size: u64(buffer, base + 32),
      link: buffer.readUInt32LE(base + 40),
      entsize: u64(buffer, base + 56),
    })
  }
  const names = headers[shstrndx]
  if (names === undefined) return headers
  const table = buffer.subarray(names.offset, names.offset + names.size)
  /** @param {number} offset */
  const readName = offset => {
    if (offset >= table.length) return ''
    let end = offset
    while (end < table.length && table[end] !== 0) end += 1
    return table.subarray(offset, end).toString('latin1')
  }
  for (const header of headers) header.name = readName(header.nameOffset)
  return headers
}

/**
 * Undefined symbols out of one symbol table section.
 * @param {Buffer} buffer
 * @param {any} section
 * @param {any[]} headers
 */
function importedSymbols(buffer, section, headers) {
  const strings = headers[section.link]
  if (strings === undefined) return []
  const table = buffer.subarray(strings.offset, strings.offset + strings.size)
  const entrySize = section.entsize === 0 ? 24 : section.entsize
  const count = Math.floor(section.size / entrySize)
  const out = []
  for (let index = 1; index < count; index += 1) {           // index 0 is the null symbol
    const base = section.offset + index * entrySize
    if (base + 24 > buffer.length) break
    const nameOffset = buffer.readUInt32LE(base)
    const shndx = buffer.readUInt16LE(base + 6)
    if (shndx !== 0) continue                                 // defined here — not an import
    if (nameOffset >= table.length) continue
    let end = nameOffset
    while (end < table.length && table[end] !== 0) end += 1
    const name = table.subarray(nameOffset, end).toString('latin1')
    if (name !== '') out.push(name)
  }
  return out
}

/**
 * Count raw syscall instructions inside executable sections.
 * @param {Buffer} buffer
 * @param {any[] | undefined} headers
 * @param {'arm64'|'x64'} arch
 */
function countRawSyscalls(buffer, headers, arch) {
  const needle = arch === 'arm64' ? Buffer.from([0x01, 0x00, 0x00, 0xd4]) : Buffer.from([0x0f, 0x05])
  const ranges = []
  if (headers === undefined) {
    ranges.push([0, buffer.length])
  } else {
    for (const header of headers) {
      if ((header.flags & SHF_EXECINSTR) === 0) continue
      if (header.type === 8 || header.size === 0) continue        // NOBITS
      ranges.push([header.offset, Math.min(buffer.length, header.offset + header.size)])
    }
  }
  let count = 0
  for (const [start, end] of ranges) {
    let index = buffer.indexOf(needle, start)
    while (index !== -1 && index + needle.length <= end) {
      count += 1
      index = buffer.indexOf(needle, index + needle.length)
    }
  }
  return count
}

/** @param {string[]} symbols @param {string[]} group */
function mark(symbols, group) {
  /** @type {Record<string, boolean>} */
  const out = {}
  for (const name of group) out[name] = symbols.includes(name)
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {{
 *   ok: boolean, arch?: 'arm64'|'x64', type?: string, bytes: number,
 *   symtab?: 'dynsym'|'symtab'|'strings', imports?: string[],
 *   publication?: Record<string, boolean>, metadata?: Record<string, boolean>, rename?: Record<string, boolean>,
 *   rawSyscall?: { instructions: number, syscallImported: boolean },
 *   verdict?: 'preload-viable'|'needs-ptrace'|'no-publication'|'unknown',
 *   why?: string[], runtimeHints?: string[], reason?: string,
 * }}
 */
export function scanWorker(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) return { ok: false, bytes: buffer?.length ?? 0, reason: 'not a buffer or too short to be ELF' }
  const headers = parseSections(buffer)
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    return { ok: false, bytes: buffer.length, reason: 'not an ELF file' }
  }
  const machine = buffer.readUInt16LE(18)
  const arch = machine === 183 ? 'arm64' : machine === 62 ? 'x64' : undefined
  if (arch === undefined) return { ok: false, bytes: buffer.length, reason: `unsupported ELF machine ${machine}` }

  let imports = []
  let symtab = 'strings'
  if (headers !== undefined) {
    const dynsym = headers.find(header => header.type === SHT_DYNSYM)
    const symtabSection = headers.find(header => header.type === SHT_SYMTAB)
    if (dynsym !== undefined) { imports = importedSymbols(buffer, dynsym, headers); symtab = 'dynsym' }
    else if (symtabSection !== undefined) { imports = importedSymbols(buffer, symtabSection, headers); symtab = 'symtab' }
  }
  if (symtab === 'strings') {
    // Stripped or section-less: fall back to name presence. Weaker evidence, so the
    // output says so and the verdict refuses to claim interposability from it alone.
    const text = buffer.toString('latin1')
    imports = [...PUBLICATION_SYSCALLS, ...METADATA_SYSCALLS, ...RENAME_SYSCALLS, 'syscall']
      .filter(name => new RegExp(`\\b${name}\\b`).test(text))
  }

  const publication = mark(imports, PUBLICATION_SYSCALLS)
  const metadata = mark(imports, METADATA_SYSCALLS)
  const rename = mark(imports, RENAME_SYSCALLS)
  const instructions = countRawSyscalls(buffer, headers, arch)
  const syscallImported = imports.includes('syscall')

  const why = []
  const wantsLink = Object.values(publication).some(Boolean)
  const wantsMetadata = Object.values(metadata).some(Boolean)
  if (wantsLink) why.push(`imports ${Object.entries(publication).filter(([, on]) => on).map(([name]) => name).join('/')} — a link-based publication`)
  if (wantsMetadata) why.push(`imports ${Object.entries(metadata).filter(([, on]) => on).map(([name]) => name).join('/')} — metadata calls hmdfs may refuse`)
  if (syscallImported) why.push('imports syscall() — it can issue syscalls by number, so symbol interposition may be bypassed')
  if (instructions > 0) why.push(`${instructions} raw ${arch === 'arm64' ? 'svc #0' : 'syscall'} instruction(s) in executable sections`)

  let verdict
  if (instructions > 0 || syscallImported) verdict = 'needs-ptrace'
  else if (wantsLink) verdict = symtab === 'strings' ? 'unknown' : 'preload-viable'
  else if (wantsMetadata) verdict = symtab === 'strings' ? 'unknown' : 'preload-viable'
  else verdict = 'no-publication'
  if (symtab === 'strings' && verdict !== 'needs-ptrace') {
    why.push('symbol table unavailable: names were found by string sweep, so "imports only" cannot be proven')
  }

  const text = buffer.toString('latin1')
  const runtimeHints = ['rustix', 'musl', 'GLIBC']
    .filter(name => text.includes(name))
    .map(name => name.toLowerCase())

  return {
    ok: true,
    arch,
    type: buffer.readUInt16LE(16) === 3 ? 'DYN' : buffer.readUInt16LE(16) === 2 ? 'EXEC' : String(buffer.readUInt16LE(16)),
    bytes: buffer.length,
    symtab,
    imports: imports.slice(0, 200),
    publication,
    metadata,
    rename,
    rawSyscall: { instructions, syscallImported },
    verdict,
    why,
    runtimeHints,
  }
}

/**
 * What the verdict means for the compat strategy, in one sentence.
 * @param {string | undefined} verdict
 */
export function verdictAdvice(verdict) {
  if (verdict === 'preload-viable') return 'LD_PRELOAD 可以改写：它通过 C 库调用，符号可被拦截'
  if (verdict === 'needs-ptrace') return 'LD_PRELOAD 大概率无效：它直接发 syscall，只有 ptrace/seccomp 层能改'
  if (verdict === 'no-publication') return '没找到 link/metadata 调用：它可能不通过链接发布新文件，问题在别处'
  return '证据不足（符号表不可用），不要据此下结论'
}
