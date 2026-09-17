/**
 * Content script: the human-visible layer. A cursor overlay that glides to where the agent is
 * about to act (closed shadow root, pointer-events:none, never intercepts clicks) and a favicon
 * badge showing the tab's state (active / deliverable / handoff). Real input still comes from CDP.
 */
type Badge = 'active' | 'deliverable' | 'handoff' | null;

const ROOT_ID = 'opencli-mcp-overlay-root';
let host: HTMLElement | null = null;
let cursor: HTMLElement | null = null;
let pos = { x: -100, y: -100 };
let anim: number | null = null;
let originalIcons: Array<{ el: HTMLLinkElement; href: string }> | null = null;

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
  img.src = chrome.runtime.getURL('cursor.svg');
  img.width = 28; img.height = 32; img.alt = '';
  cursor.appendChild(img);
  shadow.append(style, cursor);
  document.documentElement.appendChild(host);
  new MutationObserver(() => { if (host && !document.documentElement.contains(host)) document.documentElement.appendChild(host); }).observe(document.documentElement, { childList: true });
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

function badgeSvg(badge: Exclude<Badge, null>, iconHref: string | null): string {
  const base = iconHref ? `<image href="${iconHref.replace(/"/g, '&quot;')}" width="32" height="32" opacity="${badge === 'active' ? 0.35 : 1}"/>` : `<rect width="32" height="32" rx="6" fill="#e5e7eb"/>`;
  const mark = badge === 'active'
    ? `<path d="M6 6 L6 24 L11 19 L14 27 L17.5 25.5 L14.5 18 L21 18 Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>`
    : `<circle cx="25" cy="25" r="6" fill="${badge === 'deliverable' ? '#22c55e' : '#facc15'}" stroke="#fff" stroke-width="2"/>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${base}${mark}</svg>`)}`;
}

function setBadge(badge: Badge): void {
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="shortcut icon"]')];
  if (badge === null) {
    if (originalIcons) { for (const { el, href } of originalIcons) el.href = href; originalIcons = null; }
    document.querySelectorAll('link[data-opencli-badge]').forEach((l) => l.remove());
    return;
  }
  if (!originalIcons) originalIcons = links.map((el) => ({ el, href: el.href }));
  const iconHref = originalIcons[0]?.href ?? null;
  const svg = badgeSvg(badge, iconHref && !iconHref.startsWith('data:image/svg') ? iconHref : null);
  if (links.length === 0) {
    const l = document.createElement('link'); l.rel = 'icon'; l.href = svg; l.setAttribute('data-opencli-badge', '1');
    document.head?.appendChild(l);
  } else for (const el of links) el.href = svg;
}

chrome.runtime.onMessage.addListener((msg: { type?: string; x?: number; y?: number; animate?: boolean; badge?: Badge }, _sender, sendResponse) => {
  if (msg?.type === 'opencli:ping') { sendResponse({ ok: true }); return false; }
  if (msg?.type === 'opencli:cursor' && typeof msg.x === 'number' && typeof msg.y === 'number') {
    void moveTo(msg.x, msg.y, msg.animate !== false && document.visibilityState === 'visible').then(() => sendResponse({ arrived: true }));
    return true;
  }
  if (msg?.type === 'opencli:badge') { try { setBadge(msg.badge ?? null); sendResponse({ ok: true }); } catch (err) { sendResponse({ ok: false, error: String(err) }); } return false; }
  return false;
});
window.addEventListener('pagehide', () => { if (originalIcons) setBadge(null); });
