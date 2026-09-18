# Over-engineering / wrong-design audit (owner request 2026-09-18)

Same first-principles lens that caught the session-handle mistake (adopting server-minted handles for one user's one
Chrome = over-design). Three critical passes (MCP layer, object model/runtime, sites/freezing/extension). NOT a bug hunt.
Findings verified by grep. Ranked by impact. `file:line` refs.

## Tier 1 — confirmed dead / orphaned code (delete, low risk)

1. **Docs-gating subsystem is dead.** `gate()` (`src/mcp/server.ts:142`) is never called; no `DOCS_MANIFEST` entry sets
   `requiredFor`, so `requiredDocsFor()` (`src/docs/manifest.ts:73`) always returns `[]`; `state.docsRead`
   (`src/runtime/runtime.ts:47`) is written by `docs_get` and read only inside the dead `gate`. Three files of
   machinery, zero behavior — and the concept (force a doc-read before a tool) is paternalistic friction. **Delete**
   `gate`, `requiredDocsFor`, the `requiredFor` field, `docsRead`, and the "marks it as read" clause in `docs_get`.

2. **Secret scanner in the recon analyzer is orphaned scope creep.** `SECRET_PATTERNS`/`matchPairSecret`/
   `matchStringSecret`/`SecretMatch` (`src/recon/analyzer.ts:44-52,341-357`) → `DiscoverResult.secrets`/`.scripts`,
   which **no code reads** (verified). Scanning the user's own logged-in sites for leaked AWS/GitHub keys is a different
   product with no bearing on freezing a flow. **Delete** the secret half + the `secrets`/`scripts` fields.

3. **`agent.browsers` is a fleet API for one browser.** `list`/`get`/`getForUrl` (`src/api/api.ts:16,26-36,68-77`) are
   dead or no-ops (`getForUrl(_url)` ignores its arg; `list()` returns a 1-element array); only `getDefault()` is used
   (verified). Teaches the agent a routing model that can't apply. **Collapse** to one accessor (`agent.browser()`),
   drop the rest.

4. **`Tab.mark`/`markDeliverable`/`markHandoff` are dead** (`src/api/tab.ts:309-313`) — no callers; the real path is
   `browser.tabs.finalize({keep})`. **Delete**.

5. **`writeSiteKnowledge` is dead** (`src/sites/knowledge.ts`) — imported at `src/mcp/server.ts:14`, never called.
   `readSiteKnowledge` only reads a dir OpenCLI (not us) writes. **Delete** the writer + import; inline the reader or drop.

6. **Hooks system is an unused extension point** (`src/sites/hooks.ts`; fired at `executor.ts:67,98`, `runtime.ts:104`).
   Zero registrations anywhere (verified). Generality for a plugin ecosystem that isn't present. **Remove** or leave
   (cheap); don't invest.

## Tier 2 — confirmed design fixes (clear value, mostly independent of the #4 rewrite)

7. **Recon runs as a hidden side effect of `network.read`.** `tab.network.read` (`src/api/tab.ts:286`) fires
   `discoverEndpoints({maxScripts:25})` — fetching + parsing up to 25 external JS bundles — and returns a two-shape
   result (`candidates` vs `candidatesPending`) the agent must branch on. "Give me requests since cursor N" should not
   trigger a fetch-storm. **Make `network.read` return only rows; expose candidates solely via explicit
   `recon.discover(tab)`.**

8. **`site:<site>` adapter state is triplicated and pollutes the session count.** An adapter's background context is
   stored as `adapterPages` + a full `SessionState` in `this.sessions` + `siteApis` (`src/runtime/runtime.ts:80-81,
   144-169`), all keyed `site:<site>`. `doctor().sessions` then counts adapter pseudo-sessions as if they were agents.
   **Consolidate** to one `adapterContexts` map; keep `sessions` meaning MCP sessions.

9. **Stealth injection on every `goto` is a no-op in the wrong environment.** `generateStealthJs()` (OpenCLI anti-
   detection blob) is injected on every navigation (`src/backends/extension-page.ts:119,127`). We drive the user's real
   Chrome via the extension, where `navigator.webdriver` is already false etc. — the patches are near-no-ops that still
   cost a round-trip per goto. **Drop it from the goto path.** (Folds into the #4 rewrite, which removes the OpenCLI
   base anyway.)

10. **Output schemas are permissive ceremony.** The `OUT_*` schemas (`src/mcp/server.ts:69-75`) are all-optional +
    `.catchall(z.unknown())` — they can never reject anything, so they validate nothing; they're a third restatement of
    the shape (beside the description and `structuredContent`) that drifts silently. **Drop them**, or write a real
    (required-field) schema for the one or two tools where machine-readable output matters.

11. **Per-request doc re-read from disk.** The stateless HTTP handler rebuilds the McpServer per `/mcp` call, and
    `buildInstructions()` (`src/docs/manifest.ts:45`) `readFileSync`s ~6 markdown files (each `readDoc` also
    `existsSync`-probes 3 paths) on **every** request — the real backend path. **Memoize** `docsDir()`, `readDoc`, and
    the built instructions per `DocContext`.

12. **Resources duplicate tools / the object model.** `doctor`/`trace`/`tabs`/`site-knowledge` resources
    (`src/mcp/server.ts:288-290`) restate what the `doctor` tool and `js` already return. An autonomous agent reaches
    for tools, not `resources/read`. **Keep** `docs` + `sites` (genuine catalogs); drop the duplicates.

## Tier 3 — judgment calls (owner decides)

13. **The JS analyzer (web-tree-sitter jsluice port, ~359 lines + wasm) is disproportionate.** The freezing path
    (`define.ts → pickEndpoint`) uses **network evidence only** (ground truth). The analyzer feeds a *separate*
    "evidence, not contracts" surface the agent must re-verify anyway. Both audits flagged it as the heaviest component
    for a second-best role. Options: (a) keep but explicit-only (do #7) and don't expand; (b) replace with a ~40-line
    regex/heuristic URL extractor and drop the wasm dep. Recommend (a) now, consider (b) later. (Interacts with #4.)

14. **`consequentialAct` matches the wrong signal.** It runs `CONSEQUENTIAL_RE` over the *stringified locator*
    (`src/api/tab.ts:33-44`) — usually `ref:e12`/`selector:.btn`, which rarely contains "pay"/"delete". So the human-
    approval trigger mostly **misses** real consequential clicks and can false-positive on `text=Apply`. Wrong shape.
    (This is the tab_act gate I refactored for D1 — pre-existing logic.) Fix: gate on the *resolved* element's
    role/accessible-name post-resolution, or rely on `access:'write'` + explicit confirm.

15. **SIGNER HOOK scaffold emits non-working pseudo-code.** The computed-signature branch I added for the replay hook
    (`src/sites/define.ts:250-270`) synthesizes fake `tab.evaluate('(...)')` an agent is unlikely to complete —
    inviting tools that look done but silently fail. The cookie-backed re-read is solid; **for computed sigs emit the
    warning only, no scaffold code.** (Self-correction on this session's item-3 work.)

16. **Policy persistence/blocklist/wildcard is multi-tenant machinery for a single-user tool.** Both gates default off
    (`src/runtime/policy.ts:26-27`). On top sit a persisted `allowed-hosts.json`, a `blockedHosts` set (no consumer
    beyond the matcher), and `'*'` matching. **Keep** the two in-memory gates; drop file persistence + blocklist +
    wildcard unless configured.

17. **Cursor overlay animation blocks the act path.** The glide easing + `waitForArrival` (`extension/src/content/
    cursor.ts:37-55`, awaited before input at `extension/src/background.ts:79`) adds ~600ms latency per observed action
    for a purely decorative affordance. **Keep a static positioned dot; never block input on it.**

18. **Minor cosmetics.** Two MCP prompts (`server.ts:293`) an agent won't enumerate; `logging` capability +
    `sendLoggingMessage`; per-site-tool favicons; and the two notification wirings (persistent vs `handler.notify`) have
    silently drifted (HTTP path drops logging + the per-session browser-event filter). Unify the event→notification
    mapping in one helper; drop the cosmetics if no client renders them.

## Correction to an earlier premise
There is **no backward-compat code to strip** for "no back-compat": the repo passes only `{onerror}` to
`createMcpHandler`; dual-era serving + the input-required legacy shim are SDK defaults, not our code. MRTR-on-both-eras
is a free feature, not something we built.

## What is lean / correct (do not touch)
Shared single session (no handles); the single MRTR approval path; stable `eN` refs (WeakMap identity — necessary for
observe→act); trace + NetworkEvidence split (different eviction/consumers); the Playwright locator schema breadth (each
kind maps to a real need); per-tab `use()` serialization; injection-safe codegen (`escTpl`/`urlLit`/`bodyLit`);
`pickEndpoint` token matching; the DOM-fallback `step()` wrapper; `schema.ts` arg coercion.
