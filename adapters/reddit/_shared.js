// Shared helpers for the Reddit adapters. Files starting with `_` are not commands.
import { errors } from '@opencli-mcp/adapter-sdk';

/** Be on reddit.com so the same-origin .json fetches carry your session (personalized/over-18/subscribed content). */
export async function ensureOnReddit(tab) {
  const u = await tab.url().catch(() => null);
  if (!u || !/^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i.test(u)) await tab.goto('https://www.reddit.com', { waitUntil: 'load' });
}

/** A reddit listing `data.children[]` → flat, agent-friendly rows. */
export function postRows(json) {
  return (json?.data?.children || []).filter((c) => c.kind === 't3').map((c) => {
    const p = c.data;
    return {
      id: p.id, title: p.title, author: p.author, subreddit: p.subreddit_name_prefixed,
      score: p.score, comments: p.num_comments, created: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : '',
      flair: p.link_flair_text || undefined, nsfw: p.over_18 || undefined,
      text: p.selftext ? String(p.selftext).slice(0, 2000) : undefined,
      link: p.url && !p.is_self ? p.url : undefined,
      permalink: p.permalink ? `https://www.reddit.com${p.permalink}` : undefined,
    };
  });
}

export function assertListing(json) {
  if (!json || json.error) throw json?.error === 403 ? errors.auth('Reddit: forbidden (private/quarantined or not logged in)') : errors.upstream(`Reddit: ${json?.message || 'no listing returned'}`);
}
