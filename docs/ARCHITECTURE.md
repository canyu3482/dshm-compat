# dshm-compat architecture

`dshm-compat` is a DSH plugin that classifies and converts plugins that cannot
install or run on HarmonyOS DSHM. It is deliberately layered: a conversion that
would require a different runtime is reported as such, not disguised as a
manifest edit.

## DSHM constraints that shape the design

1. **No spawnable shell on the host.** The app sandbox rejects `execve` of
   bundled tools. `dshm-vm-bash` redirects `bash -c` into an Alpine QEMU guest.
2. **No host `dlopen` of profile native code.** `dshm-vm-bash`'s path notes say
   `dlopen` only admits `/data/storage/el1/bundle/libs/arm64`; a `.node` placed
   in a profile or plugin directory does not load. Native code must run in the
   guest, or be WASM/pure JS.
3. **The install path is a queue.** `$DSH_HOME/install-queue/<id>.req` is
   consumed by the host's in-process installer, which writes `<id>.done` or
   `<id>.fail` JSON. There is no package manager process to call.
4. **The guest is a full Alpine 3.22 aarch64 userland** with 9p access to the
   sandbox, QGA command execution, `apk`, and network through slirp. It is the
   universal fallback for native code and shell commands.

## Strategy layers

| Code | Layer | What runs where | Conversion |
|---|---|---|---|
| `S0` | code | host | rewrite manifest, repack; dependency vendoring and source builds later |
| `S1` | dependency | host | remove a native dependency that the DSHM core already provides as an OHOS port |
| `S2` | environment | Alpine guest | provision Node/npm/build tools, run or build the native artifact, proxy tools |
| `S3` | instruction | host/guest/remote | compile the addon to WASM with an N-API shim, or build/run remotely |
| `S4` | none | nowhere | report the blocking artifact honestly |

## Pipeline

```
spec ──► resolve (npm / GitHub / local .tgz)
      ──► extract (ustar/pax, no dependency)
      ──► analyze (manifest, native files, scripts, platform/Electron scan, core inventory)
      ──► plan (S0..S4 + concrete steps)
      ──► convert (S0/S1 manifest, S2 generic native adapter)
      ──► pack (ustar writer)
      ──► install queue (DSHM only)
```

## Modules

| Module | Responsibility |
|---|---|
| `lib/fetch.js` | resolve npm specs, GitHub repos, local archives; bounded downloads |
| `lib/tar.js` | ustar/pax extraction with traversal and size guards |
| `lib/analyze.js` | classification evidence, strategy, confidence, next action |
| `lib/core.js` | locate `$DSH_HOME/cores/<version>/node_modules` and compare runtime dependencies |
| `lib/rules.js` | operator-supplied custom rules only; no built-in per-package rules |
| `lib/convert.js` | S0 manifest rewrite/repack and vendoring; S1 native-dependency removal; dispatch to the S2 adapter |
| `lib/s2-native.js` | generic S2 worker/runtime/spawn/peer adapter |
| `lib/release.js` | GitHub Release Linux worker discovery and extraction |
| `lib/zip.js` | dependency-free ZIP reader for release assets |
| `lib/vendor.js` | flat `node_modules` vendoring for missing pure-JS dependencies |
| `lib/validate.js` | post-conversion manifest/entry/dependency validation |
| `lib/plan.js` | user-visible conversion plan for every strategy |
| `lib/guest.js` | read-only Alpine guest probe through `subprocess` |
| `lib/install.js` | DSHM install-queue producer with polling and cancellation |
| `lib/local-install.js` | profile-local tarball install with staging, backup, and rollback |
| `lib/uninstall.js` | profile-local removal of files, dependency, and bundle entry |
| `lib/source-build.js` | source-build planner and experimental guest build |
| `lib/sidecar.js` | generic guest worker staging and JSON-stdio calls |
| `lib/doctor.js` | one-shot DSHM/core/profile/queue/guest diagnosis |
| `lib/state.js` | bounded report/install index and atomic writes |
| `lib/pack.js` | dependency-free ustar/gzip writer |

## Tool surface

| Tool | Side effects |
|---|---|
| `compat_analyze` | network download; writes a report under `$DSH_HOME/dshm-compat` |
| `compat_plan` | network download; writes a report; no package changes |
| `compat_scan` | network downloads; writes one report per successful spec |
| `compat_convert` | writes a converted tarball; optionally submits it to the install queue |
| `compat_guest_probe` | read-only guest command |
| `compat_guest_provision` | installs allowlisted Alpine packages in the guest |
| `compat_sidecar` | stages/lists/probes/calls a JSON-stdio native worker in the guest |
| `compat_doctor` | read-only DSHM/core/profile/queue/guest diagnosis |
| `compat_install` | writes one install-queue request; runs third-party code |
| `compat_build` | plans a source build, or provisions a guest toolchain and runs it with confirm:true |
| `compat_uninstall` | removes a profile-local package, dependency, and bundle entry |
| `compat_status` | read-only |

## Phase status

- **Phase 1 (done):** analyzer, batch triage, S0 manifest converter + flat
  dependency vendoring + output validation, S1 manifest substitution, generic S2
  native adapter (AArch64 worker, x86_64 worker through bundled QEMU, GitHub
  Release acquisition), dependency preflight, guest probe/provisioning, worker
  execution primitive, install queue, offline tests.
- **Phase 2 (next):** on-device guest verification, automatic worker build
  (desktop/CI), nested version-conflict vendoring, sidecar RPC.
- **Phase 3:** WASM/remote fallback, market UI entry, compatibility registry
  updates.

## Non-goals

- Translating a win32-only binary into OHOS code.
- Loading profile `.node` files in the host.
- Running arbitrary `postinstall` scripts on the host.
- Claiming S2/S3/S4 conversions succeeded when only a plan exists.
