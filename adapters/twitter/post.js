import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, resolveLocalImages, attachComposerImages, insertComposerText, submitComposer } from './_shared.js';

export default defineAdapter({
  description: 'Post a new tweet, optionally with up to 4 local images.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'text', type: 'string', required: true, help: 'The text of the tweet' },
    { name: 'images', type: 'string', help: 'Local image paths, comma-separated, max 4 (jpg/png/gif/webp)' },
  ],
  async run({ tab, args }) {
    const text = String(args.text ?? '');
    const files = args.images ? resolveLocalImages(args.images) : [];
    await ensureOnX(tab);
    await tab.goto('https://x.com/compose/post', { waitUntil: 'load', settleMs: 2500 });
    if (files.length) {
      const up = await attachComposerImages(tab, files);
      if (!up?.ok) throw errors.upstream(up?.message || 'Image upload failed. Nothing was posted.');
    }
    const typed = await insertComposerText(tab, text);
    if (!typed?.ok) throw errors.upstream(typed?.message || 'Could not type tweet text.');
    const r = await submitComposer(tab, text);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check your recent tweets before retrying; the post may already be live.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Tweet failed to post.');
    return { ok: true, message: r.message, text, ...(r.id && { id: r.id }), ...(r.url && { url: r.url }) };
  },
});
