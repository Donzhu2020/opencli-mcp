import { describe, expect, it } from 'vitest';
import gmailSearch from '../adapters/gmail/search.js';
import gmailThread from '../adapters/gmail/thread.js';
import { parseBatchView, parseBootstrapUserLabels, parseFetchData, parseLabelStatus, syncThreadId } from '../adapters/gmail/_shared.js';
import facebookSearch from '../adapters/facebook/search.js';
import facebookEvents, { mapEvents } from '../adapters/facebook/events.js';
import { mapFeedEdges } from '../adapters/facebook/feed.js';
import facebookNotifications, { mapNotifications } from '../adapters/facebook/notifications.js';
import facebookFriends, { mapFriendSuggestions } from '../adapters/facebook/friends.js';
import { mapGroups } from '../adapters/facebook/groups.js';
import { parsePostRows, parseProfileSearch } from '../adapters/facebook/_shared.js';
import { jobCardsPath, mapJobCard } from '../adapters/linkedin/jobs.js';
import { jobId, mapJobDetail } from '../adapters/linkedin/job-detail.js';
import { mapConversations } from '../adapters/linkedin/inbox.js';
import { messagePayload, parseSalesRecipient, remainingCredits } from '../adapters/linkedin/salesnav-message.js';
import { mapThreadMessages, threadPath } from '../adapters/linkedin/salesnav-thread.js';
import { activityDate, profileIdentity } from '../adapters/linkedin/_profile.js';
import { mapConnection } from '../adapters/linkedin/connections.js';
import { inboxPath } from '../adapters/linkedin/salesnav-inbox.js';
import { mapProfileAnalytics } from '../adapters/linkedin/profile-analytics.js';
import { mapServices, servicesUrlFromCard } from '../adapters/linkedin/services-read.js';
import { inboxCursor, mapMarketplaceThreads } from '../adapters/facebook/marketplace-inbox.js';
import { listingsCursor, mapListingEdges } from '../adapters/facebook/marketplace-listings.js';
import discordSend from '../adapters/discord/send.js';
import discordDelete from '../adapters/discord/delete.js';
import { discordRoute, messageRow } from '../adapters/discord/_shared.js';

function batchFixture() {
  const body = Array(19).fill(null);
  const record = [];
  record[0] = 'Subject'; record[1] = 'Preview'; record[2] = 1_790_000_000_000;
  record[3] = 'thread-f:12345';
  const message = [];
  message[1] = [null, 'sender@example.com', 'Sender'];
  message[10] = ['^u', '^i'];
  record[4] = [message];
  body[2] = [[record]];
  return body;
}

function threadFixture() {
  const record = [];
  record[0] = [[null, 'to@example.com']];
  record[1] = [];
  record[4] = 'Subject'; record[5] = [];
  record[5][4] = [];
  record[5][4][6] = 'Message body';
  record[6] = 'Preview';
  record[10] = [];
  record[10][14] = 'Sender'; record[10][16] = 'sender@example.com';
  record[13] = [[[null, 'attachment-1', null, [null, null, 'file.txt', 'text/plain', 42]]]];
  record[16] = 1_790_000_000_000;
  return [null, [['thread-f:12345', null, [['msg-1', record]]]]];
}

function gmailTab() {
  let navigated = false;
  let query = 'is:read';
  const request = {
    url: 'https://mail.google.com/sync/u/0/i/bv?hl=en', method: 'POST', responseStatus: 200,
    requestBodyTruncated: false,
    requestHeaders: {
      'Content-Type': 'application/json', 'X-Framework-Xsrf-Token': 'test',
      'X-Gmail-BTAI': 'test', 'X-Gmail-Storage-Request': 'test', 'X-Google-BTD': 'test',
    },
  };
  const calls = [];
  return {
    calls,
    url: async () => 'https://mail.google.com/mail/u/0/#inbox',
    goto: async (url) => { navigated = true; query = decodeURIComponent(url.split('#search/')[1] || query); },
    network: {
      start: async () => true,
      read: async () => ({ cursor: navigated ? 1 : 0, entries: navigated ? [{ ...request, requestBodyPreview: JSON.stringify([[79, 51, null, query]]) }] : [], hasMore: false }),
    },
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      return url.includes('/i/fd?') ? threadFixture() : batchFixture();
    },
  };
}

describe('Gmail JSON API adapters', () => {
  it('combines live label status with Gmail bootstrap definitions', () => {
    const html = String.raw`[[\"^x_123\",\"Work\",null,null]],[[\"^x_456\",\"Personal\",null]]`;
    const userLabels = parseBootstrapUserLabels(html);
    expect(userLabels).toEqual([{ id: '^x_123', name: 'Work' }, { id: '^x_456', name: 'Personal' }]);
    const status = [null, null, [[['^i', 5, 10], ['^x_123', 2, 3], ['^x_456', 0, 4], ['^hidden', 1, 1]]]];
    expect(parseLabelStatus(status, userLabels)).toEqual([
      { id: '^i', name: 'Inbox', type: 'system', unreadCount: 5, totalCount: 10 },
      { id: '^x_123', name: 'Work', type: 'user', unreadCount: 2, totalCount: 3 },
      { id: '^x_456', name: 'Personal', type: 'user', unreadCount: 0, totalCount: 4 },
    ]);
    expect(() => parseLabelStatus(status, [])).toThrow(/omitted the name/);
  });
  it('parses summary and message records without page extraction', () => {
    expect(parseBatchView(batchFixture())[0]).toMatchObject({ threadId: 'thread-f:12345', unread: true, from: 'sender@example.com' });
    expect(parseFetchData(threadFixture())[0]).toMatchObject({ messageId: 'msg-1', body: 'Message body', attachments: [{ name: 'file.txt', size: 42 }] });
    expect(syncThreadId('0000003039')).toBe('thread-f:12345');
  });

  it('calls batch-view and fetch-data with captured API headers', async () => {
    const tab = gmailTab();
    expect((await gmailSearch.run({ tab, args: { query: 'is:read', limit: 1 } })).rows).toHaveLength(1);
    expect((await gmailThread.run({ tab, args: { thread: 'thread-f:12345' } })).rows).toHaveLength(1);
    expect(tab.calls.map((item) => item.url)).toEqual([
      'https://mail.google.com/sync/u/0/i/bv?hl=en',
      'https://mail.google.com/sync/u/0/i/fd?hl=en',
    ]);
    expect(tab.calls[1].opts.body).toEqual([[["thread-f:12345", 1]], 2]);
  });
});

describe('Facebook GraphQL search adapter', () => {
  const response = { data: { serpResponse: { results: { edges: [{ rendering_strategy: { view_model: {
    loggedProfile: { id: '123', name: 'Example Group', url: 'https://www.facebook.com/groups/123', typeaheadProfilePicture: { uri: 'https://example.com/image' } },
    primary_snippet_text_with_entities: { text: 'Example description' },
  } } }] } } } };

  it('maps stable profiles and rejects malformed payloads', () => {
    expect(parseProfileSearch(response).rows[0]).toMatchObject({ id: '123', name: 'Example Group', description: 'Example description' });
    expect(() => parseProfileSearch({ data: {} })).toThrow(/shape/);
  });

  it('replays the current GraphQL document with a fresh first-page cursor', async () => {
    const variables = { args: { text: 'OpenAI', experience: { type: 'GROUPS_TAB' } }, cursor: '{old}', count: 5 };
    const form = new URLSearchParams({ fb_api_req_friendly_name: 'SearchCometResultsPaginatedResultsQuery', doc_id: '123', variables: JSON.stringify(variables) });
    let navigated = false;
    let script = '';
    const tab = {
      url: async () => 'https://www.facebook.com/',
      goto: async () => { navigated = true; },
      network: { start: async () => true, read: async () => ({ cursor: navigated ? 1 : 0, entries: navigated ? [{ method: 'POST', requestBodyPreview: form.toString() }] : [] }) },
      evaluate: async (code) => { script = code; return response; },
    };
    const result = await facebookSearch.run({ tab, args: { query: 'OpenAI', type: 'groups', limit: 3 } });
    expect(result.rows).toHaveLength(1);
    expect(script).toContain('fetch(');
    expect(script).not.toContain('document.');
    const transmitted = JSON.parse(script.match(/body: ("[^"]*(?:\\.[^"]*)*"),/)?.[1] || '""');
    const replayed = JSON.parse(new URLSearchParams(transmitted).get('variables'));
    expect(replayed).toMatchObject({ cursor: null, count: 3 });
  });
});

describe('Facebook streaming posts API', () => {
  it('maps only stable post fields from the first GraphQL chunk', () => {
    const post = { id: 'story-1', post_id: '123', permalink_url: 'https://www.facebook.com/example/posts/123',
      creation_time: 1_790_000_000, actors: [{ id: '456', name: 'Example' }],
      comet_sections: { content: { story: { message: { text: 'Post text' } } } },
    };
    const result = parsePostRows({ edges: [{ rendering_strategy: { view_model: { click_model: { story: post } } } }], pageInfo: { has_next_page: true, end_cursor: 'next' } });
    expect(result.rows[0]).toMatchObject({ id: '123', author: 'Example', text: 'Post text', url: 'https://www.facebook.com/example/posts/123' });
    expect(result.pageInfo.end_cursor).toBe('next');
  });
});

describe('Facebook events GraphQL adapter', () => {
  it('maps event identity and pagination from API data', () => {
    const result = mapEvents({ data: { node: { content_tab: { requested_tab: { events: {
      edges: [{ node: { id: '123', name: 'Example Event', eventUrl: 'https://www.facebook.com/events/123/', start_timestamp: 1_790_000_000, event_place: { name: 'Tokyo' } } }],
      page_info: { has_next_page: true, end_cursor: 'next' },
    } } } } } });
    expect(result.rows[0]).toMatchObject({ id: '123', name: 'Example Event', place: 'Tokyo', url: 'https://www.facebook.com/events/123/' });
    expect(result.pageInfo.end_cursor).toBe('next');
    expect(facebookEvents.access).toBe('read');
    expect(() => mapEvents({ data: {} })).toThrow(/shape/);
  });
});

describe('Facebook news feed GraphQL adapter', () => {
  it('maps story edges and skips non-post feed units', () => {
    const rows = mapFeedEdges([
      { node: { __typename: 'ShowcaseFeedUnit', id: 'promo' } },
      { node: { __typename: 'Story', post_id: '123', creation_time: 1_790_000_000,
        permalink_url: 'https://www.facebook.com/example/posts/123',
        comet_sections: { content: { story: { actors: [{ id: '42', name: 'Example' }], message: { text: 'Hello' } } } } } },
    ]);
    expect(rows).toMatchObject([{ id: '123', author: 'Example', author_id: '42', text: 'Hello' }]);
  });
});

describe('Facebook notifications GraphQL adapter', () => {
  it('maps only notification rows and preserves their cursor', () => {
    const result = mapNotifications({ data: { viewer: { notifications_page: {
      edges: [
        { node: { row_type: 'BUCKET_HEADER' } },
        { node: { notif: { notif_id: '123', seen_state: 'SEEN_BUT_UNREAD', body: { text: 'A notification' }, creation_time: { timestamp: 1_790_000_000 }, url: 'https://www.facebook.com/photo/?fbid=1', notif_type: 'photo' } } },
      ], page_info: { has_next_page: true, end_cursor: 'next' },
    } } } });
    expect(result.rows).toEqual([{ id: '123', text: 'A notification', unread: true, time: '2026-09-21T14:13:20.000Z', url: 'https://www.facebook.com/photo/?fbid=1', type: 'photo' }]);
    expect(result.pageInfo.end_cursor).toBe('next');
    expect(facebookNotifications.access).toBe('read');
  });
});

describe('Facebook friend suggestions GraphQL adapter', () => {
  it('maps suggestions without page extraction', () => {
    const result = mapFriendSuggestions({ data: { viewer: { pymk_grid: { edges: [{ node: {
      id: '123', name: 'Alice', social_context: { text: '3 mutual friends' }, friendship_status: 'CAN_REQUEST',
    } }], page_info: { has_next_page: false } } } } });
    expect(result.rows[0]).toMatchObject({ id: '123', name: 'Alice', mutual_count: 3, url: 'https://www.facebook.com/profile.php?id=123' });
    expect(facebookFriends.access).toBe('read');
  });
});

describe('Facebook groups GraphQL adapter', () => {
  it('maps joined and managed groups', () => {
    const response = { data: {
      nonAdminGroups: { groups_tab: { tab_groups_list: { edges: [{ node: { id: '123', name: 'Example Group', last_post_time: 1_790_000_000 } }] } } },
      adminGroups: { groups_tab: { tab_groups_list: { edges: [{ node: { id: '456', name: 'Managed Group' } }] } } },
    } };
    expect(mapGroups(response)).toMatchObject([{ id: '123', kind: 'member' }, { id: '456', kind: 'managed' }]);
    expect(mapGroups(response, 'managed')).toMatchObject([{ id: '456', kind: 'managed' }]);
  });
});

describe('LinkedIn Voyager adapters', () => {
  it('maps owner analytics from the two live Voyager response types', () => {
    const summary = { numViews: 41, timeFrame: 'LAST_90_DAYS', numViewsChangeInPercentage: 25 };
    const views = { elements: [{ value: { 'com.linkedin.voyager.identity.me.wvmpOverview.WvmpViewersCard': {
      insightCards: [{ value: { 'com.linkedin.voyager.identity.me.wvmpOverview.WvmpSummaryInsightCard': summary } }],
    } } }] };
    expect(mapProfileAnalytics(views, { metadata: { numAppearances: 59 } }, { numConnections: 491 }, { publicIdentifier: 'example' }))
      .toMatchObject({ profile_views: 41, search_appearances: 59, connections: 491, profile_url: 'https://www.linkedin.com/in/example/' });
    expect(() => mapProfileAnalytics({}, {}, {}, { publicIdentifier: 'example' })).toThrow(/shape/);
  });
  it('discovers and maps a Services page from Voyager JSON', () => {
    const url = 'https://www.linkedin.com/services/page/abc123/';
    expect(servicesUrlFromCard({ topComponents: [{ footerAction: { actionUnion: { navigationAction: { actionTarget: url } } } }] })).toBe(url);
    const sections = [
      { description: { detailsBody: { text: 'Mentoring' }, serviceLocation: { subtitle: { text: 'Remote' }, accessibilityText: 'Anywhere' }, servicePrice: { subtitle: { text: 'Contact for pricing' } } } },
      { services: { providedServicesResolutionResults: [{ name: 'Training' }] } },
    ];
    const response = { data: { marketplacesDashServicesPageViewByVanityName: { elements: [
      { businessName: { text: 'Example Services' }, detailViewSectionsResolutionResults: sections,
        servicesPageMediaSections: { elements: [{ title: { text: 'Portfolio' }, description: { text: 'Demo' } }] } },
    ] } } };
    expect(mapServices(response, 'abc123')).toMatchObject({ overview: 'Mentoring', services_count: 1, media_count: 1, pricing: 'Contact for pricing' });
    expect(() => mapServices({ data: {} }, 'abc123')).toThrow(/shape/);
  });
  it('accepts only LinkedIn profile URLs and decodes activity time', () => {
    expect(profileIdentity('https://www.linkedin.com/in/jakevin/')).toBe('jakevin');
    expect(() => profileIdentity('https://www.linkedin.com.evil.example/in/jakevin/')).toThrow();
    expect(activityDate('urn:li:ugcPost:7434151475959775232')).toBe('2026-03-02T08:23:51.724Z');
  });
  it('builds the Sales Navigator API payload for a resolved lead', () => {
    const recipient = parseSalesRecipient('https://www.linkedin.com/sales/lead/P1,NAME_SEARCH,T1');
    expect(recipient.urn).toBe('urn:li:fs_salesProfile:(P1,NAME_SEARCH,T1)');
    expect(messagePayload(recipient.urn, 'Hello', 'A short note', false, '0123456789abcdef')).toEqual({
      createMessageRequest: { recipients: [recipient.urn], subject: 'Hello', body: 'A short note',
        copyToCrm: false, trackingId: '0123456789abcdef' },
    });
    expect(remainingCredits({ elements: [{ type: 'LSS_INMAIL', value: 3 }] })).toBe(3);
  });
  it('maps Sales Navigator thread history in chronological order', () => {
    expect(threadPath('2-ab/c', 40)).toContain('/salesApiMessagingThreads/2-ab%2Fc?');
    const rows = mapThreadMessages({ id: '2-thread', totalMessageCount: 2,
      participants: ['urn:li:fs_salesProfile:lead'], participantsResolutionResults: {
        'urn:li:fs_salesProfile:lead': { fullName: 'Lead Name' },
      },
      messages: [
        { id: 'new', author: 'urn:li:fs_salesProfile:lead', body: 'Second', deliveredAt: 2000 },
        { id: 'old', author: 'urn:li:fs_salesProfile:lead', body: 'First', deliveredAt: 1000 },
      ],
    });
    expect(rows.map((row) => row.message_id)).toEqual(['old', 'new']);
    expect(rows[0].sender).toBe('Lead Name');
    expect(rows[0].total_message_count).toBe(2);
  });
  it('maps messenger conversations from the current category query response', () => {
    const response = { data: { messengerConversationsByCategoryQuery: {
      elements: [{ backendUrn: 'urn:li:messagingThread:thread-1',
        conversationParticipants: [{ hostIdentityUrn: 'other', participantType: { member: { firstName: { text: 'Ada' }, lastName: { text: 'Lovelace' } } } }],
        messages: { elements: [{ body: { text: 'Hello' } }] }, unreadCount: 1, lastActivityAt: 1_790_000_000_000 }],
      metadata: { nextCursor: 'next-page' },
    } } };
    const mapped = mapConversations(response, 'self');
    expect(mapped.nextCursor).toBe('next-page');
    expect(mapped.rows).toMatchObject([{ thread_id: 'thread-1', person_name: 'Ada Lovelace', unread: true, last_message_preview: 'Hello' }]);
  });
  it('preserves Rest.li job-query punctuation and maps cards', () => {
    const path = jobCardsPath({ query: 'software engineer', workplace: 'remote' }, 25, 10);
    expect(path).toContain('query=(origin:JOB_SEARCH_PAGE_JOB_FILTER,keywords:software%20engineer');
    expect(path).toContain('workplaceType:List(2)');
    expect(path).toContain('&start=25');
    expect(mapJobCard({ jobCardUnion: { jobPostingCard: { jobPostingUrn: 'urn:li:jobPosting:123', jobPostingTitle: 'Engineer' } } }, 0)).toMatchObject({ id: '123', title: 'Engineer' });
  });

  it('maps a connection with a stable profile URL', () => {
    expect(mapConnection({ miniProfile: { publicIdentifier: 'example', firstName: 'A', lastName: 'B' }, createdAt: 123 }, 0))
      .toMatchObject({ rank: 1, name: 'A B', url: 'https://www.linkedin.com/in/example' });
  });

  it('reads stable job detail fields from the Voyager response', () => {
    expect(jobId('https://www.linkedin.com/jobs/view/software-engineer-4469917948/')).toBe('4469917948');
    expect(mapJobDetail({ title: 'Engineer', formattedLocation: 'Remote', description: { text: 'Build software' }, workplaceTypes: ['urn:li:fs_workplaceType:2'], listedAt: 1_790_000_000_000 }, '4469917948'))
      .toMatchObject({ id: '4469917948', workplace: 'remote', description: 'Build software', url: 'https://www.linkedin.com/jobs/view/4469917948' });
  });

  it('encodes Sales Navigator decoration parentheses', () => {
    expect(inboxPath('', 2)).toContain('decoration=%28id%2C');
    expect(inboxPath('next', 2)).toContain('&pageStartsAt=next');
  });
});

describe('Facebook Marketplace GraphQL response mapping', () => {
  it('maps seller inbox and listings without DOM data', () => {
    expect(mapMarketplaceThreads({ data: { viewer: { marketplaceInboxSellerMessageThreads: { edges: [{ node: {
      id: 't1', buyer: { name: 'Alice' }, listing: { title: 'Desk' }, snippet: 'Available?', unread_count: 1,
    } }] } } } }).rows[0]).toMatchObject({ id: 't1', buyer: 'Alice', listing: 'Desk', unread: true });
    expect(mapMarketplaceThreads({ data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [] } } } }, 'buyer').rows).toEqual([]);
    expect(mapListingEdges({ data: { viewer: { marketplace_listing_sets: { edges: [{ node: { marketplace_listing: {
      id: 'l1', marketplace_listing_title: 'Desk', listing_price: { formatted_amount: '$20' },
    } } }] } } } }, 'marketplace_listing_sets', 'Active').rows[0])
      .toMatchObject({ id: 'l1', title: 'Desk', price: '$20', status: 'Active' });
    expect(() => mapMarketplaceThreads({ data: {} })).toThrow(/shape/);
    expect(() => inboxCursor('{"buyer":"x"}')).toThrow(/cursor/);
    expect(() => listingsCursor('bad')).toThrow(/cursor/);
  });
});

describe('Discord authenticated API adapters', () => {
  it('parses routes and message rows', () => {
    expect(discordRoute('https://discord.com/channels/@me/1303405787065880576')).toMatchObject({ guild: '@me', channel: '1303405787065880576' });
    expect(messageRow({ id: '123', channel_id: '456', author: { username: 'alice' }, content: 'hello', attachments: [] }))
      .toMatchObject({ message_id: '123', author: 'alice', content: 'hello' });
  });

  it('sends and deletes through authenticated HTTP requests', async () => {
    let navigated = false;
    const calls = [];
    const tab = {
      url: async () => 'https://discord.com/channels/@me/1303405787065880576',
      goto: async () => { navigated = true; },
      network: {
        start: async () => true,
        read: async () => ({ cursor: navigated ? 1 : 0, entries: navigated ? [{ requestHeaders: { Authorization: 'test-token' } }] : [] }),
      },
      fetchJson: async (url, opts) => {
        calls.push({ url, opts });
        return opts.method === 'POST' ? { id: '999999999999999999', channel_id: '1303405787065880576', author: { username: 'alice' }, content: 'test', attachments: [] } : null;
      },
    };
    const sent = await discordSend.run({ tab, args: { channel: '1303405787065880576', text: 'test' } });
    await discordDelete.run({ tab, args: { channel: '1303405787065880576', message_id: sent.message_id } });
    expect(calls.map((item) => item.opts.method)).toEqual(['POST', 'DELETE']);
    expect(calls.every((item) => item.opts.headers.authorization === 'test-token')).toBe(true);
  });
});
