/**
 * The object model — the single surface behind both the typed MCP tools and the `js` session.
 *   agent.browsers → browser.tabs / browser.user / browser.capabilities → tab.observe / tab.act / …
 *   sites.<site>.<command>(args) · recon.discover(tab) · tools.define · browser.nameSession / browser.tabs.finalize
 * Split by object: tab.ts, browser.ts, api.ts (context.ts carries what they share). This file re-exports them.
 */
export * from './tab.js';
export * from './browser.js';
export * from './api.js';
export * from './context.js';
