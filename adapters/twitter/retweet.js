import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, statusUrl, tweetIdFrom, buildTwitterArticleScopeSource, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Retweet a tweet.',
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
        let attempts = 0, retweetBtn = null, unretweetBtn = null, targetArticle = null;
        while (attempts < 20) {
          targetArticle = findTargetArticle();
          unretweetBtn = targetArticle?.querySelector('[data-testid="unretweet"]') || null;
          retweetBtn = targetArticle?.querySelector('[data-testid="retweet"]') || null;
          if (unretweetBtn || retweetBtn) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        if (unretweetBtn) return { ok: true, message: 'Tweet is already retweeted.' };
        if (!retweetBtn) return { ok: false, message: 'Could not find the Retweet button. Are you logged in?' };
        retweetBtn.click();
        let confirmBtn = null;
        for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 250)); confirmBtn = document.querySelector('[data-testid="retweetConfirm"]'); if (confirmBtn) break; }
        if (!confirmBtn) return { ok: false, message: 'Retweet menu opened but the confirm option did not appear.' };
        writeStarted = true;
        confirmBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const verify = (findTargetArticle() || targetArticle)?.querySelector('[data-testid="unretweet"]');
        return verify ? { ok: true, message: 'Tweet retweeted.' } : { ok: false, unconfirmed: true, message: 'Retweet initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, statusUrl(id), script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the tweet before retrying; the retweet may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Retweet failed');
    return { ok: true, id, message: r.message };
  },
});
