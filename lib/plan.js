/**
 * Conversion planning.
 *
 * A plan is the user-visible bridge between a classification and an action. It
 * never executes anything: `compat_convert` consumes the S0/S1 plan, while S2+
 * plans name the guest packages and native build target that a later phase will
 * provision.
 *
 * @module dshm-compat/plan
 */

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** @param {any} report */
function nativeBuildOf(report) {
  const rule = record(report.rule)
  if (record(rule?.nativeBuild) !== undefined) return rule.nativeBuild
  const signals = record(report.signals) ?? {}
  if (signals.nodeGyp === true) {
    return { language: 'node-gyp', target: 'aarch64-unknown-linux-musl', notes: 'build in the Alpine guest with build-base and python3' }
  }
  if (signals.rustSource === true) {
    return { language: 'rust', target: 'aarch64-unknown-linux-musl' }
  }
  if (signals.cSource === true) {
    return { language: 'c/c++', target: 'aarch64-unknown-linux-musl', notes: 'build in the Alpine guest' }
  }
  const native = Array.isArray(report.files?.native) ? report.files.native : []
  if (native.some(file => typeof file.path === 'string' && file.path.endsWith('binding.gyp'))) {
    return { language: 'node-gyp', target: 'aarch64-unknown-linux-musl', notes: 'build in the Alpine guest with build-base and python3' }
  }
  if (native.some(file => typeof file.path === 'string' && /(?:^|\/)Cargo\.toml$/.test(file.path))) {
    return { language: 'rust', target: 'aarch64-unknown-linux-musl' }
  }
  if (native.some(file => typeof file.path === 'string' && /\.(?:c|cc|cpp)$/.test(file.path))) {
    return { language: 'c/c++', target: 'aarch64-unknown-linux-musl', notes: 'build in the Alpine guest' }
  }
  return undefined
}

/** @param {any} report */
export function buildPlan(report) {
  const strategy = report.strategy
  const dependencies = record(report.signals?.dependencies) ?? {}
  const nativeDeps = Array.isArray(report.signals?.nativeDeps) ? report.signals.nativeDeps : []
  const base = {
    spec: report.spec,
    fingerprint: report.fingerprint,
    strategy,
    confidence: report.confidence,
    source: report.resolved,
    reasons: report.reasons,
  }

  if (strategy === 'S0') {
    return {
      ...base,
      kind: 'manifest-and-bundle',
      steps: [
        'remove foreign package.json os/cpu gates',
        'remove preinstall/install/postinstall/prepare lifecycle scripts',
        'normalize dsh.client.platform to web',
        'verify runtime dependencies against the DSHM core; vendor the missing ones',
        'repack and submit to the install queue',
      ],
      dependencies: {
        core: dependencies.core,
        present: dependencies.present ?? [],
        missing: dependencies.missing ?? [],
      },
      warnings: (dependencies.missing ?? []).length > 0
        ? [`missing runtime dependencies will be vendored during conversion: ${(dependencies.missing ?? []).join(', ')}`
          + ' — pure-JS only; anything native, or still missing after vendoring, fails the conversion instead of being flattened']
        : [],
    }
  }

  if (strategy === 'S1') {
    return {
      ...base,
      kind: 'native-substitution',
      steps: [
        'verify each substitute package exists in the DSHM core',
        'remove the native dependency from package.json so the host uses the core port',
        'keep the rest of the manifest unchanged and repack',
      ],
      substitutions: nativeDeps.map(dep => ({ from: dep.name, to: dep.ohos, js: dep.js, note: dep.note })),
      warnings: nativeDeps.some(dep => dep.ohos === undefined)
        ? ['at least one dependency has no drop-in OHOS package; a code-level replacement is required']
        : [],
    }
  }

  if (strategy === 'S2') {
    const nativeBuild = nativeBuildOf(report)
    return {
      ...base,
      kind: 'guest-sidecar',
      guest: {
        alpine: '3.22',
        architecture: 'aarch64',
        packages: ['bash', 'apk-tools', 'nodejs', 'npm', 'python3', 'build-base', 'linux-headers'],
        provisioning: 'download Alpine packages on the host, copy them into the 9p share, then apk add --no-network in the guest',
      },
      nativeBuild,
      steps: [
        'probe the guest with compat_guest_probe',
        'provision Node/npm/build tools in the Alpine guest',
        nativeBuild === undefined
          ? 'run the plugin\'s linux-arm64 artifact in the guest, or rebuild it from source'
          : `cross-build or guest-build for ${nativeBuild.target}`,
        'launch the plugin host half in the guest and bridge its tools to DSH over RPC',
        'register proxy tools and keep the guest process supervised',
      ],
      warnings: Array.isArray(report.signals?.unknownNativeDeps) && report.signals.unknownNativeDeps.length > 0
        ? [`unknown native dependencies: ${report.signals.unknownNativeDeps.join(', ')}`]
        : [],
    }
  }

  if (strategy === 'S3') {
    return {
      ...base,
      kind: 'wasm-or-remote',
      steps: [
        'compile the native addon to WASM with an N-API shim, or build it on a remote Linux/OHOS host',
        'load the WASM module in the host process or proxy the remote result',
      ],
    }
  }

  return {
    ...base,
    kind: 'unsupported',
    steps: ['report the blocking artifact to the plugin author; no honest conversion exists'],
    warnings: report.reasons ?? [],
  }
}
