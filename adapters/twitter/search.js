import { defineAdapter, errors } from '@opencli-mcp/adapter-sdk';
import { ensureOnX, gql, walkTimeline } from './_shared.js';

const QUERY_ID = 'nKAncKPF1fV1xltvF3UUlw';

export default defineAdapter({
  description: 'Search X/Twitter for tweets. t.co links are expanded (see `links`).',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'query', type: 'string', required: true, help: 'Search text (X search operators allowed)' },
    { name: 'limit', type: 'int', default: 20, help: 'How many tweets to return' },
    { name: 'sort', type: 'string', default: 'top', choices: ['top', 'latest'], help: 'Ranking: top or latest' },
    { name: 'cursor', type: 'string', help: 'nextCursor from a previous call, to page further' },
  ],
  async run({ tab, args }) {
    const query = String(args.query || '').trim();
    if (!query) throw errors.argument('`query` is required', 'Give search text, e.g. { query: "anthropic" }');
    await ensureOnX(tab);
    const limit = Math.max(1, Number(args.limit) || 20);
    const product = args.sort === 'latest' ? 'Latest' : 'Top';
    const seen = new Set();
    const rows = [];
    let cursor = args.cursor || undefined;
    for (let guard = 0; rows.length < limit && guard < 20; guard++) {
      const variables = { rawQuery: query, count: Math.min(limit - rows.length + 5, 100), querySource: 'typed_query', product, ...(cursor && { cursor }) };
      const data = await gql(tab, QUERY_ID, 'SearchTimeline', variables);
      const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
      const { tweets, nextCursor } = walkTimeline(instructions, seen);
      for (const t of tweets) if (rows.length < limit) rows.push(t);
      cursor = nextCursor || undefined;
      if (!tweets.length || !cursor) break;
    }
    if (!rows.length) throw errors.empty(`No tweets found for "${query}"`);
    return { rows, ...(cursor && { nextCursor: cursor }) };
  },
});
