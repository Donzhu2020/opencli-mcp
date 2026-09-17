## js — persistent JavaScript session

Top-level `const`/`let` persist across calls (they become session globals). The value of the last expression is returned. Use `nodeRepl.write(text)` for extra output and `await nodeRepl.emitImage({ base64, mimeType })` for images; `tab.screenshot()` already returns an image block when called at top level.

```js
const browser = await agent.browsers.getDefault();
const tab = await browser.tabs.new('https://news.ycombinator.com');
const state = await tab.observe();            // text state with [N] refs
await tab.act({ target: { text: 'new' }, action: 'click' });
const titles = await tab.evaluate('[...document.querySelectorAll(".titleline a")].map(a => a.textContent)');
await sites.enable('hackernews');
const top = await sites.hackernews.top({ limit: 5 });
```

Objects: `agent.browsers.list()/get(id)/getDefault()/getForUrl(url)`; `browser.tabs.new(url?)/list()/get(id)/finalize({keep})`; `browser.user.openTabs()/claimTab({tabId,title,url})`; `browser.nameSession(name)`; `browser.capabilities.list()/get(id)`; `tab.goto/back/reload/url/title/close`, `tab.observe({mode,source,diff})`, `tab.find(target)`, `tab.act({target,action,value})`, `tab.screenshot({fullPage,annotate})`, `tab.wait({text|selector|url|time})`, `tab.evaluate(js)`, `tab.network.start(pattern)/read()`, `tab.cookies(domain)`, `tab.markDeliverable()/markHandoff()`; `recon.discover(tab)`; `tools.define(def)`, `tools.compile({...})`.
