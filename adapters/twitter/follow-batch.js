import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, domRun, domEval } from './_shared.js';

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

function parseUsernames(input) {
  const raw = String(input || '').trim();
  if (!raw) throw errors.argument('At least one X username is required');
  const seen = new Set();
  const out = [];
  for (const part of raw.split(',')) {
    const u = part.trim().replace(/^@+/, '');
    if (!u) continue;
    if (!USERNAME_RE.test(u)) throw errors.argument(`Invalid X username: ${JSON.stringify(part.trim())}`);
    const key = u.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(u); }
  }
  if (!out.length) throw errors.argument('At least one X username is required');
  return out;
}

const readState = (username) => `(async () => {
  try {
    for (let i = 0; i < 20; i++) {
      if (document.querySelector('[data-testid$="-unfollow"]')) return { ok: true, status: 'noop', message: 'Already following @${username}.' };
      if (document.querySelector('[data-testid$="-follow"]')) return { ok: false, followButtonVisible: true };
      await new Promise(r => setTimeout(r, 500));
    }
    return { ok: false, followButtonVisible: false };
  } catch (e) { return { ok: false, message: String(e) }; }
})()`;

const clickFollow = (username) => `(async () => {
  try {
    const b = document.querySelector('[data-testid$="-follow"]');
    if (!b) return { ok: false, message: 'Could not find Follow button after loading profile.' };
    b.click();
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); if (document.querySelector('[data-testid$="-unfollow"]')) return { ok: true, status: 'success', message: 'Followed @${username}.' }; }
    return { ok: false, message: 'Follow initiated but UI did not update.' };
  } catch (e) { return { ok: false, message: String(e) }; }
})()`;

export default defineAdapter({
  description: 'Follow multiple X users from a comma-separated username list.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'usernames', type: 'string', required: true, help: 'Comma-separated screen names, with or without @' },
    { name: 'delay_ms', type: 'int', default: 3000, help: 'Delay between follow attempts, in milliseconds' },
  ],
  async run({ tab, args }) {
    const usernames = parseUsernames(args.usernames);
    const delayMs = Math.max(0, Math.min(60000, Number(args.delay_ms) || 3000));
    await ensureOnX(tab);
    const rows = [];
    for (const [index, username] of usernames.entries()) {
      if (index > 0 && delayMs > 0) await tab.evaluate(`new Promise(r=>setTimeout(r,${delayMs}))`).catch(() => {});
      let r = await domRun(tab, `https://x.com/${username}`, readState(username));
      if (!r.ok && r.followButtonVisible) r = await domEval(tab, clickFollow(username));
      rows.push({ username, status: r.ok ? (r.status || 'success') : 'failed', message: r.message || 'Could not follow (are you logged in?)' });
    }
    return rows;
  },
});
