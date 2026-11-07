/**
 * Host reach: which files of a package can the DSH bundle actually load, and which
 * bare imports cannot resolve.
 *
 * The host-risk scan used to select files by directory name (tests/, scripts/, bin/…).
 * The wild kept producing shapes that filter misses — Skill bundles mounted via
 * `bundledSkillDir` (prompt assets + skill CLIs, never host code), MCP stdio servers
 * under `servers/` that only exist as spawned subprocesses, and patch rows shipped
 * `disabled: true`. All three share one property: **nothing the host loads ever
 * imports them.** So instead of guessing from names, start from the entries the
 * bundle can load — the package main, the client entry, and each enabled patch row —
 * and follow the package's own import graph. What is not reachable is not host code.
 *
 * The same walk answers a second question: a bare import that is neither built-in,
 * host-provided, declared, nor carried in the tree will throw the moment its module
 * loads — the wallpaper-engine class of packaging break that sailed through
 * conversion and only exploded at device boot.
 *
 * Both walks degrade honestly: no package.json, no resolvable entry, or a self-name
 * that cannot be established ⇒ `fellBack: true` and the caller keeps its previous
 * (path-based) behaviour. Reachability narrows the scan; it must never widen a miss.
 *
 * @module dshm-compat/reach
 */
import { builtinModules } from 'node:module'
import { posix } from 'node:path'

const SOURCE_RE = /\.(?:js|mjs|cjs|ts|mts|cts)$/
/** What the runtime provides by namespace, so a bare import of these is never a gap. */
const HOST_PROVIDED = /^(@deepseek-ai\/|cordis$|@cordis\/|react$|react-dom$|react\/|react-dom\/)/

/** @param {string} spec */
const isBuiltin = spec => spec.startsWith('node:') || builtinModules.includes(spec)

/**
 * One cordis patch row worth knowing about: its `name` and whether it ships disabled.
 * Line-oriented on purpose — patch files are flat `- id:` / `name:` / `disabled:`
 * blocks, and a full YAML parser would be a dependency for three fields.
 * @param {string} text
 * @returns {{ name: string, disabled: boolean }[]}
 */
export function patchRows(text) {
  const rows = []
  let current
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^-\s*(?:id|name)\s*:/.test(line)) {
      current = { name: undefined, disabled: false }
      rows.push(current)
    }
    if (current === undefined) continue
    const name = /^name:\s*['"]?([^'"\s#]+)['"]?/.exec(line)
    if (name !== null) current.name = name[1]
    if (/^disabled:\s*true\b/.test(line)) current.disabled = true
  }
  return rows
}

/** @param {{ path: string, data?: Buffer }[]} files */
function pathSet(files) {
  return new Set(files.map(file => file.path))
}

/**
 * Resolve a subpath the way a loader would: exact, then module endings, then a
 * directory index.
 * @param {Set<string>} paths
 * @param {string} base
 */
function resolveSubpath(paths, base) {
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.ts`]) {
    if (paths.has(candidate)) return candidate
  }
  return undefined
}

/**
 * Static import/require specifiers of one source file. Literals only — a dynamic
 * specifier is a runtime decision, not an edge this walk can follow.
 * @param {string} src
 */
export function specifiersOf(src) {
  const out = new Set()
  const patterns = [
    /import\s+[^'"()]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'"()]*?from\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) {
    let match
    while ((match = re.exec(src)) !== null) out.add(match[1])
  }
  return [...out]
}

/**
 * The patch files a manifest points at, plus the conventional default.
 * @param {{ path: string, data?: Buffer }[]} files
 * @param {any} pkg
 */
function patchTexts(files, pkg) {
  const declared = []
  const bundle = pkg?.dsh?.bundle
  if (typeof bundle?.patch === 'string') declared.push(bundle.patch)
  if (Array.isArray(bundle?.patch)) declared.push(...bundle.patch.filter(item => typeof item === 'string'))
  const wanted = new Set(declared.map(rel => rel.replace(/^\.\//, '')))
  wanted.add('cordis.patch.yml')
  const texts = []
  for (const file of files) {
    if (file.data === undefined || !wanted.has(file.path) || !file.path.endsWith('.yml') && !file.path.endsWith('.yaml')) continue
    texts.push(file.data.toString('utf8'))
  }
  return texts
}

/**
 * The target an exports condition resolves to — string, or the first string among
 * the condition object's common keys. Enough for real manifests; exotic nested
 * conditions degrade to `undefined` and the file-path fallback handles the rest.
 * @param {unknown} value
 */
function exportsTarget(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['default', 'import', 'require', 'node']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return undefined
}

/**
 * Which files can the bundle load — the scan set for host-risk, computed from the
 * entries the loader can actually reach.
 *
 * @param {{ path: string, data?: Buffer }[]} files root-relative tree of one package
 * @param {{ pkg?: any }} [options]
 * @returns {{ fellBack: boolean, files?: Set<string>, roots: string[] }}
 */
export function hostReach(files, options = {}) {
  const pkg = options.pkg
  const selfName = typeof pkg?.name === 'string' && pkg.name !== '' ? pkg.name : undefined
  if (selfName === undefined) return { fellBack: true, roots: [] }
  const paths = pathSet(files)

  // The loader resolves `pkg` and `pkg/sub` through package exports when present —
  // dsh-aris publishes no `main` at all: `.` → ./dsh/index.mjs,
  // `./scope-limits` → ./dsh/scope-limits.mjs. Map every exports key we can read.
  const exportsMap = new Map()
  const exportsField = pkg?.exports
  if (exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    for (const [key, value] of Object.entries(exportsField)) {
      const target = exportsTarget(value)
      if (typeof target === 'string') exportsMap.set(key, target)
    }
  }
  const viaExports = key => {
    const target = exportsMap.get(key)
    if (typeof target !== 'string') return undefined
    return resolveSubpath(paths, target.replace(/^\.\//, ''))
  }

  /** @type {string[]} */
  const roots = []
  const addRoot = base => {
    const resolved = resolveSubpath(paths, base)
    if (resolved !== undefined) roots.push(resolved)
  }
  // Package entry: exports ".", then main, then the conventional index.
  const mainResolved = viaExports('.') ?? addRoot(typeof pkg?.main === 'string' && pkg.main !== '' ? pkg.main.replace(/^\.\//, '') : 'index')
  if (mainResolved !== undefined) roots.unshift(mainResolved)
  // Client half: runs in the web renderer, but the host-risk scan has always covered
  // it (its crashes surface in the same boot report). Keep that coverage.
  addRoot('lib/client')
  addRoot('client')
  // Enabled patch rows that name this package's own subpaths. A row naming another
  // package loads that package, not our files; a disabled row loads nothing.
  for (const text of patchTexts(files, pkg)) {
    for (const row of patchRows(text)) {
      if (row.disabled === true || typeof row.name !== 'string' || row.name === '') continue
      if (row.name === selfName) continue // the main entry, already a root
      if (row.name.startsWith(`${selfName}/`)) {
        const sub = row.name.slice(selfName.length + 1)
        const resolved = viaExports(`./${sub}`) ?? resolveSubpath(paths, sub.replace(/^\.\//, ''))
        if (resolved !== undefined) roots.push(resolved)
      }
    }
  }
  if (roots.length === 0) return { fellBack: true, roots: [] }

  // BFS over the package's own import graph. Bare specifiers are external leaves —
  // their internals are somebody else's tree.
  const reachable = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.pop()
    if (reachable.has(current) || current.includes('node_modules/') || !SOURCE_RE.test(current)) continue
    reachable.add(current)
    const file = files.find(item => item.path === current)
    if (file?.data === undefined) continue
    for (const spec of specifiersOf(file.data.toString('utf8'))) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const resolved = resolveSubpath(paths, posix.normalize(posix.join(posix.dirname(current), spec)))
        if (resolved !== undefined) queue.push(resolved)
      } else if (spec === selfName) {
        queue.push(roots[0])
      } else if (spec.startsWith(`${selfName}/`)) {
        const resolved = resolveSubpath(paths, spec.slice(selfName.length + 1))
        if (resolved !== undefined) queue.push(resolved)
      }
    }
  }
  if (reachable.size === 0) return { fellBack: true, roots }
  return { fellBack: false, files: reachable, roots }
}

/**
 * Bare imports among reachable own files that are neither built-in, host-provided,
 * declared, nor carried in the tree — each one a module-load failure waiting for boot.
 *
 * @param {{ path: string, data?: Buffer }[]} files
 * @param {{ fellBack: boolean, files?: Set<string> }} reach
 * @param {{ declared?: Iterable<string> }} [options]
 * @returns {{ path: string, spec: string }[]}
 */
export function importGaps(files, reach, options = {}) {
  if (reach.fellBack || reach.files === undefined) return []
  const declared = new Set(options.declared ?? [])
  const paths = pathSet(files)
  // A specifier may carry a subpath (`pkg/dist/x.js`): presence is judged on the
  // package name half — scoped packages take the first two segments.
  const carried = spec => {
    const segments = spec.split('/')
    const pkgName = spec.startsWith('@') ? segments.slice(0, 3).join('/') : segments[0]
    return paths.has(`node_modules/${pkgName}/package.json`)
  }
  /** A specifier this loose is minified-code debris, not an import. */
  const plausible = spec => /^[a-z0-9@][^(){};'"`\s]*$/i.test(spec) && !spec.includes('..') && spec.length <= 100

  const gaps = []
  const seen = new Set()
  for (const path of reach.files) {
    if (path.includes('node_modules/')) continue
    const file = files.find(item => item.path === path)
    if (file?.data === undefined) continue
    for (const spec of specifiersOf(file.data.toString('utf8'))) {
      if (spec.startsWith('.') || spec.startsWith('/') || isBuiltin(spec) || HOST_PROVIDED.test(spec)) continue
      if (declared.has(spec) || carried(spec) || seen.has(`${path}→${spec}`)) continue
      if (!plausible(spec)) continue
      seen.add(`${path}→${spec}`)
      gaps.push({ path, spec })
      if (gaps.length >= 40) return gaps
    }
  }
  return gaps
}
