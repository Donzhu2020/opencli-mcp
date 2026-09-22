/** Adapter Arg[] → zod input shape (the single source for MCP tool schemas and the object API). */
import { z, type ZodTypeAny } from 'zod';
import { ActionError } from '../api/errors.js';

import type { Arg } from '@opencli-mcp/adapter-sdk';
export type { Arg } from '@opencli-mcp/adapter-sdk';

export interface ArgView {
  name: string;
  type?: string;
  required?: boolean;
  help?: string;
  default?: unknown;
  choices?: string[];
}

/** Agent-facing parameter table: enough to call the command without a failed attempt. */
export function argSpec(args: Arg[] = []): ArgView[] {
  return args.map((a) => ({
    name: a.name,
    ...(a.type && { type: a.type }),
    ...(a.required && { required: true }),
    ...(a.help && { help: a.help }),
    ...(a.default !== undefined && { default: a.default }),
    ...(a.choices?.length && { choices: a.choices }),
  }));
}

export function argToZod(arg: Arg): ZodTypeAny {
  let t: ZodTypeAny;
  if (arg.choices && arg.choices.length > 0) t = z.enum(arg.choices as [string, ...string[]]);
  else if (arg.type === 'int') t = z.number().int();
  else if (arg.type === 'number') t = z.number();
  else if (arg.type === 'boolean') t = z.boolean();
  else t = z.string();
  const desc = [arg.help, arg.default !== undefined ? `default: ${JSON.stringify(arg.default)}` : ''].filter(Boolean).join(' · ');
  if (desc) t = t.describe(desc);
  return arg.required ? t : t.optional();
}

export function argsToShape(args: Arg[] = [], extra: Record<string, ZodTypeAny> = {}): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const a of args) shape[a.name] = argToZod(a);
  for (const [k, v] of Object.entries(extra)) if (!(k in shape)) shape[k] = v;
  return shape;
}

function invalidArgs(message: string, args: Arg[]): never {
  throw new ActionError('invalid_args', message, 'Call again with the fields in details.expected. Do not guess.', { details: { expected: argSpec(args) } });
}

/** Coerce + validate kwargs against Arg[] (types, choices, required, defaults). */
export function coerceArgs(cmdArgs: Arg[] = [], kwargs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...kwargs };
  for (const def of cmdArgs) {
    const val = out[def.name];
    if (def.required && (val === undefined || val === null || val === '')) invalidArgs(`Argument "${def.name}" is required. ${def.help ?? ''}`.trim(), cmdArgs);
    if (val !== undefined && val !== null) {
      if (def.type === 'int' || def.type === 'number') {
        const n = Number(val);
        if (!Number.isFinite(n) || (def.type === 'int' && !Number.isInteger(n))) invalidArgs(`Argument "${def.name}" must be a ${def.type}`, cmdArgs);
        out[def.name] = n;
      } else if (def.type === 'boolean') {
        out[def.name] = typeof val === 'string' ? ['true', '1'].includes(val.toLowerCase()) : Boolean(val);
      }
      if (def.choices?.length && !def.choices.map(String).includes(String(out[def.name]))) {
        invalidArgs(`Argument "${def.name}" must be one of: ${def.choices.join(', ')}`, cmdArgs);
      }
    } else if (def.default !== undefined) {
      out[def.name] = def.default;
    }
  }
  return out;
}
