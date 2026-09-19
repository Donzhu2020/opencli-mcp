import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, statusUrl, tweetIdFrom, buildTwitterArticleScopeSource, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Remove your like from a tweet.',
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
        let attempts = 0, likeBtn = null, unlikeBtn = null, targetArticle = null;
        while (attempts < 20) {
          targetArticle = findTargetArticle();
          likeBtn = targetArticle?.querySelector('[data-testid="like"]') || null;
          unlikeBtn = targetArticle?.querySelector('[data-testid="unlike"]') || null;
          if (likeBtn || unlikeBtn) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        if (likeBtn) return { ok: true, message: 'Tweet is not liked (already unliked).' };
        if (!unlikeBtn) return { ok: false, message: 'Could not find the Unlike button. Are you logged in?' };
        writeStarted = true;
        unlikeBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const verify = (findTargetArticle() || targetArticle)?.querySelector('[data-testid="like"]');
        return verify ? { ok: true, message: 'Tweet unliked.' } : { ok: false, unconfirmed: true, message: 'Unlike initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, statusUrl(id), script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the tweet before retrying; the unlike may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Unlike failed');
    return { ok: true, id, message: r.message };
  },
});
