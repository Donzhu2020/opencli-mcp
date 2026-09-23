## Define a site adapter

A site adapter is an explicit JavaScript function that uses the same `Tab` API as `js`. It receives `{ tab, args, sites, recon }` and runs in its own background tab in the connected Chrome profile. Browser actions, network reads, and `tab.fetchJson()` use the user's existing login.

1. Explore the site with `tab.observe()`, `tab.act()`, and `tab.network.read()`. `recon.discover(tab)` can suggest API endpoints, but a candidate is evidence, not a verified contract.
2. Verify the endpoint or UI workflow, including authentication, arguments, pagination, and errors. Recompute CSRF tokens and request signatures at run time; never save a captured credential or one-time value.
3. Define the adapter with `tools_define {site, name, description, access, domain?, args?, func}` or `await tools.define({...})` in `js`. The `func` is a JavaScript function source such as `async ({ tab, args }) => { ... }`.
4. Run the new command with `site_run` and check its actual result. The source is saved under `~/.opencli-mcp/adapters/<site>/<name>.js` and becomes available without restarting the host.

For a logged-in JSON API, navigate to the site's origin before fetching. A minimal function looks like this:

```js
async ({ tab, args }) => {
  await tab.goto('https://example.com/');
  return await tab.fetchJson(`/api/search?q=${encodeURIComponent(args.query)}`);
}
```

Use stable semantic targets and `tab.expect()` when the adapter must interact with the UI. `tools.list()` and `tools.remove(site, name)` manage user-defined adapters. Built-in adapters and user adapters use the same loader; a user adapter with the same site and name takes precedence.
