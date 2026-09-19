import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, normalizeScreenName, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Block an X user.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'username', type: 'string', required: true, help: 'Screen name (with or without @)' },
  ],
  async run({ tab, args }) {
    const username = normalizeScreenName(String(args.username || '').trim());
    if (!username) throw errors.argument('username must be a valid X handle');
    await ensureOnX(tab);
    const script = `(async () => {
      let writeStarted = false;
      try {
        const getPrimary = () => document.querySelector('[data-testid="primaryColumn"]');
        const isBlockItem = (item) => {
          const text = String(item.textContent || ''), lower = text.toLowerCase();
          const isUnblock = lower.includes('unblock') || text.includes('取消屏蔽') || text.includes('解除屏蔽');
          const isBlock = (lower.includes('block') || text.includes('屏蔽')) && !isUnblock;
          return item.getAttribute('data-testid') === 'block' || isBlock;
        };
        let attempts = 0;
        while (attempts < 20) {
          const primary = getPrimary();
          if (!primary) return { ok: false, message: 'Could not find profile surface. Are you logged in?' };
          if (primary.querySelector('[data-testid$="-unblock"]')) return { ok: true, message: 'Already blocking @${username}.' };
          if (primary.querySelector('[data-testid="userActions"]')) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        const moreBtn = getPrimary()?.querySelector('[data-testid="userActions"]');
        if (!moreBtn) return { ok: false, message: 'Could not find user actions menu. Are you logged in?' };
        moreBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const blockItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(isBlockItem);
        if (!blockItem) return { ok: false, message: 'Could not find Block option in menu.' };
        blockItem.click();
        await new Promise(r => setTimeout(r, 1000));
        const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (!confirmBtn) return { ok: false, message: 'Block confirmation dialog did not appear.' };
        writeStarted = true;
        confirmBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        return getPrimary()?.querySelector('[data-testid$="-unblock"]') ? { ok: true, message: 'Blocked @${username}.' } : { ok: false, unconfirmed: true, message: 'Block initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, `https://x.com/${username}`, script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the profile before retrying; the block may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Block failed');
    return { ok: true, username, message: r.message };
  },
});
