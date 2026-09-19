import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, statusUrl, tweetIdFrom, buildTwitterArticleScopeSource, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Bookmark a tweet.',
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
        let attempts = 0, bookmarkBtn = null, targetArticle = null;
        while (attempts < 20) {
          targetArticle = findTargetArticle();
          if (targetArticle?.querySelector('[data-testid="removeBookmark"]')) return { ok: true, message: 'Tweet is already bookmarked.' };
          bookmarkBtn = targetArticle?.querySelector('[data-testid="bookmark"]') || null;
          if (bookmarkBtn) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        if (!bookmarkBtn) return { ok: false, message: 'Could not find Bookmark button. Are you logged in?' };
        writeStarted = true;
        bookmarkBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const verify = (findTargetArticle() || targetArticle)?.querySelector('[data-testid="removeBookmark"]');
        return verify ? { ok: true, message: 'Tweet bookmarked.' } : { ok: false, unconfirmed: true, message: 'Bookmark initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, statusUrl(id), script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the tweet before retrying; the bookmark may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Bookmark failed');
    return { ok: true, id, message: r.message };
  },
});
