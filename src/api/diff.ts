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
