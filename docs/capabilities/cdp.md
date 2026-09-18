## Capability: cdp
Raw Chrome DevTools Protocol on the current tab (`(await browser.capabilities.get('cdp')).send(method, params)` in `js`), limited to an allowlist (DOM, Accessibility, Input, Page metrics/screenshots, Emulation). Prefer the higher-level tools. If you change page or browser state through CDP and leave it, tell the user what changed.
