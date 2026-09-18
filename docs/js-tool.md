## js — persistent JavaScript session

Top-level `const`/`let` persist across calls (they become session globals). The value of the last expression is returned. Use `nodeRepl.write(text)` for extra output and `await nodeRepl.emitImage({ base64, mimeType })` for images; `tab.screenshot()` already returns an image block when called at top level.

```js
const browser = await agent.browsers.getDefault();
const tab = await browser.tabs.new('https://news.ycombinator.com');
const state = await tab.observe();            // accessibility snapshot with [ref=eN] refs
await tab.act({ target: { text: 'new' }, action: 'click' });
const titles = await tab.evaluate('[...document.querySelectorAll(".titleline a")].map(a => a.textContent)');
await sites.enable('hackernews');
const top = await sites.hackernews.top({ limit: 5 });
```

Objects: `agent.browsers.list()/get(id)/getDefault()/getForUrl(url)`; `browser.tabs.new(url?)/list()/get(id)/selected()/finalize({keep})`; `browser.user.openTabs()/claimTab({tabId,title,url})`; `tab.console.read({levels?, filter?, afterSequence?})` (console messages + uncaught exceptions, cursor-paged); `browser.nameSession(name)`; `browser.capabilities.list()/get(id)` (`cdp`, `viewport`, `visibility`, `webmcp`); `tab.goto/back/forward/reload/url/title/close`, `tab.observe({mode,source,diff,annotate})`, `tab.find(target | {x,y})`, `tab.act({target, action, value, files, to, direction, amount, timeoutMs, settleMs})` — actions: click, dblclick, hover, focus, fill, type, press, select, check, uncheck, upload, drag, scroll, back, forward, reload; `tab.screenshot({fullPage,annotate})`, `tab.wait({text|selector|url|time})`, `tab.evaluate(js)`, `tab.network.start(pattern)/read({afterSequence,pattern,limit})`, `tab.webmcp.list()/call(name,input)`, `tab.cookies(domain)`, `tab.frames()`, `tab.download(pattern)`, `tab.markDeliverable()/markHandoff()`; `sites.search(q)/list()/enable(site)/run(site,cmd,args)` and `sites.<site>.<command>(args)`; `recon.discover(tab)`; `tools.define(def)/compile({...})/list()/remove()`; `session.name(n)/finalize(keep)/trace()`.
