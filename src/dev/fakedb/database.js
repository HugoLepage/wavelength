// Stand-in for `firebase/database` — DEV ONLY. astro.fakedb.config.mjs aliases
// the real module to this file so online play can be tried with several
// players on one machine without touching the real database.
//
// It implements exactly the subset of the SDK the app may use (see the build
// notes) with Firebase's semantics: every client keeps a mirror of the whole
// tree, fed by one streamed HTTP connection to the dev server (server.mjs);
// writes go to the server over fetch, one at a time and in order, and resolve
// once this client's stream has delivered them (so listeners have already
// fired, as with the SDK's local events). Transactions are compare-and-set
// against the server, retried with the server's value like the SDK does.
//
// Not emulated: security rules (every read/write is allowed, cancel callbacks
// never fire), priorities, offline persistence, optimistic local events.
//
// Works in browsers and Node 22 (plain fetch + streamed body, no EventSource).
// The server lives at '/__fakedb' unless globalThis.__FAKEDB_URL__ says
// otherwise (the tests point it at an ephemeral port).

import { getApp } from './app.js';
import {
  deepEqual, exportVal, getAt, isBranch, joinPath, nextPushId, normalize, parsePath, queryChildren, setAt,
  sortedKeys, splitPath,
} from './tree.js';

const MAX_TRANSACTION_RETRIES = 25;
const REQUEST_ATTEMPTS = 6;

const baseUrl = () => String(globalThis.__FAKEDB_URL__ || '/__fakedb').replace(/\/+$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isAbove = (a, b) => a.length < b.length && a.every((k, i) => k === b[i]);
const related = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};
const sameOrder = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((k, i) => k === b[i]));

// Like the SDK: an exception thrown by user code inside an event callback is
// re-thrown on its own, so it cannot break the stream.
function exceptionGuard(fn) {
  try {
    fn();
  } catch (err) {
    setTimeout(() => {
      throw err;
    }, 0);
  }
}

function parseEvent(block) {
  let event = 'message';
  const data = [];
  for (const raw of block.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

// --- the connection: one stream + the mirror + the listeners -------------------

class Connection {
  constructor() {
    this.tree = null;
    this.ready = false; // a full tree has arrived at least once
    this.connected = false;
    this.connId = null;
    this.seq = 0;
    this.listeners = new Set();
    this.seqWaiters = [];
    this.connWaiters = [];
    this.chain = Promise.resolve();
    this.ctrl = null;
    this.retryTimer = null;
    this.failures = 0;
    this.offline = false;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (!this.offline) this.open();
  }

  async open() {
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    try {
      const res = await fetch(`${baseUrl()}/stream`, {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { accept: 'text/event-stream' },
      });
      if (!res.ok || !res.body) throw new Error(`stream answered HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (this.ctrl === ctrl) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while (this.ctrl === ctrl && (cut = buf.indexOf('\n\n')) >= 0) {
          const msg = parseEvent(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
          if (!msg) continue;
          if (msg.event === 'hello') this.onHello(msg.data);
          else if (msg.event === 'change') this.onChange(msg.data);
        }
      }
      if (this.ctrl !== ctrl) reader.cancel().catch(() => {});
    } catch (err) {
      if (!ctrl.signal.aborted && this.failures === 0) {
        console.warn(`[fakedb] stream to ${baseUrl()} failed: ${err?.message || err}`);
      }
    } finally {
      this.onClosed(ctrl);
    }
  }

  onClosed(ctrl) {
    if (this.ctrl !== ctrl) return; // superseded by goOffline / goOnline
    this.ctrl = null;
    this.markDown();
    if (this.offline) return;
    this.failures += 1;
    const delay = Math.min(5000, 250 * 2 ** Math.min(this.failures - 1, 5)) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.offline && !this.ctrl) this.open();
    }, delay);
    this.retryTimer.unref?.(); // never keeps a Node process alive on its own
  }

  markDown() {
    if (!this.connected && this.connId === null) return;
    this.connected = false;
    this.connId = null;
    this.notify([['.info']]);
  }

  onHello({ conn, seq, tree }) {
    if (!this.ready && typeof window !== 'undefined') {
      console.info(`[fakedb] using the in-memory dev database at ${baseUrl()}/ (see ${baseUrl()}/dump)`);
    }
    this.connId = conn;
    this.seq = seq;
    this.tree = tree ?? null;
    this.connected = true;
    this.ready = true;
    this.failures = 0;
    this.notify(null);
    // A full tree is at least as new as anything we were waiting for.
    const seqWaiters = this.seqWaiters;
    this.seqWaiters = [];
    seqWaiters.forEach((w) => w.resolve());
    const connWaiters = this.connWaiters;
    this.connWaiters = [];
    connWaiters.forEach((resolve) => resolve());
  }

  onChange({ seq, ops }) {
    const paths = [];
    for (const op of ops || []) {
      const parts = splitPath(op.p);
      this.tree = setAt(this.tree, parts, op.v ?? null);
      paths.push(parts);
    }
    this.seq = Math.max(this.seq, seq);
    this.notify(paths);
    this.seqWaiters = this.seqWaiters.filter((w) => {
      if (w.seq > this.seq) return true;
      w.resolve();
      return false;
    });
  }

  goOffline() {
    this.offline = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ctrl = this.ctrl;
    this.ctrl = null;
    ctrl?.abort();
    this.markDown();
  }

  goOnline() {
    if (!this.offline) return;
    this.offline = false;
    this.failures = 0;
    if (this.started && !this.ctrl) this.open();
  }

  // --- reading ---

  infoTree() {
    return { connected: this.connected, serverTimeOffset: 0 };
  }

  // { node, order } for a listener / get: order is the key list of a query.
  evaluate({ parts, spec, info }) {
    if (info) return { node: getAt(this.infoTree(), parts.slice(1)), order: null };
    const node = getAt(this.tree, parts);
    if (!spec) return { node, order: null };
    let out = null;
    const order = [];
    for (const [key, child] of queryChildren(node, spec)) {
      (out ??= {})[key] = child;
      order.push(key);
    }
    return { node: out, order };
  }

  listen(l) {
    this.listeners.add(l);
    // Never synchronously: the caller has not even got its unsubscribe yet.
    if (l.info || this.ready) {
      queueMicrotask(() => {
        if (this.listeners.has(l) && !l.fired) this.emit(l, this.evaluate(l));
      });
    }
    return () => {
      this.listeners.delete(l);
    };
  }

  emit(l, result) {
    l.fired = true;
    l.last = result;
    const snap = new DataSnapshot(result.node, l.ref, result.order);
    exceptionGuard(() => l.cb(snap));
  }

  // paths: the key arrays that changed, or null for "anything may have".
  notify(paths) {
    for (const l of [...this.listeners]) {
      if (!this.listeners.has(l)) continue;
      if (!l.fired) {
        if (l.info || this.ready) this.emit(l, this.evaluate(l));
        continue;
      }
      if (paths && !paths.some((p) => related(p, l.parts))) continue;
      const next = this.evaluate(l);
      if (deepEqual(l.last.node, next.node) && sameOrder(l.last.order, next.order)) continue;
      this.emit(l, next);
    }
  }

  // --- talking to the server ---

  whenConnected() {
    return this.connected ? Promise.resolve() : new Promise((resolve) => this.connWaiters.push(resolve));
  }

  whenReady() {
    return this.ready ? Promise.resolve() : this.whenConnected();
  }

  // Resolves once the stream has delivered change `seq` (or a newer full tree).
  waitSeq(seq) {
    if (this.seq >= seq) return Promise.resolve();
    return new Promise((resolve) => this.seqWaiters.push({ seq, resolve }));
  }

  // Requests leave one at a time, in call order, like the SDK's writes.
  enqueue(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  async request(route, makeBody = null) {
    let lastError = null;
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt++) {
      await this.whenConnected();
      const body = makeBody ? makeBody() : null;
      let res;
      try {
        res = await fetch(`${baseUrl()}/${route}`, body
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }
          : { cache: 'no-store' });
      } catch (err) {
        lastError = err; // server restarting? wait for the stream to come back
        await sleep(150 * (attempt + 1));
        continue;
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.status === 410 && body && body.conn !== undefined) {
        // Our connection closed under us: re-send on the next one.
        lastError = new Error(data?.error || 'connection closed');
        await new Promise((resolve) => {
          if (this.connected && this.connId !== body.conn) resolve();
          else this.connWaiters.push(resolve);
        });
        continue;
      }
      if (!res.ok || !data) throw new Error(`fakedb: ${route.split('?')[0]} failed: ${data?.error || `HTTP ${res.status}`}`);
      return data;
    }
    throw new Error(`fakedb: ${route.split('?')[0]} failed: ${lastError?.message || 'no connection'}`);
  }

  async write(route, body) {
    const out = await this.enqueue(() => this.request(route, () => body));
    await this.waitSeq(out.seq);
  }
}

// --- public types ----------------------------------------------------------------

class Database {
  constructor(app) {
    this.app = app;
    this.type = 'database';
    this._conn = new Connection();
  }
}

class QueryImpl {
  constructor(db, parts, spec) {
    this._db = db;
    this._parts = parts;
    this._spec = spec;
  }

  get ref() {
    return new ReferenceImpl(this._db, this._parts);
  }

  isEqual(other) {
    return !!other && other._db === this._db && joinPath(other._parts) === joinPath(this._parts) &&
      JSON.stringify(other._spec) === JSON.stringify(this._spec);
  }

  toString() {
    const root = String(this._db.app.options?.databaseURL || 'fakedb:').replace(/\/+$/, '');
    return `${root}/${this._parts.map(encodeURIComponent).join('/')}`;
  }

  toJSON() {
    return this.toString();
  }
}

class ReferenceImpl extends QueryImpl {
  constructor(db, parts) {
    super(db, parts, null);
  }

  get key() {
    return this._parts.length ? this._parts[this._parts.length - 1] : null;
  }

  get parent() {
    return this._parts.length ? new ReferenceImpl(this._db, this._parts.slice(0, -1)) : null;
  }

  get root() {
    return new ReferenceImpl(this._db, []);
  }

  get ref() {
    return this;
  }
}

class DataSnapshot {
  constructor(node, ref, order = null) {
    this._node = node ?? null;
    this.ref = ref;
    this._order = order;
  }

  get key() {
    return this.ref.key;
  }

  get size() {
    return isBranch(this._node) ? Object.keys(this._node).length : 0;
  }

  val() {
    return exportVal(this._node);
  }

  exists() {
    return this._node !== null;
  }

  child(path) {
    const parts = parsePath(String(path), 'DataSnapshot.child failed: path argument');
    return new DataSnapshot(getAt(this._node, parts), new ReferenceImpl(this.ref._db, [...this.ref._parts, ...parts]));
  }

  hasChild(path) {
    return this.child(path).exists();
  }

  hasChildren() {
    return isBranch(this._node);
  }

  // Children in key order (or in the query's order); stops when `action`
  // returns true, and then returns true itself.
  forEach(action) {
    if (!isBranch(this._node)) return false;
    const keys = this._order || sortedKeys(this._node);
    for (const key of keys) {
      const snap = new DataSnapshot(this._node[key], new ReferenceImpl(this.ref._db, [...this.ref._parts, key]));
      if (action(snap) === true) return true;
    }
    return false;
  }

  toJSON() {
    return this.val();
  }
}

class TransactionResult {
  constructor(committed, snapshot) {
    this.committed = committed;
    this.snapshot = snapshot;
  }

  toJSON() {
    return { committed: this.committed, snapshot: this.snapshot.toJSON() };
  }
}

class QueryConstraint {
  constructor(type, value) {
    this.type = type;
    this._value = value;
  }
}

// Duck-typed rather than instanceof, so references survive a second copy of
// this module (an HMR update, or the file reached through another URL).
const isQuery = (r) => !!r && !!r._db && !!r._db._conn && Array.isArray(r._parts);

function assertRef(fn, r) {
  if (!isQuery(r)) throw new Error(`${fn} failed: expected a database reference`);
}

function assertWritable(fn, r) {
  if (!isQuery(r) || r._spec) throw new Error(`${fn} failed: expected a database reference (not a query)`);
  if (r._parts[0] === '.info') throw new Error(`${fn} failed = Can't modify data under /.info/`);
}

// update()-style values → { 'rel/path': node }, rejecting overlapping paths.
function mergeValues(fn, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`${fn} failed: values argument  must be an object containing the children to replace.`);
  }
  const out = {};
  const paths = [];
  for (const key of Object.keys(values)) {
    const parts = parsePath(key, `${fn} failed: values argument contains a key that`);
    out[joinPath(parts)] = normalize(values[key], `${fn} failed: values argument `, key);
    paths.push(parts);
  }
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths.length; j++) {
      if (i !== j && (isAbove(paths[i], paths[j]) || (i < j && joinPath(paths[i]) === joinPath(paths[j])))) {
        throw new Error(`${fn} failed: values argument contains a path ${joinPath(paths[i])} that is ancestor of another path ${joinPath(paths[j])}`);
      }
    }
  }
  return { out, count: paths.length };
}

// --- the API ------------------------------------------------------------------------

const databases = new Map();

export function getDatabase(app = getApp()) {
  let db = databases.get(app);
  if (!db) {
    db = new Database(app);
    databases.set(app, db);
  }
  return db;
}

export function ref(db, path) {
  if (!db || !db._conn || db.type !== 'database') throw new Error('ref failed: first argument must be a Database');
  db._conn.start();
  if (path === undefined) return new ReferenceImpl(db, []);
  return new ReferenceImpl(db, parsePath(path, 'ref failed: path argument', { allowInfo: true }));
}

export function child(parent, path) {
  assertRef('child', parent);
  const parts = parsePath(path, 'child failed: path argument', { allowInfo: parent._parts.length === 0 });
  return new ReferenceImpl(parent._db, [...parent._parts, ...parts]);
}

export function set(r, value) {
  assertWritable('set', r);
  const node = normalize(value, 'set failed: value argument ');
  return r._db._conn.write('set', { path: joinPath(r._parts), value: node });
}

export function update(r, values) {
  assertWritable('update', r);
  const { out, count } = mergeValues('update', values);
  if (!count) return Promise.resolve();
  return r._db._conn.write('update', { path: joinPath(r._parts), values: out });
}

export function remove(r) {
  assertWritable('remove', r);
  return r._db._conn.write('remove', { path: joinPath(r._parts) });
}

// A reference to a new child with a chronologically sortable key; also a
// promise that resolves (to a plain reference) once `value` is written.
export function push(parent, value) {
  assertWritable('push', parent);
  if (value !== undefined) normalize(value, 'push failed: value argument ');
  const parts = [...parent._parts, nextPushId(Date.now())];
  const thenable = new ReferenceImpl(parent._db, parts);
  const plain = new ReferenceImpl(parent._db, parts);
  const promise = value != null ? set(plain, value).then(() => plain) : Promise.resolve(plain);
  thenable.then = promise.then.bind(promise);
  thenable.catch = promise.then.bind(promise, undefined);
  return thenable;
}

export async function get(q) {
  assertRef('get', q);
  const conn = q._db._conn;
  const l = { parts: q._parts, spec: q._spec, info: q._parts[0] === '.info' };
  if (!l.info) {
    await conn.whenReady();
    if (conn.connected) {
      try {
        // Ask the server where it is, then let the stream catch up to it.
        const { seq } = await conn.enqueue(() => conn.request(`get?path=${encodeURIComponent(joinPath(q._parts))}`));
        await conn.waitSeq(seq);
      } catch {
        /* fall back to what the mirror has */
      }
    }
  }
  const { node, order } = conn.evaluate(l);
  return new DataSnapshot(node, new ReferenceImpl(q._db, q._parts), order);
}

// onValue(query, cb, cancelCb?, { onlyOnce }?) → unsubscribe. Fires once the
// data is there, then whenever the value at the path (or the query's result)
// changes. The cancel callback never fires: there are no rules to deny.
export function onValue(q, callback, cancelOrOptions, options) {
  assertRef('onValue', q);
  if (typeof callback !== 'function') throw new Error('onValue failed: callback must be a function');
  const opts = (cancelOrOptions && typeof cancelOrOptions === 'object' ? cancelOrOptions : options) || {};
  const conn = q._db._conn;
  let unsubscribe = null;
  const l = {
    parts: q._parts,
    spec: q._spec,
    info: q._parts[0] === '.info',
    ref: new ReferenceImpl(q._db, q._parts),
    fired: false,
    last: null,
    cb: opts.onlyOnce ? (snap) => {
      unsubscribe();
      callback(snap);
    } : callback,
  };
  unsubscribe = conn.listen(l);
  return unsubscribe;
}

// Compare-and-set against the server: `fn` sees this client's copy first and,
// whenever the server had something else, runs again on the server's value.
// `fn` returning undefined aborts. Resolves { committed, snapshot }.
export async function runTransaction(r, fn, options) { // eslint-disable-line no-unused-vars
  assertWritable('runTransaction', r);
  if (typeof fn !== 'function') throw new Error('runTransaction failed: transactionUpdate must be a function');
  const conn = r._db._conn;
  const path = joinPath(r._parts);
  const plain = new ReferenceImpl(r._db, r._parts);
  await conn.whenReady();
  let current = getAt(conn.tree, r._parts);
  for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt++) {
    const out = fn(exportVal(current));
    if (out === undefined) return new TransactionResult(false, new DataSnapshot(current, plain));
    const next = normalize(out, 'transaction failed: Data returned ');
    const expected = current;
    const res = await conn.enqueue(() => conn.request('cas', () => ({ path, expected, value: next })));
    if (res.ok) {
      await conn.waitSeq(res.seq);
      return new TransactionResult(true, new DataSnapshot(res.value ?? null, plain));
    }
    current = res.current ?? null;
  }
  throw new Error('maxretry');
}

class OnDisconnect {
  constructor(r) {
    this._ref = r;
  }

  _send(op, value) {
    const conn = this._ref._db._conn;
    const path = joinPath(this._ref._parts);
    return conn.enqueue(() => conn.request('ondisconnect', () => ({ conn: conn.connId, path, op, value })))
      .then(() => undefined);
  }

  set(value) {
    return this._send('set', normalize(value, 'OnDisconnect.set failed: value argument '));
  }

  update(values) {
    const { out, count } = mergeValues('OnDisconnect.update', values);
    if (!count) return Promise.resolve();
    return this._send('update', out);
  }

  remove() {
    return this._send('remove', null);
  }

  cancel() {
    return this._send('cancel', null);
  }
}

// Writes the server performs when this client's connection goes away.
export function onDisconnect(r) {
  assertWritable('onDisconnect', r);
  return new OnDisconnect(r);
}

export const serverTimestamp = () => ({ '.sv': 'timestamp' });

export const increment = (delta) => ({ '.sv': { increment: delta } });

export function query(q, ...constraints) {
  assertRef('query', q);
  const spec = { orderByChild: null, limitToLast: null, ...(q._spec || {}) };
  for (const c of constraints) {
    if (!c || (c.type !== 'orderByChild' && c.type !== 'limitToLast') || !('_value' in c)) {
      throw new Error('query failed: the fake database supports orderByChild() and limitToLast() only');
    }
    if (c.type === 'orderByChild') {
      if (spec.orderByChild) throw new Error("orderByChild: You can't combine multiple orderBy calls.");
      spec.orderByChild = c._value;
    } else {
      if (spec.limitToLast != null) throw new Error('limitToLast: Limit was already set (by another call to limitToFirst or limitToLast).');
      spec.limitToLast = c._value;
    }
  }
  return new QueryImpl(q._db, q._parts, spec);
}

export function orderByChild(path) {
  if (path === '$key' || path === '$value' || path === '$priority') {
    throw new Error(`orderByChild: "${path}" is invalid.  Use orderByKey(), orderByValue() or orderByPriority() instead.`);
  }
  return new QueryConstraint('orderByChild', parsePath(path, 'orderByChild failed: path argument'));
}

export function limitToLast(limit) {
  if (typeof limit !== 'number' || Math.floor(limit) !== limit || limit <= 0) {
    throw new Error('limitToLast: First argument must be a positive integer.');
  }
  return new QueryConstraint('limitToLast', limit);
}

// Real SDK functions too, handy in tests and from the console: drop / restore
// this client's connection (dropping it runs its onDisconnect writes).
export function goOffline(db) {
  db._conn.goOffline();
}

export function goOnline(db) {
  db._conn.goOnline();
}
