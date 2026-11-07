/**
 * One-shot DSHM compatibility doctor.
 *
 * Collects the facts that decide whether an install can work: whether this is
 * DSHM, which core is present, which profile owns the plugin, whether the queue
 * is reachable, and what the guest looks like. It never writes anything.
 *
 * @module dshm-compat/doctor
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditAssets } from './asset-names.js'
import { inspectCore } from './core.js'
import { probeGuest } from './guest.js'
import { findAddons, summariseAddons } from './native-probe.js'
import { describeLinkProbe, linkPolicyFor, probeLinkSupport, readHostFacts } from './hostcap.js'
import { clientServiceNames, hostServiceNames, pendingFromLogs } from './services.js'
import { resolveProfileDir } from './local-install.js'
import { dshHome, status } from './state.js'

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {string} file */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return undefined }
}

/** @param {string} file */
function pluginVersion(file) {
  const pkg = record(readJson(file))
  return typeof pkg?.version === 'string' ? pkg.version : undefined
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {NodeJS.ProcessEnv} env
 */
export async function runDoctor(ctx, env = process.env) {
  /** @type {{ name: string, status: 'ok'|'warn'|'error', detail: string }[]} */
  const checks = []
  const add = (name, status, detail) => checks.push({ name, status, detail: String(detail) })

  const dshm = env.DSHM_PLATFORM === 'ohos' || typeof env.DSHM_HOME === 'string'
  add('dshm', dshm ? 'ok' : 'warn', dshm ? `DSHM_HOME=${dshHome(env)}` : 'not running on DSHM; install/queue checks will be limited')

  const core = inspectCore(env)
  add('core', core.available ? 'ok' : 'warn', core.available ? `DSHM core ${core.version ?? 'unknown'}` : core.reason)

  /*
   * Device facts. These are the ones that decide whether a publication patch is
   * needed at all, and they differ per profile: the phone profile forbids
   * `link(2)` while the PC/2in1 profile allows it. Reporting them here is what
   * stops a green PC run from being read as "the plugin works everywhere".
   */
  const facts = readHostFacts(env)
  if (facts.ready !== undefined) {
    const rt = facts.ready.runtime
    const bits = [
      `node=${rt.nodeVersion ?? '?'}`,
      `platform=${rt.platform ?? '?'}`,
      `jitless=${rt.jitless ?? '?'}`,
      rt.natives === undefined ? undefined : `natives=${Array.isArray(rt.natives) ? rt.natives.length : typeof rt.natives}`,
      rt.terminal === undefined ? undefined : `realShell=${rt.terminal.realShell}`,
      rt.terminal === undefined ? undefined : `libsExec=${rt.terminal.libsExec}`,
    ].filter(bit => bit !== undefined)
    add('host', 'ok', `${facts.source}: ${bits.join(' ')}`)
  } else if (facts.log !== undefined) {
    add('host', 'ok', `${facts.source}: probes=${facts.log.probes.join(',') || 'none'} ${Object.entries(facts.log.fields).map(([key, value]) => `${key}=${value}`).join(' ')}`)
  } else {
    add('host', 'warn', 'no runtime readout found (host-ready.json / dshm-host.log); link policy cannot be inferred from the device, only probed')
  }

  const probeDir = existsSync(dshHome(env)) ? dshHome(env) : undefined
  const link = probeLinkSupport(probeDir)
  add('link', link.ok ? 'ok' : 'warn',
    `${describeLinkProbe(link)}; patch policy → in-process: ${linkPolicyFor('in-process', link)}, guest/9p: ${linkPolicyFor('guest', link)}`)

  const profileDir = resolveProfileDir(env)
  let assets
  if (profileDir === undefined) {
    add('profile', 'warn', 'cannot locate the owning profile; pass profileDir to local installs')
  } else {
    const manifest = record(readJson(join(profileDir, 'package.json')))
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    add('profile', bundles.includes('dshm-compat') ? 'ok' : 'warn',
      `${profileDir}; dshm-compat in bundles: ${bundles.includes('dshm-compat')}`)

    /*
     * Installed asset names. A file the installer named `东张西望.webm\n19 mtim`
     * answers 404 on every route that serves it by name, while the host log stays
     * clean — this check turns that invisible state into one line. Read-only: the
     * doctor reports, `compat_audit { apply: true }` fixes.
     */
    try {
      assets = auditAssets(profileDir)
      if (assets.status === 'missing') {
        add('assets', 'warn', assets.reason)
      } else if (assets.broken.length === 0) {
        add('assets', 'ok', `${assets.scanned} name(s) scanned under node_modules; no installer-mangled names`)
      } else {
        const first = assets.broken[0]
        add('assets', 'error', `${assets.broken.length} file(s) carry pax metadata in their name (e.g. ${JSON.stringify(first.name)} → ${first.shouldBe}); those routes answer 404 until renamed`)
      }
    } catch (error) {
      add('assets', 'warn', `cannot scan installed asset names: ${String(error?.message ?? error)}`)
    }
  }

  const queue = join(dshHome(env), 'install-queue')
  add('install-queue', existsSync(queue) ? 'ok' : 'warn', existsSync(queue) ? queue : `${queue} does not exist yet`)

  const state = status(env)
  add('state', 'ok', `${state.reports.length} report(s), ${state.installs.length} install attempt(s) in ${state.compatDir}`)

  const guest = await probeGuest(ctx, { timeoutMs: 15000 })
  if (guest.status === 'unavailable') add('guest', 'warn', guest.reason)
  else if (guest.status === 'ok') add('guest', 'ok', `${guest.run?.uname ?? 'Linux'} / Alpine ${guest.run?.alpine ?? '?'}; bash=${guest.run?.bash} apk=${guest.run?.apk} node=${guest.run?.node}`)
  else add('guest', 'error', guest.reason ?? guest.stderr ?? 'guest probe failed')

  /*
   * Native addons. A `.node` built against glibc fails at `require` with a single
   * loader line ("Error loading shared library …: No such file or directory") that
   * names the addon rather than the missing library, so it reads like a missing file.
   * Reading the ELF separates that from a genuinely absent file.
   */
  try {
    const addons = findAddons(core.nodeModules, { limit: 200 })
    if (addons.length === 0) {
      add('addons', 'warn', 'core tree has no *.node addons to inspect')
    } else {
      const summary = summariseAddons(addons, path => readFileSync(path))
      const broken = summary.problems
      if (broken.length === 0) add('addons', 'ok', `${summary.total} addon(s), all musl-compatible on arm64`)
      else add('addons', 'error', broken.slice(0, 4).map(item => `${item.path.split('/').pop()}: ${item.verdict}`).join('; '))
    }
  } catch (error) {
    add('addons', 'warn', `cannot inspect addons: ${String(error?.message ?? error)}`)
  }

  /*
   * Services. A row whose required service is missing stays `pending` forever and
   * takes the boot down with it (`dsh-rewind` → `conversationEvents`). Both halves
   * matter: the host side is exact (live registry), the client side is a scan of
   * the core tree's provider bundles and is labelled as such.
   */
  const hostServices = hostServiceNames(ctx)
  const clientInventory = clientServiceNames(core, { env, profileDir })
  add('services', hostServices.length > 0 ? 'ok' : 'warn',
    `host ${hostServices.length} service(s); client ${clientInventory.ok ? clientInventory.names.length : 'unknown'}`
    + ` (${clientInventory.source}${clientInventory.reason === undefined ? '' : ` / ${clientInventory.reason}`})`)

  const pending = pendingFromLogs(env)
  if (pending.ok !== true) {
    add('pending', 'warn', pending.reason)
  } else if (pending.pending.length === 0) {
    add('pending', 'ok', 'no pending or failed rows in the host log')
  } else {
    const stuck = pending.pending
      .filter(item => item.plugin !== undefined)
      .map(item => `${item.plugin} → ${item.service}`)
    add('pending', 'error', stuck.length > 0 ? `rows never activated: ${stuck.join(', ')}` : pending.pending[0].line)
  }

  const overall = checks.some(check => check.status === 'error') ? 'error'
    : checks.some(check => check.status === 'warn') ? 'warn' : 'ok'
  return {
    status: overall,
    pluginVersion: pluginVersion(new URL('../package.json', import.meta.url)),
    dshHome: dshHome(env),
    compatDir: state.compatDir,
    host: {
      source: facts.source,
      ready: facts.ready?.runtime,
      logProbes: facts.log?.probes,
    },
    services: { host: hostServices, client: { ok: clientInventory.ok, source: clientInventory.source, count: clientInventory.names.length } },
    pending: pending.ok === true ? pending.pending : { unavailable: pending.reason },
    assets: assets === undefined || assets.status === 'missing'
      ? { available: false }
      : {
        available: true,
        scanned: assets.scanned,
        broken: assets.broken.length,
        sample: assets.broken.slice(0, 5).map(item => ({ name: item.name, shouldBe: item.shouldBe })),
        limits: assets.limits,
      },
    link: {
      ...link,
      policy: {
        inProcess: linkPolicyFor('in-process', link),
        guest: linkPolicyFor('guest', link),
      },
    },
    checks,
  }
}
