# Adapter architecture, from first principles (owner: "manifest + register 感觉复杂，有没有更优雅的？")

Forget how OpenCLI did it. What is the minimal, elegant shape?

## What an adapter actually is
A **self-describing capability**: metadata (site, name, description, access, domain, args) + an implementation
(a function of `(page/args) → data`, or a declarative pipeline). Nothing more.

## Where today's complexity comes from (name it precisely)
1. **A global mutable registry populated by import side-effects.** `cli({...})` (registry.js:13) doesn't just describe a
   command — it calls `registerCommand()` into a process-global `Map` (line 36). Importing a module *mutates global
   state*. Order-dependent, implicit, hard to reason about.
2. **A 1.1 MB monolithic manifest that exists only to work around #1.** Because you can't learn a command's metadata
   without importing it (and importing registers it), we precompute `cli-manifest.json` (1332 entries, all args) so the
   core can discover everything without loading 1332 modules. The manifest is a symptom, not a design choice.
3. **Metadata declared twice** — once in each module's `cli({...})`, once (generated) in the manifest — which must be
   kept in sync by a build step.

So we carry a global registry + a giant generated file + a sync step, to answer one simple question: "what capabilities
exist, and how do I run one?"

## The elegant model: self-describing, path-addressed modules
Three moves collapse all of it:

1. **Make `cli()` pure** — validate and **return** the descriptor, no global register. The module becomes:
   ```js
   export default cli({ site: 'hackernews', name: 'top', description: '…', access: 'read', args: [...], pipeline: [...] })
   ```
   One line changed per adapter (`export default`). The global `Map` and import-side-effects **disappear**.
2. **File path = identity.** An adapter lives at `<source>/<site>/<command>.js`. Site and name come from the path;
   the module's default export is the full descriptor. Adding a capability = dropping a file. No manifest entry, no
   register call.
3. **The core is a lazy loader + a small derived index.** To run `(site, command)`: resolve the path → `import` →
   `.default` → run. For cross-site `sites_search`: a **light, auto-derived index** (site + name + description +
   keywords ≈ **97 KB vs 1.1 MB**), rebuilt automatically when a source's mtime changes — a *cache*, never authored.
   Full args load lazily with the module (exactly when you enable/call the site — dozens of modules, not 1332).

## What this removes
- the global mutable registry and import-as-registration,
- the 1.1 MB hand-in-the-loop manifest (becomes a tiny optional cache, or nothing for the common per-site path),
- the metadata duplication + sync build step,
- the special-cased `registerManifest` / `loadDefinedTools` / user-override branches — they all become **one concept:
  a list of sources, later overrides earlier.**

## How it also answers the earlier questions (dynamic load + core/adapter split)
- **Dynamic load / override**: a source is just a directory. `~/.opencli-mcp/adapters/` overrides builtin by precedence;
  drop or edit a file → the mtime-keyed index refreshes → live. Agent-defined tools are simply another source.
- **Core/adapter separation**: the **descriptor shape + the page/tab interface + `cli()`** are the entire SDK contract.
  Core depends on the SDK to *provide* the page and read descriptors; adapters depend on the SDK to *shape* themselves.
  The corpus is just a directory of files → trivially its own package, independently versioned. No core release needed to
  fix or add an adapter.

## The run contract (optional, phase later)
Today three shapes: `func(page,args)` (browser), `pipeline:[…]` (declarative), `func({tab,sites,…,args})` (defined).
Ideal: one `run(ctx)` with `ctx = { page, args, … }`, keeping `pipeline` as a declarative alternative (it's genuinely
elegant). Unifying signatures is a bigger corpus edit; the descriptor+loader change above stands on its own and can land
first.

## Migration (we own the corpus)
- `cli()` → pure (return, drop the `registerCommand` side-effect). Small SDK change.
- Codemod 1332 modules: `cli({…})` → `export default cli({…})`. Mechanical, scriptable.
- Replace `registry.ts` (manifest read + global Map + lazy stubs) with: path-addressed loader + source list + derived
  index builder. Net **less** code.
- Drop `cli-manifest.json` (or keep as a generated cache). No adapter-body rewrites.

## Honest tradeoffs
- Cross-site full-text search needs *some* index or a lazy load; a 97 KB derived cache is the pragmatic answer (still a
  file, but generated and 11× smaller, and not the source of truth).
- Enabling a site now imports its command modules to read full args (vs reading the manifest). That's per-site (dozens),
  on the path where you already need them. Fine.
- It's a real migration (a codemod + a registry rewrite), but it *removes* moving parts rather than adding them — which
  is the point of the question.

**Recommendation:** yes, this is meaningfully simpler and more elegant than manifest+global-register. Worth doing as the
foundation before the package split. I can prototype the pure-`cli()` + path loader + derived index on a few sites to
prove it, then codemod the rest.
