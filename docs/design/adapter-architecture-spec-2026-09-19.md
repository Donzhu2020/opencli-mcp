# Adapter architecture — complete spec (first principles)

Owner's insight: "the directory tree is itself the metadata." That's the whole design. Below is the complete, elegant
scheme — layout, descriptor, discovery, execution, SDK boundary, sources/override, migration, edge cases.

## Principle
An adapter is a **self-describing capability**: identity + metadata + implementation. Identity lives in the **path**;
metadata + implementation live in the **module**. The core is a **loader over a list of source directories** — nothing
global, nothing precomputed by hand.

## 1. Filesystem layout — the source of truth
```
adapters/                     ← a "source" (there can be several; see §6)
  twitter/
    site.json                 ← OPTIONAL site-level defaults (domain, strategy, siteSession, description)
    bookmarks.js              ← one file = one command; filename = command name
    search.js
  hackernews/
    top.js
```
- **`adapters/<site>/<command>.js` — the path is the identity.** `site` and `command` are the directory and filename.
  They are NOT repeated in the module (kills the duplication that made the manifest necessary).
- **`site.json` (optional)** carries shared defaults a command inherits unless it overrides: `{ domain, strategy,
  siteSession, defaultWindowMode, description }`. Absent → commands are fully self-contained.

## 2. The descriptor — what a command module exports
```js
import { defineAdapter, Strategy } from '@opencli-mcp/adapter-sdk'

export default defineAdapter({
  description: 'Your bookmarked tweets',
  access: 'read',                 // 'read' | 'write'  (the only safety-relevant field)
  browser: true,                  // needs a logged-in page?
  args: [{ name: 'limit', type: 'int', default: 20, help: '…' }],
  // exactly one of:
  run: async ({ page, args }) => [...],     // imperative
  // pipeline: [ { fetch: {…} }, { map: {…} } ],  // declarative (kept — it's genuinely elegant)
})
```
- `defineAdapter()` is **pure**: it validates + fills defaults + returns the descriptor. **No global registry, no import
  side-effect.** (This is the one change that dissolves the manifest.)
- `site`/`name`/`aliases`: site & name come from the path; `aliases?` may stay in the descriptor.
- `columns` becomes optional legacy metadata (agents read JSON; see the earlier MCP-native work).

## 3. Discovery — two tiers, no authored manifest
- **Cheap tier (site + command names): pure `readdir`.** Site list = subdirs across all sources; a site's commands =
  files in `<site>/`. Instant, zero imports. Powers `doctor` counts and `sites.<site>` existence.
- **Rich tier (description/keywords/args): the module.** Loaded lazily when a command is enabled or run.
- **Cross-site `sites_search`** needs descriptions for ~1332 commands. Answer: a **derived cache** `.cache/index.json`
  (`{site,name,description,keywords,access,domain}` — **~97 KB vs the old 1.1 MB**, no full args). Auto-rebuilt when any
  source dir's mtime is newer than the cache. It is a *cache*: deletable, regenerated, never authored, never the source
  of truth. (Pure-lazy with no cache is possible but makes the first global search slow; the 97 KB cache is the
  pragmatic, honest choice.)

## 4. Execution — a path-addressed lazy loader
`run(site, command, args)`:
1. Resolve the file: first source (by precedence) that has `<site>/<command>.(js|ts)`.
2. `import()` it once (module cache handles repeats) → read `.default`.
3. Merge `site.json` defaults → inject `{ site, command }` from the path.
4. Provide the page/ctx from the runtime; run `run(ctx)` or the `pipeline`; return data.

Only the called command's module is ever imported. No global map to consult.

## 5. The SDK boundary — this IS the core/adapter contract
`@opencli-mcp/adapter-sdk` exports everything an adapter may depend on, and nothing else:
- `defineAdapter()`, `Strategy`, the descriptor + `Arg` types,
- the error helpers (one vocabulary),
- the **`Page` / `Tab` / ctx interface** adapters code against,
- the declarative `pipeline` step types.

Adapters import **only** the SDK. The core imports the SDK types to *provide* the page and *read* descriptors. The
corpus is just a directory → its own package (`@opencli-mcp/adapters`), independently versioned. Third parties ship
their own directory. This is the separation asked for earlier, and it falls out for free.

## 6. Sources, override, dynamic loading — one concept
`sources: string[]` — an ordered list of directories; **a later source overrides an earlier one for the same
`<site>/<command>`.** Default order:
```
[ built-in corpus dir,  ~/.opencli-mcp/adapters,  …runtime-added ]
```
- **Fix/add an adapter without a core release**: drop or edit a file in `~/.opencli-mcp/adapters/<site>/<cmd>.js`. The
  mtime-keyed cache invalidates; next search/run picks it up. No restart.
- **Agent-defined tools** (`tools.define`) = simply *write a file into the user source*. `loadDefinedTools`,
  `registerManifest`, and the user-override branch all collapse into this single mechanism.

## 7. What gets deleted
`cli-manifest.json` (1.1 MB) · the global `__opencli_registry__` Map · `registerCommand` import side-effects ·
`registerManifest` / `loadDefinedTools` / user-override special-casing · lazy-stub bookkeeping · the manifest build
step. The new `registry.ts` (a `SourceLoader`: list / resolve / search-cache) is **net less code**.

## 8. Migration (we own the corpus)
1. **SDK**: `defineAdapter()` = today's `cli()` minus `registerCommand`; keep `pipeline`/`run`. Publish the Page/Tab
   interface + errors as the SDK.
2. **Codemod 1332 files** (files are already at `clis/<site>/<name>.js`, so the path is *already* the identity):
   `cli({ site, name, ...rest })` → `export default defineAdapter({ ...rest })` (drop site/name). Mechanical/scriptable;
   no function-body rewrites.
3. **Rewrite `registry.ts`** → `SourceLoader` (readdir list, path resolve, derived-cache search).
4. **Delete** `cli-manifest.json` + its generator.
5. **Verify**: `npm run check` + a smoke over a few real sites.

## 9. Edge cases / honest notes
- **Aliases**: kept in the descriptor; the search cache indexes them → resolve maps alias→file.
- **read/write counts** for `sites()` summaries need the descriptor → served from the cache (or lazily).
- **Enabling a site** imports its command modules to read full args (vs the old manifest) — per-site (dozens), on the
  path where you already need them. Fine.
- **`site.json`** is optional sugar; skip it in v1 if we want the absolute minimum (commands self-contained).
- **Run-contract unification** (`func(page,args)` / `pipeline` / defined-tool `func({tab,…})` → one `run(ctx)`) is a
  nice follow-on but not required for this change; can land separately.

## Recommendation
This is the elegant end state: **path = identity, module = definition, core = a loader over sources.** It removes the
manifest, the global registry, and the special-cased loaders, and delivers dynamic loading + core/adapter separation +
version decoupling as side effects. Proposed first step: **prototype the SDK `defineAdapter()` + `SourceLoader` (list /
resolve / derived cache) and port 2–3 sites** to prove it end-to-end (gate + smoke), then codemod the rest.

## 10. Placement — in the repo and on the user's machine (owner Q)

### In the repo (now, dev phase: one repo, split-ready)
Replace the awkward `vendor/opencli/clis` with first-class top-level dirs, so the later package/repo split is a *move*,
not a rewrite:
```
/adapters/            ← built-in corpus (site dirs). git-tracked, editable — this is what we own
/packages/adapter-sdk/ ← the SDK (defineAdapter, Strategy, Page/Tab interface, errors, pipeline) — carved from vendor/opencli
/src/                 ← the core (server, runtime, engine, object model, SourceLoader, projection)
```
Later, `/adapters` → `@opencli-mcp/adapters` and `/packages/adapter-sdk` → `@opencli-mcp/adapter-sdk`, each publishable
independently; core depends on a compatible SDK version and lists the adapters package as a source. (Monorepo
workspaces when we want independent versioning; not required to start.)

### On the user's machine — the `sources[]` precedence list (later overrides earlier)
```
1. built-in corpus   <globalNodeModules>/opencli-mcp/adapters/            (ships with the version; read-only baseline)
2. user source       ~/.opencli-mcp/adapters/<site>/<command>.js          (user-writable; overrides builtin; survives upgrades)
3. configured extras (optional)  dirs from config `sources: [...]`        (teams / third-party adapter packs)
derived cache:       ~/.opencli-mcp/.cache/adapter-index.json             (regenerated; not in the read-only package)
```
- **`~/.opencli-mcp/adapters/` is the one writable source** and it unifies three things that are separate today:
  agent-defined tools (currently `~/.opencli-mcp/tools/`), user adapters (OpenCLI's old `~/.opencli/clis`), and
  hot-fixes/overrides of builtin commands. Drop `~/.opencli-mcp/adapters/twitter/bookmarks.js` and it shadows the
  builtin one — a fix without a core release, surviving upgrades.
- **SDK resolution for user adapters**: user modules `import '@opencli-mcp/adapter-sdk'`; the loader ensures
  `~/.opencli-mcp/` can resolve it (a managed symlink/`node_modules` entry, same trick define.ts uses today for
  `@jackwener`), or the core injects the SDK. So a user file needs no local install.
- **Updating the corpus independently of core**: either `npm i -g @opencli-mcp/adapters@latest` (once it's its own
  package) or just drop/replace files in `~/.opencli-mcp/adapters/`. The mtime-keyed cache refreshes; no restart.
