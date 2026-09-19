/**
 * Content script: the human-visible layer. A cursor overlay that glides to where the agent is
 * about to act (closed shadow root, pointer-events:none, never intercepts clicks). Real input still comes from CDP.
 */

const ROOT_ID = 'opencli-mcp-overlay-root';
let host: HTMLElement | null = null;
let cursor: HTMLElement | null = null;
let keeper: MutationObserver | null = null;
let pos = { x: -100, y: -100 };
let anim: number | null = null;

function ensureOverlay(): HTMLElement {
  if (host && document.documentElement.contains(host)) return cursor!;
  host = document.createElement('div');
  host.id = ROOT_ID;
  host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `.c{position:fixed;left:0;top:0;width:28px;height:32px;pointer-events:none;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));transition:opacity .2s;opacity:0}.c.on{opacity:1}@media print{.c{display:none}}`;
  cursor = document.createElement('div');
  cursor.className = 'c';
  const img = document.createElement('img');
  try { img.src = chrome.runtime.getURL('cursor.svg'); } catch { /* context invalidated */ }
  img.width = 28; img.height = 32; img.alt = '';
  cursor.appendChild(img);
  shadow.append(style, cursor);
  document.documentElement.appendChild(host);
  keeper = new MutationObserver(() => { if (host && !document.documentElement.contains(host)) document.documentElement.appendChild(host); });
  keeper.observe(document.documentElement, { childList: true });
  return cursor;
}

function moveTo(x: number, y: number, animate: boolean): Promise<void> {
  const el = ensureOverlay();
  el.classList.add('on');
  if (anim) cancelAnimationFrame(anim);
  const from = { ...pos };
  const dist = Math.hypot(x - from.x, y - from.y);
  const duration = !animate || from.x < 0 ? 0 : Math.min(600, 120 + dist * 0.6);
  const start = performance.now();
  if (duration === 0 || document.visibilityState !== 'visible') { pos = { x, y }; el.style.transform = `translate(${x - 2}px, ${y - 2}px)`; return Promise.resolve(); }
  return new Promise((resolve) => {
    const step = (now: number) => {
      const t = duration === 0 ? 1 : Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      pos = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
      el.style.transform = `translate(${pos.x - 2}px, ${pos.y - 2}px)`;
      if (t < 1) anim = requestAnimationFrame(step); else { anim = null; pos = { x, y }; resolve(); }
    };
    anim = requestAnimationFrame(step);
  });
}

// The favicon-badge feature was removed: rewriting the page favicon to a data: SVG always violates a strict `img-src`
// CSP (e.g. Hacker News), which a content script cannot avoid or catch, so it logged a CSP error on those pages. Agent
// tabs are already marked by the named, coloured tab group; the cursor overlay shows where the agent is acting.

type CursorState = { x: number; y: number; seq: number; visible: boolean; animate?: boolean } | null;

/** The session is done with this tab: tear the overlay down completely (observer off, animation cancelled, root removed). */
function dispose(): void {
  keeper?.disconnect(); keeper = null;
  if (anim) { cancelAnimationFrame(anim); anim = null; }
  host?.remove(); host = null; cursor = null; pos = { x: -100, y: -100 };
}

/** Render the background-owned state: null → dispose; hidden → fade out (position kept); visible → glide (or jump) to the point, then report arrival with the sequence. */
function render(state: CursorState): Promise<{ arrived: boolean; seq?: number }> {
  if (!state) { dispose(); return Promise.resolve({ arrived: false }); }
  if (!state.visible) { if (cursor) cursor.classList.remove('on'); pos = { x: state.x, y: state.y }; return Promise.resolve({ arrived: false }); }
  return moveTo(state.x, state.y, state.animate === true && document.visibilityState === 'visible').then(() => ({ arrived: true, seq: state.seq }));
}

/** A new document (navigation, bfcache restore) starts from the background's state instead of blank. */
/** True until the extension is reloaded/updated; after that the old content script's chrome.* calls throw "Extension context invalidated". */
function alive(): boolean { try { return Boolean(chrome.runtime?.id); } catch { return false; } }

/** A new document (navigation, bfcache restore) starts from the background's state instead of blank. */
function pullState(): void {
  if (!alive()) return; // this content script belongs to a replaced extension version; the fresh one loads on next navigation
  try {
    chrome.runtime.sendMessage({ type: 'opencli:cursor-state?' })
      .then((r: { state?: CursorState } | undefined) => { if (r && r.state !== undefined) void render(r.state ? { ...r.state, animate: false } : null); })
      .catch(() => { /* context invalidated or no listener */ });
  } catch { /* context invalidated */ }
}

chrome.runtime.onMessage.addListener((msg: { type?: string; state?: CursorState }, _sender, sendResponse) => {
  if (msg?.type === 'opencli:ping') { sendResponse({ ok: true }); return false; }
  if (msg?.type === 'opencli:cursor-state') { void render(msg.state ?? null).then(sendResponse); return true; }
  return false;
});
window.addEventListener('pageshow', pullState);
pullState();
