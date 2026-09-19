import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, normalizeScreenName, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Follow an X user.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'username', type: 'string', required: true, help: 'Screen name (with or without @)' },
  ],
  async run({ tab, args }) {
    const username = normalizeScreenName(String(args.username || '').trim());
    if (!username) throw errors.argument('username must be a valid X handle');
    await ensureOnX(tab);
    const script = `(async () => {
      let writeStarted = false;
      try {
        let attempts = 0, followBtn = null;
        while (attempts < 20) {
          if (document.querySelector('[data-testid$="-unfollow"]')) return { ok: true, message: 'Already following @${username}.' };
          followBtn = document.querySelector('[data-testid$="-follow"]');
          if (followBtn) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        if (!followBtn) return { ok: false, message: 'Could not find Follow button. Are you logged in?' };
        writeStarted = true;
        followBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        return document.querySelector('[data-testid$="-unfollow"]') ? { ok: true, message: 'Followed @${username}.' } : { ok: false, unconfirmed: true, message: 'Follow initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, `https://x.com/${username}`, script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the profile before retrying; the follow may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Follow failed');
    return { ok: true, username, message: r.message };
  },
});
