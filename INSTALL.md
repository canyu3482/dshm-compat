# Installing dshm-compat

The artifact is a normal DSH bundle package: the current
`dshm-compat-<version>.tgz` (built with `npm pack`). It has no runtime
dependencies and adds **21 agent tools** plus one browser half — the
**兼容市场** tab in the Plugins page (and in Settings → Plugins).

## 0. After installing, check two surfaces

| Surface | Where | What you should see |
|---|---|---|
| agent tools | ask the agent for `compat_doctor` | a JSON report with `host` and `link` checks |
| market tab | Settings → Plugins | a tab labelled 兼容市场 next to the built-in inventory tab |

If the tools work but the tab does not appear, the host half is fine and only the
client half failed to mount. Check, in this order:

1. restart DSHM (client bundles load at boot, not on install);
2. `compat_doctor` → `profile` → confirm `dshm-compat` is in `dsh.profile.bundles`;
3. the profile's `node_modules/dshm-compat/package.json` carries
   `dsh.client.platform: "web"` — if it does not, the installed copy is older
   than 0.1.16;
4. the browser console for a `__ModuleLoader__` error naming `dshm-compat`.
   The client bundle requires only `react`, so an error there is a wiring bug,
   not a missing dependency.


## A. DSHM (the tablet)

### A1. npm or GitHub

Publish the package to npm (remove `"private": true` from `package.json`
first), or push this directory to a GitHub repository.

On DSHM builds without a shell, the official **Settings → Plugins → Add plugin**
input calls `pnpm view` before installing and fails with
`Command failed with EACCES: pnpm view ... spawn pnpm EACCES`. Use one of these
instead:

- ask the DSHM Agent to run `pnpm add dshm-compat@0.1.14` in its bash tool (the
  bundled pnpm shim routes that command to the host install queue); or
- install from a GitHub repository URL; or
- after any working install, use the plugin's own `compat_install` tool for
  npm/GitHub specs.

The plugin's local converted tarballs are installed by `compat_install` itself:
it unpacks them into `profiles/<profile>/node_modules/<name>`, records the
dependency and bundle, and asks for a DSHM restart. The host install queue does
not accept local paths, `file:` or `http://` specs.

### A2. HTTPS tarball

Put `dshm-compat-0.1.14.tgz` on any HTTPS host (GitHub Release, Gitee Release,
object storage) and paste the `.tgz` URL into the same Add plugin input. DSHM's
installer accepts tarball specs; if the current market UI refuses a plain URL,
use A1.

### A3. hdc / local path

If `hdc` is available and the app can read the path:

```sh
hdc file send dshm-compat-0.1.14.tgz /data/storage/el2/base/haps/entry/files/dshm-compat-0.1.14.tgz
```

Then enter the absolute path (or `file:/...`) in the Add plugin input. This
depends on the DSHM build's local-file support; A1 is safer.

## B. Desktop DSH (for testing only)

```powershell
& 'D:\安装\dsh-desktop\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\dsh\dsh-26-09-30\dshm-compat\dshm-compat-0.1.14.tgz'
```

If the profile reports `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`, its `node_modules`
was migrated from another DSH home; repair that profile first or use a fresh
profile.

## C. After installation

- The bundle row is `dshm-compat`; enable it if it is disabled.
- Ask the agent to run `compat_status`; it should return the data directory and
  empty report list.
- Then run `compat_analyze`, `compat_plan`, `compat_convert`, `compat_install`.
- No market input interception is included; the tools are the entry point.

## D. Uninstall

Remove `dshm-compat` from the plugin market/plugin manager. Its data lives under
`$DSH_HOME/dshm-compat` and is not removed automatically.
