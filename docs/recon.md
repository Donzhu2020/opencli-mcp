## recon.discover(tab) — find a site's API behind the page

Static candidates + dynamic evidence. The runtime collects the scripts the page loaded, parses them with a syntax-aware analyzer (fetch/XHR/jQuery/axios/WebSocket/location uses; string concatenation resolved, unknown parts marked `EXPR`), and merges with captured network requests. Ledger order: seen in network > api-shaped static > other.

Candidates are evidence, not contracts: the scan cannot prove auth, signatures, pagination or field semantics. Verify a candidate in `js` (`tab.evaluate` for a read, or `page.fetchJson` inside a site command) or by triggering the UI with capture armed (`tab.network.start()` in `js`), then freeze it with `tools_define`. Never persist suspected secret values; the analyzer reports only redacted previews.
