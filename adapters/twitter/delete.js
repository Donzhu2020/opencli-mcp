import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, statusUrl, tweetIdFrom, buildTwitterArticleScopeSource, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Delete one of your own tweets.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'Tweet numeric ID or a full status URL' },
  ],
  async run({ tab, args }) {
    const id = tweetIdFrom(args.tweet_id);
    await ensureOnX(tab);
    const script = `(async () => {
      try {
        const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
        ${buildTwitterArticleScopeSource(id)}
        let targetArticle = findTargetArticle();
        for (let i = 0; i < 20 && !targetArticle; i++) { await new Promise(r => setTimeout(r, 250)); targetArticle = findTargetArticle(); }
        if (!targetArticle) return { ok: false, message: 'Could not find the tweet card matching the requested id.' };
        const belongs = (el) => el.closest('article') === targetArticle;
        const buttons = Array.from(targetArticle.querySelectorAll('button,[role="button"]')).filter(belongs);
        const moreMenu = Array.from(targetArticle.querySelectorAll('[data-testid="caret"]')).filter(belongs).find(visible)
          || buttons.find((el) => visible(el) && /^(More|更多)/.test((el.getAttribute('aria-label') || '').trim()));
        if (!moreMenu) return { ok: false, message: 'Could not find the "More" menu on the matched tweet. Are you logged in?' };
        const before = new Set(document.querySelectorAll('[role="menuitem"]'));
        moreMenu.click();
        await new Promise(r => setTimeout(r, 1000));
        const items = Array.from(document.querySelectorAll('[role="menuitem"]')).filter((it) => visible(it) && !before.has(it));
        const deleteBtn = items.find((it) => { const t = (it.textContent || '').trim(); return (t.includes('Delete') || t.includes('删除')) && !t.includes('List') && !t.includes('列表'); });
        if (!deleteBtn) return { ok: false, message: 'The tweet menu did not contain Delete. This tweet may not belong to you.' };
        deleteBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (!confirmBtn) return { ok: false, message: 'Delete confirmation dialog did not appear.' };
        confirmBtn.click();
        return { ok: true, message: 'Tweet deleted.' };
      } catch (e) { return { ok: false, message: String(e) }; }
    })()`;
    const r = await domRun(tab, statusUrl(id), script);
    if (!r?.ok) throw errors.upstream(r?.message || 'Delete failed');
    return { ok: true, id, message: r.message };
  },
});
