// Shared helpers for the Bilibili adapters. Files starting with `_` are not commands.
import { errors } from '@opencli-mcp/adapter-sdk';

/** Be on bilibili.com so page-context fetches to api.bilibili.com carry the .bilibili.com session cookies. */
export async function ensureOnBili(tab) {
  const u = await tab.url().catch(() => null);
  if (!u || !/^https?:\/\/([a-z0-9-]+\.)?bilibili\.com/i.test(u)) await tab.goto('https://www.bilibili.com', { waitUntil: 'load' });
}

/** GET a Bilibili web-interface JSON endpoint through the logged-in page; unwrap { code, message, data }. */
export async function biliGet(tab, url) {
  const res = await tab.fetchJson(url);
  if (!res || typeof res !== 'object') throw errors.upstream('Bilibili returned no JSON');
  if (res.code !== 0) {
    if (res.code === -101 || res.code === -400) throw errors.auth(`Bilibili: ${res.message || 'not logged in'}`);
    throw errors.upstream(`Bilibili error ${res.code}: ${res.message || 'unknown'}`);
  }
  return res.data;
}
