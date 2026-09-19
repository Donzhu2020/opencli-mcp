import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, normalizeScreenName, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Unfollow an X user.',
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
        let attempts = 0, unfollowBtn = null;
        while (attempts < 20) {
          if (document.querySelector('[data-testid$="-follow"]')) return { ok: true, message: 'Not following @${username} (already unfollowed).' };
          unfollowBtn = document.querySelector('[data-testid$="-unfollow"]');
          if (unfollowBtn) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        if (!unfollowBtn) return { ok: false, message: 'Could not find Unfollow button. Are you logged in?' };
        unfollowBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (!confirmBtn) return { ok: false, message: 'Unfollow confirmation dialog did not appear.' };
        writeStarted = true;
        confirmBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        return document.querySelector('[data-testid$="-follow"]') ? { ok: true, message: 'Unfollowed @${username}.' } : { ok: false, unconfirmed: true, message: 'Unfollow initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, `https://x.com/${username}`, script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the profile before retrying; the unfollow may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Unfollow failed');
    return { ok: true, username, message: r.message };
  },
});
