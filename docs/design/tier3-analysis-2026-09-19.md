# Tier 3 deep analysis (owner asked for principled judgment on items 1–3)

Lens: first principles · agent-friendly · elegant · correct. These three are judgment calls, not clear deletes.

## Tier 3.1 — The JS analyzer (jsluice/web-tree-sitter port). Verdict: KEEP; already right-sized.

**What it is.** ~350 lines + a `web-tree-sitter` wasm dep that statically parses a page's scripts for endpoints
(fetch/XHR/jQuery/axios/WebSocket/location), resolving string concat + template literals and marking unknowns `EXPR`.

**First principles.** The product value is freezing a flow so the agent calls the API instead of scraping the DOM. The
*ground truth* for that is the real request the page made — which **network capture** records (method, URL, headers,
body, real params, cookie auth). And in fact `tools_compile` freezes from **network evidence only** (`pickEndpoint`
over captured requests); it never touches the analyzer. So the analyzer is not on the freezing path — it feeds
`recon.discover`, whose output is explicitly "evidence, not contracts" the agent re-verifies with `fetchJson`.

**So is it over-built?** The real problem was that it ran as a hidden side effect of every `observe`/`network.read`
(fetching + parsing up to 25 bundles). **That is fixed in Tier 2** — it now runs only on an explicit `recon.discover`.
Its cost is opt-in.

**Should we go further and replace tree-sitter with regex?** No. Regex URL extraction over *minified/bundled* JS is
unreliable exactly where it matters: modern bundlers build URLs by concatenation and template literals, and resolving
those is the analyzer's whole point. A regex version would emit worse candidates and undermine the feature, to save a
dependency that now loads only when `recon.discover` is called. Degrading a correct, tested component to shed an
on-demand dependency is the wrong trade.

**Recommendation:** keep as-is after the Tier 2 explicit-only change. Don't invest more breadth in client-library
heuristics either. Revisit only if npm bundle weight becomes a real packaging problem.

## Tier 3.2 — `consequentialAct` keys on the wrong signal. Verdict: fix the signal (or drop the auto-gate).

**What it is.** The human-approval trigger for a consequential click runs `CONSEQUENTIAL_RE` (pay|submit|delete|…)
against `describeTarget(target)` — the **stringified locator**.

**Why it's wrong-shaped.** The gate fires on *how the agent addressed the element*, not *what the element is*. Click
"Delete" by `{ref:"e12"}` or `{selector:".btn"}` → the string is `ref:e12` / `selector:.btn`, no keyword → **the gate
silently misses**. The recommended workflow is observe→act by ref, so in practice the gate rarely fires. It can also
false-fire on `{text:"Apply filter"}`. For a safety trigger, keying on the wrong signal is a real defect — though note
it is only active when a user turns `confirmWrites` on (off by default).

**Deeper point.** A keyword regex over button text is a fragile proxy for "consequential" regardless of the signal:
it misses "Confirm order", icon-only buttons, and every non-English UI. The *robust* protections are already elsewhere:
`access:'write'` site commands gated by MRTR (structured, reliable), and the `confirmations` doc the agent follows for
consequential UI actions (the same trust model as the rest of the agent's behavior).

**Options.** (a) Gate on the **resolved element's** role + accessible name (post-resolution), so it keys on the right
signal — still an English-keyword regex, but at least correct about *what* it's gating. (b) **Drop** the tab_act
keyword gate; rely on MRTR for write commands + the confirmations doc for raw clicks.

**Recommendation:** I lean (a) — if we keep an auto-gate for raw clicks it must key on the resolved name, not the
locator string; removing the net entirely weakens safety when a user explicitly asked for it. (b) is the honest
minimal if we accept that raw-click safety lives in the doc + MRTR. Owner's call on safety posture. (Small implementation
either way; needs the resolved name threaded to the gate, so I left it for your decision.)

## Tier 3.3 — SIGNER HOOK scaffold emits non-working pseudo-code. Verdict: warning-only for computed sigs (self-correction).

**What it is.** My item-3 replay hook. The **cookie-backed** branch (csrf/xsrf → `tab.cookie`) works and is correct —
keep it. The **computed-signature** branch emits a commented scaffold (`// SIGNER HOOK … const sig = await
tab.evaluate('(...)')`) plus a warning.

**Why it's questionable.** The scaffold is a comment that doesn't run, and it asks the agent to reverse-engineer and
recompute a site's signature (wbi/x-s/transaction-id) — a deep RE task it's unlikely to complete correctly. The risk:
a "defined" tool that *looks* complete but silently 403s at replay because the header is omitted. Emitting fake code an
agent won't finish is worse than saying plainly "this endpoint needs a signature we can't freeze."

**Options.** (a) Keep the cookie path; for computed sigs emit **only the warning**, no scaffold code — honest, minimal.
(b) When a computed signature is detected, **fall back to DOM steps** (which don't need the signature) instead of
freezing a broken API call — a working slower tool beats a broken fast one, but it's a bigger compile-behavior change.

**Recommendation:** (a) now — delete the fake scaffold, keep the clear warning (and the working cookie path). Consider
(b) later if we want signed-endpoint sites to still get a working DOM tool automatically. This one is low-risk and I can
apply it immediately on your OK.

## Summary
- **3.1 analyzer:** keep; Tier 2 already right-sized it (explicit-only). No regex rewrite.
- **3.2 consequentialAct:** wrong signal; fix to gate on the resolved role+name (a), or drop the auto-gate (b). Safety-posture call.
- **3.3 signer scaffold:** emit warning only for computed sigs, drop the non-working scaffold (a). Low-risk; ready to apply.
