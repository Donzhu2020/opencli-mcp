## js — persistent JavaScript session

Top-level `const`/`let` persist across calls (they become session globals). The value of the last expression is returned. Use `nodeRepl.write(text)` for extra output and `await nodeRepl.emitImage({ base64, mimeType })` for images; `tab.screenshot()` already returns an image block when called at top level.

Pre-bound session globals (no import/bootstrap): `browser` (the default Chrome), `agent`, `sites`, `recon`, `tools`, `session`, `Tab`, `nodeRepl`. So `await browser.tabs.new(...)` works directly; `const browser = await agent.browsers.getDefault()` is the same object if you prefer to be explicit.

```js
const tab = await browser.tabs.new('https://news.ycombinator.com');
const state = await tab.observe();            // accessibility snapshot with [ref=eN] refs
await tab.act({ target: { text: 'new' }, action: 'click' });
const titles = await tab.evaluate('[...document.querySelectorAll(".titleline a")].map(a => a.textContent)');
await sites.enable('hackernews');
const top = await sites.hackernews.top({ limit: 5 });
// freeze what you just did into a tool — the same tab API, the function itself is saved
await tools.define({ site: 'hackernews', name: 'newest-titles', description: 'titles on /newest', access: 'read', func: async ({ tab }) => { await tab.goto('https://news.ycombinator.com/newest'); return await tab.evaluate('[...document.querySelectorAll(".titleline a")].map(a => a.textContent)'); } });
```

The full object model is in the generated API reference that follows (`docs_get api-reference`); nothing else exists.
