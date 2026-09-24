## How to act on a page

The core loop and the discipline that makes it reliable. Tool-by-tool argument shapes are in each tool's schema; error
families are in the `errors` doc; read the full object model on demand with `docs_get {name:"api-reference"}`.

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
8. **Choose the data path for the task.** For a reusable adapter, start from the UI behavior and inspect the request that carried the data. Every session tab captures from attach: `network_inspect` list returns compact request summaries; detail by `seq` returns headers and a bounded request or response body. Continue with `body.nextStart` when needed. In `js`, use `tab.network.list()` and `tab.network.detail({seq})`. `recon.discover(tab)` ranks captured requests, and `{includeStatic:true}` adds script analysis only when needed. Replay a candidate with `tab.fetchJson(url,{method,headers,body})` inside the logged-in page, then compare its result to the captured response. An adapter should handle changing tokens at run time. For a one-off UI task, complete it directly; there is no need to reverse-engineer every endpoint.
9. **Dialogs:** a native `alert`/`confirm`/`prompt` freezes the page (`dialog_open`, details in `error.dialog`). Read
   with `tab.dialog.get()` and answer `tab.dialog.accept(text?)` / `tab.dialog.dismiss()` (in `js`), then retry — never
   answer a dialog the user didn't ask you to.
10. **Observe discipline:** one observe to orient, then act on its refs. The snapshot is the action map, not the
    document — read an article, doc, or chat log with `tab_read` (linear text, no refs; scroll is restored). If it returns
    `nextStart`, pass it with `readId` as `start` and `readId` to continue that same capture. `reason:"unbounded"` means a growing feed stopped the scan; `scan_limit` means the scan ended before the page did. Branches marked `(collapsed)`
    keep their ref; `tab_observe` with `{ref:"eN"}` opens that one branch. The snapshot is the full tree unless you pass
    `since` with the `snapshotId` of a state still in your context for an exact diff; otherwise you get the full state. `viewport: true` is the
    on-screen subtree, not a page of the full tree. `click` is a real mouse event and fails with `not_delivered` when
    the page did not receive it, or the element has no box; only then, once, `method:"dom"`. Don't re-verify a fact an authoritative signal already shows
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
14. **Popup and download outcomes:** If an action returns `openedTabs`, use its `tab` ids directly; each is a child of the source tab observed while the action ran and already belongs to the session. A `pending:true` child has no page handle yet; call `tab_list` and match its numeric `tabId` to obtain the handle when ready. For a download, keep `download.afterSequence` from the action, then call `tab_download_wait` with the same tab and cursor (or `await tab.download(afterSequence)` in `js`). A `download.started` entry proves that page began a download, while `downloaded:true` means Chrome reports a completed file whose new start event was paired with the page event by URL. `not_started`, `unconfirmed`, `ambiguous`, and `cursor_expired` do not prove completion. Chrome's download event has no source-tab id, so a file match is reported with `association:"url+event"` rather than as exact provenance.
