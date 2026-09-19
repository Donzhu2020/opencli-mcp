# Adapter rewrite: one engine, corpus in-repo (review item 4)

Owner decision (2026-09-18): move the whole site corpus into our repo and rewrite the adapters onto the one engine;
drop the `@jackwener/opencli` runtime base (`CDPBasePage`). "完全不用担心完全重设计." This doc is the plan of record.

## The problem (from the deep review + architecture map)

`ExtensionPage extends CDPBasePage` (`src/backends/extension-page.ts:70`). We override the transport + interaction
methods onto our `act` engine, but ~10 methods are **inherited** and still run OpenCLI's own JS
(`target-resolver.js` / `dom-snapshot.js` / `dom-helpers.js`) through `page.evaluate`:

- `snapshot` / `_basicSnapshot` / `collectAxSnapshotTrees` (a second AX snapshot + `_axRefs` ref space)
- `wait`, `autoScroll`, `getFormState`
- `networkRequests`, `consoleMessages`, `installInterceptor`, `getInterceptedRequests`, `waitForCapture`
- `dblClick` (shadow resolver + `clickResolvedJs`), `handleJavaScriptDialog`
- `fetchJson` / `annotatedScreenshot` / `evaluateWithArgs` (hit our transport but carry OpenCLI logic)

Any corpus adapter or pipeline step that calls these runs a **second locator/snapshot/network engine** with a
different ref vocabulary (`match_level: exact|stable|reidentified`, `_axRefs`) than ours (`observe`/`find`/`aria`,
stable `eN`). This is the one real structural debt and the second error vocabulary's root.

## End state

- No `extends CDPBasePage`. `ExtensionPage` implements the full page contract standalone, every method routing to the
  one engine (`extension/src/page` injected engine + bridge, via `act`/`pageCall`/`aria`/`expect`).
- The corpus (site adapters + manifest) lives in-repo; we own the `cli()` / registry / `CliCommand`/`Arg` types /
  pipeline / errors. No runtime dependency on `@jackwener/opencli`.
- One ref vocabulary, one snapshot, one network capture, one error vocabulary.

## Staged plan (each stage: gate green; real-Chrome regression handed to the tester at the end)

**Phase 1 — kill the shadow engine (unambiguous, highest structural value, start now).**
Override every currently-inherited method in `ExtensionPage` to route to our engine, then drop `extends CDPBasePage`:
- `snapshot` → our `aria`/observe snapshot; `getFormState` → our engine; `wait` → our `expect`/settle;
  `autoScroll` → our `act` scroll loop; `dblClick` → `act({action:'dblclick'})`.
- `networkRequests`/`consoleMessages` → our `startNetworkCapture`/`readNetworkCapture`/`consoleLogs`;
  `installInterceptor`/`getInterceptedRequests`/`waitForCapture` → our capture (or a thin bridge shim).
- `handleJavaScriptDialog` → our `dialog`; `fetchJson`/`annotatedScreenshot` already route to our transport — keep.
- Result: one engine even while the corpus still ships from the package. This removes the accidental complexity and
  the shadow ref space in one bounded change.

**Phase 2 — own the corpus in-repo.**
Vendor `clis/` + the manifest into the repo; provide our own `cli()`/`registerCommand`/`getRegistry`, `CliCommand`/
`Arg`/`IPage` types, `executePipeline`, `toEnvelope`, and the manifest build step. Rewrite corpus module imports from
`@jackwener/opencli/registry` to our registry. Corpus command bodies (`func(page,args)` / `pipeline`) run **unchanged**
on the one engine because the page contract is preserved — "rewrite the adapters" here = rebase them onto our engine +
repo, not hand-rewrite ~1200 command bodies. Drop the dependency.

**Phase 3 — converge the page contract on `Tab`.**
Corpus adapters currently get the raw `ExtensionPage`; frozen tools get `{tab,…}`. Give corpus adapters the same
`Tab`-shaped surface so there is one page object and writes go through the same policy/confirm gate. Sequenced after 1–2.

## Interpretation to confirm
"全部重写适配" = vendor the corpus + rebase it onto our one engine and repo (Phases 1–2), corpus bodies run unchanged;
NOT hand-rewriting each of ~1200 command bodies. Phase 3 converges them on `Tab` incrementally. If the owner wants a
literal per-adapter logic rewrite, that is a separate, much larger effort to scope.

## Risks
1. **Behavioral parity** of the ex-shadow methods (snapshot ref format, wait/settle semantics, network interception)
   on our engine — needs real-Chrome regression (tester).
2. **Ref-vocabulary reconciliation**: adapters that capture a ref from `snapshot()` then act on it must resolve against
   our aria refs.
3. **Owning the manifest build** (`build-manifest`) and the lazy `_lazy`/`_modulePath` loader.
4. **Electron exclusion** + user-adapter + defined-tool loading paths must be preserved.

## Status (2026-09-19)
- **Phase 1 DONE** (88a9fe3): `ExtensionPage` no longer extends `CDPBasePage`; the shadow engine is gone. The
  corpus-used inherited methods are reimplemented on our engine + pure helper JS. Gate green, embedded smoke ok.
- **Phase 2 DONE** (59561e7, 23ff9f2): corpus + OpenCLI runtime vendored into `vendor/opencli/`; dependency is
  `file:vendor/opencli` (git-tracked, editable, no upstream pull). OpenCLI's runtime deps hoisted into our
  package.json so a packaged install resolves them (verified: clean tarball install loads 168 sites / 1208 commands).
- **Phase 3 (converge corpus onto the `Tab` surface)**: not required for "one engine / own the corpus" — deferred.
- **Remaining gate:** real-Chrome regression of the corpus running on the one engine — for the tester.
