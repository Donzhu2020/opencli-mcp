// Shared helpers for the X/Twitter adapters. Files starting with `_` are not commands.
import { errors } from '@opencli-mcp/adapter-sdk';
import fs from 'node:fs';
import path from 'node:path';

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

// Features the UserByScreenName op expects (used to resolve a screen_name -> numeric rest_id).
export const USER_BY_SCREEN_NAME_QUERY_ID = 'IGgvgiOx4QZndDHuD3x9TQ';
export const USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true, rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true, subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true, responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true, creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true,
};

const SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const SCREEN_NAME_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com']);
const TWEET_HOSTS = new Set(['x.com', 'twitter.com']);
const TWEET_PATH_PATTERN = /^\/(?:[^/]+|i)\/status\/(\d+)\/?$/;
const RESERVED_SCREEN_NAME_PATHS = new Set([
  'compose', 'explore', 'help', 'home', 'i', 'intent', 'jobs', 'login', 'logout',
  'messages', 'notifications', 'privacy', 'search', 'settings', 'signup', 'tos',
]);

function isTwitterHost(hostname) {
  return TWEET_HOSTS.has(hostname) || hostname.endsWith('.x.com') || hostname.endsWith('.twitter.com');
}

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

/** Auth headers for a direct GraphQL/REST fetch through the logged-in page. */
export async function authHeaders(tab) {
  const token = await ct0(tab);
  return { authorization: `Bearer ${BEARER}`, 'x-csrf-token': token, 'content-type': 'application/json' };
}

const enc = (v) => encodeURIComponent(JSON.stringify(v));

/** Call a Twitter GraphQL operation through the logged-in page. Returns parsed JSON. */
export async function gql(tab, queryId, name, variables, opts = {}) {
  const { features = FEATURES, method = 'GET', extra, fieldToggles } = opts;
  const headers = await authHeaders(tab);
  if (method === 'GET') {
    const parts = [];
    if (variables !== undefined) parts.push(`variables=${enc(variables)}`);
    if (features) parts.push(`features=${enc(features)}`);
    if (fieldToggles) parts.push(`fieldToggles=${enc(fieldToggles)}`);
    return tab.fetchJson(`/i/api/graphql/${queryId}/${name}?${parts.join('&')}`, { headers });
  }
  const body = { variables, queryId, ...(features ? { features } : {}), ...(fieldToggles ? { fieldToggles } : {}), ...extra };
  return tab.fetchJson(`/i/api/graphql/${queryId}/${name}`, { method, headers, body });
}

/** Translate an HTTP status into an agent-facing error to throw. */
export function apiError(op, status, hint) {
  const code = Number(status);
  if (code === 401 || code === 403) return errors.auth(`${op}: HTTP ${status} (session expired or forbidden)`, 'Open x.com, sign in, then retry.');
  let suffix;
  if (code === 429) suffix = 'rate-limited by X; retry after a cooldown (typically 15-30 min)';
  else if (code === 404) suffix = 'resource not found (deleted, suspended, or private)';
  else if (code >= 500 && code < 600) suffix = 'X server error; retry later';
  else suffix = 'possibly a schema change or transient failure';
  return errors.upstream(`HTTP ${status}: ${op} failed - ${suffix}${hint ? ` (${hint})` : ''}`);
}

/** @param value handle, @handle, or a profile URL -> canonical screen name, or '' if invalid. */
export function normalizeScreenName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let candidate = '';
  try {
    const url = raw.startsWith('/') ? new URL(raw, 'https://x.com') : new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !SCREEN_NAME_HOSTS.has(url.hostname)) return '';
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return '';
    candidate = segments[0];
  } catch {
    if (raw.includes('/') || raw.includes('?') || raw.includes('#')) return '';
    candidate = raw.replace(/^@+/, '');
  }
  if (!SCREEN_NAME_PATTERN.test(candidate)) return '';
  if (RESERVED_SCREEN_NAME_PATHS.has(candidate.toLowerCase())) return '';
  return candidate;
}

/** Strict tweet-URL parse -> { id, url }. Throws on malformed / off-domain input. */
export function parseTweetUrl(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) throw errors.argument('Tweet URL cannot be empty', 'Example: https://x.com/jack/status/20');
  let parsed;
  try { parsed = new URL(value); } catch { throw errors.argument(`Invalid tweet URL: ${value}`, 'Use a full https://x.com/<user>/status/<id> URL'); }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !isTwitterHost(hostname)) throw errors.argument(`Invalid tweet URL host: ${value}`, 'Use a full https://x.com/<user>/status/<id> URL');
  const match = parsed.pathname.match(TWEET_PATH_PATTERN);
  if (!match?.[1]) throw errors.argument(`Could not extract tweet ID from URL: ${value}`, 'Use a full https://x.com/<user>/status/<id> URL');
  return { id: match[1], url: parsed.toString() };
}

/** Lenient: accept a bare numeric id OR any URL containing /status/<id> or /article/<id>. */
export function tweetIdFrom(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/\/(?:status|article)\/(\d+)/) || s.match(/^(\d+)$/);
  if (!m) throw errors.argument('Invalid tweet id or URL', 'Pass a numeric tweet id or a https://x.com/<user>/status/<id> URL');
  return m[1];
}

/** Canonical status URL for a tweet id (redirects to the author's handle URL). */
export function statusUrl(id) { return `https://x.com/i/status/${id}`; }

/** Resolve a screen name to a numeric user rest_id. */
export async function resolveUserId(tab, screenName) {
  const data = await gql(tab, USER_BY_SCREEN_NAME_QUERY_ID, 'UserByScreenName',
    { screen_name: screenName, withSafetyModeUserFields: true }, { features: USER_BY_SCREEN_NAME_FEATURES });
  const id = data?.data?.user?.result?.rest_id;
  if (!id) throw errors.empty(`Could not resolve @${screenName}`);
  return id;
}

/** Detect the logged-in user's screen name from the sidebar profile link. */
export async function resolveLoggedInUser(tab) {
  await tab.goto('https://x.com/home', { waitUntil: 'load', settleMs: 1500 });
  const href = await tab.evaluate(`(() => { const l = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'); return l ? l.getAttribute('href') : null; })()`);
  const u = normalizeScreenName(typeof href === 'string' ? href : '');
  if (!u) throw errors.auth('Could not detect the logged-in user', 'Open x.com, sign in, then retry.');
  return u;
}

/** One tweet -> a flat, agent-friendly row. Expands t.co, surfaces a `links` list, minimal media. */
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
    bookmarks: legacy.bookmark_count || 0, views: Number(tw.views?.count) || 0, created_at: legacy.created_at || '',
    url: `https://x.com/${author}/status/${tw.rest_id}`, ...(media.length && { media }),
  };
}

/** Extract media flags & URLs from a tweet's legacy object (mp4 for video/gif, https for photos). */
export function extractMedia(legacy) {
  const media = legacy?.extended_entities?.media || legacy?.entities?.media;
  if (!Array.isArray(media) || media.length === 0) return { has_media: false, media_urls: [], media_posters: [] };
  const urls = [];
  const posters = [];
  for (const m of media) {
    if (!m) continue;
    if (m.type === 'video' || m.type === 'animated_gif') {
      const variants = m.video_info?.variants || [];
      const mp4 = variants.filter((v) => v?.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const url = mp4?.url || m.media_url_https;
      if (url) { urls.push(url); posters.push(m.media_url_https || url); }
    } else if (m.media_url_https) {
      urls.push(m.media_url_https); posters.push(m.media_url_https);
    }
  }
  return { has_media: urls.length > 0, media_urls: urls, media_posters: posters };
}

/** Walk a GraphQL timeline's instructions -> { tweets, nextCursor }. Works for bookmarks, search, likes, etc. */
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
      if (content.entryType === 'TimelineTimelineModule' && String(entry.entryId || '').startsWith('cursor-')) continue;
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

// ── Engagement re-ranking (the old --top-by-engagement, now the `top_by_engagement` arg) ──
const ENGAGEMENT_WEIGHTS = Object.freeze({ likes: 1, retweets: 3, replies: 2, bookmarks: 5, viewsLog: 0.5 });
export function computeEngagementScore(row) {
  if (!row || typeof row !== 'object') return 0;
  const num = (key) => { const n = Number(row[key]); return Number.isFinite(n) ? Math.max(0, n) : 0; };
  const score = num('likes') * ENGAGEMENT_WEIGHTS.likes + num('retweets') * ENGAGEMENT_WEIGHTS.retweets
    + num('replies') * ENGAGEMENT_WEIGHTS.replies + num('bookmarks') * ENGAGEMENT_WEIGHTS.bookmarks
    + Math.log10(num('views') + 1) * ENGAGEMENT_WEIGHTS.viewsLog;
  return Math.round(score * 100) / 100;
}
export function applyTopByEngagement(rows, topN) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const n = Number(topN);
  if (!Number.isFinite(n) || n <= 0) return rows;
  return rows.map((row, idx) => ({ row, idx, score: computeEngagementScore(row) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, Math.floor(n)).map((e) => e.row);
}

/**
 * Browser-side helper source: declares tweet-scoping bindings inside a page.evaluate IIFE
 * so write actions target the exact <article> matching a status id (not the first one).
 * Bindings: tweetId, __twGetStatusIdFromHref(href), __twHasLinkToTarget(root), findTargetArticle().
 */
export function buildTwitterArticleScopeSource(tweetId) {
  return `
    const tweetId = ${JSON.stringify(tweetId)};
    const __twTweetPathRe = /^\\/(?:[^/]+|i)\\/status\\/(\\d+)\\/?$/;
    const __twIsTwitterHost = (hostname) => hostname === 'x.com' || hostname === 'twitter.com'
      || hostname.endsWith('.x.com') || hostname.endsWith('.twitter.com');
    const __twGetStatusIdFromHref = (href) => {
      try {
        const parsed = new URL(href, window.location.origin);
        if (parsed.protocol !== 'https:' || !__twIsTwitterHost(parsed.hostname.toLowerCase())) return null;
        return parsed.pathname.match(__twTweetPathRe)?.[1] || null;
      } catch { return null; }
    };
    const __twHasLinkToTarget = (root) => Array.from(root.querySelectorAll('a[href*="/status/"]'))
      .some((link) => __twGetStatusIdFromHref(link.href) === tweetId);
    const findTargetArticle = () => Array.from(document.querySelectorAll('article')).find(__twHasLinkToTarget);
  `;
}

// ── Lists management (owned + subscribed lists), shared by lists / list-add / list-remove / list-delete ──
export const LISTS_MANAGEMENT_QUERY_ID = '78UbkyXwXBD98IgUWXOy9g';
const OWNED_SUBSCRIBED_ENTRY_PREFIX = 'owned-subscribed-list-module-';

export function getListsManagementInstructions(data) {
  const i = data?.data?.viewer?.list_management_timeline?.timeline?.instructions
    || data?.data?.viewer_v2?.user_results?.result?.list_management_timeline?.timeline?.instructions
    || data?.data?.list_management_timeline?.timeline?.instructions;
  return Array.isArray(i) ? i : null;
}

function extractListEntry(entry, seen) {
  const list = entry?.content?.itemContent?.list || entry?.content?.list || entry?.item?.itemContent?.list;
  if (!list) return null;
  const id = list.id_str || list.id || '';
  if (!id || seen.has(id)) return null;
  seen.add(id);
  const mode = typeof list.mode === 'string' && /private/i.test(list.mode) ? 'private' : 'public';
  return { id: String(id), name: list.name || '', members: String(list.member_count ?? 0), followers: String(list.subscriber_count ?? 0), mode };
}

/** Parse ListsManagementPageTimeline -> owned + subscribed lists (excludes "discover" recommendations). */
export function parseListsManagement(data, seen) {
  const lists = [];
  for (const inst of getListsManagementInstructions(data) || []) {
    for (const entry of inst.entries || []) {
      if (!String(entry?.entryId || '').startsWith(OWNED_SUBSCRIBED_ENTRY_PREFIX)) continue;
      const direct = extractListEntry(entry, seen);
      if (direct) { lists.push(direct); continue; }
      for (const item of entry?.content?.items || []) { const nested = extractListEntry(item, seen); if (nested) lists.push(nested); }
    }
  }
  return lists;
}

/** Fetch the logged-in user's managed lists (owned + subscribed). */
export async function fetchManagedLists(tab) {
  const data = await gql(tab, LISTS_MANAGEMENT_QUERY_ID, 'ListsManagementPageTimeline', undefined, { method: 'GET' })
    .catch((e) => { throw apiError('ListsManagementPageTimeline', e?.data?.status || e?.status || 0); });
  if (!getListsManagementInstructions(data)) throw errors.upstream('X lists returned an unexpected payload shape');
  return parseListsManagement(data, new Set());
}

/** Navigate to `url`, then run a write-capable page script (returns whatever the script returns). */
export async function domRun(tab, url, script) {
  await tab.goto(url, { waitUntil: 'load', settleMs: 1500 });
  return tab.evaluate(script, { allowWrite: true });
}

/** Run a write-capable page script on the current page (no navigation). */
export function domEval(tab, script) {
  return tab.evaluate(script, { allowWrite: true });
}

// ── Composer helpers (post / reply / quote) ──
export const COMPOSER_FILE_INPUT_SELECTOR = 'input[type="file"][data-testid="fileInput"]';
const SUPPORTED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MIME_BY_EXT = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Read local image paths (comma-separated string or array) into base64 upload descriptors. */
export function resolveLocalImages(input, max = 4) {
  const paths = (Array.isArray(input) ? input : String(input || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (paths.length > max) throw errors.argument(`Too many images: ${paths.length} (max ${max})`);
  return paths.map((p) => {
    const abs = path.resolve(p);
    const ext = path.extname(abs).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) throw errors.argument(`Unsupported image format "${ext}". Supported: jpg, png, gif, webp`);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw errors.argument(`Image file not found: ${abs}`);
    if (fs.statSync(abs).size > MAX_IMAGE_BYTES) throw errors.argument(`Image too large: ${abs}`);
    return { name: path.basename(abs), mime: MIME_BY_EXT[ext] || 'image/jpeg', base64: fs.readFileSync(abs).toString('base64') };
  });
}

/** Download a remote image URL into a base64 upload descriptor. */
export async function downloadRemoteImage(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw errors.argument(`Invalid image URL: ${url}`); }
  if (!/^https?:$/.test(parsed.protocol)) throw errors.argument(`Unsupported image URL protocol: ${parsed.protocol}`);
  const resp = await fetch(url);
  if (!resp.ok) throw errors.upstream(`Image download failed: HTTP ${resp.status}`);
  const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const extByCt = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
  let ext = extByCt[ct];
  if (!ext) { try { const e = path.extname(new URL(url).pathname).toLowerCase(); if (SUPPORTED_IMAGE_EXTS.has(e)) ext = e; } catch { /* ignore */ } }
  if (!ext) throw errors.argument(`Unsupported remote image format "${ct || 'unknown'}"`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) throw errors.argument('Remote image too large');
  return { name: `image${ext}`, mime: MIME_BY_EXT[ext] || 'image/jpeg', base64: buf.toString('base64') };
}

/** Attach base64 image descriptors to the current composer's file input, then wait for previews. */
export async function attachComposerImages(tab, files) {
  const script = `(async () => {
    const files = ${JSON.stringify(files)};
    const input = document.querySelector(${JSON.stringify(COMPOSER_FILE_INPUT_SELECTOR)});
    if (!input) return { ok: false, message: 'No file input found on the composer.' };
    const dt = new DataTransfer();
    for (const f of files) { const bin = atob(f.base64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); dt.items.add(new File([bytes], f.name, { type: f.mime })); }
    let assigned = false;
    try { Object.defineProperty(input, 'files', { value: dt.files, writable: false, configurable: true }); assigned = input.files && input.files.length >= files.length; }
    catch { try { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files'); if (s && s.set) { s.set.call(input, dt.files); assigned = input.files && input.files.length >= files.length; } } catch {} }
    if (!assigned) return { ok: false, message: 'Could not assign files to the composer input.' };
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      const previews = Math.max(
        document.querySelectorAll('[data-testid="attachments"] img, [data-testid="attachments"] video, [data-testid="tweetPhoto"], img[src^="blob:"], video[src^="blob:"]').length,
        document.querySelectorAll('[data-testid="media-upload-preview"], [data-testid="card.layoutLarge.media"]').length
      );
      if (previews >= files.length) return { ok: true };
    }
    return { ok: false, message: 'Image upload timed out.' };
  })()`;
  return domEval(tab, script);
}

/** Insert text into the current composer's Draft.js editor and verify it landed. */
export async function insertComposerText(tab, text) {
  const script = `(async () => {
    try {
      const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
      const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]'));
      const box = boxes.find(visible) || boxes[0];
      if (!box) return { ok: false, message: 'Could not find the composer text area. Are you logged in?' };
      box.focus();
      const t = ${JSON.stringify(text)};
      if (!document.execCommand('insertText', false, t)) {
        const dt = new DataTransfer(); dt.setData('text/plain', t);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
      await new Promise(r => setTimeout(r, 800));
      const norm = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const actual = box.innerText || box.textContent || '';
      return norm(actual).includes(norm(t)) ? { ok: true } : { ok: false, message: 'Could not verify composer text after typing.' };
    } catch (e) { return { ok: false, message: String(e) }; }
  })()`;
  return domEval(tab, script);
}

/** Click the composer's Post button and wait for a success/failure toast. Returns { ok, message, id?, url? }. */
export async function submitComposer(tab, text) {
  const script = `(async () => {
    try {
      const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
      for (const toast of Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))) if (visible(toast)) toast.setAttribute('data-oc-before', '1');
      let btn = null;
      for (let i = 0; i < 30; i++) { btn = Array.from(document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')).find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'); if (btn) break; await new Promise(r => setTimeout(r, 500)); }
      if (!btn) return { ok: false, message: 'Post button is disabled or not found.' };
      btn.click();
      const statusUrl = (root) => { if (!root || typeof root.querySelectorAll !== 'function') return {}; for (const link of Array.from(root.querySelectorAll('a[href*="/status/"]'))) { const href = link.href || link.getAttribute('href') || ''; try { const u = new URL(href, window.location.origin); const host = u.hostname.toLowerCase().replace(/^www\\./, ''); if (!['x.com','twitter.com','mobile.twitter.com'].includes(host)) continue; const m = u.pathname.match(/^\\/([^/]+)\\/status\\/(\\d+)\\/?$/); if (m) return { url: u.href, id: m[2] }; } catch {} } return {}; };
      const norm = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const expected = norm(${JSON.stringify(text)});
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        const toasts = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]')).filter((el) => visible(el) && !el.hasAttribute('data-oc-before'));
        const ok = toasts.find((el) => /sent|posted|your post was sent|your tweet was sent/i.test(el.textContent || ''));
        if (ok) return { ok: true, message: 'Posted.', ...statusUrl(ok) };
        const err = toasts.find((el) => /failed|error|try again|not sent|could not/i.test(el.textContent || ''));
        if (err) return { ok: false, message: (err.textContent || 'Post failed.').trim() };
      }
      return { ok: false, unconfirmed: true, message: 'Submission did not complete before timeout.' };
    } catch (e) { return { ok: false, message: String(e) }; }
  })()`;
  return domEval(tab, script);
}
