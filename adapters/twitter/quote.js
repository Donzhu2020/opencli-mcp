import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, parseTweetUrl, resolveLocalImages, downloadRemoteImage, attachComposerImages, insertComposerText, submitComposer, buildTwitterArticleScopeSource, domEval } from './_shared.js';

export default defineAdapter({
  description: 'Quote-tweet a tweet with your own commentary, optionally with a local image or a remote image URL.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'tweet_id', type: 'string', required: true, help: 'Full status URL (or numeric ID) of the tweet to quote' },
    { name: 'text', type: 'string', required: true, help: 'The text of your quote' },
    { name: 'image', type: 'string', help: 'Optional local image path to attach' },
    { name: 'image_url', type: 'string', help: 'Optional remote image URL to attach' },
  ],
  async run({ tab, args }) {
    if (args.image && args.image_url) throw errors.argument('Provide either image or image_url, not both');
    const input = String(args.tweet_id || '').trim();
    const target = /^\d+$/.test(input) ? { id: input, url: `https://x.com/i/status/${input}` } : parseTweetUrl(input);
    const text = String(args.text ?? '');
    const files = args.image ? resolveLocalImages(args.image, 1) : (args.image_url ? [await downloadRemoteImage(args.image_url)] : []);
    await ensureOnX(tab);
    await tab.goto(`https://x.com/compose/post?url=${encodeURIComponent(target.url)}`, { waitUntil: 'load', settleMs: 2500 });
    // Confirm the quoted card actually attached before posting (else we'd post a plain tweet).
    const cardOk = await domEval(tab, `(async () => {
      ${buildTwitterArticleScopeSource(target.id)}
      for (let i = 0; i < 20; i++) { if (__twHasLinkToTarget(document)) return true; await new Promise(r => setTimeout(r, 250)); }
      return false;
    })()`);
    if (!cardOk) throw errors.upstream('Quote target did not render in the composer. The source tweet may be deleted or restricted.');
    if (files.length) {
      const up = await attachComposerImages(tab, files);
      if (!up?.ok) throw errors.upstream(up?.message || 'Image upload failed. Nothing was posted.');
    }
    const typed = await insertComposerText(tab, text);
    if (!typed?.ok) throw errors.upstream(typed?.message || 'Could not type quote text.');
    const r = await submitComposer(tab, text);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check your profile before retrying; the quote may already be live.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Quote tweet failed to post.');
    return { ok: true, message: r.message, quoted: target.id, text, ...(r.id && { id: r.id }), ...(r.url && { url: r.url }) };
  },
});
