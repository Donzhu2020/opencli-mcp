## How to act on a page

The core loop and the discipline that makes it reliable. Tool-by-tool argument shapes are in each tool's schema; error
families are in the `errors` doc; the full object model arrives with your first `js` result (`api-reference`).

1. **Loop:** `tab_open` (or `tab_claim` a tab the user already has) → `tab_observe` → `tab_act` → `tab_observe`. One
   `tab_act` call does everything (waits for actionable, scrolls, hit-tests, dispatches real input, settles).
2. **Locators come from the latest observe — never guess one.** Use a `{ref:"eN"}` from the last observe, or a
   role/name/label/text/testid you can read there. `tab_act` is strict: exactly one visible match acts; several fail
   with `selector_ambiguous` (no `nth`/first shortcut through ambiguity). Scope generic labels (Close, Search, Add to
   cart, S/M/L) with `within` (a container's selector or its eN ref). After a strict failure, observe or `find` again —
   never retry the same target unchanged. `tab.find(target)` (in `js`) runs the same engine; pass an entry's `selector`
   back to act on that exact element. Durability order: `testid` → stable `id`/`data-*` → stable `href` → `role`+`name`
   → `label` → `text` → structural css.
3. **Refs are per-snapshot.** After navigation or a page change, observe again before reusing a ref.
4. **Branch on `error.code`, never message text.** Full families and what to do for each are in the `errors` doc.
5. **iframes:** add `frame` to the target — `{frame:"#checkout", role:"button", name:"Pay"}`, `frame:0`, or a chain
   outermost-first `frame:["#checkout", 0]` / `"#checkout >> iframe.card"`. Same-origin, data:/srcdoc, and cross-origin
   are entered the same way.
6. **Don't re-`goto` a URL the tab is already on** (it reloads and loses form state); use `tab_act {action:"reload"}`
   when a reload is intended.
7. **`tab.evaluate(js)` is read-only page scope.** Writes go through `tab_act` / `tab.act`.
8. **API first.** Every session tab is captured from attach: `tab.network.read({afterSequence})` (in `js`) is a paged
   log of the requests your steps triggered (method, status, headers, body, JSON sample); endpoint candidates come from
   the explicit `recon.discover(tab)`. When you've reached the data in the UI, find the request that carried it, verify
   with `tab.fetchJson(url,{method,headers,body})` (runs in the page: cookies + origin), and freeze that. DOM
   extraction (`tab.evaluate`) is the last resort. `tools_compile` follows the same order and explains its choice in
   `warnings`.
9. **Dialogs:** a native `alert`/`confirm`/`prompt` freezes the page (`dialog_open`, details in `error.dialog`). Read
   with `tab.dialog.get()` and answer `tab.dialog.accept(text?)` / `tab.dialog.dismiss()` (in `js`), then retry — never
   answer a dialog the user didn't ask you to.
10. **Observe discipline:** one observe to orient, then act on its refs. The snapshot is the full tree unless you pass
    `diff: true`, and only do that when the previous full snapshot is still in your context. `viewport: true` is the
    on-screen subtree, not a page of the full tree. Don't re-verify a fact an authoritative signal already shows
    (checked state, selected option, success toast, URL parameter). No fixed sleeps — `tab_expect` waits for the state
    you need. Credential field values read as `<redacted>`.
11. **WebMCP:** pages that register their own tools show them in `tab.webmcp.list()` (in `js`); prefer one over clicking
    the DOM, but a page tool never authorizes a consequential action.
12. **Lookups:** one focused direct navigation to an obvious result or search URL is fine; don't iterate guessed URL
    variants. On localhost apps, reload after a code/build change before verifying, and read `tab.console.read()` for
    errors the page logged.
13. **Answers:** screenshots the user asked for go inline in your final answer (Markdown image), not as bare links. If
    browser control is interrupted by the user or the extension, say so plainly ("browser use was stopped in Chrome")
    without quoting runtime error text.
