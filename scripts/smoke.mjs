// End-to-end smoke test against the embedded stdio server (no browser needed for public site commands).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const useDist = process.argv.includes('--dist');
const transport = new StdioClientTransport(useDist
  ? { command: 'node', args: ['dist/src/main.js', 'stdio', '--embedded'], stderr: 'pipe' }
  : { command: 'npx', args: ['tsx', 'src/main.ts', 'stdio', '--embedded'], stderr: 'pipe' });
transport.stderr?.on('data', (d) => process.stderr.write(`  [server] ${d}`));
const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} });
const t0 = Date.now();
await client.connect(transport);
console.log(`connected in ${Date.now() - t0}ms; instructions chars = ${client.getInstructions()?.length}`);
const tools = await client.listTools();
console.log(`tools: ${tools.tools.length} → ${tools.tools.map((t) => t.name).join(', ')}`);
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const s = text(r); console.log(`\n▶ ${name} ${JSON.stringify(args)} ${r.isError ? 'ERROR' : 'ok'}\n${s.slice(0, 700)}${s.length > 700 ? '…' : ''}`); return r; };
await call('doctor');
await call('sites_search', { query: 'hacker news', limit: 5 });
await call('sites_enable', { site: 'hackernews' });
const after = await client.listTools();
console.log(`\ntools after enable: ${after.tools.length}; has hackernews_top: ${after.tools.some((t) => t.name === 'hackernews_top')}`);
await call('hackernews_top', { limit: 3 });
await call('site_run', { site: 'hackernews', command: 'top', args: { limit: 2 } });
await call('js', { code: 'const hits = sites.search("reddit hot");\nhits.length' });
await call('js', { code: 'const top = await sites.hackernews.top({ limit: 2 });\ntop.map(r => r.title)' });
await call('tools_define', { site: 'smoketest', name: 'echo', description: 'echo args', access: 'read', strategy: 'public', args: [{ name: 'msg', required: true }], columns: ['msg', 'len'], func: 'async (args) => ({ msg: args.msg, len: args.msg.length })' });
await call('site_run', { site: 'smoketest', command: 'echo', args: { msg: 'hello' } });
await call('tools_remove', { site: 'smoketest', name: 'echo' });
await call('docs_list');
const res = await client.listResources();
console.log(`\nresources: ${res.resources.map((r) => r.uri).join(', ')}`);
const sitesRes = await client.readResource({ uri: 'opencli://sites' });
console.log(`opencli://sites → ${sitesRes.contents[0].text.length} chars`);
const prompts = await client.listPrompts();
console.log(`prompts: ${prompts.prompts.map((p) => p.name).join(', ')}`);
await call('tab_open', { url: 'https://example.com' }); // expected: browser_unavailable in embedded mode
await client.close();
console.log('\nsmoke done');
process.exit(0);
