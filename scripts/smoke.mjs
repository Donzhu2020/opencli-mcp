// End-to-end smoke test against the embedded stdio server (no browser needed for public site commands).
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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
const call = async (name, args = {}, expectedError = false) => { const r = await client.callTool({ name, arguments: args }); const s = text(r); console.log(`\n▶ ${name} ${JSON.stringify(args)} ${r.isError ? 'ERROR' : 'ok'}\n${s.slice(0, 700)}${s.length > 700 ? '…' : ''}`); assert.equal(Boolean(r.isError), expectedError, `${name}: ${s}`); return r; };
const site = `smoketest${process.pid}`;
try {
  assert.equal(JSON.parse(text(await call('doctor'))).backend, 'none');
  const search = JSON.parse(text(await call('sites_search', { query: 'reddit', limit: 5 })));
  assert.ok(search.results.length > 0);
  await call('js', { code: "await sites.enable('reddit')" });
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'reddit_hot'));
  await call('tools_define', { site, name: 'echo', description: 'echo args', access: 'read', browser: false, args: [{ name: 'msg', required: true }], func: 'async ({ args }) => ({ msg: args.msg, len: args.msg.length })' });
  await call('js', { code: `await sites.enable('${site}')` });
  assert.ok((await client.listTools()).tools.some((t) => t.name === `${site}_echo`));
  for (const name of ['site_run', `${site}_echo`]) {
    const args = name === 'site_run' ? { site, command: 'echo', args: { msg: 'hello' } } : { msg: 'hello' };
    assert.deepEqual(JSON.parse(text(await call(name, args))).value, { msg: 'hello', len: 5 });
  }
  await call('js', { code: `const echo = await sites.${site}.echo({ msg: 'hello' }); if (echo.msg !== 'hello' || echo.len !== 5) throw new Error('echo mismatch'); echo` });
  await call('docs_list');
  const res = await client.listResources();
  console.log(`\nresources: ${res.resources.map((r) => r.uri).join(', ')}`);
  const sitesRes = await client.readResource({ uri: 'opencli://sites' });
  console.log(`opencli://sites → ${sitesRes.contents[0].text.length} chars`);
  const prompts = await client.listPrompts();
  console.log(`prompts: ${prompts.prompts.map((p) => p.name).join(', ')}`);
  const unavailable = await call('tab_open', { url: 'https://example.com' }, true);
  assert.equal(JSON.parse(text(unavailable)).error.code, 'browser_unavailable'); // expected: browser_unavailable in embedded mode
} finally {
  try { await call('js', { code: `tools.remove('${site}', 'echo')` }); }
  finally { await client.close(); }
}
console.log('\nsmoke done');
process.exit(0);
