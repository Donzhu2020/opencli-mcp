/** MCP schema projected from the same per-action contract used by boundary validation. */
import { z } from 'zod';
import { ACTION_RULES } from './act-input.js';
import type { ActAction } from '../api/tab.js';

export const targetSchema = z.object({
  ref: z.string().optional().describe('eN ref from tab_observe; do not combine with another locator'),
  selector: z.string().optional().describe('Playwright selector; do not combine with ref, role, or x/y'),
  within: z.string().optional().describe('scope: container selector or eN ref'),
  nth: z.number().int().optional(),
  role: z.string().optional().describe('ARIA role'),
  name: z.string().optional().describe('accessible name with role'),
  label: z.string().optional(),
  text: z.string().optional(),
  testid: z.string().optional(),
  x: z.number().optional().describe('viewport x; y is required with it'),
  y: z.number().optional(),
  frame: z.union([z.string(), z.number().int(), z.array(z.union([z.string(), z.number().int()]))]).optional(),
}).strict().describe('Exactly one locator: ref, selector, role/name, label, text, testid, or x/y');

const common = {
  tab: z.string().optional().describe('required when the session has more than one tab'),
  observe: z.boolean().default(false).describe('also return the page state after the action'),
};

function variant(actions: ActAction[]) {
  const action = actions[0];
  const rule = ACTION_RULES[action];
  const shape: Record<string, z.ZodTypeAny> = { action: actions.length === 1 ? z.literal(action) : z.enum(actions as [ActAction, ...ActAction[]]), ...common };
  if (rule.target === 'required') shape.target = targetSchema;
  else if (rule.target === 'optional') shape.target = targetSchema.optional();
  if (rule.value === 'present') shape.value = z.string().describe('empty string clears the field');
  else if (rule.value === 'nonempty') shape.value = z.string().min(1);
  if (rule.files === 'required') shape.files = z.array(z.string().min(1)).min(1);
  if (rule.to === 'required') shape.to = targetSchema;
  if (rule.scroll) {
    shape.direction = z.enum(['up', 'down', 'left', 'right']).optional();
    shape.amount = z.number().optional();
  }
  if (action === 'click') shape.method = z.enum(['cdp', 'dom']).optional().describe('dom = HTMLElement.click(), only after the real mouse was not delivered or the element has no box');
  if (!['back', 'forward', 'reload'].includes(action)) shape.settleMs = z.number().int().min(0).max(10_000).default(600);
  return z.object(shape).strict();
}

const groups = new Map<string, ActAction[]>();
for (const action of Object.keys(ACTION_RULES) as ActAction[]) {
  const key = JSON.stringify({ ...ACTION_RULES[action], method: action === 'click', navigation: ['back', 'forward', 'reload'].includes(action) });
  groups.set(key, [...(groups.get(key) ?? []), action]);
}
const variants = [...groups.values()].map(variant);
const validator = z.discriminatedUnion('action', variants as [ReturnType<typeof variant>, ReturnType<typeof variant>, ...Array<ReturnType<typeof variant>>]);
const standard = validator['~standard'];

/** JSON Schema references keep the action alternatives readable without repeating the target contract. */
const compactJson = () => {
  const schema = structuredClone(standard.jsonSchema.input({ target: 'draft-2020-12' })) as Record<string, unknown> & { oneOf?: Array<{ properties?: Record<string, unknown> }> };
  const target = schema.oneOf?.find((entry) => entry.properties?.target)?.properties?.target;
  if (target) {
    schema.$defs = { Target: target };
    for (const entry of schema.oneOf ?? []) {
      if (entry.properties?.target) entry.properties.target = { $ref: '#/$defs/Target' };
      if (entry.properties?.to) entry.properties.to = { $ref: '#/$defs/Target' };
    }
  }
  return schema;
};
export const actionSchema = { '~standard': { ...standard, jsonSchema: { ...standard.jsonSchema, input: compactJson } } };
