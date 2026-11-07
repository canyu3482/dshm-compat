/**
 * Host-risk audit: plugins that do not fail, they kill the host.
 *
 * `dshm-brickpack/v04-throw-async` is the reference case. Installing it produced no
 * failure page, no rescue hook, a stuck「正在应用配置」and an uncancellable install,
 * because the plugin's `apply()` returned an un-awaited rejected promise. The cordis
 * loader had already committed to loading it, so the rejection surfaced as a
 * process-level fault rather than a load error — and DSHM's rescue only mounts on a
 * *failure page*.
 *
 * That class cannot be fixed after the fact: there is nothing to report to the user
 * because the thing that would report is dead. It has to be refused **before** the
 * install, from the source.
 *
 * So this module looks for shapes that end the host process or park it forever:
 *
 *   kills-host              process.exit / process.abort inside the plugin
 *   parks-forever           `await new Promise(() => {})` — a promise nobody settles
 *   async-apply-throws      `async apply()` containing `throw` — rejected promise,
 *                           un-awaited by the loader
 *   top-level-throw         module init throwing, before any row can be marked bad
 *   unhandled-rejection     Promise.reject / an async call with no .catch in file
 *
 * Everything is reported with file, line and the matched text, because "risky" without
 * evidence is not actionable. Severity is deliberately conservative: only the first
 * three are treated as fatal, and the audit never refuses on a hunch alone.
 *
 * @module dshm-compat/host-risk
 */

/** Shapes that end the host process or park it forever. */
const FATAL = [
  {
    kind: 'kills-host',
    pattern: /\bprocess\.(exit|abort)\s*\(/g,
    why: '插件自己调 process.exit/abort：宿主进程被直接结束，任何失败页都来不及出现',
  },
  {
    kind: 'parks-forever',
    pattern: /await\s+new\s+Promise\s*\(\s*(?:\([^)]*\)|)\s*=>\s*\{\s*\}\s*\)/g,
    why: 'await 一个永远不 settle 的 Promise：安装流程会停在「正在应用配置」，且无法取消',
  },
  {
    kind: 'async-apply-throws',
    pattern: /export\s+async\s+function\s+apply\s*\([^)]*\)\s*\{[\s\S]{0,4000}?\bthrow\b/g,
    why: 'async apply 里直接 throw：返回的是 rejected Promise，加载器没 await ⇒ 宿主进程级中断，没有失败页',
  },
  {
    /*
     * The exact `v04-throw-async` shape, verbatim:
     *
     *     export function apply(ctx) {
     *       return Promise.reject(new Error('…'))
     *     }
     *
     * The function is not `async`, so nothing above matches it, yet the loader gets a
     * rejected promise it never awaits — the host dies without a failure page.
     */
    kind: 'apply-returns-rejection',
    pattern: /(?:apply|activate|onLoad)\s*\([^)]*\)\s*\{[^}]{0,600}?return\s+Promise\.reject\s*\(/g,
    why: 'apply 直接 return 了一个已 rejected 的 Promise：加载器不 await，宿主被进程级中断，没有失败页',
  },
]

/** Worth flagging, but not enough to refuse on its own. */
const SUSPECT = [
  {
    kind: 'top-level-throw',
    // Column 0 only: an indented `throw` is inside some function, and flagging those
    // turned every guarded `if (!ok) throw` into a "suspicious plugin".
    pattern: /(?:^|\n)throw\s+new\s/g,
    why: '模块顶层 throw：插件在挂载前就抛，行还来不及被标记为坏，启动只能中断',
  },
  {
    kind: 'unhandled-rejection',
    pattern: /\bPromise\.reject\s*\(/g,
    why: '显式 Promise.reject：若同一文件里没有 .catch，会变成 unhandledRejection',
    /*
     * `r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))` inside a `.then`
     * is idiomatic and harmless — the chain's `.catch` handles it. Flagging that turned
     * two ordinary plugins into "suspect". The rejection only matters when the file has
     * no catch at all.
     */
    skip: text => /\.catch\s*\(/.test(text),
  },
  {
    kind: 'effect-async-throws',
    pattern: /ctx\.effect\(\s*\(?\s*async\b[\s\S]{0,2000}?\bthrow\b/g,
    why: 'ctx.effect 里用 async 且会 throw：cordis 收不到正确的回收结果',
  },
]

/** @param {string} text @param {number} index */
function lineAt(text, index) {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

/** @param {string} text */
function snippet(text, index, length = 90) {
  const start = Math.max(0, text.lastIndexOf('\n', index) + 1)
  const end = Math.min(text.length, text.indexOf('\n', index + length) === -1 ? index + length : text.indexOf('\n', index + length))
  return text.slice(start, end).trim().slice(0, 140)
}

/**
 * Scan one file's source text.
 *
 * @param {string} text
 * @param {string} path
 * @returns {{ path: string, kind: string, fatal: boolean, line: number, why: string, snippet: string }[]}
 */
export function scanText(text, path) {
  const findings = []
  for (const [group, fatal] of [[FATAL, true], [SUSPECT, false]]) {
    for (const rule of group) {
      if (typeof rule.skip === 'function' && rule.skip(text)) continue
      // A fresh lastIndex per rule keeps the regexes safe to reuse across files.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
      let match
      while ((match = pattern.exec(text)) !== null) {
        findings.push({
          path,
          kind: rule.kind,
          fatal,
          line: lineAt(text, match.index),
          why: rule.why,
          snippet: snippet(text, match.index),
        })
        if (match[0].length === 0) pattern.lastIndex += 1
        if (findings.length > 40) return findings
      }
    }
  }
  return findings
}

/**
 * Aggregate findings into a verdict.
 *
 * `host-killing` means the install must be refused: the failure it produces cannot be
 * reported or undone from inside the host.
 *
 * @param {{ path: string, kind: string, fatal: boolean, line: number, why: string, snippet: string }[]} findings
 * @param {{ scanned: number, truncated?: boolean }} [meta]
 */
export function summariseHostRisk(findings, meta = {}) {
  const fatal = findings.filter(item => item.fatal === true)
  const level = fatal.length > 0
    ? 'host-killing'
    : findings.length > 0 ? 'suspect' : 'safe'
  const kinds = [...new Set(findings.map(item => item.kind))]
  return {
    level,
    kinds,
    fatalCount: fatal.length,
    total: findings.length,
    scanned: meta.scanned ?? 0,
    truncated: meta.truncated === true,
    findings: findings.slice(0, 12),
    note: level === 'host-killing'
      ? '这些写法会让宿主进程中断或永久卡住：没有失败页可看，救援脚本也没有挂载条件'
      : level === 'suspect'
        ? '有可疑写法，但没有命中致命项；装上后若异常，优先怀疑它们'
        : '没有命中宿主级风险写法',
  }
}

/**
 * Which files are worth scanning: plugin source, minus tests, fixtures and — this one
 * matters — **auxiliary entrypoints that never run inside the host**.
 *
 * `dsh-pet` was the false positive that forced this list. It carries `process.exit` in
 * three legitimate places: an Electron helper process it spawns, a `standalone.js` CLI
 * with its own entrypoint, and an install-time script. None of them runs in the DSH host,
 * yet a naive scan reported the plugin as `host-killing` — and the guard would then have
 * offered to disable a working wallpaper widget.
 *
 * A rule that disables working plugins is worse than no rule, so the scan is restricted
 * to files the plugin's own row can load.
 *
 * @param {string} path
 */
export function isScannableSource(path) {
  if (!/\.(?:js|mjs|cjs|ts|mts|cts)$/.test(path)) return false
  if (/(?:^|\/)(?:node_modules|test|tests|__tests__|fixtures?|examples?)\//.test(path)) return false
  // Auxiliary processes and build tooling: separate entrypoints, out of the host's reach.
  if (/(?:^|\/)(?:scripts?|tools|runtime|electron-helper|standalone|bin|docs?|bench|benchmark)\//i.test(path)) return false
  if (/\.(?:test|spec)\.[mc]?[jt]sx?$/i.test(path)) return false
  if (/\.d\.[mc]?ts$/i.test(path)) return false
  if (/(?:standalone|ensure-electron|electron-helper|dev-server)[\w.-]*\.[mc]?[jt]s$/i.test(path)) return false
  return true
}
