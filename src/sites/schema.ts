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
  const desc = [arg.help, arg.default !== undefined ? `default: ${JSON.stringify(arg.default)}` : ''].filter(Boolean).join(' · ');
  if (desc) t = t.describe(desc);
  return arg.required ? t : t.optional();
}

export function argsToShape(args: Arg[], extra: Record<string, ZodTypeAny> = {}): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const a of args) shape[a.name] = argToZod(a);
  return { ...shape, ...extra };
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
