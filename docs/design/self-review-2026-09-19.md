# Self-review of this session's MCP-native changes (owner: "review 一轮 … 代码/设计/思路")

Reviewed the whole batch: arg-projection strip (`CLI_ONLY_ARGS`), `deCli` `--flag` cleanup, tool annotations, docs
resource filter, removed dangling `sendResourceListChanged`, kebab→snake arg normalization. Not a victory lap — I
looked for what I got wrong.

## Real bug I introduced — found and fixed (commit 5b18c97)
Stripping the CLI `timeout` arg from the agent surface removed the only way to extend a command's wall-clock. **104 of
120** commands that declare `timeout` default to **>60s** (logins 300s, `chatgpt/deep-research-result` 120s,
`antigravity/watch` 86400s). And the executor never wired that declared default into the actual `withTimeout` — it used
a flat `DEFAULT_TIMEOUT_MS` (60s). So after my change those commands were hard-killed at 60s with no recourse on the
typed/site_run path. This was a **latent bug my change exposed** (the declared default was ignored for the wall-clock
even before). Fix: `resolveTimeoutMs()` — precedence explicit (js) → command's declared default → runtime default; the
client can still cancel via MCP. Unit-tested. **Lesson: a projection change silently altered runtime behavior because
`timeout` is the one arg the executor reads for control flow, not just passes to the adapter. I verified it's the
*only* such arg — every other stripped arg (`output`/`all`/`output-file`/`resume-file`/`stdout`) is consumed inside
adapter bodies, so their defaults apply harmlessly. Regression class is bounded.**

## Verified-good (spot-checked, not assumed)
- **kebab reverse-map covers the js path.** `sites.<site>.<cmd>()` routes through `runSite → runSiteCommand`
  (api.ts:48), where `restoreArgNames` runs — so `sites.x.y({note_id})` works, and command names were already
  underscore-mapped there (api.ts:57), so my arg direction is consistent with existing behavior.
- **Projection is lossless corpus-wide.** All 241 kebab args across 158 commands snake-case cleanly; 0 collisions, 0
  commands lose an arg. The collision guard is defensive (never triggers on today's corpus) — kept anyway.
- **`deCli` regex is bounded** — only strips `--` after start/space before a letter; single hyphens, ranges (`10-20`),
  and `/a--b` in URLs are untouched. Tested.
- **Annotations** are conservative and correct (I dropped 3 the sweep suggested — `js_reset`/`tools_define`/
  `tools_compile` — because they mutate/write and aren't read-only, and "additive write" isn't "destructive").
- Independent judgment held: I rejected two sweep arg-misreads (`no-progress`, `column`) by reading adapter help.

## Design-level reflection (the honest tradeoff)
I keep growing a **projection/translation layer** (strip args, rename args, rewrite help) instead of editing the corpus
we now own. That's deliberate and I stand by it for breadth: one seam, no 1,332-file churn, corpus stays a clean
runnable drop. But the cost is real — the agent-facing surface and the corpus **diverge**, every future reader must
apply the transform mentally, and bugs hide in the seam (the timeout regression is exactly that). Recommendation: keep
projection for now; **if the layer keeps growing, a one-time corpus codemod becomes worth it** — but that's bigger than
it looks (adapter bodies read `args['note-id']`, so renaming the manifest means rewriting bodies too), which is the
whole reason projection was the right first move.

## Weaknesses I'm not fixing now (named, not hidden)
- **No integration test on the executor timeout path** — the unit test covers `resolveTimeoutMs`, but nothing runs a
  real command end-to-end asserting the wall-clock. That gap is why the regression was invisible until this review.
- `columns` dropped from the site resource → slight loss of pre-call shape info (still present in results). Acceptable.
- The bigger MCP-native items remain open by design (download→bytes, host-path args, shared `http` session).
