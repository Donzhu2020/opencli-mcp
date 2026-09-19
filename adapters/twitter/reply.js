import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, tweetIdFrom, statusUrl, resolveLocalImages, downloadRemoteImage, attachComposerImages, insertComposerText, submitComposer, domEval } from './_shared.js';

export default defineAdapter({
  description: 'Reply to a tweet, optionally with a local image or a remote image URL.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'Numeric ID or full status URL of the tweet to reply to' },
    { name: 'text', type: 'string', required: true, help: 'The text of your reply' },
    { name: 'image', type: 'string', help: 'Optional local image path to attach' },
    { name: 'image_url', type: 'string', help: 'Optional remote image URL to attach' },
  ],
  async run({ tab, args }) {
    if (args.image && args.image_url) throw errors.argument('Provide either image or image_url, not both');
    const id = tweetIdFrom(args.tweet_id);
    const text = String(args.text ?? '');
    const files = args.image ? resolveLocalImages(args.image, 1) : (args.image_url ? [await downloadRemoteImage(args.image_url)] : []);
    await ensureOnX(tab);
    await tab.goto(`https://x.com/compose/post?in_reply_to=${id}`, { waitUntil: 'load', settleMs: 2500 });
    // Fallback: if the standalone composer did not render, open the tweet page and click its reply action.
    let hasComposer = await domEval(tab, `!!document.querySelector('[data-testid="tweetTextarea_0"]')`);
    if (!hasComposer) {
      await tab.goto(statusUrl(id), { waitUntil: 'load', settleMs: 2500 });
      await domEval(tab, `(() => { const b = Array.from(document.querySelectorAll('[data-testid="reply"]')).find((el) => el.offsetParent !== null); if (b) b.click(); return true; })()`);
      await tab.evaluate('new Promise(r=>setTimeout(r,1500))').catch(() => {});
      hasComposer = await domEval(tab, `!!document.querySelector('[data-testid="tweetTextarea_0"]')`);
    }
    if (!hasComposer) throw errors.upstream('Could not open the reply composer.');
    if (files.length) {
      const up = await attachComposerImages(tab, files);
      if (!up?.ok) throw errors.upstream(up?.message || 'Image upload failed. Nothing was posted.');
    }
    const typed = await insertComposerText(tab, text);
    if (!typed?.ok) throw errors.upstream(typed?.message || 'Could not type reply text.');
    const r = await submitComposer(tab, text);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the tweet before retrying; the reply may already be live.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Reply failed to post.');
    return { ok: true, message: r.message, in_reply_to: id, text, ...(r.id && { id: r.id }), ...(r.url && { url: r.url }) };
  },
});
