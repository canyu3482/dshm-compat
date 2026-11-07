# dshm-compat development rules

## No per-plugin adaptation

- **Never** add a production branch, recipe, rule, or hand-built artifact for one
  package name. `dshm-compat` must adapt plugins through its generic engines.
- S2/native plugins go through `lib/s2-native.js`: detect the worker and the
  standard runtime/spawn patterns, stage the worker, normalize the manifest, and
  validate the result. Package names may appear only in tests and documentation
  examples, never in `if (name === ...)` logic.
- If a plugin has a genuinely unique protocol, expose a **generic extension
  point** in the plugin engine (patterns, hooks, or sidecar descriptor), not a
  one-off patch.
- `dsh-ops` is a regression fixture. It proves the generic S2 adapter; it is not
  a special case.
- Deliverables are the plugin and its generic tooling, not a converted tarball
  for a single plugin.

## Source patches must never lose semantics silently

- A rewrite of a package's own source (`lib/publish-patch.js`, and anything that
  grows next to it) must state **what it changed and what that costs**. Records
  carry `patternId`, `form`, and a `semantics` list; `warnings[]` repeats the
  weakened ones at the top level. "It built" is not evidence.
- When a source pattern is found but cannot be rewritten, record it in
  `anchorsMissing` and, with `requireNoClobber`, fail the build
  (`status:"patch-unsafe"`). A silent no-op is indistinguishable from a
  successful patch once the build passes — that is exactly how 0.1.13 shipped a
  patch that never took effect.
- Only emit an upgrade (e.g. keeping `hard_link` as the primary path) when the
  file itself proves the needed API. Evidence, not hope.
- Never assume the platform: `link(2)` is refused on the phone profile and
  allowed on PC/2in1. Probe (`lib/hostcap.js`) before deciding to patch, and
  remember a host that allows links says nothing about how 9p exports it.

