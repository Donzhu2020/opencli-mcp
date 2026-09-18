// API-first verification on real sites through the stdio launcher (global opencli-mcp → Chrome-spawned host).
// For each site: open → reach the data in the UI → extract → tools.compile → report what was frozen and why.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const t = new StdioClientTransport({ command: 'opencli-mcp', args: [], stderr: 'pipe' });
t.stderr?.on('data', (d) => { const s = String(d); if (/error|fail/i.test(s)) process.stderr.write(`  [launcher] ${s}`); });
const c = new Client({ name: 'verify-api-first', version: '0' }, { capabilities: {} });
await c.connect(t);
const js = async (code) => {
  const r = await c.callTool({ name: 'js', arguments: { code } });
  const text = r.content?.filter((x) => x.type === 'text').map((x) => x.text).join('\n') ?? '';
  if (r.isError) throw new Error(text.slice(0, 800));
  // the js tool returns the last value JSON-encoded; our snippets already stringify, so unwrap once
  try { const v = JSON.parse(text); return typeof v === 'string' ? v : JSON.stringify(v); } catch { return text; }
};
const obj = (s) => { try { return JSON.parse(s); } catch { return { raw: String(s).slice(0, 200) }; } };

const SITES = [
  { site: 'hackernews', url: 'https://news.ycombinator.com/', extract: `[...document.querySelectorAll('.titleline > a')].slice(0, 5).map(a => a.textContent)`, inputs: {} },
  { site: 'reddit', url: 'https://www.reddit.com/r/programming/', wait: 'shreddit-post, .thing .title a', extract: `[...document.querySelectorAll('shreddit-post')].slice(0, 5).map(p => p.getAttribute('post-title')).concat([...document.querySelectorAll('.thing .title a.title')].slice(0, 5).map(a => a.textContent)).filter(Boolean).slice(0, 5)`, inputs: {} },
  { site: 'github', url: 'https://github.com/microsoft/playwright/issues', wait: 'a[data-testid=issue-pr-title-link], a.Link--primary.markdown-title', extract: `[...document.querySelectorAll('a[data-testid=issue-pr-title-link], a.Link--primary.markdown-title')].slice(0, 5).map(a => a.textContent.trim())`, inputs: {} },
  { site: 'zhihu', url: 'https://www.zhihu.com/', wait: '.ContentItem-title, .HotItem-title', extract: `[...document.querySelectorAll('.ContentItem-title, .HotItem-title')].slice(0, 5).map(e => e.textContent.trim())`, inputs: {} },
  { site: 'twitter', url: 'https://x.com/home', wait: '[data-testid=tweetText]', extract: `[...document.querySelectorAll('[data-testid=tweetText]')].slice(0, 5).map(e => e.textContent.trim().slice(0, 80))`, inputs: {} },
];

const out = [];
await js(`const browser = await agent.browsers.getDefault(); await browser.nameSession('🧪 api-first verify'); 'ok'`);
for (const s of SITES) {
  const rec = { site: s.site };
  try {
    await js(`session.clearTrace(); var tab = await browser.tabs.new(${JSON.stringify(s.url)}); 'ok'`);
    if (s.wait) await js(`await tab.expect({ selector: ${JSON.stringify(s.wait)} }, { timeoutMs: 25000 }).catch(() => null); 'ok'`); else await js(`await new Promise(r => setTimeout(r, 2500)); 'ok'`);
    rec.url = await js(`JSON.stringify(await tab.url())`);
    const extracted = await js(`var extracted = await tab.evaluate(${JSON.stringify(s.extract)}); JSON.stringify(extracted)`);
    rec.extracted = extracted.slice(0, 200);
    const net = await js(`var net = await tab.network.read({ limit: 400 }); JSON.stringify({ n: net.entries.length, bytes: net.entries.reduce((a, e) => a + (e.responseBodyFullSize || 0), 0), kept: net.entries.reduce((a, e) => a + String(e.responsePreview || "").length, 0), json: net.entries.filter(e => /json|graphql/i.test(String(e.responseContentType ?? e.contentType ?? ''))).length, candidates: (net.candidates ?? []).length, pending: !!net.candidatesPending, sample: net.entries.filter(e => /json|graphql/i.test(String(e.responseContentType ?? ''))).slice(0, 4).map(e => (e.method + ' ' + e.url).slice(0, 110)) })`);
    rec.network = obj(net);
    const comp = await js(`var def = tools.compile({ site: ${JSON.stringify(s.site)}, name: 'verify-probe', description: 'probe', inputs: ${JSON.stringify(s.inputs)} }); JSON.stringify({ api: def.func.includes('tab.fetchJson('), call: (def.func.match(/tab\\.fetchJson\\([^\\n]*/) || [''])[0].slice(0, 220), warnings: def.warnings })`);
    rec.compile = obj(comp);
    if (rec.compile.api) {
      // run the frozen call once through the page and compare with what the UI showed
      const run = await js(`var fn = new Function('return (' + def.func + ')')(); var data = await fn({ tab, args: {} }); var text = JSON.stringify(data); JSON.stringify({ bytes: text.length, carries: (extracted || []).filter(v => v && text.includes(String(v).slice(0, 30))).length, of: (extracted || []).length })`);
      rec.replay = obj(run);
    }
    await js(`await tab.close(); 'ok'`);
  } catch (err) {
    rec.error = String(err.message ?? err).slice(0, 300);
    try { rec.tabs = await js(`JSON.stringify((await browser.tabs.list()).map(t => t.url))`); } catch { /* ignore */ }
    try { await js(`for (const t of await browser.tabs.list()) await browser.tabs.get(t.id).close(); 'ok'`); } catch { /* gone */ }
  }
  out.push(rec);
  console.log(JSON.stringify(rec));
}
await js(`await browser.tabs.finalize(); 'ok'`).catch(() => {});
await c.close();
