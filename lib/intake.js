/**
 * Lenient intake: accept whatever the user typed and never answer with a bare error.
 *
 * The old behaviour was "resolve or fail": a name that is not an exact npm package, a
 * GitHub URL copied from a browser, a search phrase, a typo — all produced
 * `RESOLVE_FAILED`. That is the wrong shape for the one input box the market has. A
 * person typing "桌宠" is not asking for an error, they are asking "what is it called".
 *
 * So: classify first, then act.
 *
 *   · a spec we can resolve (npm name, `owner/repo`, `github:…`, `/tree/…`, tarball URL,
 *     local file) → hand it to `resolveSpec`
 *   · anything else → search the local index and answer with candidates
 *   · a spec that fails to resolve → **also** answer with candidates, because a typo and
 *     a phrase deserve the same treatment
 *
 * The result always carries `status`, so callers can render "not found, here is what is
 * close" without inventing copy for every failure mode.
 *
 * @module dshm-compat/intake
 */
import { parseNpmSpec } from './fetch.js'
import { loadIndex, searchIndex } from './index-source.js'

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i

/**
 * What kind of thing is this string?
 *
 * @param {unknown} raw
 * @returns {{ kind: 'empty'|'github'|'url'|'path'|'npm'|'phrase', text: string }}
 */
export function classifyInput(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { kind: 'empty', text }
  if (/^github:/i.test(text)) return { kind: 'github', text }
  if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(text)) return { kind: 'github', text }
  if (/^https?:\/\//i.test(text)) return { kind: 'url', text }
  if (/\.(?:tgz|tar\.gz)$/i.test(text)) return { kind: 'path', text }
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('./') || text.startsWith('.\\') || /\\/.test(text)) {
    return { kind: 'path', text }
  }
  // `owner/repo` (exactly one slash, both sides look like repo names) is GitHub shorthand.
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) && !text.startsWith('@')) return { kind: 'github', text }
  // `pkg@1.2.3` / `@scope/pkg@next` — npm name plus a version range. parseNpmSpec
  // (fetch.js) accepts any range after the last '@', including empty (latest); a
  // version-pinned spec must reach resolveSpec, not die as a search phrase.
  const versioned = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@([^@\s/]*)$/i.exec(text)
  if (versioned !== null && NPM_NAME.test(versioned[1])) return { kind: 'npm', text }
  if (NPM_NAME.test(text) && !/\s/.test(text)) return { kind: 'npm', text }
  return { kind: 'phrase', text }
}

/**
 * Candidates for a string that is not (yet) a spec.
 *
 * @param {string} text
 * @param {{ env?: NodeJS.ProcessEnv, limit?: number }} [options]
 */
export function suggest(text, options = {}) {
  const index = loadIndex(options.env ?? process.env)
  if (index === undefined) {
    return {
      status: 'no-index',
      query: String(text ?? ''),
      entries: [],
      hint: '本地还没有全量索引；先跑一次 compat_market_index { refresh: true } 就能按名字搜索。',
    }
  }
  const query = String(text ?? '').trim()
  // Strict substring only. Fuzzy candidates on a misspelled name read as "this exists,
  // try it" and send the user to a package they never asked for.
  const result = searchIndex(index, { query, limit: Math.min(Math.max(Number(options.limit ?? 8), 1), 30) })
  return {
    status: result.total > 0 ? 'suggest' : 'no-match',
    query,
    total: result.total,
    entries: result.entries,
    index: { version: index.version, count: index.count },
    hint: result.total > 0
      ? '这些是索引里的候选（未验证能否在本机运行）；点一个拿它的适配指令。'
      : '索引里没有匹配项。可以直接给出完整的 npm 包名或 GitHub 地址。',
  }
}

/**
 * One entry point for "the user typed something".
 *
 * `resolve` is injected so this module stays testable without network access, and so the
 * caller keeps ownership of how a spec is fetched.
 *
 * A spec that cannot be resolved is answered with a plain **"未找到该项目"** — not with a
 * guess. Fuzzy candidates here were worse than useless: `dsh-pett` produced a list
 * headed by an unrelated package, which reads as "this exists, try it" and sends the
 * user somewhere they never asked to go. A phrase (spaces, Chinese) is still a search,
 * because "桌宠" is a description, not a misspelled name.
 *
 * @param {unknown} raw
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   resolve?: (text: string) => Promise<any>,
 *   limit?: number,
 * }} [options]
 * @returns {Promise<{ status: 'resolved'|'suggest'|'not-found'|'empty', kind: string, text: string, resolved?: any, suggestions?: any, message?: string }>}
 */
export async function resolveIntake(raw, options = {}) {
  const classified = classifyInput(raw)
  if (classified.kind === 'empty') {
    return { status: 'empty', ...classified, hint: '输入插件名、GitHub 地址或 .tgz 路径都可以。' }
  }

  // A phrase is a search, not a spec — do not even attempt resolution.
  if (classified.kind === 'phrase') {
    const result = suggest(classified.text, options)
    return result.status === 'suggest'
      ? { status: 'suggest', ...classified, suggestions: result }
      : { status: 'not-found', ...classified, suggestions: result, message: notFoundMessage(classified.text) }
  }

  const resolve = options.resolve
  if (typeof resolve !== 'function') return { status: 'resolved', ...classified }

  try {
    const resolved = await resolve(classified.text)
    return { status: 'resolved', ...classified, resolved }
  } catch (error) {
    /*
     * One message for every failure shape: a name that is not on npm, a GitHub URL with
     * a typo in the owner, a `https://` link that is not a tarball. The registry's own
     * wording ("only GitHub repositories and .tgz/.tar.gz URLs are supported") tells the
     * user nothing they can act on; "未找到该项目" plus what they typed does.
     */
    return {
      status: 'not-found',
      ...classified,
      reason: String(error?.message ?? error),
      message: notFoundMessage(classified.text),
      hint: classified.kind === 'github'
        ? '确认地址能打开，且仓库/分支/子目录都存在。'
        : classified.kind === 'url'
          ? '只支持 GitHub 仓库地址和 .tgz / .tar.gz 直链。'
          : classified.kind === 'path'
            ? '确认文件路径存在，且是 .tgz / .tar.gz。'
            : '确认包名拼写完整；也可以直接给 GitHub 地址。',
    }
  }
}

/**
 * @param {string} text
 */
export function notFoundMessage(text) {
  return `未找到该项目：${text}`
}

/**
 * The npm spec a suggestion should be installed by, when the caller wants one.
 * Scoped names and bare names are both valid specs; a GitHub-only entry falls back to
 * the repository URL recorded in the index.
 *
 * @param {{ name?: string, repo?: string }} entry
 */
export function specFor(entry) {
  if (typeof entry?.name === 'string' && NPM_NAME.test(entry.name)) return entry.name
  if (typeof entry?.repo === 'string' && entry.repo !== '') return entry.repo
  return undefined
}
