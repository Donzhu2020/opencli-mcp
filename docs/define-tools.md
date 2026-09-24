## Define a site adapter

A site adapter is a host-side JavaScript function that uses the same `Tab` API as `js`. It receives `{ tab, args, sites, recon }` and operates its own background tab in the connected Chrome profile. Browser actions, network reads, and `tab.fetchJson()` use the user's existing login.

The optional `domain` is metadata for discovery and the tool icon. It does not navigate the tab; the adapter should call `tab.goto()` when it needs a site origin.

1. Explore the site with `tab.observe()` and `tab.act()`. The action result's `network.afterSequence` is the cursor before that action; use it with `network_inspect` list (then detail by `seq`) or `tab.network.list()/detail()` in `js` to inspect requests observed during and after the action. This time window is evidence, not proof that every request was caused by the action. `recon.discover(tab)` ranks observed requests; pass `{includeStatic:true}` only when the captured traffic is insufficient.
2. Verify the endpoint or UI workflow, including authentication, arguments, pagination, and errors. Recompute CSRF tokens and request signatures at run time; never save a captured credential or one-time value.
3. Define an inactive draft with `tools_define {site, name, description, access, domain?, args?, func}` or `await tools.define({...})` in `js`. The `func` is a JavaScript function source such as `async ({ tab, args }) => { ... }`. Args may use nested `array`/`object`, `nullable`, bounds, choices and examples; this same contract powers search, MCP schemas and execution.
4. Run `tools_try {draftId,args,expect}` with real sample args and an assertion (`{path:"value.id"}` or `{minRows:1}`; add `equals` when a particular value matters). Inspect the actual result and assertion report. A failed trial stays inactive. A write draft may perform the write during this trial, so use a sample whose effect you intend to verify.
5. Call `tools_activate {draftId}` only after a passing trial. It atomically replaces the active adapter under `~/.opencli-mcp/adapters/<site>/<name>.js`; `site_run` can then execute it. For a typed `<site>_<name>` tool, call `sites.enable(site)` in `js` (`write:true` for write commands).

A draft never replaces the current adapter until activation. Activation fails if that adapter changed since the draft was created; create a new draft against the latest version.
Discard an unused draft with `tools_discard {draftId}` or `tools.discard(draftId)` in `js`.

For a logged-in JSON API, navigate to the site's origin before fetching. A minimal function looks like this:

```js
async ({ tab, args }) => {
  await tab.goto('https://example.com/');
  return await tab.fetchJson(`/api/search?q=${encodeURIComponent(args.query)}`);
}
```

Use stable semantic targets and `tab.expect()` when the adapter must interact with the UI. `tools.list()` and `tools.remove(site, name)` manage user-defined adapters. Built-in adapters and user adapters use the same loader; a user adapter with the same site and name takes precedence. If writing an adapter file directly, import `defineAdapter` and `errors` from `opencli-mcp/adapter-sdk`; this SDK is part of the main package.
