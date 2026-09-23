## js — persistent JavaScript session

Top-level `const`/`let` persist across calls (they become session globals). The value of the last expression is returned. Use `nodeRepl.write(text)` for extra output and `await nodeRepl.emitImage({ base64, mimeType })` for images; `tab.screenshot()` already returns an image block when called at top level.

Pre-bound session globals (no import/bootstrap): `browser` (the default Chrome), `agent`, `sites`, `recon`, `tools`, `session`, `Tab`, `nodeRepl`. So `await browser.tabs.new(...)` works directly; `const browser = await agent.browsers.getDefault()` is the same object if you prefer to be explicit.

```js
const tab = await browser.tabs.new('https://news.ycombinator.com');
const state = await tab.observe();            // action map with [ref=eN] refs; { diff: true } only if you still have the previous snapshot; { ref: 'e12' } opens one collapsed branch
const article = await tab.read();              // linear text of a bounded document, no refs; scroll is restored
if (article.nextStart !== undefined) await tab.read({ start: article.nextStart }); // continue on an unchanged page
await tab.act({ target: { text: 'new' }, action: 'click' });
const titles = await tab.evaluate('[...document.querySelectorAll(".titleline a")].map(a => a.textContent)');
// freeze what you just did into a tool — the same tab API, the function itself is saved
await tools.define({ site: 'hackernews', name: 'newest-titles', description: 'titles on /newest', access: 'read', func: async ({ tab }) => { await tab.goto('https://news.ycombinator.com/newest'); return await tab.evaluate('[...document.querySelectorAll(".titleline a")].map(a => a.textContent)'); } });
await tab.release();                            // leave the page open; tab.close() would close it
```

Built-in site commands use the connected browser session:

```js
await sites.enable('reddit');
const posts = await sites.reddit.hot({ subreddit: 'programming', limit: 5 });
posts;
```

The full object model is in the generated API reference that follows (`docs_get api-reference`); nothing else exists.
