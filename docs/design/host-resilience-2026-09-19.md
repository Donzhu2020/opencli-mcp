# Host / bridge resilience — first-principles review (owner: "别只打补丁，想想整个方案")

The "Transport closed" bug is a symptom. This is the architecture behind it and whether the whole shape can be better.

## How the pieces actually live (grounded in the code)
- **Native Messaging spawns the host per connection.** `chrome.runtime.connectNative` (extension `native.ts`) makes
  Chrome spawn `opencli-mcp host --native`; the host talks to the extension over stdio. The host's lifetime **equals
  that port**: `host.ts:45` shuts the host down (`process.exit`) the instant the Native port closes.
- **The host embeds everything:** the MCP HTTP endpoint (`startHttpServer`), the Runtime (sessions, enabled sites,
  traces, js sessions), and the extension bridge. So when the port drops, the MCP endpoint **and** all runtime state die
  together.
- **What drops the port:** an extension reload/update, a crash, or the service worker being replaced. It is NOT normal
  idle — while the Native port is open Chrome keeps the SW awake, and while the host runs it holds the port; they keep
  each other alive. So the host is stable during use; it dies mainly on a reload (a dev action — exactly what triggered
  this report).
- **The extension already self-heals its side:** `native.ts` schedules a reconnect (alarm + `onDisconnect`), so once the
  SW is alive again it reconnects → Chrome spawns a **fresh** host, which writes a **new** `host.json` (new port/token).
- **The gap was only the launcher:** it proxied to the old host and `process.exit(0)`'d on the drop, so the agent's
  stdio channel died and never picked up the new host. (Fixed — see below.)

## The fix already shipped (tactical, and correct regardless of what we choose next)
The stdio launcher now keeps the client channel up for the whole session and treats the host as reconnectable: it
re-reads `host.json` on demand (new port/token after a respawn), retries once on a disconnect, and returns a retryable
`host_unavailable` while the host is down. Combined with the extension's existing auto-reconnect, the channel now
**self-heals**: reload extension → old host dies → extension respawns host → launcher reconnects. This is the missing
resilience layer, not a band-aid — a Native-Messaging host is *inherently* restartable, so the client of it must be
reconnect-tolerant.

## The remaining, inherent limit
A host restart still starts a **fresh Runtime** — enabled sites, js-session variables, and the trace from before are
gone, and the debugger attachments (held by the *extension*, which just reloaded) are gone too. So mid-session state is
lost across a reload. The question the owner is really asking: can the architecture avoid that?

## Options

**A. Keep the model; ship the launcher reconnect (done).** The host stays Chrome-spawned; the client tolerates
restarts. Pro: simplest, matches Native Messaging's nature, no new moving parts. Con: mid-session runtime state is lost
on the (rare, mostly-dev) host restart.

**B. Decouple the Runtime/MCP from the Native port — a persistent local daemon the extension *attaches* to.** Instead of
Chrome spawning a host that owns everything, a long-lived daemon owns the Runtime + MCP endpoint, and the browser bridge
attaches/detaches. Because Native Messaging can't reach an already-running process, this means the extension connects to
the daemon over **localhost WebSocket** (MV3 SWs support WS and WS keeps the SW alive) instead of `connectNative`, or the
Native host becomes a thin relay to the daemon. Pro: the MCP endpoint and non-browser runtime state (enabled sites,
trace, js vars) survive an extension reload; on reconnect the daemon can re-attach the debugger to the still-open tabs,
giving real session continuity. Con: a genuine redesign — daemon lifecycle (who starts/stops it, idle shutdown),
a localhost server the extension trusts (auth/origin), and moving off Native Messaging (a local-socket variant was tried
once, c2f3c04, and reverted). It also cannot preserve the debugger attachment *through* the reload itself — only
re-attach after — so part of the benefit is limited.

**C. Minor hardening (complements A).** Make the extension respawn the host faster after a drop (shorter reconnect
backoff) and have the host persist a tiny bit of cheap runtime state (enabled sites) to disk so a respawn restores it.
Small, cheap continuity without B's redesign.

## Recommendation
**Ship A (done) now; do NOT build B yet.** For a single-user local tool, B's payoff is preserving ephemeral state across
an event that is mostly a developer reload — and it can't preserve the live debugger attachment through the reload
anyway. That is a lot of new machinery (daemon lifecycle + a trusted localhost WS + leaving Native Messaging) for a
narrow, rare benefit — the kind of thing the recent over-engineering pass was cutting, not adding. The reconnect layer
already makes the channel self-heal, which is the property that actually matters.

If we later find real value in cross-reload continuity (e.g. long unattended sessions, or multiple clients sharing one
browser), revisit B — and then do it properly (daemon + WS attach + re-attach on reconnect), not a socket bolt-on. A
cheap middle step (C: persist `enabledSites`, faster respawn) is available any time if reload-continuity becomes annoying.
