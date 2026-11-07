/**
 * Native-addon triage: why did `dlopen` fail?
 *
 * The message
 *
 *     Error loading shared library
 *       …/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/musl/system.node:
 *       No such file or directory
 *
 * comes from the dynamic loader, and it is misleading: `ENOENT` here usually means a
 * **dependency** could not be found, not that the named file is missing. Four causes
 * look identical in that one line:
 *
 *   1. the file really is absent (wrong `bin/<abi>/` subdirectory shipped),
 *   2. wrong architecture (x64 addon in an arm64 tree),
 *   3. built against the wrong libc — a glibc addon needs `libc.so.6` and a
 *      `/lib/ld-linux-aarch64.so.1` interpreter; OHOS is musl-based and has neither,
 *   4. right libc, but a `NEEDED` library is not on the loader search path
 *      (e.g. `libgcc_s.so.1` that nothing puts next to the addon).
 *
 * Reading the ELF distinguishes all four without executing anything: the
 * `PT_INTERP` string says which loader it wants, and the `DT_NEEDED` list says which
 * libraries must be resolvable. This module reports both, resolves each dependency
 * against the directories you give it, and names the cause.
 *
 * @module dshm-compat/native-probe
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_INTERP = 3
const SHT_DYNSYM = 11
const SHT_SYMTAB = 2

/** @param {Buffer} buffer @param {number} offset */
function u32(buffer, offset) {
  return buffer.readUInt32LE(offset)
}

/** @param {Buffer} buffer @param {number} offset */
function u64(buffer, offset) {
  return Number(buffer.readBigUInt64LE(offset))
}

/** @param {Buffer} buffer */
function parseHeader(buffer) {
  if (buffer.length < 64) return undefined
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) return undefined
  if (buffer[4] !== 2 || buffer[5] !== 1) return undefined
  return {
    type: buffer.readUInt16LE(16),
    machine: buffer.readUInt16LE(18),
    phoff: u64(buffer, 0x20),
    phentsize: buffer.readUInt16LE(0x36),
    phnum: buffer.readUInt16LE(0x38),
    shoff: u64(buffer, 0x28),
    shentsize: buffer.readUInt16LE(0x3a),
    shnum: buffer.readUInt16LE(0x3c),
    shstrndx: buffer.readUInt16LE(0x3e),
  }
}

/** @param {Buffer} buffer @param {ReturnType<typeof parseHeader>} header */
function programSegments(buffer, header) {
  const out = []
  if (header.phoff === 0 || header.phnum === 0 || header.phentsize < 56) return out
  for (let index = 0; index < header.phnum; index += 1) {
    const base = header.phoff + index * header.phentsize
    if (base + 56 > buffer.length) break
    out.push({
      type: u32(buffer, base),
      offset: u64(buffer, base + 8),
      vaddr: u64(buffer, base + 16),
      filesz: u64(buffer, base + 32),
    })
  }
  return out
}

/** @param {Buffer} buffer @param {ReturnType<typeof parseHeader>} header */
function sections(buffer, header) {
  const out = []
  if (header.shoff === 0 || header.shnum === 0 || header.shentsize < 64) return out
  for (let index = 0; index < header.shnum; index += 1) {
    const base = header.shoff + index * header.shentsize
    if (base + 64 > buffer.length) break
    out.push({
      nameOffset: u32(buffer, base),
      type: u32(buffer, base + 4),
      offset: u64(buffer, base + 24),
      size: u64(buffer, base + 32),
      link: u32(buffer, base + 40),
      entsize: u64(buffer, base + 56),
    })
  }
  const names = out[header.shstrndx]
  if (names !== undefined) {
    const table = buffer.subarray(names.offset, names.offset + names.size)
    for (const section of out) {
      if (section.nameOffset >= table.length) continue
      let end = section.nameOffset
      while (end < table.length && table[end] !== 0) end += 1
      section.name = table.subarray(section.nameOffset, end).toString('latin1')
    }
  }
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {{
 *   ok: boolean, arch?: 'arm64'|'x64', type?: string, interpreter?: string,
 *   needed: string[], soname?: string, rpath: string[], runpath: string[],
 *   verdict?: string, cause?: string, advice?: string, reason?: string,
 * }}
 */
export function probeNative(buffer) {
  const empty = { ok: false, needed: [], rpath: [], runpath: [] }
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) return { ...empty, reason: 'too short to be ELF' }
  const header = parseHeader(buffer)
  if (header === undefined) return { ...empty, reason: 'not a little-endian ELF64 file' }

  const arch = header.machine === 183 ? 'arm64' : header.machine === 62 ? 'x64' : undefined
  const segments = programSegments(buffer, header)

  let interpreter
  for (const segment of segments) {
    if (segment.type !== PT_INTERP) continue
    const raw = buffer.subarray(segment.offset, segment.offset + segment.filesz)
    const end = raw.indexOf(0)
    interpreter = (end === -1 ? raw : raw.subarray(0, end)).toString('latin1')
    break
  }

  const all = sections(buffer, header)
  const dynamic = all.find(section => section.name === '.dynamic')
  const dynamicStringTab = dynamic === undefined ? undefined : all[dynamic.link]

  const needed = []
  const rpath = []
  const runpath = []
  let soname
  if (dynamic !== undefined && dynamicStringTab !== undefined) {
    const strings = buffer.subarray(dynamicStringTab.offset, dynamicStringTab.offset + dynamicStringTab.size)
    const read = offset => {
      if (offset >= strings.length) return ''
      let end = offset
      while (end < strings.length && strings[end] !== 0) end += 1
      return strings.subarray(offset, end).toString('latin1')
    }
    const entrySize = 16
    for (let offset = 0; offset + entrySize <= dynamic.size; offset += entrySize) {
      const tag = buffer.readBigInt64LE(dynamic.offset + offset)
      const value = Number(buffer.readBigUInt64LE(dynamic.offset + offset + 8))
      if (tag === 0n) break
      if (tag === 1n) needed.push(read(value))
      else if (tag === 14n) soname = read(value)
      else if (tag === 15n) rpath.push(...read(value).split(':').filter(Boolean))
      else if (tag === 29n) runpath.push(...read(value).split(':').filter(Boolean))
    }
  }

  const hasGlibc = needed.some(name => /^libc\.so\.6$|^ld-linux|^libpthread\.so\.0$|^libdl\.so\.2$/.test(name))
  const hasMusl = needed.some(name => name === 'libc.so' || name === 'libc.musl-aarch64.so.1')
  const wantsGlibcLoader = typeof interpreter === 'string' && /ld-linux/.test(interpreter)

  let verdict
  let cause
  let advice
  if (arch !== 'arm64') {
    verdict = 'wrong-arch'
    cause = `这个 addon 是 ${arch ?? '未知架构'} 的，而设备是 arm64`
    advice = '换 arm64 构建，或确认安装包选错了 bin/<abi>/ 子目录'
  } else if (hasGlibc || wantsGlibcLoader) {
    verdict = 'glibc-on-musl'
    cause = `它按 glibc 编的${wantsGlibcLoader ? `（interpreter=${interpreter}）` : ''}，需要 ${needed.filter(name => /libc\.so\.6|ld-linux/.test(name)).join(', ')}；OHOS 是 musl，没有这些`
    advice = '这是加载失败的常见原因：换成 musl 目标重新编译，或使用 musl 子目录里的那一份'
  } else if (hasMusl || needed.length === 0) {
    verdict = 'musl-ok'
    cause = needed.length === 0 ? '没有 DT_NEEDED（静态或极简依赖）' : '依赖里是 libc.so（musl），libc 这一关是对的'
    advice = '若仍加载失败，问题在别的 NEEDED 上：用 searchDirs 传入同目录与 lib 目录再解析一次'
  } else {
    verdict = 'unknown-libc'
    cause = '依赖列表里既没有 libc.so.6 也没有 libc.so'
    advice = '把 DT_NEEDED 与设备上的实际库对照'
  }

  return {
    ok: true,
    arch,
    type: header.type === 3 ? 'DYN' : header.type === 2 ? 'EXEC' : String(header.type),
    interpreter,
    needed,
    soname,
    rpath,
    runpath,
    verdict,
    cause,
    advice,
  }
}

/**
 * Resolve `DT_NEEDED` names against directories. On a device the loader searches
 * the executable's directory, its `RUNPATH`/`RPATH`, then the system dirs.
 *
 * @param {string[]} needed
 * @param {string[]} searchDirs
 */
export function resolveNeeded(needed, searchDirs) {
  const resolved = []
  const missing = []
  for (const name of needed) {
    const hit = (searchDirs ?? []).map(dir => join(dir, name)).find(candidate => existsSync(candidate))
    if (hit === undefined) missing.push(name)
    else resolved.push({ name, path: hit })
  }
  return { resolved, missing }
}

/**
 * Read a whole directory's `*.node` files and summarise the ones that cannot load.
 * Used by the doctor check: a core tree whose addons are glibc-built fails at the
 * first `require`, and the single loader line names no cause.
 *
 * @param {string[]} paths
 * @param {(path: string) => Buffer} read
 */
export function summariseAddons(paths, read) {
  const rows = []
  for (const path of paths) {
    try {
      const probe = probeNative(read(path))
      rows.push({ path, dir: dirname(path), ...probe })
    } catch (error) {
      rows.push({ path, ok: false, reason: String(error?.message ?? error) })
    }
  }
  const broken = rows.filter(row => row.ok === true && row.verdict !== 'musl-ok')
  return { total: rows.length, broken: broken.length, rows, problems: broken }
}

/**
 * Find `*.node` files under a directory, bounded.
 * @param {string} root
 * @param {{ limit?: number }} [options]
 */
export function findAddons(root, options = {}) {
  const limit = Number(options.limit ?? 200)
  const out = []
  const walk = dir => {
    if (out.length >= limit) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (out.length >= limit) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (entry.name.endsWith('.node')) out.push(path)
    }
  }
  walk(root)
  return out
}
