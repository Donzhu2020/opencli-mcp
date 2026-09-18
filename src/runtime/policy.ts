/**
 * Policy — the *shapes* of authorization, decoupled from the extension's permissions.
 * Defaults are permissive (single-user local machine); the shapes are what matters:
 *   needs_origin_approval  — first navigation to a new host (when `askNewOrigins` is on)
 *   needs_confirmation      — write actions that change the user's accounts (when `confirmWrites` is on)
 * Denials carry `retryable`; a non-retryable denial must not be bypassed through another path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { OPENCLI_MCP_DIR, readConfig } from '../host/state.js';
import { ActionError } from '../api/errors.js';

export interface PolicyConfig { askNewOrigins?: boolean; confirmWrites?: boolean; allowedHosts?: string[]; blockedHosts?: string[] }
export type Decision = { allowed: true } | { allowed: false; code: string; message: string; hint?: string; retryable: boolean };

const ALLOWLIST_FILE = path.join(OPENCLI_MCP_DIR, 'allowed-hosts.json');

export class Policy {
  private allowed = new Set<string>();
  private blocked = new Set<string>();
  readonly askNewOrigins: boolean;
  readonly confirmWrites: boolean;
  constructor(cfg: PolicyConfig = {}) {
    const fileCfg = (readConfig() as { policy?: PolicyConfig }).policy ?? {};
    const merged = { ...fileCfg, ...cfg };
    this.askNewOrigins = merged.askNewOrigins ?? false;
    this.confirmWrites = merged.confirmWrites ?? false;
    for (const h of merged.allowedHosts ?? []) this.allowed.add(h.toLowerCase());
    for (const h of merged.blockedHosts ?? []) this.blocked.add(h.toLowerCase());
    try { for (const h of JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8')) as string[]) this.allowed.add(h.toLowerCase()); } catch { /* none */ }
  }
  private matches(set: Set<string>, host: string): boolean {
    const h = host.toLowerCase();
    for (const s of set) if (h === s || h.endsWith(`.${s}`) || s === '*') return true;
    return false;
  }
  /** Navigation / claim policy for a host. */
  checkOrigin(url: string): Decision {
    let host: string;
    try { host = new URL(url).hostname; } catch { return { allowed: false, code: 'invalid_url', message: `not a URL: ${url}`, retryable: false }; }
    if (this.matches(this.blocked, host)) return { allowed: false, code: 'site_blocked', message: `${host} is on the blocklist`, retryable: false };
    if (!this.askNewOrigins || this.matches(this.allowed, host)) return { allowed: true };
    return { allowed: false, code: 'needs_origin_approval', message: `${host} has not been approved for this runtime`, hint: `Ask the user, then session.allowOrigin(${JSON.stringify(host)}) in js (add true to persist it for this site).`, retryable: true };
  }
  allowHost(hostRaw: string, persist = false): void {
    const host = hostRaw.toLowerCase();
    this.allowed.add(host);
    if (persist) {
      let list: string[] = [];
      try { list = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8')) as string[]; } catch { /* new */ }
      if (!list.includes(host)) { list.push(host); fs.mkdirSync(OPENCLI_MCP_DIR, { recursive: true }); fs.writeFileSync(ALLOWLIST_FILE, JSON.stringify(list, null, 2)); }
    }
  }
  /** Write-action policy: site commands with access:'write', or explicit outward actions. */
  checkWrite(what: string, confirmed: boolean): Decision {
    if (!this.confirmWrites || confirmed) return { allowed: true };
    return { allowed: false, code: 'needs_confirmation', message: `"${what}" changes the user's account or sends data; confirm with the user first`, hint: 'State the exact action, destination and data to the user; on approval re-call with confirm:true.', retryable: true };
  }
  static throwIfDenied(d: Decision): void {
    if (d.allowed) return;
    throw new ActionError(d.code, d.message, d.hint, { retryable: d.retryable });
  }
}
