import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, statusUrl, tweetIdFrom, buildTwitterArticleScopeSource, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Remove a tweet from your bookmarks.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'Tweet numeric ID or a full status URL' },
  ],
  async run({ tab, args }) {
    const id = tweetIdFrom(args.tweet_id);
    await ensureOnX(tab);
    const script = `(async () => {
      let writeStarted = false;
      try {
        ${buildTwitterArticleScopeSource(id)}
        let attempts = 0, removeBtn = null, targetArticle = null;
        while (attempts < 20) {
          targetArticle = findTargetArticle();
          if (targetArticle?.querySelector('[data-testid="bookmark"]')) return { ok: true, message: 'Tweet is not bookmarked (already removed).' };
          removeBtn = targetArticle?.querySelector('[data-testid="removeBookmark"]') || null;
          if (removeBtn) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        if (!removeBtn) return { ok: false, message: 'Could not find Remove Bookmark button. Are you logged in?' };
        writeStarted = true;
        removeBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const verify = (findTargetArticle() || targetArticle)?.querySelector('[data-testid="bookmark"]');
        return verify ? { ok: true, message: 'Removed from bookmarks.' } : { ok: false, unconfirmed: true, message: 'Unbookmark initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, statusUrl(id), script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the tweet before retrying; the removal may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Unbookmark failed');
    return { ok: true, id, message: r.message };
  },
});
