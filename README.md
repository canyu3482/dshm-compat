# dshm-compat

Analyze DSH plugins that cannot install or run on HarmonyOS DSHM, then convert
them through the least invasive strategy that can work.

## 5 分钟上手

这个插件做一件事：**让为 DSH 写的插件能装进鸿蒙 DSHM**。给它一个插件名、一个
GitHub 地址或一个本地 `.tgz`，它回答三个问题——**能不能装、要改什么、装上去**。

```text
compat_market  { input: "某插件" }                    ← 一站式：分析→改写→转换，dryRun:true 只看不动
compat_verdict { input: "某插件" }                    ← 只判"能不能装、卡在哪"，不转换不安装（最快）
compat_doctor  { }                                    ← 本机环境体检：core / profile / 队列 / guest
```

三条规矩，先说清楚：

- **装前必看成本**：`dryRun:true` 转换但不落盘；真正安装永远需要 `confirm:true`，装完要重启 DSHM。
- **结论只来自本机**：分析报告、判定缓存、货架徽章都是"这台设备上的事实"；目录里的 `预期可直装`
  之类只是描述，不是承诺。
- **会杀宿主的插件绝不装**：`host-killing` 在分析阶段就被拦下，证据（文件/行号）一并给出。

插件自带一个 **兼容市场** 标签页（插件页里），可以逛目录、搜全部 2 万多个社区插件、
复制任何一条的适配指令——它是便捷壳，不是另一个市场；所有执行仍走上面的宿主工具。

## 工具一览（21 个）

| 想干什么 | 用哪个 |
|---|---|
| 一站式适配（分析→转换→安装） | `compat_market` |
| 只问"能不能装、卡在哪" | `compat_verdict` |
| 只分析、出报告 | `compat_analyze` · `compat_plan` · `compat_scan`（批量 ≤50） |
| 只转换、不出报告 | `compat_convert` · `compat_build`（S2 源码构建） |
| 安装与善后 | `compat_install` · `compat_uninstall` · `compat_verify`（装后复核/回滚） |
| 环境 | `compat_doctor` · `compat_status` |
| 市场（浏览/搜索，不做安装） | `compat_market_index`（全量 2 万+）· `compat_market_browse` |
| S2 原生 worker | `compat_worker_scan` · `compat_native_probe` · `compat_guest_probe` · `compat_guest_provision` · `compat_sidecar` |
| 安全网 | `compat_guard`（体检已装插件）· `compat_audit`（修复错名的资产文件） |

每个工具的完整入参在会话里问 agent 即可；转换策略 S0–S4 的含义见下文与
[docs/RECIPES.md](docs/RECIPES.md)。

## 文档去哪找

| 想了解 | 看 |
|---|---|
| 安装与各端差异 | [INSTALL.md](INSTALL.md) |
| 架构：三层结构、为什么这么设计 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 逐版本改了什么 | [CHANGELOG.md](CHANGELOG.md) |
| 维护者守则（禁按包名写死等五条硬约定） | [AGENTS.md](AGENTS.md) |

## Current phase

> Historical phase notes below run through 0.1.15 only. The living history is
> [CHANGELOG.md](CHANGELOG.md) — 0.1.28 rebuilt the market tab to browse the
> way dshmarket does (debounced IME-safe search, category chips, hot/new sort,
> card grid, pagination, honest 未分析 badges).

0.1.15 was a verification build, not published. It stopped the 9p source patch
from silently changing semantics: the `hard_link` publication is now rewritten
into an explicitly-labelled form (`guarded` when the source proves it can stat and
inspect errno, otherwise a narrower one whose cost is recorded in
`patches[].semantics`), a site that cannot be rewritten is reported instead of
skipped, and `compat_build { requireNoClobber:true }` refuses either case. It also
adds `lib/hostcap.js`: the device's own runtime readout plus a direct `link(2)`
probe, because the phone profile forbids hard links while PC/2in1 allows them —
so "it works on my device" needed a machine-checkable answer.

0.1.14 was a verification build: it fixes the x64 wrapper
`${realName}` interpolation and missing glibc libraries, and adds
`compat_convert { buildNative:true }` to build a 9p-patched native AArch64
worker from source and convert with it. 0.1.13 added the generic 9p
source-build patch (hard_link publication → rename). 0.1.5 added non-`-c`
spawn wrappers, release fallbacks, and `compat_uninstall`; 0.1.4 added the
generic S2 adapter with x86_64 QEMU and GitHub Release acquisition. Phase 1
ships the analyzer, the S0/S1 converter, the generic S2 engine, guest
probing/provisioning, the DSHM install-queue transport, and a profile-local
fallback for artifacts the host queue rejects:

- `compat_analyze` downloads an npm/GitHub/local package and classifies it.
- `compat_plan` returns the concrete conversion plan without changing anything.
- `compat_scan` triages up to 50 specs in parallel and returns a strategy table.
- `compat_convert` rewrites an S0 package's manifest (foreign `os`/`cpu` gates,
  install lifecycle scripts, client platform), vendors missing pure-JS runtime
  dependencies into a flat `node_modules`, validates the resulting tarball, and
  repacks it as a DSHM tarball; for S1 it removes a native dependency that the
  DSHM core already provides. For S2 it uses the generic native adapter: it
  detects the worker, `PLATFORMS` matrix, `${platform}-${arch}` templates,
  standard spawn calls, and foreign `os`/`cpu`/peer gates. A worker can come from
  `workerPath`, the package's `runtime/linux-*`, or the GitHub Release assets
  (linux-arm64 first, then linux-x64). An x86_64 worker is executed through the
  bundled `qemu-x86_64` and glibc rootfs, so no AArch64 rebuild is required.
  A source-only checkout is retried against the package's published npm build
  (with a `fallback` field in the result); only when neither a worker nor a
  published build exists does it return `needs-build`/`needs-native-build` with
  the external build command. Package names are not special-cased.
- `compat_guest_probe` reports the Alpine guest kernel/packages/tools.
- `compat_guest_provision` installs a reviewed allowlist of Alpine packages in
  the guest (`confirm:true` required).
- `compat_sidecar` stages a native Linux/AArch64 worker from a converted
  tarball and lists/probes/calls it in the guest with JSON stdin/stdout.
- `compat_status` lists stored reports and install attempts.
- `compat_market` — the one-stop entry. Give it a plugin **name, npm spec, GitHub
  URL, tarball URL, or local `.tgz`** and it runs the whole pipeline
  (resolve → classify → rewrite → install) and returns a card: strategy, what
  changed, size/sha256, whether a restart is needed, and the exact checks to run
  afterwards. `dryRun:true` converts without touching the profile; installing
  needs `confirm:true`. A native (S2) plugin without `workerPath` is not a dead
  end — the source is prepared and the PC/CI build command is handed back.
- `compat_market_browse` — what can be installed: registry search (or an explicit
  name list) with packument-level friction signals (no `dsh` manifest, foreign
  `os`/`cpu`, peer/engines gate, platform-only optional deps). Metadata only, so
  each entry says `needsAnalysis:true`; follow up with `compat_market`.
- `compat_doctor` checks DSHM mode, core, profile/bundle, queue, state, the
  guest, and — new in 0.1.15 — the host's runtime readout plus a live `link(2)`
  probe with the patch policy it implies, all in one read-only call.
- `compat_install` installs an npm/GitHub spec through the host queue. Local
  `.tgz` paths (and `file:`/`link:`) are unpacked directly into the owning DSH
  profile and its bundle list, then need a DSHM restart; this is required
  because the DSHM host queue rejects local specs.
- `compat_build` plans a source build (PC/CI commands) or, with
  `backend:"guest"` and `confirm:true`, provisions Node/Rust in the Alpine
  guest and attempts the build there. The guest path is experimental and
  depends on guest network/disk. Pass `requireNoClobber:true` to refuse any
  hard-link rewrite that cannot prove it keeps "target must not exist" semantics.
- `compat_uninstall` removes a profile-local package, its dependency entry, and
  its bundle entry; it also needs a restart.
- `compat_worker_scan` reads a prebuilt worker **without running it** and says which
  repair can possibly work: `preload-viable` (an `LD_PRELOAD` shim can rewrite its
  calls), `needs-ptrace` (it issues syscalls directly — a shim cannot reach it),
  `no-publication`, or `unknown` (symbols only found by string sweep). Run this
  before attempting a shim; that question cost several releases.
- `compat_audit` finds the files the host installer named wrong. DSHM unpacks a
  non-ASCII path into `东张西望.webm\n19 mtim` — bytes intact, name wrong — so every
  route that serves that asset by name answers 404 while the host log stays silent.
  The tool reports what each name should be and, with `apply:true`, renames it back
  (names only; nothing is read, compared, or deleted). Paths over 100 bytes that lost
  their pax `path` entirely cannot be recovered by a rename and are reported as a limit.
- `compat_verify` answers "did the plugins I installed actually activate": one
  verdict per pending install (`active` / `failed` / `unknown`) built from the host
  log and the plugin inventory. `rollback:true` removes the ones proven failed;
  installs made with `autoRollback:true` are cleaned up on the next boot without
  asking. `unknown` is never acted on.
- `compat_convert` with `install:true` uses the same local fallback for its
  converted tarball.

The converter stops at the manifest/repack/vendor boundary for S0/S1. S2 also
returns `needs-build` for a source-only package or `needs-native-build` when no
Linux worker can be obtained. It does not silently claim that an unsupported
native build succeeded.

See [architecture](docs/ARCHITECTURE.md) and [conversion recipes](docs/RECIPES.md).

## Development policy

There are **no per-plugin production branches**. S2 native plugins go through
the generic `lib/s2-native.js` engine; package names appear only in tests and
documentation examples. If a plugin has a unique protocol, add a generic
extension point (pattern, hook, or sidecar descriptor) instead of a one-off
patch. See [AGENTS.md](AGENTS.md).

## CLI

The same converter runs on a PC without installing the DSH plugin:

```sh
node bin/dshm-compat.mjs analyze dsh-m
node bin/dshm-compat.mjs plan some-native-plugin
node bin/dshm-compat.mjs convert dsh-cache-billing --no-vendor
node bin/dshm-compat.mjs convert some-native-plugin --worker ./some-native-worker
node bin/dshm-compat.mjs scan dsh-m some-native-plugin some-plugin
```

`convert` writes the tarball under `$DSH_HOME/dshm-compat/builds` (override with
`DSHM_COMPAT_DIR`).

## Test

```sh
node test/run.mjs
```

The harness builds synthetic tarballs under `_tmp`, uses a fake DSHM core, and
never touches a real DSH profile.

Strategy codes:

| Code | Meaning |
|---|---|
| `S0` | pure JS/TS; code-level conversion on the host |
| `S1` | known native dependency with an OHOS/JS substitute |
| `S2` | native binary or shell command; guest Alpine sidecar |
| `S3` | source-available native; WASM or remote build |
| `S4` | unsupported, e.g. a win32-only binary with no source |

## Install

Install the package directory as a DSH bundle in the target profile. On DSHM,
the package can be packed and submitted through the install queue once the
converter phase is in place.

## Data

`$DSH_HOME/dshm-compat/`

- `reports/<fingerprint>.json` — full analyzer report.
- `state.json` — bounded report/install index.

## Safety

The analyzer never executes install scripts. `compat_install` runs third-party
code only after the caller passes `confirm:true`.

## Its own market

This plugin has its own storefront in two surfaces: a **tab in Settings → Plugins**
and the same shelf in the conversation.

### The tab (`lib/client.js`)

Registers into `settings.plugins.tab` — the slot the built-in plugin inventory
uses — with `id: "dshm-compat-market"`, `order: 20`, label 兼容市场. Inside it:

- an input box: paste a plugin name, `owner/repo`, tarball URL or `.tgz` path;
- the catalog (`assets/catalog.json`, inlined into the client bundle because a
  browser half cannot read host files) with each entry's expected strategy;
- 已装 badges from the host's **existing** `remote.pluginInventory` namespace —
  real data, not a guess;
- a copy button producing the exact command the host tool takes:
  `compat_market { input: "dsh-ops" }`.

**Why a copy button rather than an install button**: a browser half cannot call
this plugin's host code. Host services are reached through Typert Remote
namespaces, and those need compiler-generated input codecs
(`descriptor.input` / `result.mode` — see `isTypertRemoteMethod` in
`@deepseek-ai/dsh-typert-protocol`). A plugin cannot synthesise that metadata at
runtime, and there is no generic "run a tool" RPC. So the tab owns discovery and
the decision; execution stays in the host tool. If DSHM ever exposes a plugin
extension point for Remote namespaces, only step 3 changes — the UI does not.

### The shelf in the conversation

`compat_market_browse` with no arguments returns the same shelf, merged with this
device's ledger, and works with no network at all:

```
货架 · 3 条（目录 2 / 已分析 1）
  [S0] market-dry（已分析）
        最近 2026-10-22  …/market-dry-2.0.0.tgz
  [S2] dsh-ops  dsh-ops 运维工具集
        带原生 worker（Rust），走 guest 路线；对它的复测是这套适配器的回归样本。
```

A catalog entry is a description, **never a rule**. Adaptation always goes through
`analyze`/`convert`/`s2-native`; `AGENTS.md` forbids per-package branches and two
tests pin it (`PACKAGE_RULES` empty, client catalog identical to the host's).

### The card

`compat_market` is what you get after typing a name or a URL:

```
[DRY-RUN] market-dry@2.0.0  [S0]  纯 JS/TS — 改写清单即可
  产物   376 B  sha256 0eeb91b41ea0
  改动   removed os gate; removed cpu gate; removed postinstall; client.platform → web
  流程   resolve:ok → classify:ok → transform:ok → install:skipped
  下一步
    1. 确认 warnings 与 changed 列表
    2. 带 confirm:true 重新输入以安装
```

Both conversation tools render prose, not JSON: a market you have to parse is not
a market.

## Positioning

`dshmarket` is DSHM's plugin market UI; it installs whatever `pnpm` accepts, with no
notion of adaptation, so a plugin with foreign `os`/`cpu` gates simply fails to load.
`dshm-compat` answers the question that comes *before* installation — "can this run
here, and if so what has to change".
