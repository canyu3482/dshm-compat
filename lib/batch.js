/**
 * Bounded batch analysis.
 *
 * Scanning a market list is the only practical way to answer "which of these
 * can be converted"; doing it serially would be too slow and unbounded
 * concurrency would exhaust the host. This module runs at most three analyses
 * at a time and returns summaries, not full reports.
 *
 * @module dshm-compat/batch
 */
import { analyze } from './analyze.js'

const DEFAULT_CONCURRENCY = 3
const MAX_SPECS = 50

/**
 * @param {string[]} specs
 * @param {{ concurrency?: number, textScan?: boolean, signal?: AbortSignal, registry?: string }} [options]
 */
export async function scan(specs, options = {}) {
  if (!Array.isArray(specs)) throw Object.assign(new Error('specs must be an array'), { code: 'INVALID_SPEC' })
  const unique = [...new Set(specs.filter(spec => typeof spec === 'string' && spec.trim() !== '').map(spec => spec.trim()))]
  if (unique.length > MAX_SPECS) throw Object.assign(new Error(`at most ${MAX_SPECS} specs per scan`), { code: 'TOO_MANY_SPECS' })
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 5, unique.length || 1))
  /** @type {Array<{ spec: string, ok: boolean, strategy?: string, confidence?: string, name?: string, version?: string, error?: string, fingerprint?: string }>} */
  const items = new Array(unique.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= unique.length) return
      const spec = unique[index]
      try {
        const report = await analyze(spec, { textScan: options.textScan === true, signal: options.signal, registry: options.registry })
        items[index] = {
          spec,
          ok: true,
          strategy: report.strategy,
          confidence: report.confidence,
          name: report.resolved?.name,
          version: report.resolved?.version,
          fingerprint: report.fingerprint,
          report,
        }
      } catch (error) {
        items[index] = { spec, ok: false, error: String(error?.message ?? error) }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  const counts = { total: unique.length, ok: 0, error: 0, S0: 0, S1: 0, S2: 0, S3: 0, S4: 0 }
  for (const item of items) {
    if (!item.ok) { counts.error += 1; continue }
    counts.ok += 1
    counts[item.strategy] += 1
  }
  return { counts, items }
}
