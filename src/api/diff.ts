/** Line diff for observe(): report only what changed when the page moved a little. */
export interface LineDiff { changedRatio: number; text: string; added: number; removed: number }

export function lineDiff(prev: string, next: string): LineDiff {
  const a = prev.split('\n'); const b = next.split('\n');
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return { changedRatio: 1, text: next, added: m, removed: n };
  // LCS table (rows compressed to two arrays would lose backtrack; sizes are bounded above)
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = []; let added = 0, removed = 0, i = 0, j = 0, lastCtx = -1;
  const pushCtx = (line: string, idx: number) => { if (lastCtx !== idx - 1) out.push('…'); out.push(`  ${line}`); lastCtx = idx; };
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${a[i]}`); removed++; i++; }
    else { if (j > 0 && lastCtx !== j - 1 && out.length === 0) pushCtx(b[j - 1], j - 1); out.push(`+ ${b[j]}`); added++; j++; }
  }
  while (i < n) { out.push(`- ${a[i++]}`); removed++; }
  while (j < m) { out.push(`+ ${b[j++]}`); added++; }
  const changedRatio = (added + removed) / Math.max(1, m);
  return { changedRatio, text: out.join('\n'), added, removed };
}

/**
 * Semantic diff of two aria snapshots, keyed on element identity (the [ref=eN] of each line) the way the ChatGPT
 * plugin diffs accessibility trees: `~` a node whose line changed, `+` a node that appeared, removed nodes summarized
 * as ref ranges; text-only lines (no ref) are matched by content.
 */
export interface AriaDiff { changedRatio: number; text: string; added: number; removed: number; changed: number }
const REF = /\[ref=((?:f\d+)?e\d+)\]/;
export function ariaDiff(prev: string, next: string): AriaDiff {
  const index = (t: string) => { const m = new Map<string, string>(); const texts = new Map<string, number>(); for (const line of t.split('\n')) { const r = REF.exec(line); if (r) m.set(r[1], line); else if (line.trim()) texts.set(line, (texts.get(line) ?? 0) + 1); } return { m, texts }; };
  const a = index(prev), b = index(next);
  const out: string[] = []; let added = 0, removed = 0, changed = 0;
  const seenText = new Map<string, number>();
  for (const line of next.split('\n')) {
    const r = REF.exec(line);
    if (r) {
      const before = a.m.get(r[1]);
      if (before === undefined) { out.push(`+${line}`); added++; }
      else if (before !== line) { out.push(`~${line}`); changed++; }
    } else if (line.trim()) {
      const n = (seenText.get(line) ?? 0) + 1; seenText.set(line, n);
      if (n > (a.texts.get(line) ?? 0)) { out.push(`+${line}`); added++; }
    }
  }
  const gone = [...a.m.keys()].filter((k) => !b.m.has(k));
  for (const [line, n] of a.texts) removed += Math.max(0, n - (b.texts.get(line) ?? 0));
  removed += gone.length;
  if (gone.length) {
    // summarize removed refs as ranges: e12–e15, e20
    const nums = gone.map((k) => ({ k, n: Number(k.replace(/^f\d+/, '').slice(1)), p: k.replace(/e\d+$/, '') })).sort((x, y) => x.p.localeCompare(y.p) || x.n - y.n);
    const ranges: string[] = []; let start = nums[0], last = nums[0];
    for (const cur of nums.slice(1)) { if (cur.p === last.p && cur.n === last.n + 1) { last = cur; continue; } ranges.push(start === last ? start.k : `${start.k}–${last.k}`); start = last = cur; }
    ranges.push(start === last ? start.k : `${start.k}–${last.k}`);
    out.push(`removed: ${ranges.join(', ')}`);
  }
  const total = Math.max(1, b.m.size + [...b.texts.values()].reduce((x, y) => x + y, 0));
  const header = 'Diff from the previous observe: ~ changed, + added; removed nodes are listed by ref.';
  return { changedRatio: (added + removed + changed) / total, text: out.length ? `${header}\n${out.join('\n')}` : '', added, removed, changed };
}
