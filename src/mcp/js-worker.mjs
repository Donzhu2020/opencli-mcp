/** Node's REPL evaluator lives off the host thread. Only API calls cross the bridge. */
import repl from 'node:repl';
import { PassThrough } from 'node:stream';
import { parentPort, workerData } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';

const scope = new AsyncLocalStorage();
const pending = new Map();
const handles = new WeakMap();
let sequence = 0;
const input = new PassThrough();
const output = new PassThrough();
output.resume();
const shell = repl.start({ input, output, terminal: false, prompt: '', useGlobal: false, ignoreUndefined: true });
const errorData = e => ({ name: e?.name ?? 'Error', message: e?.message ?? String(e), stack: e?.stack, code: e?.code, hint: e?.hint, data: e?.data });

function encode(value, seen = new WeakSet()) {
  if (value && handles.has(value)) return handles.get(value);
  if (typeof value === 'function') return { $function: value.toString() };
  if (!value || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || types.isAnyArrayBuffer(value)) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let result;
  if (types.isDate(value)) result = value.toISOString();
  else if (types.isMap(value)) result = [...value].map(entry => encode(entry, seen));
  else if (types.isSet(value)) result = [...value].map(entry => encode(entry, seen));
  else if (types.isNativeError(value)) result = encode(errorData(value), seen);
  else result = Array.isArray(value) ? value.map(v => encode(v, seen)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v, seen)]));
  seen.delete(value);
  return result;
}
function decode(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.$remote !== undefined) return remote(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  return Array.isArray(value) ? value.map(decode) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
}
function remote(descriptor, path = []) {
  const proxy = new Proxy(path.length || descriptor.callable ? function () {} : {}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      if (key === 'toJSON') return () => descriptor.summary ?? { type: 'API' };
      if (typeof key !== 'string') return undefined;
      if (!path.length && Object.hasOwn(descriptor.props ?? {}, key)) return descriptor.props[key];
      return remote(descriptor, [...path, key]);
    },
    apply(_target, _this, args) {
      const run = scope.getStore();
      if (run == null) return Promise.reject(new Error('API calls must be awaited inside a js call'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        parentPort.postMessage({ kind: 'call', run, id, target: descriptor.$remote, path, args: encode(args) });
      });
    },
  });
  handles.set(proxy, { $remote: descriptor.$remote, path });
  return proxy;
}
const emit = (kind, value) => parentPort.postMessage({ kind, run: scope.getStore(), value: encode(value) });
shell.context.nodeRepl = {
  write: value => emit('write', value),
  emitImage: async value => emit('image', value),
};
shell.context.console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...values) => emit('log', { level, values })]));
Object.assign(shell.context, decode(workerData.globals));
parentPort.on('message', message => {
  if (message.kind === 'reply') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error));
    else request.resolve(decode(message.value));
    return;
  }
  if (message.kind !== 'run') return;
  scope.run(message.run, () => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      shell._domain.removeListener('error', onError);
      try { parentPort.postMessage({ kind: 'done', run: message.run, ...(error ? { error: errorData(error) } : { value: encode(value) }) }); }
      catch (e) { parentPort.postMessage({ kind: 'done', run: message.run, error: errorData(e) }); }
    };
    const onError = error => { if (scope.getStore() === message.run) finish(error); };
    // The default evaluator routes synchronous exceptions through its domain, not its callback.
    shell._domain.on('error', onError);
    shell.eval(message.code + '\n', shell.context, `js-call-${message.run}.js`, (error, value) => {
      if (error) finish(error.err ?? error);
      else Promise.resolve(value).then(v => finish(null, v), onError);
    });
  });
});
