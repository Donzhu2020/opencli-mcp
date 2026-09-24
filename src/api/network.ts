/** Bounded, two-stage network evidence for agents. Raw captures stay in the session log. */
export interface NetworkEntry extends Record<string, unknown> { seq: number }

export function networkSummary(e: NetworkEntry): Record<string, unknown> {
  return {
    seq: e.seq,
    requestId: e.requestId,
    url: e.url ?? e.name,
    method: e.method ?? 'GET',
    status: e.responseStatus ?? e.status,
    contentType: e.responseContentType ?? e.contentType ?? e.mimeType,
    resourceType: e.resourceType,
    timestamp: e.timestamp ?? e.startTime ?? e.ts,
    completed: e.done ?? true,
    requestBytes: e.requestBodyFullSize,
    responseBytes: e.responseBodyFullSize,
    responseTruncated: e.responseBodyTruncated ?? false,
    requestTruncated: e.requestBodyTruncated ?? false,
  };
}

export function networkDetail(e: NetworkEntry, opts: { part?: 'request' | 'response'; start?: number; maxChars?: number } = {}): Record<string, unknown> {
  const part = opts.part ?? 'response';
  const raw = String(part === 'request' ? e.requestBodyPreview ?? '' : e.responsePreview ?? '');
  const fullSize = Number(part === 'request' ? e.requestBodyFullSize ?? raw.length : e.responseBodyFullSize ?? raw.length);
  const start = Math.min(Math.max(0, opts.start ?? 0), raw.length);
  const maxChars = Math.min(Math.max(200, opts.maxChars ?? 8_000), 100_000);
  const nextStart = start + maxChars < raw.length ? start + maxChars : undefined;
  return {
    ...networkSummary(e),
    requestHeaders: e.requestHeaders ?? {},
    responseHeaders: e.responseHeaders ?? {},
    body: { part, text: raw.slice(start, start + maxChars), start, ...(nextStart !== undefined && { nextStart }), fullSize,
      captureTruncated: part === 'request' ? e.requestBodyTruncated ?? false : e.responseBodyTruncated ?? false },
  };
}
