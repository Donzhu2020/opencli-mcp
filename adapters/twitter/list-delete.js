import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, fetchManagedLists, domRun } from './_shared.js';

export default defineAdapter({
  description: 'Delete an X list you own.',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'list_id', type: 'string', required: true, help: 'Numeric ID of a list you own (from the `lists` command)' },
  ],
  async run({ tab, args }) {
    const listId = String(args.list_id || '').trim();
    if (!/^\d+$/.test(listId)) throw errors.argument('list_id must be a numeric ID');
    await ensureOnX(tab);
    const before = await fetchManagedLists(tab);
    const target = before.find((l) => l.id === listId);
    if (!target) throw errors.upstream(`List ${listId} not found among your lists (${before.length} fetched).`);
    const script = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const visible = (el) => !!el && el.offsetParent !== null;
      const btnText = (el) => (el.innerText || el.textContent || '').trim();
      const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(200); } return null; };
      const findButton = (text) => Array.from(document.querySelectorAll('button, [role="button"]')).find((el) => visible(el) && btnText(el).toLowerCase() === text.toLowerCase());
      const editLink = Array.from(document.querySelectorAll('a[href$="/info"]')).find((el) => visible(el) && /edit list/i.test(el.innerText || el.textContent || ''));
      if (!editLink) return { ok: false, message: 'Edit List link not found' };
      editLink.click();
      if (!await waitFor(() => document.querySelector('[role="dialog"]'))) return { ok: false, message: 'Edit List dialog did not open' };
      const deleteButton = findButton('Delete List');
      if (!deleteButton) return { ok: false, message: 'Delete List button not found' };
      deleteButton.click(); await sleep(800);
      const confirmButton = document.querySelector('[data-testid="confirmationSheetConfirm"]') || findButton('Delete');
      if (!confirmButton) return { ok: false, message: 'Delete confirmation button not found' };
      confirmButton.click(); await sleep(2500);
      return { ok: true };
    })()`;
    const r = await domRun(tab, `https://x.com/i/lists/${listId}`, script);
    if (!r?.ok) throw errors.upstream(`Failed to delete list ${listId}: ${r?.message || 'unknown UI failure'}`);
    const after = await fetchManagedLists(tab);
    if (after.some((l) => l.id === listId)) throw errors.upstream(`Failed to delete list ${listId}: it still appears in your lists.`);
    return { ok: true, list_id: listId, name: target.name, members: String(target.members ?? '0'), message: `Deleted list ${target.name} (${target.members ?? '0'} members)` };
  },
});
