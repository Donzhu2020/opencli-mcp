import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX } from './_shared.js';
import { runListAdd } from './list-add.js';

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

function parseUsernames(raw) {
  const values = String(raw || '').split(',').map((p) => p.trim().replace(/^@/, '')).filter(Boolean);
  if (!values.length) throw errors.argument('At least one username is required');
  const seen = new Set();
  const out = [];
  for (const u of values) {
    if (!USERNAME_RE.test(u)) throw errors.argument(`Invalid X username: ${JSON.stringify(u)}`);
    if (!seen.has(u.toLowerCase())) { seen.add(u.toLowerCase()); out.push(u); }
  }
  return out;
}

function isGlobalFailure(e) {
  const c = e?.code;
  if (c === 'auth_required' || c === 'invalid_argument') return true;
  return /Invalid list_id|not found among your lists|Not logged into x\.com/i.test(e?.message || '');
}

export default defineAdapter({
  description: 'Add multiple users to an X list you own, from a comma-separated username list.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'list_id', type: 'string', required: true, help: 'Numeric ID of a list you own (from the `lists` command)' },
    { name: 'usernames', type: 'string', required: true, help: 'Comma-separated screen names to add (with or without @)' },
    { name: 'interval', type: 'int', default: 5, help: 'Seconds to wait between additions' },
  ],
  async run({ tab, args }) {
    const listId = String(args.list_id || '').trim();
    const usernames = parseUsernames(args.usernames);
    const interval = Math.max(0, Math.min(600, Number(args.interval) || 5));
    await ensureOnX(tab);
    const rows = [];
    for (let i = 0; i < usernames.length; i++) {
      try { rows.push(await runListAdd(tab, listId, usernames[i])); }
      catch (e) { if (isGlobalFailure(e)) throw e; rows.push({ list_id: listId, username: usernames[i], user_id: '', status: 'failed', message: e?.message || String(e) }); }
      if (i < usernames.length - 1 && interval > 0) await tab.evaluate(`new Promise(r=>setTimeout(r,${interval * 1000}))`).catch(() => {});
    }
    return rows;
  },
});
