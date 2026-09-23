## recon.discover(tab) — find a site's API behind the page

Static candidates + dynamic evidence. The runtime collects the scripts the page loaded, parses them with a syntax-aware analyzer (fetch/XHR/jQuery/axios/WebSocket/location uses; string concatenation resolved, unknown parts marked `EXPR`), and merges with captured network requests. Ledger order: seen in network > api-shaped static > other.

Candidates are evidence, not contracts: the scan cannot prove auth, signatures, pagination or field semantics. Verify a candidate in `js` with `tab.fetchJson()` or by triggering the UI with capture armed (`tab.network.start()` in `js`). If a reusable command is useful, encode the verified behavior explicitly with `tools_define` and check it with `site_run`.
