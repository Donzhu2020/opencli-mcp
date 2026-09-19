import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, statusUrl, tweetIdFrom, buildTwitterArticleScopeSource, domRun, domEval } from './_shared.js';

function buildScript(id, allowParentDiscovery) {
  return `(async () => {
    try {
      ${buildTwitterArticleScopeSource(id)}
      const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
      const moreLabels = new Set(['More', '更多']);
      const findParentConversationUrl = (targetArticle) => {
        const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
        const articles = Array.from(primary.querySelectorAll('article'));
        const idx = articles.indexOf(targetArticle);
        if (idx <= 0) return null;
        for (let i = idx - 1; i >= 0; i--) {
          for (const link of Array.from(articles[i].querySelectorAll('a[href*="/status/"]')).filter((l) => l.querySelector('time'))) {
            const sid = __twGetStatusIdFromHref(link.href);
            if (sid && sid !== tweetId) { const p = new URL(link.href, window.location.origin); if (p.origin === window.location.origin) return p.toString(); }
          }
        }
        return null;
      };
      let attempts = 0, targetArticle = null, moreMenu = null;
      while (attempts < 20) {
        targetArticle = findTargetArticle();
        if (targetArticle) {
          moreMenu = Array.from(targetArticle.querySelectorAll('button,[role="button"]')).find((el) => visible(el) && moreLabels.has((el.getAttribute('aria-label') || '').trim()));
          if (moreMenu) break;
        }
        await new Promise(r => setTimeout(r, 500)); attempts++;
      }
      if (!targetArticle) return { ok: false, message: 'Could not find the requested reply on this page.' };
      if (!moreMenu) return { ok: false, message: 'Could not find the "More" menu on the requested reply. Are you logged in?' };
      moreMenu.click();
      await new Promise(r => setTimeout(r, 1000));
      let hideItem = null;
      for (const item of document.querySelectorAll('[role="menuitem"]')) {
        const text = String(item.textContent || ''), testId = item.getAttribute('data-testid');
        if (testId === 'hideReply' || text.includes('Hide reply') || text.includes('隐藏回复') || (text.includes('隐藏') && text.includes('回复') && !text.includes('取消'))) { hideItem = item; break; }
      }
      if (!hideItem) {
        if (${allowParentDiscovery ? 'true' : 'false'}) { const parentUrl = findParentConversationUrl(targetArticle); if (parentUrl) return { ok: false, retryOnParent: true, parentUrl, message: 'Hide option missing on standalone page; retrying in parent conversation.' }; }
        return { ok: false, message: 'Could not find "Hide reply" option. This may not be a reply on your tweet.' };
      }
      hideItem.click();
      await new Promise(r => setTimeout(r, 1500));
      return { ok: true, message: 'Reply hidden.' };
    } catch (e) { return { ok: false, message: String(e) }; }
  })()`;
}

export default defineAdapter({
  description: 'Hide a reply on your tweet (useful for hiding bot/spam replies).',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'Numeric ID or full status URL of the reply to hide' },
  ],
  async run({ tab, args }) {
    const id = tweetIdFrom(args.tweet_id);
    await ensureOnX(tab);
    let r = await domRun(tab, statusUrl(id), buildScript(id, true));
    if (r?.retryOnParent && r.parentUrl) {
      await tab.goto(r.parentUrl, { waitUntil: 'load', settleMs: 1500 });
      r = await domEval(tab, buildScript(id, false));
    }
    if (!r?.ok) throw errors.upstream(r?.message || 'Hide reply failed');
    return { ok: true, id, message: r.message };
  },
});
