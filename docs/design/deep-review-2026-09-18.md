# Deep review (task #4): four lenses

First principles · agent-friendly · reverse-engineering site APIs · MCP-native architecture. Critical, grounded in the
code as it is on v2. Ordered by how much each finding matters.

## 1. First principles — what is essential vs accidental

**Essence (right):** the product is two verbs — *operate a page step by step* and *freeze what you explored into a tool* —
over one engine (Playwright injected script), one object model, one error shape. The runtime exists because a browser is
stateful and a CLI is not (debugger, refs, progress, images, questions). That framing is sound and the code mostly honours it.

**Accidental complexity (the one real structural debt):** adapters still inherit OpenCLI's `CDPBasePage`, which carries a
*second, complete engine* (its own locator/`_axRefs`, AX snapshot, network interception, key parser). We override ~11
interaction methods onto the act engine but not `snapshot`/`dblClick`/`installInterceptor`/`autoScroll`/... so any adapter
using those silently runs the shadow engine, shadow ref space, and shadow capture. This is the single biggest violation of
"one engine, one path," and it also splits the error vocabulary (below). It is the adapter rewrite already on the table; it
needs the corpus-home decision (OpenCLI upstream adopts `{tab,args}` vs corpus moves in-repo). Until then, "one engine" is
true for everything we wrote and false at the inherited seam.

**Second seam:** two notification mechanisms now — persistent `server.send*` (embedded stdio) vs stateless `handler.notify`
(HTTP). Justified by the two transport models, but it is a seam to keep honest.

## 2. Agent-friendly — can an LLM drive this well?

**Strong:** one object model with a generated API reference; `js` code mode for real control flow; semantic-diff observe;
strict `act` (no count-first, no nth/first); stable `eN` refs pinned to elements; an error-family table; a locator/observe
discipline recipe; API-first guidance; now typed output schemas and favicon icons.

**Real gaps:**
- **Confirmations are broken under 2026-07-28 (D1 from the v2 review).** `elicitInput` throws on modern requests, so the
  agent can never get a native user approval — it silently degrades to `confirm:true`. For an agent doing consequential
  actions (send/purchase/delete/login), this is the most user-visible agent-friendliness gap. Fix = MRTR `inputRequired`.
- **Two error vocabularies.** The agent path emits lowercase (`not_found`, `stale_ref`); the site/adapter path also emits
  OpenCLI SCREAMING_SNAKE (`TIMEOUT`, `COMMAND_EXEC`, `TargetError`). A model branching on `error.code` must know both. One
  vocabulary would be strictly more agent-friendly. (Collapses with the adapter rewrite.)
- **Dual surface tax.** 15 typed tools + `js`. Codex converged on `js`-only (typed tools are a projection). Ours are a
  helpful on-ramp, but every typed tool is a second schema to keep in sync and more tokens in `tools/list`. Worth asking
  whether the typed set should shrink to the true core (open/observe/act/finalize/js) and let `js` carry the rest.
- **`site_run` has no output schema** (variable shape) and `docs_get` returns a string — fine, but it means structured
  output is not uniform; a model can't assume every tool is typed.

## 3. Reverse-engineering site APIs — how strong is the freezing?

**Strong and verified:** capture-on-attach for every session tab; the jsluice-style analyzer (real web-tree-sitter port:
fetch/XHR/jQuery/axios/location/WebSocket, concat/template resolution, `EXPR` for unknowns, query/body params, secret
redaction); `recon.discover` merges static candidates with captured requests into a ranked ledger; `tools_compile` picks
the JSON response that carries the words the agent extracted, freezes method + contract headers + body, parameterizes
inputs at value granularity, and names per-request tokens/credentials instead of freezing them. Real-site checks: X froze
the GraphQL HomeTimeline call with its tokens named; GitHub matched `_graphql` 5/5.

**The frontier (inherent, but name it):**
- **Signed/computed params (the hard wall).** wbi (Bilibili), x-s (Xiaohongshu), CSRF/transaction ids — computed by page
  JS per request. We *name* them but the frozen tool then fails, because we give the agent no way to recompute them at
  replay. The high-value next step is a **replay hook**: let a frozen tool call a small page function (the site's own
  signer) before `fetchJson`, or re-read the token from a cookie/DOM at run time. Without that, signed-endpoint sites fall
  back to DOM.
- **GraphQL persisted queries**: we freeze the captured query hash; if the site rotates it, the tool breaks. No detection.
- **Pagination / lists**: we freeze one request; there is no generalization to "next page" — the agent must hand-edit.
- **Analyzer is host-side** (fetches script `src`): misses `eval`/dynamically-injected endpoints; network capture covers
  those, so the two legs are complementary — good — but a site that only ever builds URLs at runtime yields thin static
  candidates.

Verdict: the *evidence* pipeline is strong; the *replay* side stops at signed requests. That gap (a signer/replay hook) is
the single highest-leverage improvement for "reverse the interface, don't scrape the DOM."

## 4. MCP-native architecture — is it idiomatic on v2?

**Native (right):** on v2 SDK; stateless HTTP via `createMcpHandler` + node adapter; resources for docs/sites/trace/tabs/
doctor; prompts; subscriptions bus for list-changed; output schemas; tool icons; backward-compatible with 2025 clients.

**Not-yet-native (the MCP-native gaps):**
- **Handles are half-native.** MCP-native stateless = state travels as server-minted handles the client passes. We instead
  share one `'http'` runtime session across all requests. Correct and simple for one user, but it is *not* the handle model:
  a second client shares the same browser, and there is no `browser`/`session` handle to pass. True native = mint a session
  handle, return it, and key state by it. (Our object model is already id-based, so this is a small step, deferred.)
- **MRTR not adopted (same root as D1).** Human-in-the-loop should be `input_required` results, not a bespoke `confirm:true`
  round-trip. This is the clearest "not MCP-native" spot and it is also a live bug under 2026-07-28.
- **Tasks not adopted.** Long browses are blocking `tools/call`s with (currently dropped, D2) progress. MCP-native long ops
  are the tasks extension. Deferred deliberately (needs a task client + a store), but it is the honest remaining gap.

## Priorities out of this review
1. **D1 / MRTR confirmations** — a live bug *and* the biggest MCP-native + agent-friendly gap. Do first.
2. **D2 proxy progress/cancel** — restore long-op feedback through the launcher.
3. **Signer/replay hook for signed endpoints** — the highest-leverage reverse-engineering improvement.
4. **Adapter rewrite onto the one engine** — collapses the shadow engine + the second error vocabulary (needs corpus-home decision).
5. Consider shrinking the typed-tool surface toward `js`-first; unify the error vocabulary; mint real session handles.
