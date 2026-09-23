/**
 * MCP-boundary checks for tab_act / tab_expect.
 * Typed tools reject mixed locators and fields the action does not take, before any browser call.
 * Missing value for fill/type/press/select is also rejected in the shared engine, so js cannot bypass it.
 */
import { ActionError } from '../api/errors.js';
import type { ActAction, Target } from '../api/tab.js';

export interface RawTarget {
  ref?: string;
  selector?: string;
  within?: string;
  nth?: number;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testid?: string;
  x?: number;
  y?: number;
  frame?: Target['frame'];
}

export interface ActToolInput {
  action: ActAction;
  target?: RawTarget;
  to?: RawTarget;
  value?: string;
  files?: string[];
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  method?: 'cdp' | 'dom';
}

type Need = 'required' | 'nonempty' | 'present' | 'optional' | 'forbidden';

const RULES: Record<ActAction, { target: Need; value: Need; files: Need; to: Need; scroll: boolean }> = {
  click: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  dblclick: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  hover: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  focus: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  check: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  uncheck: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  fill: { target: 'required', value: 'present', files: 'forbidden', to: 'forbidden', scroll: false },
  type: { target: 'required', value: 'nonempty', files: 'forbidden', to: 'forbidden', scroll: false },
  press: { target: 'required', value: 'nonempty', files: 'forbidden', to: 'forbidden', scroll: false },
  select: { target: 'required', value: 'nonempty', files: 'forbidden', to: 'forbidden', scroll: false },
  upload: { target: 'required', value: 'forbidden', files: 'required', to: 'forbidden', scroll: false },
  drag: { target: 'required', value: 'forbidden', files: 'forbidden', to: 'required', scroll: false },
  scroll: { target: 'optional', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: true },
  back: { target: 'forbidden', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  forward: { target: 'forbidden', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
  reload: { target: 'forbidden', value: 'forbidden', files: 'forbidden', to: 'forbidden', scroll: false },
};

const TARGET_HELP = 'Exactly one of {ref}, {selector}, {role, name?}, {name}, {label}, {text}, {testid}, or {x,y}. frame, within, and nth narrow a non-point locator.';

/** What the model can copy into the next call. Wire shape is error.details.expected. */
export function expectedAct(action: ActAction): Record<string, string> {
  const rule = RULES[action];
  return {
    action,
    tab: 'session tab id; required when more than one tab is open',
    target: rule.target === 'forbidden' ? 'forbidden' : rule.target === 'optional' ? `optional. ${TARGET_HELP}` : `required. ${TARGET_HELP}`,
    value: rule.value === 'forbidden' ? 'forbidden' : rule.value === 'present' ? 'string, required; "" clears the field' : rule.value === 'optional' ? 'optional string' : 'non-empty string, required',
    files: rule.files === 'required' ? 'non-empty string[], required' : 'forbidden',
    to: rule.to === 'required' ? `required. ${TARGET_HELP}` : 'forbidden',
    direction: rule.scroll ? 'optional up|down|left|right (default down)' : 'forbidden',
    amount: rule.scroll ? 'optional number (default 600)' : 'forbidden',
    method: action === 'click' ? 'optional cdp|dom. dom runs HTMLElement.click() and sends no mouse event. Only after not_delivered or no box.' : 'forbidden',
  };
}

function reject(action: ActAction, message: string): never {
  throw new ActionError('invalid_args', message, 'Copy expected and send only those fields.', { details: { expected: expectedAct(action) } });
}

/** `name` only modifies `role`. Any other pair of these is two locators. */
function semanticKeys(t: RawTarget): string[] {
  const keys: string[] = [];
  if (t.role) keys.push('role');
  if (t.label) keys.push('label');
  if (t.text) keys.push('text');
  if (t.testid) keys.push('testid');
  if (t.name && !t.role) keys.push('name');
  return keys;
}

function families(t: RawTarget): string[] {
  const found: string[] = [];
  if (t.ref !== undefined && t.ref !== '') found.push('ref');
  if (t.selector) found.push('selector');
  if (t.x !== undefined || t.y !== undefined) found.push('{x,y}');
  const semantic = semanticKeys(t);
  if (semantic.length === 1) found.push(semantic[0]);
  else if (semantic.length > 1) found.push(semantic.join('+'));
  return found;
}

export function pickTarget(t: RawTarget | undefined, action: ActAction, slot: 'target' | 'to'): Target | undefined {
  if (!t) return undefined;
  const found = families(t);
  if ((t.x === undefined) !== (t.y === undefined)) reject(action, `${slot} point needs both x and y.`);
  if (semanticKeys(t).length > 1) reject(action, `${slot} mixes ${semanticKeys(t).join(' and ')}. name is only a modifier of role.`);
  if (found.includes('{x,y}') && (t.frame !== undefined || t.within || t.nth !== undefined)) reject(action, `${slot} point cannot take frame, within, or nth. Those are ignored and the click hits the top document.`);
  if (found.length > 1) reject(action, `${slot} mixes ${found.join(' and ')}. ${TARGET_HELP}`);
  if (found.length === 0) {
    if (t.frame !== undefined || t.within || t.nth !== undefined) reject(action, `${slot} has modifiers but no locator.`);
    return undefined;
  }
  const mods = { ...(t.frame !== undefined && { frame: t.frame }), ...(t.within && { within: t.within }) };
  if (t.ref !== undefined && t.ref !== '') return { ref: t.ref, ...mods };
  if (t.selector) return { selector: t.selector, ...(t.nth !== undefined && { nth: t.nth }), ...mods };
  if (t.x !== undefined && t.y !== undefined) return { x: t.x, y: t.y };
  return { role: t.role, name: t.name, label: t.label, text: t.text, testid: t.testid, ...(t.nth !== undefined && { nth: t.nth }), ...mods };
}

function present(value: unknown): boolean {
  return value !== undefined;
}

export function checkActInput(input: ActToolInput): { target?: Target; to?: Target; method?: 'cdp' | 'dom' } {
  const rule = RULES[input.action];
  const target = pickTarget(input.target, input.action, 'target');
  const to = pickTarget(input.to, input.action, 'to');
  if (rule.target === 'required' && !target) reject(input.action, `action "${input.action}" needs a target.`);
  if (rule.target === 'forbidden' && target) reject(input.action, `action "${input.action}" does not take a target.`);
  if (rule.to === 'required' && !to) reject(input.action, `action "${input.action}" needs to.`);
  if (rule.to === 'forbidden' && to) reject(input.action, `action "${input.action}" does not take to.`);
  if (rule.value === 'present' && input.value === undefined) reject(input.action, `action "${input.action}" needs value. Pass "" to clear the field; omitting it would clear it by accident.`);
  if (rule.value === 'nonempty' && !input.value) reject(input.action, `action "${input.action}" needs a non-empty value. Omitting it is not a default key.`);
  if (rule.value === 'forbidden' && present(input.value)) reject(input.action, `action "${input.action}" does not take value.`);
  if (rule.files === 'required' && !(input.files && input.files.length)) reject(input.action, `action "${input.action}" needs files.`);
  if (rule.files === 'forbidden' && input.files !== undefined) reject(input.action, `action "${input.action}" does not take files.`);
  if (!rule.scroll && (input.direction !== undefined || input.amount !== undefined)) reject(input.action, `action "${input.action}" does not take direction or amount.`);
  if (input.method !== undefined) {
    if (input.method !== 'cdp' && input.method !== 'dom') reject(input.action, 'method must be "cdp" or "dom".');
    if (input.action !== 'click') reject(input.action, `action "${input.action}" does not take method.`);
    if (input.method === 'dom' && input.target && (input.target.x !== undefined || input.target.y !== undefined)) reject(input.action, 'method "dom" needs an element, not a point.');
  }
  return { target, to, ...(input.method && { method: input.method }) };
}

const EXPECT_KEYS = ['text', 'notText', 'url', 'title', 'selector', 'ref'] as const;

export function checkExpect(what: { text?: string; notText?: string; url?: string; title?: string; selector?: string; ref?: string; visible?: boolean }): void {
  const has = EXPECT_KEYS.some((k) => what[k] !== undefined && what[k] !== '');
  if (!has) {
    throw new ActionError('invalid_args', 'tab_expect needs at least one of text, notText, url, title, selector, ref.', 'An empty expect succeeds without looking at the page.', { details: { expected: { oneOf: [...EXPECT_KEYS] } } });
  }
  if (what.visible !== undefined && !what.selector && !what.ref) {
    throw new ActionError('invalid_args', 'visible requires selector or ref.', 'visible does not apply to text, url, or title checks.', { details: { expected: { visible: 'boolean', with: 'selector or ref' } } });
  }
}
