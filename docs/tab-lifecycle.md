## Tabs are the user's property

- Name the session with the first tab (`tab_open {session}`, or `session.name()` in `js`; short, emoji-prefixed). Agent-created tabs go into a Chrome tab group with that name, open in the background, and are muted until the user looks at them.
- To work in a tab the user already opened, `tab_claim` by `tabId` (list them with `browser.user.openTabs()` in `js`), or with a `url` (exact or prefix) and/or `title` (substring) when you know the page but not the id — that match must be unique (`claim_ambiguous` lists the candidates). `url`/`title` passed together with a `tabId` are guards: the claim fails closed if the tab no longer matches; never claim a different tab silently. Claimed user tabs are never moved into the agent group and never closed by finalize.
- Popups and links the agent opens are captured into the same session.
- Finish with `session_finalize`. Keep a tab only when the user needs the live page: `deliverable` (leaves the group, stays open, green badge) or `handoff` (stays in the group for a later turn, yellow badge). Everything else the agent opened is closed. If you forget, the runtime finalizes on session end.
- Keep the browser in the background by default; `(await browser.capabilities.get('visibility')).set(true)` in `js` only when the user wants to watch.

- The cursor overlay is owned by the runtime, not the page: it is only shown in the tab the user is looking at (active tab of a non-minimized window), keeps its position across navigations, and disappears when the tab leaves the session (finalize/release). In unobserved tabs actions do not animate or wait for the cursor.
- The debugger attachment to a tab is kept for the whole session and released by finalize. If the user cancels it from Chrome's debugging bar, the next action re-attaches once automatically; no per-action health check is performed.
