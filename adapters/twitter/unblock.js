import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, normalizeScreenName, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Unblock an X user.',
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
        const getPrimary = () => document.querySelector('[data-testid="primaryColumn"]');
        let attempts = 0, unblockBtn = null;
        while (attempts < 20) {
          const primary = getPrimary();
          if (!primary) return { ok: false, message: 'Could not find profile surface. Are you logged in?' };
          if (primary.querySelector('[data-testid$="-follow"]')) return { ok: true, message: 'Not blocking @${username} (already unblocked).' };
          unblockBtn = primary.querySelector('[data-testid$="-unblock"]');
          if (unblockBtn) break;
          await new Promise(r => setTimeout(r, 500)); attempts++;
        }
        if (!unblockBtn) return { ok: false, message: 'Could not find Unblock button. Are you logged in?' };
        unblockBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (!confirmBtn) return { ok: false, message: 'Unblock confirmation dialog did not appear.' };
        writeStarted = true;
        confirmBtn.click();
        await new Promise(r => setTimeout(r, 1000));
        return getPrimary()?.querySelector('[data-testid$="-follow"]') ? { ok: true, message: 'Unblocked @${username}.' } : { ok: false, unconfirmed: true, message: 'Unblock initiated but UI did not update.' };
      } catch (e) { return { ok: false, unconfirmed: writeStarted, message: String(e) }; }
    })()`;
    const r = await domRun(tab, `https://x.com/${username}`, script);
    if (r?.unconfirmed) throw errors.upstream(`${r.message} Check the profile before retrying; the unblock may already have succeeded.`);
    if (!r?.ok) throw errors.upstream(r?.message || 'Unblock failed');
    return { ok: true, username, message: r.message };
  },
});
