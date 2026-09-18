// Live-browser end-to-end: goes through the stdio launcher, which proxies to the Chrome-spawned host.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/src/main.js', 'stdio'], stderr: 'pipe' });
transport.stderr?.on('data', (d) => process.stderr.write(`  [launcher] ${d}`));
const client = new Client({ name: 'smoke-browser', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const images = (r) => r.content.filter((c) => c.type === 'image');
let failures = 0;
const call = async (name, args = {}, { expectError = false, show = 500 } = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const s = text(r);
  const bad = Boolean(r.isError) !== expectError;
  if (bad) failures++;
  console.log(`\n▶ ${name} ${JSON.stringify(args).slice(0, 160)} → ${r.isError ? 'ERROR' : 'ok'}${images(r).length ? ` +${images(r).length} image` : ''}${bad ? '   <<< UNEXPECTED' : ''}\n${s.slice(0, show)}${s.length > show ? '…' : ''}`);
  return { r, s, json: (() => { try { return JSON.parse(s); } catch { return null; } })() };
};

await call('doctor');
await call('session_name', { name: '🔎 opencli-mcp e2e' });
const opened = await call('tab_open', { url: 'https://example.com/' }, { show: 900 });
const tab = opened.json?.tab;
console.log('tab id =', tab);
await call('tab_find', { tab, target: { role: 'link' } });
await call('tab_act', { tab, action: 'click', target: { role: 'link' } /* example.com's only link; its text drifted from 'More information' to 'Learn more' */, observe: true }, { show: 700 });
await call('tab_wait', { tab, url: 'iana.org', timeout: 20 });
await call('tab_observe', { tab, mode: 'state' }, { show: 400 });
await call('tab_screenshot', { tab, annotate: true }, { show: 120 });
await call('tab_evaluate', { tab, js: 'document.title' });
await call('tab_evaluate', { tab, js: 'document.querySelector("a").click()' }, { expectError: true, show: 200 });
await call('tab_act', { tab, action: 'click', target: { text: 'this text does not exist on the page' } }, { expectError: true, show: 300 });
await call('tab_network', { tab, op: 'start' });
await call('tab_act', { tab, action: 'reload' });
await call('tab_network', { tab, op: 'read', limit: 3 }, { show: 300 });
await call('recon_discover', { tab, maxScripts: 5 }, { show: 500 });
await call('tab_list', {});
const users = await call('tab_list', { user: true }, { show: 600 });
const ut = users.json?.userTabs?.find((t) => (t.url ?? '').includes('example.org'));
if (ut) {
  await call('tab_claim', { tabId: ut.tabId, title: 'WRONG TITLE', url: ut.url }, { expectError: true, show: 300 });
  const claimed = await call('tab_claim', { tabId: ut.tabId, title: ut.title, url: ut.url }, { show: 400 });
  await call('tab_act', { tab: claimed.json?.tab, action: 'scroll', direction: 'down' });
}
await call('js', { code: `const b = await agent.browsers.getDefault();\nconst t = await b.tabs.new('https://example.com/');\nconst st = await t.observe();\nnodeRepl.write(st.state.slice(0, 160));\nconst shot = await t.screenshot();\n({ url: st.url, title: st.title, tabs: (await b.tabs.list()).length })` }, { show: 600 });
await call('tools_compile', { site: 'example', name: 'more-info', description: 'click through to IANA', inputs: {} }, { show: 500 });
{ const tr = await client.readResource({ uri: 'opencli://session/trace' }); console.log(`\n▶ resource opencli://session/trace → ${JSON.parse(tr.contents[0].text).length} events`); }
await call('session_finalize', { keep: [] }, { show: 300 });
await client.close();
console.log(`\nbrowser smoke done; unexpected results: ${failures}`);
process.exit(failures ? 1 : 0);
