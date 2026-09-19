# Dynamic adapter loading + separating adapters from the MCP core (owner Q, 2026-09-19)

Short answer: **dynamic loading is mostly already true; a clean adapter/core split is very feasible — we're ~80% there
because we already vendored the corpus as its own package.** The one real decision is what the adapter SDK contract is.

## What's already dynamic (grounded in the code)
- **Modules lazy-load on first use.** `registry.ts` registers manifest entries as lazy stubs (`_lazy`, `_modulePath`);
  `resolve()` `import()`s the module only when a command is first called. Nothing loads 1,332 adapter files up front.
- **Three adapter sources already coexist:** the vendored builtin manifest, a user manifest (`~/.opencli/clis/
  adapter-manifest.json`), and agent-defined tools (`define()` writes a file, imports it, registers it — hot add/remove,
  no restart).
- **The MCP tool surface updates live:** `sites.enable()` → `syncSiteTools()` → `sendToolListChanged()`.

So "load an adapter on demand without restart" already works for the defined-tool path and lazily for the corpus. What's
*missing* for full dynamic loading is only: (a) registering a **new adapter source at runtime** (sources are fixed at
`load()` today), and (b) reloading/adding a manifest without a restart. Both are small generalizations of
`registerManifest`.

## Why separation is close: the seam already exists physically
The corpus doesn't depend on our `src/` core. It depends on a contract:
- `@jackwener/opencli/registry` — **1110** imports (`cli()`, `Strategy`, `registerCommand`: registration + the page/args
  contract)
- `@jackwener/opencli/errors` — **938** (error vocabulary)
- `@jackwener/opencli/{logger,utils,download,launcher,browser/*}` — a few dozen (helpers)

That contract IS `@jackwener/opencli/*`, which we **already vendored as a separate `file:` package**. Our core imports it
to *provide* pages (the standalone `ExtensionPage` satisfies its page interface); adapters import it to *register*. The
core's MCP surface is already insulated from corpus specifics by the projection layer (strip/rename/deCli). Of 1,332
commands, 321 are pure fetch/pipeline (trivially separable) and 1,011 are browser adapters that depend on the page
contract — which is exactly the SDK's core surface.

## The one decision: what is the adapter SDK?
- **Option A (recommended): adopt the vendored OpenCLI runtime contract AS our adapter SDK** — freeze/rename it to
  `@opencli-mcp/adapter-sdk` (registry `cli`/`registerCommand`, errors, the RuntimePage/page interface, the manifest
  schema). Cheap; **zero adapter rewrites**. We already own it.
- **Option B: define our own SDK** (our `Tab`/`RuntimePage` + our registry + our errors) and migrate 1,332 adapters onto
  it. Big — 2,000+ imports and the page contract to reconcile. Not worth it now.

## Proposed end state (with Option A)
```
@opencli-mcp/adapter-sdk   ← the frozen contract: cli()/registerCommand, errors, RuntimePage interface, manifest schema
opencli-mcp-core           ← MCP server + runtime + engine + object model + registry mechanism + projection.  depends on SDK (to PROVIDE pages)
opencli-adapters (corpus)  ← manifest + adapter modules.  depends ONLY on SDK (to REGISTER).  independently versioned/loadable
```
The core discovers adapter **packages/dirs** (not a hardcoded `vendor/opencli` path) via the generalized source
mechanism, and loads commands on demand. Third parties could ship adapter packages; the corpus updates without a new
core release.

## Phased plan
- **Phase A — dynamic sources (small, do first).** Generalize the registry to N runtime-addable sources; expose
  `sites.installSource(dir|package)` + a reload; auto-scan `~/.opencli-mcp/adapters/`. Lazy load-on-demand already works.
  Gets "dynamic 装载" with low risk.
- **Phase B — formal SDK boundary (medium).** Carve `@opencli-mcp/adapter-sdk` out of the vendored runtime explicitly
  (it exists physically; make it a named contract), point core discovery at packages, split the corpus into its own
  package/repo. No adapter rewrites under Option A.
- **Phase C — publish (later).** Independent versioning + a compatible-SDK-version range in each adapter package.

## Risks / honest notes
- The page contract is wide (ExtensionPage reimplements ~10 methods to satisfy it). Freezing it as a public SDK commits
  us to that surface — but we're already committed by vendoring.
- MCP-native-ization is what *enabled* this: one engine (no shadow CDP), the projection layer (core doesn't know corpus
  CLI-isms), and the vendored corpus already being a separate dep.
- This does not require touching adapter bodies (Option A) — it's a packaging + discovery-mechanism change.
