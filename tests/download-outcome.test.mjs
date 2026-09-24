import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadCursor, pageDownloadsAfter, registerListeners, waitForDownload } from '../extension/src/cdp.js';

const event = () => ({ addListener: vi.fn() });

afterEach(() => { vi.unstubAllGlobals(); });

describe('page-scoped download outcome', () => {
  it('ignores unrelated Chrome downloads and completes the file from this page event', async () => {
    const onEvent = event();
    const onCreated = event();
    const items = [
      { id: 10, url: 'https://other.test/old.csv', finalUrl: 'https://other.test/old.csv', state: 'complete', filename: '/tmp/old.csv' },
      { id: 11, url: 'https://example.test/report.csv', finalUrl: 'https://example.test/report.csv', state: 'complete', filename: '/tmp/report.csv' },
    ];
    const search = vi.fn(async ({ id }) => items.filter((item) => item.id === id));
    vi.stubGlobal('chrome', {
      debugger: { onEvent, onDetach: event() },
      tabs: { onRemoved: event(), onUpdated: event() },
      downloads: { search, onCreated },
    });
    registerListeners();
    const listener = onEvent.addListener.mock.calls[0][0];
    const created = onCreated.addListener.mock.calls[0][0];
    const cursor = downloadCursor(901);
    created({ id: 10, url: 'https://other.test/old.csv', finalUrl: 'https://other.test/old.csv' });
    listener({ tabId: 901 }, 'Page.downloadWillBegin', { url: 'https://example.test/report.csv', suggestedFilename: 'report.csv' });
    created({ id: 11, url: 'https://example.test/report.csv', finalUrl: 'https://example.test/report.csv' });
    expect(pageDownloadsAfter(901, cursor)).toEqual([expect.objectContaining({ suggestedFilename: 'report.csv' })]);
    expect(await waitForDownload(901, cursor, 1000)).toMatchObject({ downloaded: true, started: true, id: 11, association: 'url+event' });
  });

  it('does not choose a file when Chrome has multiple matches', async () => {
    const onEvent = event();
    const onCreated = event();
    vi.stubGlobal('chrome', {
      debugger: { onEvent, onDetach: event() },
      tabs: { onRemoved: event(), onUpdated: event() },
      downloads: { onCreated, search: vi.fn(async () => [
        { id: 20, url: 'https://example.test/export', finalUrl: 'https://example.test/export', state: 'complete' },
        { id: 21, url: 'https://example.test/export', finalUrl: 'https://example.test/export', state: 'complete' },
      ]) },
    });
    registerListeners();
    const listener = onEvent.addListener.mock.calls[0][0];
    const created = onCreated.addListener.mock.calls[0][0];
    const cursor = downloadCursor(902);
    listener({ tabId: 902 }, 'Page.downloadWillBegin', { url: 'https://example.test/export', suggestedFilename: 'export.csv' });
    created({ id: 20, url: 'https://example.test/export', finalUrl: 'https://example.test/export' });
    created({ id: 21, url: 'https://example.test/export', finalUrl: 'https://example.test/export' });
    expect(await waitForDownload(902, cursor, 1000)).toMatchObject({ downloaded: false, started: true, state: 'ambiguous', candidates: 2 });
  });
  it('rejects a completed file with the same URL that existed before the action', async () => {
    const onEvent = event();
    const onCreated = event();
    const search = vi.fn(async () => [{ id: 40, url: 'https://example.test/repeated.csv', finalUrl: 'https://example.test/repeated.csv', state: 'complete' }]);
    vi.stubGlobal('chrome', { debugger: { onEvent, onDetach: event() }, tabs: { onRemoved: event(), onUpdated: event() }, downloads: { onCreated, search } });
    registerListeners();
    onCreated.addListener.mock.calls[0][0]({ id: 40, url: 'https://example.test/repeated.csv', finalUrl: 'https://example.test/repeated.csv' });
    const cursor = downloadCursor(904);
    onEvent.addListener.mock.calls[0][0]({ tabId: 904 }, 'Page.downloadWillBegin', { url: 'https://example.test/repeated.csv', suggestedFilename: 'repeated.csv' });
    expect(await waitForDownload(904, cursor, 220)).toMatchObject({ downloaded: false, started: true, state: 'unconfirmed' });
    expect(search).not.toHaveBeenCalled();
  });
});
