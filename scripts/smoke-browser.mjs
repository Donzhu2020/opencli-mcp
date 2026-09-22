// Live-browser end-to-end: goes through the stdio launcher, which proxies to the Chrome-spawned host.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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
const opened = await call('tab_open', { url: 'https://example.com/', session: '🔎 opencli-mcp e2e' }, { show: 900 });
const tab = opened.json?.tab;
console.log('tab id =', tab);
await call('js', { code: `const b0 = await agent.browsers.getDefault(); const t0 = await b0.tabs.get(${JSON.stringify(tab)}); await t0.find({ role: 'link' })` });
await call('tab_act', { tab, action: 'click', target: { role: 'link' } /* example.com's only link; its text drifted from 'More information' to 'Learn more' */, observe: true }, { show: 700 });
await call('tab_expect', { tab, url: 'iana.org', timeout: 20 });
await call('tab_observe', { tab, mode: 'state' }, { show: 400 });
await call('tab_observe', { tab, mode: 'screenshot', annotate: true }, { show: 120 });
await call('js', { code: `await t0.evaluate('document.title')` });
await call('js', { code: `await t0.evaluate('document.querySelector("a").click()')` }, { expectError: true, show: 200 });
await call('tab_act', { tab, action: 'click', target: { text: 'this text does not exist on the page' } }, { expectError: true, show: 300 });
await call('js', { code: `await t0.network.start()` });
await call('tab_act', { tab, action: 'reload' });
await call('js', { code: `await t0.network.read({ limit: 3 })` }, { show: 300 });
await call('js', { code: `await recon.discover(t0, { maxScripts: 5 })` }, { show: 500 });
await call('js', { code: `await b0.tabs.list()` });
const users = await call('js', { code: `const ut = (await b0.user.openTabs()).find((t) => (t.url ?? '').includes('example.org')); ut ?? null` }, { show: 600 });
const ut = users.json?.value ?? null;
if (ut) {
  await call('tab_claim', { tabId: ut.tabId, title: 'WRONG TITLE', url: ut.url }, { expectError: true, show: 300 });
  const claimed = await call('tab_claim', { tabId: ut.tabId, title: ut.title, url: ut.url }, { show: 400 });
  await call('tab_act', { tab: claimed.json?.tab, action: 'scroll', direction: 'down' });
}
await call('js', { code: `const b = await agent.browsers.getDefault();\nconst t = await b.tabs.new('https://example.com/');\nconst st = await t.observe();\nnodeRepl.write(st.state.slice(0, 160));\nconst shot = await t.screenshot();\n({ url: st.url, title: st.title, tabs: (await b.tabs.list()).length })` }, { show: 600 });
await call('tools_compile', { site: 'example', name: 'more-info', description: 'click through to IANA', inputs: {} }, { show: 500 });
await call('js', { code: `session.trace()` }, { show: 300 });
await call('session_finalize', { keep: [] }, { show: 300 });
await client.close();
console.log(`\nbrowser smoke done; unexpected results: ${failures}`);
process.exit(failures ? 1 : 0);
