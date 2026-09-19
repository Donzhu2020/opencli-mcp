import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Add a muted word or phrase on X.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'keyword', type: 'string', required: true, help: 'Word or phrase to mute' },
  ],
  async run({ tab, args }) {
    const keyword = String(args.keyword || '').trim();
    if (!keyword) throw errors.argument('keyword cannot be empty');
    await ensureOnX(tab);
    const script = `(async () => {
      const keyword = ${JSON.stringify(keyword)};
      let writeStarted = false;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const visible = (n) => { if (!n) return false; const s = window.getComputedStyle ? window.getComputedStyle(n) : null; return !s || (s.visibility !== 'hidden' && s.display !== 'none'); };
      const textOf = (n) => String(n?.innerText || n?.textContent || '').trim();
      const lowerTextOf = (n) => textOf(n).toLowerCase();
      const exactTextOf = (n) => lowerTextOf(n).replace(/\\s+/g, ' ');
      const setNativeValue = (n, v) => {
        if ('value' in n) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n), 'value')?.set; if (setter) setter.call(n, v); else n.value = v; } else n.textContent = v;
        let ev; try { ev = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }); } catch { ev = new Event('input', { bubbles: true }); }
        n.dispatchEvent(ev); n.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const surface = () => document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
      const scopeFor = (n) => n?.closest('form, [data-testid="primaryColumn"], main') || surface();
      const keywordRows = () => { const s = surface(); if (!s) return []; return Array.from(s.querySelectorAll('[data-testid*="muted"], [data-testid*="keyword"], [role="listitem"], li')).filter((n) => visible(n) && !n.querySelector('input, textarea, [role="textbox"]')); };
      const rowSnapshot = () => keywordRows().map(textOf).filter(Boolean);
      const exactRows = () => keywordRows().filter((n) => textOf(n) === keyword);
      const hasNewRow = (before) => exactRows().length > before.filter((t) => t === keyword).length;
      const toastTexts = () => Array.from(document.querySelectorAll('[role="status"], [data-testid="toast"], [data-testid*="toast"], [aria-live]')).filter((n) => { if (!visible(n)) return false; const t = lowerTextOf(n); return (t.includes('muted') || t.includes('added') || t.includes('saved') || t.includes('已') || t.includes('保存') || t.includes('添加')) && t.includes(keyword.toLowerCase()); }).map(exactTextOf);
      const hasNewToast = (before) => { const c = new Map(); for (const t of before) c.set(t, (c.get(t) || 0) + 1); for (const t of toastTexts()) { const n = c.get(t) || 0; if (n > 0) c.set(t, n - 1); else return true; } return false; };
      const findField = () => { const s = surface(); if (!s) return null; const exact = Array.from(s.querySelectorAll('input[name="keyword"], textarea[name="keyword"]')).filter(visible); if (exact.length) return exact[0]; const cands = Array.from(s.querySelectorAll('input[aria-label], textarea[aria-label], [role="textbox"]')).filter(visible); return cands.find((n) => { const a = String(n.getAttribute('aria-label') || '').trim().toLowerCase(), p = String(n.getAttribute('placeholder') || '').trim().toLowerCase(); const set = ['word or phrase', 'word', 'phrase', '关键词', '屏蔽词']; return set.includes(a) || set.includes(p); }) || null; };
      const findSave = (field) => { const labels = new Set(['save', 'add', 'done', '保存', '添加', '完成']); const scope = scopeFor(field); if (!scope) return null; return Array.from(scope.querySelectorAll('button, [role="button"]')).find((n) => { if (!visible(n) || n.disabled || n.getAttribute('aria-disabled') === 'true') return false; const t = exactTextOf(n), a = String(n.getAttribute('aria-label') || '').trim().toLowerCase(); return labels.has(t) || labels.has(a); }) || null; };
      try {
        const field = findField();
        if (!field) return { ok: false, message: 'Could not find muted word input. Are you logged in?' };
        field.focus?.(); setNativeValue(field, keyword); await sleep(100);
        const beforePath = location.pathname, beforeRows = rowSnapshot(), beforeToasts = toastTexts();
        const saveButton = findSave(field);
        if (!saveButton) return { ok: false, message: 'Could not find muted word Save button.' };
        writeStarted = true;
        saveButton.click();
        for (let i = 0; i < 20; i++) {
          await sleep(250);
          if (beforePath !== '/settings/muted_keywords' && location.pathname === '/settings/muted_keywords') return { ok: true, message: 'Muted word added.' };
          if (hasNewToast(beforeToasts)) return { ok: true, message: 'Muted word added.' };
          if (hasNewRow(beforeRows)) return { ok: true, message: 'Muted word added.' };
        }
        return { ok: false, unconfirmed: true, message: 'Muted word submission did not show confirmation.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e?.message || e) }; }
    })()`;
    const r = await domRun(tab, 'https://x.com/settings/add_muted_keyword', script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check muted words before retrying; the word may already have been added.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Could not add muted word');
    return { ok: true, keyword, message: r.message };
  },
});
