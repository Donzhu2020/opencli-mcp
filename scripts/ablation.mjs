// Ablation runner: the same task matrix under different runtime toggles, against the live host.
// Usage: node scripts/ablation.mjs [--toggle actMode=extension,host] [--toggle observeDiff=true,false] [--url https://example.com/]
// Each configuration is applied via the `js` tool (session-scoped runtime overrides), so no restart is needed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const toggles = {};
for (let i = 0; i < args.length; i++) if (args[i] === '--toggle') { const [k, v] = args[++i].split('='); toggles[k] = v.split(','); }
if (!Object.keys(toggles).length) Object.assign(toggles, { actMode: ['extension', 'host'], observeDiff: ['true', 'false'] });
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'https://example.com/';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/src/main.js', 'stdio'], stderr: 'pipe' });
const client = new Client({ name: 'ablation', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const call = async (name, a = {}) => { const t0 = performance.now(); const r = await client.callTool({ name, arguments: a }); return { ms: Math.round(performance.now() - t0), isError: Boolean(r.isError), chars: text(r).length, json: (() => { try { return JSON.parse(text(r)); } catch { return null; } })() }; };
const combos = Object.entries(toggles).reduce((acc, [k, vals]) => acc.flatMap((c) => vals.map((v) => ({ ...c, [k]: v }))), [{}]);
const rows = [];
for (const combo of combos) {
  const override = Object.fromEntries(Object.entries(combo).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v]));
  await call('js', { code: `Object.assign(session.runtimeAblation(), ${JSON.stringify(override)}); session.runtimeAblation()` });
  const t = { combo: JSON.stringify(combo), steps: [], errors: 0, ms: 0, chars: 0 };
  const step = async (name, a) => { const r = await call(name, a); t.steps.push({ name, ms: r.ms, chars: r.chars, err: r.isError }); t.ms += r.ms; t.chars += r.chars; if (r.isError) t.errors++; return r; };
  await step('session_name', { name: '🧪 ablation' });
  const open = await step('tab_open', { url });
  const tab = open.json?.tab;
  await step('tab_observe', { tab });
  await step('tab_act', { tab, action: 'click', target: { text: 'More information' } });
  await step('tab_wait', { tab, url: 'iana', timeout: 15 });
  await step('tab_observe', { tab });
  await step('tab_act', { tab, action: 'back' });
  await step('tab_observe', { tab });
  await step('session_finalize', { keep: [] });
  rows.push(t);
  console.log(`\n${t.combo}: total ${t.ms} ms, ${t.chars} chars, ${t.errors} errors`);
  for (const s of t.steps) console.log(`  ${s.name.padEnd(18)} ${String(s.ms).padStart(6)} ms ${String(s.chars).padStart(7)} chars${s.err ? '  ERR' : ''}`);
}
console.log('\n| combo | total ms | total chars | errors |\n|---|---|---|---|');
for (const r of rows) console.log(`| ${r.combo} | ${r.ms} | ${r.chars} | ${r.errors} |`);
await client.close();
process.exit(0);
