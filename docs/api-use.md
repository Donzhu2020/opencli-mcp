## How to act on a page

1. `tab_open` (or `tab_claim` a tab the user already has) → `tab_observe` → `tab_act` → `tab_observe`.
2. `tab_act` takes one `target`: `{ref}` from the last observe, `{role,name}`, `{label}`, `{text}`, `{testid}`, `{css,nth?}`, or `{x,y}`. It waits until the target is visible and enabled, scrolls it into view, checks that nothing intercepts the click point, then dispatches real mouse/keyboard input. Read `match_level`: `exact` proceed; `stable` proceed but re-check values you typed; `reidentified` double-check you hit the right element.
3. Branch on `error.code`, never on message text: `not_found`, `stale_ref`, `selector_ambiguous`, `intercepted`, `not_visible`, `timeout`.
4. Refs are per-snapshot. After navigation or a page change, observe again before reusing a ref.
5. `tab_observe` returns a diff by default when the page changed only a little; pass `diff:false` for the full state.
6. If a tab is already at a URL, do not `goto` it again (that reloads and loses form state). Use `tab_act` with `{action:"reload"}` only when a reload is intended.
7. `tab_evaluate` is read-only page scope. Writes must go through `tab_act`.
8. Long commands report progress; you may cancel.
