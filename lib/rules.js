/**
 * Custom compatibility rules.
 *
 * Heuristics classify unknown packages. A rule is an operator-supplied hint for
 * a package whose exact blocker and conversion recipe are already known; it wins
 * over the heuristic and carries build/run instructions the converter cannot
 * infer. Built-in per-package rules are intentionally absent: adaptation lives
 * in the generic engines, not in a package-name branch.
 *
 * A deployment can add rules in
 * `$DSH_HOME/dshm-compat/registry.json`:
 *
 * ```json
 * { "packages": { "my-plugin": { "strategy": "S2", "reason": "...", "next": ["..."] } } }
 * ```
 *
 * @module dshm-compat/rules
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compatDir } from './state.js'

/**
 * @typedef {{
 *   strategy: 'S0'|'S1'|'S2'|'S3'|'S4',
 *   reason: string,
 *   next: string[],
 *   nativeBuild?: { language: string, target: string, crate?: string, binary?: string, notes?: string }
 * }} PackageRule
 */

/** @type {Record<string, PackageRule>} */
export const PACKAGE_RULES = {}

const STRATEGIES = new Set(['S0', 'S1', 'S2', 'S3', 'S4'])

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {unknown} value */
function validRule(value) {
  const rule = record(value)
  if (rule === undefined) return undefined
  if (typeof rule.strategy !== 'string' || !STRATEGIES.has(rule.strategy)) return undefined
  if (typeof rule.reason !== 'string' || rule.reason === '') return undefined
  const next = Array.isArray(rule.next) ? rule.next.filter(item => typeof item === 'string') : []
  const nativeBuild = record(rule.nativeBuild)
  return {
    strategy: rule.strategy,
    reason: rule.reason,
    next,
    ...(nativeBuild === undefined ? {} : {
      nativeBuild: {
        language: typeof nativeBuild.language === 'string' ? nativeBuild.language : 'unknown',
        target: typeof nativeBuild.target === 'string' ? nativeBuild.target : 'aarch64-unknown-linux-musl',
        ...(typeof nativeBuild.crate === 'string' ? { crate: nativeBuild.crate } : {}),
        ...(typeof nativeBuild.binary === 'string' ? { binary: nativeBuild.binary } : {}),
        ...(typeof nativeBuild.notes === 'string' ? { notes: nativeBuild.notes } : {}),
      },
    }),
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, PackageRule>}
 */
export function customRules(env = process.env) {
  const file = env.DSHM_COMPAT_REGISTRY || join(compatDir(env), 'registry.json')
  let text
  try { text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '') } catch { return {} }
  let parsed
  try { parsed = JSON.parse(text) } catch { return {} }
  const packages = record(record(parsed)?.packages)
  if (packages === undefined) return {}
  const result = {}
  for (const [name, value] of Object.entries(packages)) {
    const rule = validRule(value)
    if (rule !== undefined) result[name] = rule
  }
  return result
}

/** @param {string | undefined} name @param {NodeJS.ProcessEnv} [env] */
export function lookupPackageRule(name, env = process.env) {
  if (typeof name !== 'string') return undefined
  return customRules(env)[name] ?? PACKAGE_RULES[name]
}
