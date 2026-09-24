## recon.discover(tab) — find a site's API behind the page

Dynamic evidence first. The runtime ranks captured requests from the real page flow. With `{includeStatic:true}`, it also collects loaded scripts, parses fetch/XHR/jQuery/axios/WebSocket/location uses, resolves string concatenation where possible, and merges relative paths against the page origin. Unknown dynamic parts are marked `EXPR`. Ledger order: seen in network > api-shaped static > other. Static analysis is slower and may include noise, so request it only when the observed traffic does not answer the question.

Candidates are evidence, not contracts: the scan cannot prove auth, signatures, pagination or field semantics. Use `network_inspect` list/detail to inspect the original request and response, then verify a candidate through the page with `tab.fetchJson()` or UI interaction. Encode a reusable behavior as a draft with `tools_define`, run `tools_try` with an assertion, and publish with `tools_activate`.
