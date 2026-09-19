/** OpenCLI Arg[] → zod input shape (single source for MCP tool schemas and the object API). */
import { z, type ZodTypeAny } from 'zod';
import type { Arg } from '@jackwener/opencli/registry';

export function argToZod(arg: Arg): ZodTypeAny {
  let t: ZodTypeAny;
  if (arg.choices && arg.choices.length > 0) t = z.enum(arg.choices as [string, ...string[]]);
  else if (arg.type === 'int') t = z.number().int();
  else if (arg.type === 'number') t = z.number();
  else if (arg.type === 'boolean' || arg.type === 'bool') t = z.boolean();
  else t = z.string();
  const desc = [deCli(arg.help), arg.default !== undefined ? `default: ${JSON.stringify(arg.default)}` : ''].filter(Boolean).join(' · ');
  if (desc) t = t.describe(desc);
  return arg.required ? t : t.optional();
}

/**
 * CLI-only args that OpenCLI exposes for a person at a terminal but that make no sense to an MCP agent, so we never
 * project them into a tool schema / discovery signature:
 *  - output / output-file: write results to a path on the HOST's disk — unreadable to a remote agent (results come back over the protocol).
 *  - resume-file: batch-resume state for long shell jobs.
 *  - all: fetch every page to disk/memory; MCP-native is a bounded page + the agent paging with limit/page/cursor.
 *  - timeout: a per-command wall-clock knob; MCP has progress + cancellation and the runtime's own default.
 *  - stdout: print to the terminal instead of returning — MCP results always come back over the protocol.
 * The executor still honours any of these if the js escape hatch passes one; we just don't advertise them.
 * (Deliberately NOT stripped despite CLI-ish names: `no-progress` skips a real API call, `column` selects a data
 * channel, `formats`/`stable`/`json` are data-shape options — verified per-adapter, not name-matched.)
 */
export const CLI_ONLY_ARGS = new Set(['output', 'output-file', 'resume-file', 'all', 'timeout', 'stdout']);

/** Strip CLI-flag grammar (`--flag` → `flag`) from agent-facing help/description text — the corpus was written for a shell. */
export function deCli(text: string | undefined | null): string {
  return (text ?? '').replace(/(^|\s)--(?=[A-Za-z])/g, '$1');
}

/** Drop CLI-only args when projecting a command's Arg[] to any agent-facing surface (tool schema, search signature, site resource). */
export function projectArgs(args: Arg[]): Arg[] {
  return args.filter((a) => !CLI_ONLY_ARGS.has(a.name));
}

export function argsToShape(args: Arg[], extra: Record<string, ZodTypeAny> = {}): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const a of projectArgs(args)) shape[a.name] = argToZod(a);
  for (const [k, v] of Object.entries(extra)) if (!(k in shape)) shape[k] = v;
  return shape;
}

/** Coerce + validate kwargs against Arg[] the way OpenCLI's executor does (kept local: not a public export). */
export function coerceArgs(cmdArgs: Arg[], kwargs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...kwargs };
  for (const def of cmdArgs) {
    const val = out[def.name];
    if (def.required && (val === undefined || val === null || val === '')) {
      throw Object.assign(new Error(`Argument "${def.name}" is required. ${def.help ?? ''}`.trim()), { code: 'ARGUMENT' });
    }
    if (val !== undefined && val !== null) {
      if (def.type === 'int' || def.type === 'number') {
        const n = Number(val);
        if (!Number.isFinite(n) || (def.type === 'int' && !Number.isInteger(n))) throw Object.assign(new Error(`Argument "${def.name}" must be a ${def.type}`), { code: 'ARGUMENT' });
        out[def.name] = n;
      } else if (def.type === 'boolean' || def.type === 'bool') {
        out[def.name] = typeof val === 'string' ? ['true', '1'].includes(val.toLowerCase()) : Boolean(val);
      }
      if (def.choices?.length && !def.choices.map(String).includes(String(out[def.name]))) {
        throw Object.assign(new Error(`Argument "${def.name}" must be one of: ${def.choices.join(', ')}`), { code: 'ARGUMENT' });
      }
    } else if (def.default !== undefined) {
      out[def.name] = def.default;
    }
  }
  return out;
}
