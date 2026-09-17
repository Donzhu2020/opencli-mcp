## Tabs are the user's property

- Name the session first (`session_name`, short, emoji-prefixed). Agent-created tabs go into a Chrome tab group with that name, open in the background, and are muted until the user looks at them.
- To work in a tab the user already opened, `tab_list` with `user:true` then `tab_claim` with the exact `tabId`, `title` and `url` from that list. Claiming fails closed if the tab changed; never claim a different tab silently. Claimed user tabs are never moved into the agent group and never closed by finalize.
- Popups and links the agent opens are captured into the same session.
- Finish with `session_finalize`. Keep a tab only when the user needs the live page: `deliverable` (leaves the group, stays open, green badge) or `handoff` (stays in the group for a later turn, yellow badge). Everything else the agent opened is closed. If you forget, the runtime finalizes on session end.
- Keep the browser in the background by default; `capabilities_enable` `visibility` and set it only when the user wants to watch.
