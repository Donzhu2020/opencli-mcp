import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, domEval } from './_shared.js';

export default defineAdapter({
  description: 'Auto-accept DM requests whose content matches given keywords.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'query', type: 'string', required: true, help: 'Keywords to match (comma-separated for OR)' },
    { name: 'max', type: 'int', default: 20, help: 'Maximum number of requests to accept' },
  ],
  async run({ tab, args }) {
    const keywords = String(args.query || '').split(',').map((k) => k.trim()).filter(Boolean);
    if (!keywords.length) throw errors.argument('query cannot be empty');
    const maxAccepts = Math.max(1, Number(args.max) || 20);
    await ensureOnX(tab);
    const results = [];
    let acceptCount = 0;
    const visited = new Set();
    for (let round = 0; round < maxAccepts + 50; round++) {
      if (acceptCount >= maxAccepts) break;
      await tab.goto('https://x.com/messages/requests', { waitUntil: 'load', settleMs: 4000 });
      const convInfo = await domEval(tab, `(async () => {
        try {
          let attempts = 0;
          while (attempts < 10) { if (document.querySelectorAll('[data-testid="conversation"]').length) break; await new Promise(r => setTimeout(r, 1000)); attempts++; }
          const seen = new Set(); let noNew = 0;
          for (let s = 0; s < 20; s++) {
            const convs = Array.from(document.querySelectorAll('[data-testid="conversation"]'));
            const prev = seen.size; convs.forEach((_, i) => seen.add(i));
            if (convs.length >= ${maxAccepts + 10}) break;
            if (convs.length) convs[convs.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
            await new Promise(r => setTimeout(r, 1500));
            if (seen.size <= prev) { noNew++; if (noNew >= 3) break; } else noNew = 0;
          }
          const convs = Array.from(document.querySelectorAll('[data-testid="conversation"]'));
          if (!convs.length) return { ok: false, items: [] };
          return { ok: true, items: convs.map((conv, idx) => { const text = conv.innerText || ''; const link = conv.querySelector('a[href]'); return { idx, text, href: link ? link.href : '', user: text.split('\\n').filter((l) => l.trim())[0] || 'Unknown' }; }) };
        } catch (e) { return { ok: false, error: String(e), items: [] }; }
      })()`);
      if (!convInfo?.ok || !convInfo.items?.length) { if (!results.length) results.push({ index: 1, status: 'info', user: 'System', message: 'No message requests found' }); break; }
      let found = false;
      for (const item of convInfo.items) {
        if (acceptCount >= maxAccepts) break;
        const key = item.href || `conv-${item.idx}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (!keywords.some((k) => item.text.includes(k))) continue;
        const clicked = await domEval(tab, `(async () => { try { const conv = Array.from(document.querySelectorAll('[data-testid="conversation"]'))[${item.idx}]; if (!conv) return { ok: false }; conv.click(); await new Promise(r => setTimeout(r, 2000)); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; } })()`);
        if (!clicked?.ok) continue;
        const res = await domEval(tab, `(async () => {
          try {
            const keywords = ${JSON.stringify(keywords)};
            const heading = document.querySelector('[data-testid="conversation-header"]') || document.querySelector('[data-testid="DM-conversation-header"]');
            const username = heading ? heading.innerText.trim().split('\\n')[0] : 'Unknown';
            const chat = document.querySelector('[data-testid="DmScrollerContainer"]') || document.querySelector('[data-testid="DMConversationBody"]') || document.querySelector('main');
            const text = chat ? chat.innerText : '';
            const matched = keywords.filter((k) => text.includes(k));
            if (!matched.length) return { status: 'skipped', user: username, message: 'No keyword match in full content' };
            const acceptBtn = Array.from(document.querySelectorAll('[role="button"]')).find((b) => { const t = b.innerText.trim().toLowerCase(); return t === 'accept' || t === '接受'; });
            if (!acceptBtn) return { status: 'no_button', user: username, message: 'Keyword matched but no Accept button' };
            acceptBtn.click(); await new Promise(r => setTimeout(r, 2000));
            const confirmBtn = Array.from(document.querySelectorAll('[role="button"]')).find((b) => { const t = b.innerText.trim().toLowerCase(); return (t === 'accept' || t === '接受') && b !== acceptBtn; });
            if (confirmBtn) { confirmBtn.click(); await new Promise(r => setTimeout(r, 1000)); }
            return { status: 'accepted', user: username, message: 'Accepted! Matched: ' + matched.join(', ') };
          } catch (e) { return { status: 'error', user: 'system', message: String(e) }; }
        })()`);
        if (res?.status === 'accepted') { acceptCount++; found = true; results.push({ index: acceptCount, status: 'accepted', user: res.user || 'Unknown', message: res.message }); break; }
      }
      if (!found) break;
    }
    if (!results.length) results.push({ index: 0, status: 'info', user: 'System', message: `No requests matched keywords "${keywords.join(', ')}"` });
    return results;
  },
});
