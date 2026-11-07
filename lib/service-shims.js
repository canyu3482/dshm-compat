/**
 * Service shims: the difference between "we told you it would break" and
 * "it works".
 *
 * A row blocked on a missing client service never activates, so reporting the
 * missing name is only half the job. For a *narrow* set of names the compat client
 * half can provide the service itself, which makes cordis activate the waiting
 * row. The set stays narrow on purpose: a shim that lies about behaviour is worse
 * than a refusal, so a name only gets a shim when
 *
 *   1. its surface is small enough to state exactly, and
 *   2. an empty implementation degrades to "nothing happens", not to wrong data.
 *
 * `conversationEvents` qualifies. `dsh-rewind@0.11.12` uses it as:
 *
 *     const events = ctx.get("conversationEvents") ?? ctx.conversationEvents
 *     if (events?.subscribe !== undefined) {
 *       patch();                                  // walks events.entries()
 *       const off = events.subscribe(patch)
 *       ctx.effect(() => off)
 *     }
 *
 * Both members are optional in its own code, so an empty surface means its
 * dedup patch silently does nothing — which is the honest outcome here, because
 * this deployment has no such event stream for it to dedup in the first place.
 *
 * Anything not in this table keeps the strict behaviour: `status:"blocked"`.
 *
 * Keep this list and the factories in `lib/client.js` in step; a test compares
 * their keys.
 *
 * @module dshm-compat/service-shims
 */

/**
 * @type {Record<string, { sides: ('host'|'client')[], surface: string[], degrade: string, offeredBy: string }>}
 */
export const SERVICE_SHIMS = {
  conversationEvents: {
    sides: ['client', 'host'],
    offeredBy: 'dshm-compat 的客户端与宿主半边',
    surface: ['entries()', 'subscribe(listener)'],
    degrade: '事件流为空：依赖它做 instruction-hint 去重/回放的功能会安静跳过，不报错也不产生数据',
  },
}

/**
 * Split missing names into "compat can supply these" and "nobody can".
 *
 * `side` matters: a name may be safe to stub on one half and not the other. Host
 * gaps default to **not** shimmable — the host talks to real DSH services, so an
 * empty object there is more likely to produce wrong answers than an honest
 * failure. The table opts a name in per side, explicitly.
 *
 * @param {string[]} names
 * @param {'host'|'client'} [side]
 */
export function shimmableServices(names, side = 'client') {
  const covered = []
  const uncovered = []
  for (const name of names) {
    const entry = SERVICE_SHIMS[name]
    if (entry === undefined || !entry.sides.includes(side)) uncovered.push(name)
    else covered.push(name)
  }
  return { covered, uncovered }
}
