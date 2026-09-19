import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, resolveUserId, normalizeScreenName, fetchManagedLists, domRun } from './_shared.js';

/** Remove one user from a list via the profile "Add/remove from Lists" dialog. Also used by list-remove-batch. */
export async function runListRemove(tab, listId, rawUsername) {
  const username = String(rawUsername || '').replace(/^@/, '').trim();
  if (!/^\d+$/.test(String(listId))) throw errors.argument(`Invalid list_id: ${JSON.stringify(listId)}. Expected a numeric ID.`);
  if (!username || !normalizeScreenName(username)) throw errors.argument('username is required');
  const userId = await resolveUserId(tab, username);
  const lists = await fetchManagedLists(tab);
  const target = lists.find((l) => l.id === listId);
  if (!target) throw errors.upstream(`List ${listId} not found among your lists.`);
  const memberCountBefore = Number(target.members) || 0;
  const script = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findOne = (sel, root = document) => root.querySelector(sel);
    const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(200); } return null; };
    try {
      const caret = await waitFor(() => findOne('[data-testid="userActions"]'));
      if (!caret) return { ok: false, message: 'Could not find user actions (…) button' };
      caret.click(); await sleep(600);
      const addToList = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => /add\\/remove|从列表|列表|add to list|add or remove/i.test(el.innerText));
      if (!addToList) return { ok: false, message: 'Could not find "Add/remove from Lists" menu item' };
      addToList.click(); await sleep(1200);
      const dialog = await waitFor(() => findOne('[role="dialog"]'));
      if (!dialog) return { ok: false, message: 'List selection dialog did not open' };
      const targetName = ${JSON.stringify(target.name)};
      let scrollEl = [dialog.querySelector('[data-viewportview="true"]'), ...Array.from(dialog.querySelectorAll('div')).filter((d) => d.scrollHeight > d.clientHeight + 10)].filter(Boolean)[0] || dialog;
      let row = null, lastTop = -1;
      for (let i = 0; i < 12; i++) {
        row = Array.from(dialog.querySelectorAll('[data-testid="cellInnerDiv"]')).find((c) => (c.innerText || '').split('\\n')[0].trim() === targetName);
        if (row) break;
        const prev = scrollEl.scrollTop; scrollEl.scrollTop = prev + Math.max(200, scrollEl.clientHeight - 100);
        if (scrollEl.scrollTop === prev && scrollEl.scrollTop === lastTop) break;
        lastTop = scrollEl.scrollTop; await sleep(500);
      }
      if (!row) return { ok: false, message: 'List "' + targetName + '" not found in dialog.' };
      const listCell = row.querySelector('[data-testid="listCell"]') || row.querySelector('[role="checkbox"]') || row;
      const read = () => { const v = listCell.getAttribute('aria-checked'); return v === 'true' || v === 'false' ? v : null; };
      await sleep(600);
      let aria = read();
      for (let i = 0; i < 8; i++) { await sleep(500); const n = read(); if (n && n === aria) break; aria = n || aria; }
      if (aria !== 'true') { const close = findOne('[data-testid="app-bar-close"]') || findOne('[aria-label="Close"]'); if (close) close.click(); return { ok: true, noop: true }; }
      try { listCell.scrollIntoView({ block: 'center' }); } catch {}
      await sleep(400);
      const rowRect = listCell.getBoundingClientRect();
      const saveButton = Array.from(dialog.querySelectorAll('[role="button"], button')).find((b) => /^(Save|Done|保存|完成|儲存)$/i.test((b.innerText || '').trim()));
      const saveRect = saveButton ? saveButton.getBoundingClientRect() : null;
      return { ok: true, needsNativeInteraction: true, rowClickX: Math.round(rowRect.left + rowRect.width / 2), rowClickY: Math.round(rowRect.top + rowRect.height / 2), saveClickX: saveRect ? Math.round(saveRect.left + saveRect.width / 2) : null, saveClickY: saveRect ? Math.round(saveRect.top + saveRect.height / 2) : null };
    } catch (e) { return { ok: false, message: 'UI error: ' + String(e?.message || e) }; }
  })()`;
  const ui = await domRun(tab, `https://x.com/${username}`, script);
  if (!ui?.ok) throw errors.upstream(`Failed to remove @${username} from list ${listId}: ${ui?.message}`);
  if (ui.noop) return { list_id: listId, username, user_id: String(userId), status: 'noop', message: `@${username} was not a member of list ${listId}` };
  if (ui.needsNativeInteraction) {
    if (!ui.saveClickX) throw errors.upstream('Save button not found in dialog.');
    await tab.act({ action: 'click', target: { x: ui.rowClickX, y: ui.rowClickY } });
    await tab.evaluate('new Promise(r=>setTimeout(r,800))').catch(() => {});
    await tab.act({ action: 'click', target: { x: ui.saveClickX, y: ui.saveClickY } });
    await tab.evaluate('new Promise(r=>setTimeout(r,3500))').catch(() => {});
    const after = await fetchManagedLists(tab);
    const afterList = after.find((l) => l.id === listId);
    const memberCountAfter = Number(afterList?.members) || 0;
    if (!afterList || memberCountAfter >= memberCountBefore) throw errors.upstream(`Failed to remove @${username} from list ${listId}: member_count unchanged (${memberCountBefore} -> ${memberCountAfter}).`);
    return { list_id: listId, username, user_id: String(userId), status: 'success', message: `Removed @${username} from list ${listId} (member_count ${memberCountBefore} -> ${memberCountAfter})` };
  }
  return { list_id: listId, username, user_id: String(userId), status: 'success', message: `Removed @${username} from list ${listId}` };
}

export default defineAdapter({
  description: 'Remove a user from an X list you own (no-op if not currently a member).',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'list_id', type: 'string', required: true, help: 'Numeric ID of a list you own (from the `lists` command)' },
    { name: 'username', type: 'string', required: true, help: 'Screen name to remove (with or without @)' },
  ],
  async run({ tab, args }) {
    await ensureOnX(tab);
    return runListRemove(tab, String(args.list_id || '').trim(), args.username);
  },
});
