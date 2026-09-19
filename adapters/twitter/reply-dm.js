import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, domRun, domEval } from './_shared.js';

export default defineAdapter({
  description: 'Send the same message to your recent DM conversations (batch).',
  access: 'write',
  domain: 'x.com',
  args: [
    { name: 'text', type: 'string', required: true, help: 'Message text to send' },
    { name: 'max', type: 'int', default: 20, help: 'Maximum number of conversations to reply to' },
    { name: 'skip_replied', type: 'boolean', default: true, help: 'Skip conversations where you already sent the same text' },
  ],
  async run({ tab, args }) {
    const messageText = String(args.text ?? '');
    if (!messageText) throw errors.argument('text cannot be empty');
    const maxSend = Math.max(1, Number(args.max) || 20);
    const skipReplied = args.skip_replied !== false;
    await ensureOnX(tab);
    const needed = maxSend + 10;
    const convList = await domRun(tab, 'https://x.com/messages', `(async () => {
      try {
        let attempts = 0;
        while (attempts < 10) { if (document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]').length) break; await new Promise(r => setTimeout(r, 1000)); attempts++; }
        const needed = ${needed};
        const seen = new Set(); let noNew = 0;
        for (let s = 0; s < 30; s++) {
          const items = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]'));
          items.forEach((el) => seen.add(el.getAttribute('data-testid')));
          if (seen.size >= needed) break;
          const sc = document.querySelector('[data-testid="dm-inbox-panel"]') || items[items.length - 1]?.closest('[class*="scroll"]') || items[items.length - 1]?.parentElement;
          if (sc) sc.scrollTop = sc.scrollHeight;
          if (items.length) items[items.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
          await new Promise(r => setTimeout(r, 1500));
          const newIds = new Set(Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]')).map((el) => el.getAttribute('data-testid')));
          if (newIds.size <= seen.size) { noNew++; if (noNew >= 3) break; } else noNew = 0;
        }
        const finalItems = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]'));
        const conversations = finalItems.map((item, idx) => {
          const testId = item.getAttribute('data-testid') || '';
          const text = item.innerText || '';
          const user = text.split('\\n').filter((l) => l.trim())[0] || 'Unknown';
          const match = testId.match(/dm-conversation-item-(.+)/);
          const convId = match ? match[1].replace(':', '-') : '';
          const link = item.querySelector('a[href*="/messages/"]');
          return { idx, user, convId, href: link ? link.href : '' };
        });
        return { ok: true, conversations };
      } catch (e) { return { ok: false, error: String(e), conversations: [] }; }
    })()`);
    if (!convList?.ok || !convList.conversations?.length) return [{ index: 1, status: 'info', user: 'System', message: 'No conversations found' }];
    const results = [];
    let sent = 0;
    for (const conv of convList.conversations) {
      if (sent >= maxSend) break;
      const convUrl = conv.convId ? `https://x.com/messages/${conv.convId}` : conv.href;
      if (!convUrl) continue;
      const res = await domRun(tab, convUrl, `(async () => {
        try {
          const messageText = ${JSON.stringify(messageText)};
          const skipReplied = ${skipReplied};
          const dmHeader = document.querySelector('[data-testid="DmActivityContainer"] [dir="ltr"] span') || document.querySelector('[data-testid="conversation-header"]') || document.querySelector('[data-testid="DmActivityContainer"] h2');
          const username = dmHeader ? dmHeader.innerText.trim().split('\\n')[0] : ${JSON.stringify(conv.user)};
          if (skipReplied) { const chat = document.querySelector('[data-testid="DmScrollerContainer"]') || document.querySelector('main'); if (chat && (chat.innerText || '').includes(messageText)) return { status: 'skipped', user: username, message: 'Already sent this message' }; }
          const input = document.querySelector('[data-testid="dmComposerTextInput"]');
          if (!input) return { status: 'error', user: username, message: 'No message input found' };
          input.focus(); await new Promise(r => setTimeout(r, 300));
          document.execCommand('insertText', false, messageText); await new Promise(r => setTimeout(r, 500));
          const sendBtn = document.querySelector('[data-testid="dmComposerSendButton"]');
          if (!sendBtn) return { status: 'error', user: username, message: 'No send button found' };
          sendBtn.click(); await new Promise(r => setTimeout(r, 1500));
          return { status: 'sent', user: username, message: 'Message sent: ' + messageText };
        } catch (e) { return { status: 'error', user: 'system', message: String(e) }; }
      })()`);
      if (res?.status === 'sent') { sent++; results.push({ index: sent, status: 'sent', user: res.user || conv.user, message: res.message }); }
      else if (res?.status === 'skipped') results.push({ index: results.length + 1, status: 'skipped', user: res.user || conv.user, message: res.message });
    }
    if (!results.length) results.push({ index: 0, status: 'info', user: 'System', message: 'No conversations processed' });
    return results;
  },
});
