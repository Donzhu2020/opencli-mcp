// Shared helpers for the X/Twitter adapters. Files starting with `_` are not commands.
import { errors } from '@opencli-mcp/adapter-sdk';

// The public web bearer token (same one x.com's own site uses); pairs with the ct0 cookie for CSRF.
export const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const FEATURES = {
  rweb_video_screen_enabled: false, profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false, rweb_tipjar_consumption_enabled: false, verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true, responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false, content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true, freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

/** Make sure the tab is on x.com so page-context fetches carry the session cookies and correct origin. */
export async function ensureOnX(tab) {
  const u = await tab.url().catch(() => null);
  if (!u || !/^https?:\/\/([a-z0-9-]+\.)?(x|twitter)\.com/i.test(u)) await tab.goto('https://x.com/home', { waitUntil: 'load' });
}

async function ct0(tab) {
  const v = (await tab.cookie('ct0', { domain: '.x.com' })) || (await tab.cookie('ct0', { domain: 'x.com' })) || (await tab.cookie('ct0'));
  if (!v) throw errors.auth('Not logged into x.com (no ct0 cookie)', 'Open x.com and sign in, then retry.');
  return v;
}

/** Call a Twitter GraphQL operation through the logged-in page. Returns parsed JSON. */
export async function gql(tab, queryId, name, variables, { features = FEATURES, method = 'GET', extra } = {}) {
  const token = await ct0(tab);
  const headers = { authorization: `Bearer ${BEARER}`, 'x-csrf-token': token, 'content-type': 'application/json' };
  if (method === 'GET') {
    const qs = `variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
    return tab.fetchJson(`/i/api/graphql/${queryId}/${name}?${qs}`, { headers });
  }
  return tab.fetchJson(`/i/api/graphql/${queryId}/${name}`, { method, headers, body: { variables, features, queryId, ...extra } });
}

/** One tweet → a flat, agent-friendly row. Expands t.co, surfaces a `links` list, minimal media. */
export function extractTweet(node, seen) {
  const tw = node?.tweet || node;
  if (!tw?.rest_id || seen.has(tw.rest_id)) return null;
  seen.add(tw.rest_id);
  const legacy = tw.legacy || {};
  const user = tw.core?.user_results?.result;
  const author = user?.legacy?.screen_name || user?.core?.screen_name || 'unknown';
  const name = user?.legacy?.name || user?.core?.name || '';
  const note = tw.note_tweet?.note_tweet_results?.result?.text;
  const urlEntities = [...(legacy.entities?.urls || []), ...(tw.note_tweet?.note_tweet_results?.result?.entity_set?.urls || [])];
  let text = note || legacy.full_text || '';
  for (const u of urlEntities) if (u?.url && u?.expanded_url) text = text.split(u.url).join(u.expanded_url);
  const links = [...new Set(urlEntities.map((u) => u?.expanded_url).filter(Boolean))];
  const media = (legacy.extended_entities?.media || legacy.entities?.media || []).map((m) => m?.media_url_https || m?.media_url).filter(Boolean);
  return {
    id: tw.rest_id, author, name, text, links,
    likes: legacy.favorite_count || 0, retweets: legacy.retweet_count || 0, replies: legacy.reply_count || 0,
    bookmarks: legacy.bookmark_count || 0, created_at: legacy.created_at || '',
    url: `https://x.com/${author}/status/${tw.rest_id}`, ...(media.length && { media }),
  };
}

/** Walk a GraphQL timeline's instructions → { tweets, nextCursor }. Works for bookmarks, search, likes, etc. */
export function walkTimeline(instructions, seen) {
  const tweets = [];
  let nextCursor = null;
  for (const inst of instructions || []) {
    const entries = inst.entries || (inst.entry ? [inst.entry] : []);
    for (const entry of entries) {
      const content = entry.content || {};
      if (content.entryType === 'TimelineTimelineCursor' || content.__typename === 'TimelineTimelineCursor') {
        if (content.cursorType === 'Bottom' || content.cursorType === 'ShowMore') nextCursor = content.value;
        continue;
      }
      if (String(entry.entryId || '').startsWith('cursor-bottom-')) { nextCursor = content.value || content.itemContent?.value || nextCursor; continue; }
      const item = content.itemContent;
      if (item?.tweet_results?.result) { const t = extractTweet(item.tweet_results.result, seen); if (t) tweets.push(t); continue; }
      for (const mi of content.items || []) {
        const r = mi?.item?.itemContent?.tweet_results?.result;
        if (r) { const t = extractTweet(r, seen); if (t) tweets.push(t); }
      }
    }
  }
  return { tweets, nextCursor };
}
