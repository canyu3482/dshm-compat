# Generic conversion patterns

These are the patterns behind `S1`/`S2` plans. They are **generic**: no
production branch is keyed on a package name. A package name may appear only in
tests or as a documentation example.

## S2: native worker

The generic adapter in `lib/s2-native.js` recognizes the common shape of a
native DSH plugin:

1. A worker binary under `runtime/<platform>-<arch>/<name>`, a worker passed
   explicitly with `workerPath`, or a Linux asset on the repository's GitHub
   Release (arm64 preferred, then x64).
2. A JS module exporting a `PLATFORMS` array and interpolating
   `${platform}-${arch}` into runtime paths.
3. Spawn calls of the form `const argv = [file]` or `let argv = [file]`.
4. Optional `package.json` `os`/`cpu` gates and a DSH `peerDependencies` range.

For each match it:

- appends `linux-arm64` (AArch64 worker) or `linux-x64` (x86_64 worker) to
  `PLATFORMS` and injects a `resolveTarget()` helper so `openharmony`/arm64
  resolves to that target in both `resolveWorker` and `tryResolveWorker`;
- replaces `${platform}-${arch}` **inside template literals** with
  `${resolveTarget(platform, arch)}`;
- rewrites every standard spawn call to `['bash', file]` and stages a shell
  wrapper at `file` that `exec`s the real worker with `"$@"`. The
  non-`-c` path is required because `dshm-vm-bash` drops positional parameters
  for `bash -c`; the wrapper preserves the worker's argv;
- removes `os`/`cpu`/`engines.dsh`, drops win32/darwin optional payloads, and
  relaxes `@deepseek-ai/dsh` to `workspace:*`;
- adds `openharmony`/target/arch to `dsh-plugin.json` component targets;
- stages the wrapper at `runtime/<target>/<worker>` and the real binary at
  `<worker>-bin` (AArch64) or `<worker>-x64` (x86_64), with a matching
  `provenance.json` (`version`, `target`, `executable`, `sha256`). The wrapper
  also links the host app-files prefix
  `/data/storage/el2/base/haps/entry/files` to the guest `/mnt/share` mount, so
  a worker that canonicalizes the host `policy.workspaceRoot` sees a real path.

A source package whose `main` is absent but which has a `build`/`prepack` script
returns `needs-build` with `npm ci && npm run build && npm pack`; the produced
tarball is then passed back to `compat_convert`. Before returning that, the
converter retries the package's latest published npm build and records a
`fallback` field when it succeeds. This keeps a source checkout from being
misreported as a broken recipe while still preferring a runnable published build.

### Guest source build

`compat_build { spec, backend: "plan" }` returns the exact PC/CI commands. With
`backend: "guest"` and `confirm: true`, the plugin provisions Node or Rust in
the Alpine guest and runs the detected command (`cargo build --release`, or
`npm ci && npm run build && npm pack`). This is experimental: it needs guest
network, enough guest disk for the toolchain, and a guest-visible source
directory. A failure returns the exact `apk`/build stderr; fall back to an
external build and pass the produced artifact to `compat_convert`.

An x86_64 worker is staged as a shell wrapper plus `qemu-x86_64`, a minimal
x86_64 glibc rootfs, and the original `<worker>-x64`; the wrapper runs QEMU in
the guest. This makes a `linux-x64` runtime usable without an AArch64 rebuild.

If no worker is supplied, none is found in the package, and the GitHub Release
has no Linux asset, the result is `needs-native-build` with the cross-build
command. The adapter never builds the worker itself.

### Building the worker

For a Rust crate under `native/`:

```sh
cargo build --release --locked --manifest-path native/Cargo.toml --target aarch64-unknown-linux-musl
# or, with a Zig-based cross linker:
cargo zigbuild --release --locked --manifest-path native/Cargo.toml --target aarch64-unknown-linux-musl
```

The result must be a static AArch64 musl ELF: `e_machine == 183`, no
`PT_INTERP`. Dynamic glibc binaries will not start in the Alpine guest.

### Generic sidecar

A native worker that follows one-JSON-request / one-JSON-response can also be
staged and called without patching the plugin's own tool layer:

```json
compat_sidecar { "action": "stage", "tarball": "<converted.tgz>", "workerPath": "runtime/linux-arm64/worker", "id": "my-worker" }
compat_sidecar { "action": "probe", "id": "my-worker" }
compat_sidecar { "action": "call", "id": "my-worker", "input": { "ping": true }, "confirm": true }
```

Staging checks the worker is an AArch64 ELF and puts it under
`$DSH_HOME/dshm-compat/sidecars/<id>/`. Calls run through
`bash -c 'exec "$0" "$@"'`, which `dshm-vm-bash` routes into Alpine.

## Common native dependencies

| Dependency | DSHM route |
|---|---|
| `sharp` | DSHM core ships an OpenHarmony port; remove the plugin's dependency so the core resolves it (S1) |
| `koffi` | same as `sharp` |
| `node-pty` | same as `sharp`; DSHM's terminal backend already uses it |
| `better-sqlite3` / `sqlite3` | replace calls with `node:sqlite` (Node 24) or run in the guest |
| `canvas` | no core port; guest or WASM |
| `esbuild` | `esbuild-wasm` on the host or `esbuild` in the guest |
| `bcrypt` | `bcryptjs` |
| `argon2` | `hash-wasm` |

## Electron API shim

For host plugins that import `electron` only for platform glue:

| Electron | DSHM equivalent |
|---|---|
| `app.getPath(...)` | DSH home/paths service |
| `shell.openExternal` / `openPath` | `open-in-app` |
| `dialog.showOpenDialog` | directory picker |
| `clipboard` | ArkWeb clipboard API |
| `ipcMain` / `ipcRenderer` | DSH client connection / Cordis events |
| `BrowserWindow` | not shimmed; reimplement as a DSH client plugin or run remotely |

## Shell commands

A plugin that calls `child_process` directly will not be redirected by
`dshm-vm-bash`. Two options:

1. Rewrite the import in the bundled host code to DSH's `subprocess` service
   (which routes `bash -c` to the guest).
2. Run the whole plugin host half in the guest and proxy its tools over RPC.

The guest has `apk`; ffmpeg, git, and Python can be installed offline by
downloading the Alpine packages on the host, placing them in the 9p share, and
running `apk add --no-network`.
