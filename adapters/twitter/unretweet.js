import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, statusUrl, tweetIdFrom, buildTwitterArticleScopeSource, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Undo a retweet.',
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
          retweetBtn = targetArticle?.querySelector('[data-testid="retweet"]') || null;
          unretweetBtn = targetArticle?.querySelector('[data-testid="unretweet"]') || null;
          if (retweetBtn || unretweetBtn) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        if (retweetBtn) return { ok: true, message: 'Tweet is not retweeted (already removed).' };
        if (!unretweetBtn) return { ok: false, message: 'Could not find the Unretweet button. Are you logged in?' };
        unretweetBtn.click();
        let confirmBtn = null;
        for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 250)); confirmBtn = document.querySelector('[data-testid="unretweetConfirm"]'); if (confirmBtn) break; }
        if (!confirmBtn) return { ok: false, message: 'Unretweet menu opened but the confirm option did not appear.' };
        writeStarted = true;
        confirmBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const verify = (findTargetArticle() || targetArticle)?.querySelector('[data-testid="retweet"]');
        return verify ? { ok: true, message: 'Retweet removed.' } : { ok: false, unconfirmed: true, message: 'Unretweet initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, statusUrl(id), script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the tweet before retrying; the removal may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Unretweet failed');
    return { ok: true, id, message: r.message };
  },
});
