/**
 * Post-install verification: did the row we just installed actually activate?
 *
 * Installing a plugin can take DSHM down on the next boot (a missing service leaves
 * the row `pending`, and the boot reports `did not activate`). Reporting that after
 * the fact is too late — the user is already looking at a broken start.
 *
 * So a successful install now records an intent to check ("pendingVerify"), and the
 * next boot evaluates it from evidence that already exists:
 *
 *   · the host log, for `pending (waiting for service: X)` on that plugin,
 *   · the plugin inventory, when the host exposes it, for "is the row there at all".
 *
 * Two outcomes are safe to act on:
 *   failed     the row is provably stuck, or provably absent → unattended rollback is
 *              allowed *only when the install asked for it* (`autoRollback:true`)
 *   active     nothing wrong found and the row is listed
 *
 * Everything else stays `unknown` and is reported, never acted upon. An automated
 * uninstall based on a guess is worse than the original failure, because the user
 * loses the evidence along with the plugin.
 *
 * @module dshm-compat/verify
 */
import { readState, writeState } from './state.js'
import { pendingFromLogs } from './services.js'

const MAX_PENDING = 10

/**
 * Record that a plugin was installed and still owes us a boot check.
 * @param {{ name: string, version?: string, profileDir?: string, autoRollback?: boolean, source?: string }} entry
 * @param {NodeJS.ProcessEnv} [env]
 */
export function markPendingVerify(entry, env = process.env) {
  const state = readState(env)
  const pending = Array.isArray(state.pendingVerify) ? state.pendingVerify : []
  const record = {
    name: String(entry.name),
    version: entry.version,
    profileDir: entry.profileDir,
    source: entry.source,
    autoRollback: entry.autoRollback === true,
    at: new Date().toISOString(),
  }
  state.pendingVerify = [record, ...pending.filter(item => item?.name !== record.name)].slice(0, MAX_PENDING)
  writeState(state, env)
  return record
}

/** @param {NodeJS.ProcessEnv} [env] */
export function listPendingVerify(env = process.env) {
  const state = readState(env)
  return Array.isArray(state.pendingVerify) ? state.pendingVerify : []
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export function clearPendingVerify(name, env = process.env) {
  const state = readState(env)
  const pending = Array.isArray(state.pendingVerify) ? state.pendingVerify : []
  const kept = pending.filter(item => item?.name !== name)
  state.pendingVerify = kept
  writeState(state, env)
  return pending.length - kept.length
}

/**
 * Judge every pending entry against the evidence.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   logs?: ReturnType<typeof pendingFromLogs>,
 *   inventory?: string[] | undefined,
 * }} [options]
 */
export function evaluatePending(options = {}) {
  const env = options.env ?? process.env
  const logs = options.logs ?? pendingFromLogs(env)
  const inventory = options.inventory
  const pending = listPendingVerify(env)

  const verdicts = pending.map(entry => {
    const stuck = logs.ok === true
      ? logs.pending.filter(item => item.plugin === entry.name && item.service !== undefined)
      : []
    if (stuck.length > 0) {
      return {
        ...entry,
        verdict: 'failed',
        reason: `log says it is stuck on ${stuck[0].service}`,
        evidence: stuck.slice(0, 3).map(item => item.line),
      }
    }
    if (Array.isArray(inventory)) {
      const present = inventory.some(name => name === entry.name)
      return present
        ? { ...entry, verdict: 'active', reason: 'listed in the plugin inventory and not pending' }
        : { ...entry, verdict: 'failed', reason: 'not in the plugin inventory after a boot' }
    }
    return {
      ...entry,
      verdict: 'unknown',
      reason: logs.ok === true
        ? 'no pending line and no inventory to cross-check'
        : `cannot read host logs (${logs.reason ?? 'unavailable'})`,
    }
  })

  return {
    status: 'ok',
    logsAvailable: logs.ok === true,
    inventoryAvailable: Array.isArray(inventory),
    verdicts,
    counts: {
      failed: verdicts.filter(item => item.verdict === 'failed').length,
      active: verdicts.filter(item => item.verdict === 'active').length,
      unknown: verdicts.filter(item => item.verdict === 'unknown').length,
    },
  }
}

/**
 * Apply the verdicts: drop entries that are settled, and roll back the failed ones
 * that were installed with `autoRollback`.
 *
 * @param {ReturnType<typeof evaluatePending>} evaluation
 * @param {{ env?: NodeJS.ProcessEnv, rollback?: (name: string, profileDir?: string) => any }} [options]
 */
export function applyVerdicts(evaluation, options = {}) {
  const env = options.env ?? process.env
  const rollback = options.rollback
  const actions = []
  for (const verdict of evaluation.verdicts) {
    if (verdict.verdict === 'active') {
      clearPendingVerify(verdict.name, env)
      actions.push({ name: verdict.name, action: 'confirmed-active' })
      continue
    }
    if (verdict.verdict === 'failed') {
      if (verdict.autoRollback !== true || typeof rollback !== 'function') {
        actions.push({
          name: verdict.name,
          action: 'report-only',
          reason: verdict.autoRollback === true ? 'no rollback hook supplied' : 'installed without autoRollback',
        })
        continue
      }
      try {
        const result = rollback(verdict.name, verdict.profileDir)
        if (result?.ok === true) {
          clearPendingVerify(verdict.name, env)
          actions.push({ name: verdict.name, action: 'rolled-back', result })
        } else {
          actions.push({ name: verdict.name, action: 'rollback-failed', result })
        }
      } catch (error) {
        actions.push({ name: verdict.name, action: 'rollback-failed', reason: String(error?.message ?? error) })
      }
      continue
    }
    actions.push({ name: verdict.name, action: 'kept-unknown', reason: verdict.reason })
  }
  return { status: 'ok', actions }
}

/**
 * Pull the installed-plugin list out of the host, when it is exposed. Never throws:
 * an absent service just means "unknown", not "everything is broken".
 * @param {any} ctx
 */
export async function inventoryFromContext(ctx) {
  try {
    const service = ctx?.get?.('pluginInventory')
    if (service === undefined || typeof service?.list !== 'function') return undefined
    const result = await service.list()
    if (result?.ok !== true) return undefined
    const rows = Array.isArray(result.value) ? result.value : (Array.isArray(result.value?.items) ? result.value.items : [])
    return rows
      .map(row => (typeof row?.name === 'string' ? row.name : (typeof row?.id === 'string' ? row.id : undefined)))
      .filter(name => typeof name === 'string')
  } catch {
    return undefined
  }
}
