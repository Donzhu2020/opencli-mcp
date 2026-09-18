/** Session trace: the evidence stream that tools_compile turns into a tool draft, and that resources expose. */
/** A captured request kept as compile evidence — separate from the step trace so it can never evict a goto/act/expect. */
export interface NetworkEvidence {
  url: string; method?: string; status?: number; contentType?: string; bodyBytes?: number;
  resourceType?: string; requestHeaders?: Record<string, string>; auth?: boolean; postData?: string; responseSample?: string;
  /** the step that triggered it, and the tab it came from */ after?: string; page?: string;
}

export type TraceEvent = { t: number; page?: string } & (
  | { kind: 'goto'; url: string }
  | { kind: 'act'; action: string; target: string; targetSpec?: Record<string, unknown>; targetSelector?: string; targetRef?: string; value?: string; matchLevel?: string; ok: boolean }
  | { kind: 'observe'; mode: string; summary?: string; /** head of the state text — evidence of what the agent saw, matched against captured responses by tools_compile */ sample?: string }
  | { kind: 'expect'; what: Record<string, unknown>; ok: boolean }
  | { kind: 'evaluate'; code: string; result?: string }
  | { kind: 'site'; site: string; name: string; ok: boolean; elapsedMs: number }
  | { kind: 'note'; text: string }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TraceInput = DistributiveOmit<TraceEvent, 't'> & { t?: number };

export class TraceRecorder {
  readonly events: TraceEvent[] = [];
  constructor(private readonly max = 2000) {}
  record(e: TraceInput): void {
    this.events.push({ t: Date.now(), ...e } as TraceEvent);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }
  clear(): void { this.events.length = 0; }
}
