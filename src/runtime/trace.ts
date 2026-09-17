/** Session trace: the evidence stream that tools_compile turns into a tool draft, and that resources expose. */
export type TraceEvent = { t: number; page?: string } & (
  | { kind: 'goto'; url: string }
  | { kind: 'act'; action: string; target: string; targetSpec?: Record<string, unknown>; targetRef?: string; value?: string; matchLevel?: string; ok: boolean }
  | { kind: 'observe'; mode: string; summary?: string }
  | { kind: 'network'; url: string; method?: string; status?: number; contentType?: string; bodyBytes?: number }
  | { kind: 'evaluate'; code: string }
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
