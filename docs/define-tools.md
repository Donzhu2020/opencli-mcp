## tools_define / tools_compile — freezing a flow

A frozen flow is written against the same object model you explored with. Its function receives `{ tab, args, sites, recon, page }`: `tab` is a normal Tab (`goto/act/expect/observe/find/evaluate/fetchJson/network/…`) bound to the tool's own background page, `sites` and `recon` are the same objects as in `js`. Freezing changes nothing about how the page is driven.

Three ways to freeze:
- **From the code you just ran** (`js`): `await tools.define({ site, name, description, access, args, func: async ({ tab, args }) => { … } })` — pass the function itself; its source is what gets saved.
- **From the session trace**: `tools_compile` drafts the function from your recorded steps — network-first (a captured JSON endpoint becomes one `tab.fetchJson` call through the logged-in page), else `tab.goto`, `tab.act({action, target:{selector}, value})` with the selector recorded when you acted, and `tab.expect({...})` for every `tab_expect` you made. Put a `tab_expect` after each meaningful step while exploring; those checkpoints are what make the frozen tool trustworthy.
- **By hand**: `tools_define` with `func` source.

`inputs` are explicit: `{query: "what you typed"}` or `{query: {sample, description, type, mode: "exact"|"within"}}`. By default only whole literals equal to the sample become `args.query`; declare `mode: "within"` to also parameterize longer literals that contain it. Nothing is guessed.

Each compiled step is wrapped: a failure reports `error.details.step`, `label`, the engine's code/hint, the failed expectation and the page state at that moment, so the one broken step can be fixed. `tools_define` takes `{site, name, description, access, strategy?, domain?, args?, columns?, pipeline? | func?}`; review the draft, define it, run it once.
