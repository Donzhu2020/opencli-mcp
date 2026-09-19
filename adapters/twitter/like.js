import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, statusUrl, tweetIdFrom, buildTwitterArticleScopeSource, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Like a tweet.',
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
        if (unlikeBtn) return { ok: true, message: 'Tweet is already liked.' };
        if (!likeBtn) return { ok: false, message: 'Could not find the Like button. Are you logged in?' };
        writeStarted = true;
        likeBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const verify = (findTargetArticle() || targetArticle)?.querySelector('[data-testid="unlike"]');
        return verify ? { ok: true, message: 'Tweet liked.' } : { ok: false, unconfirmed: true, message: 'Like initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, statusUrl(id), script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the tweet before retrying; the like may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Like failed');
    return { ok: true, id, message: r.message };
  },
});
