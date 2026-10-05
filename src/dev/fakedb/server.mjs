// The fake Realtime Database's server half — DEV ONLY. Holds the whole JSON
// tree in memory (mirrored to node_modules/.fakedb/db.json so a dev-server
// restart keeps it) and speaks a tiny HTTP protocol under /__fakedb/:
//
//   GET  stream          Server-Sent Events. `hello` {conn, seq, tree} first,
//                        then `change` {seq, ops: [{p, v}]} for every write.
//                        Closing it runs that connection's onDisconnect ops.
//   POST set             {path, value}
//   POST update          {path, values: {'rel/path': value}}   (multi-path)
//   POST remove          {path}
//   POST cas             {path, expected, value} → {ok, seq, value} | {ok: false, current}
//   POST ondisconnect    {conn, path, op: set|update|remove|cancel, value|values}
//   GET  get?path=a/b    {value, seq}
//   GET  dump            the whole tree (pretty JSON)
//   POST reset           clear everything (or load the JSON body's `tree`)
//
// Writes reply {seq}; the client waits until its stream has delivered that
// change before resolving, so `await set()` means "my listeners saw it".
// Server values ({'.sv': 'timestamp'} / {'.sv': {increment}}) are resolved
// here, against the stored data, before anything is stored or broadcast.
//
// fakeDbPlugin() mounts it in the Vite dev server (astro.fakedb.config.mjs);
// createFakeDbHandler() mounts it anywhere (the tests use node:http).

import fs from 'node:fs';
import path from 'node:path';
import {
  FakeDbError, deepEqual, getAt, isBranch, normalize, parsePath, resolveServerValues, setAt, splitPath,
} from './tree.js';

const MAX_BODY = 10 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- onDisconnect queues ---------------------------------------------------
// One per connection: Map<'a/b', node> with no entry above another, the
// same sparse tree the Firebase SDK keeps. A write below a queued write is
// folded into it; cancel() below a queued write splits that write into its
// children first, so only the cancelled part is dropped.

const isAbove = (a, b) => (a === '' ? b !== '' : b.startsWith(`${a}/`));
const relParts = (from, to) => splitPath(to.slice(from.length));

function queueRemember(queue, key, node) {
  for (const [k, v] of queue) {
    if (isAbove(k, key)) {
      queue.set(k, setAt(v, relParts(k, key), node));
      return;
    }
  }
  for (const k of [...queue.keys()]) if (k === key || isAbove(key, k)) queue.delete(k);
  queue.set(key, node);
}

function queueForget(queue, key) {
  for (const k of [...queue.keys()]) if (k === key || isAbove(key, k)) queue.delete(k);
  for (const [k, v] of queue) {
    if (!isAbove(k, key)) continue;
    if (v !== null && !isBranch(v)) return; // a leaf has nothing below it to forget
    queue.delete(k);
    if (v) for (const child of Object.keys(v)) queue.set(k ? `${k}/${child}` : child, v[child]);
    queueForget(queue, key);
    return;
  }
}

// --- the store ---------------------------------------------------------------

export function createFakeDb({ file = null, log = null } = {}) {
  let tree = null;
  // Sequence numbers start from the clock so they keep rising across restarts.
  let seq = Date.now() * 1000;
  let nextConn = 1;
  const conns = new Map(); // id → { res, queue }
  let saveTimer = null;
  let heartbeat = null;

  if (file) {
    try {
      tree = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') log?.(`fakedb: could not load ${file} (${err.message}), starting empty`);
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(tree ?? {}, null, 1));
    } catch (err) {
      log?.(`fakedb: could not save ${file} (${err.message})`);
    }
  }

  function scheduleSave() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, 150);
    saveTimer.unref?.();
  }

  function send(conn, event, data) {
    try {
      conn.res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      /* the close handler cleans up */
    }
  }

  function broadcast(event, payload) {
    const data = JSON.stringify(payload);
    for (const conn of conns.values()) send(conn, event, data);
  }

  // Apply [{parts, value}] as one atomic change (value: a normalized node,
  // sentinels allowed). Returns { seq, ops } with the resolved values.
  function commit(sets) {
    const now = Date.now();
    const ops = [];
    for (const { parts, value } of sets) {
      const resolved = resolveServerValues(value, getAt(tree, parts), now);
      tree = setAt(tree, parts, resolved);
      ops.push({ p: parts.join('/'), v: resolved });
    }
    seq += 1;
    broadcast('change', { seq, ops });
    scheduleSave();
    return { seq, ops };
  }

  function openStream(req, res) {
    const id = `c${nextConn++}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    req.socket?.setNoDelay?.(true);
    const conn = { id, res, queue: new Map() };
    conns.set(id, conn);
    send(conn, 'hello', JSON.stringify({ conn: id, seq, tree }));
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const c of conns.values()) {
          try {
            c.res.write(': ping\n\n');
          } catch {
            /* ignore */
          }
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    }
    let closed = false;
    const onClose = () => {
      if (closed) return;
      closed = true;
      conns.delete(id);
      if (!conns.size && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (conn.queue.size) {
        const sets = [...conn.queue].map(([k, v]) => ({ parts: splitPath(k), value: v }));
        conn.queue.clear();
        commit(sets);
      }
    };
    res.on('close', onClose);
    req.on('close', onClose);
  }

  const writablePath = (p) => {
    const parts = parsePath(p ?? '', 'path', { allowEmpty: true });
    return parts;
  };

  // --- operations (also handy for tests that poke the server directly) ---
  const api = {
    get tree() {
      return tree;
    },
    get seq() {
      return seq;
    },
    get connections() {
      return [...conns.keys()];
    },
    set(p, value) {
      return commit([{ parts: writablePath(p), value: normalize(value, 'set: ') }]);
    },
    update(p, values) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new FakeDbError('update: values must be an object');
      }
      const base = writablePath(p);
      const sets = Object.keys(values).map((rel) => ({
        parts: [...base, ...parsePath(rel, 'update key')],
        value: normalize(values[rel], 'update: '),
      }));
      if (!sets.length) return { seq, ops: [] };
      return commit(sets);
    },
    remove(p) {
      return commit([{ parts: writablePath(p), value: null }]);
    },
    cas(p, expected, value) {
      const parts = writablePath(p);
      const current = getAt(tree, parts);
      if (!deepEqual(current, normalize(expected ?? null, 'cas expected: '))) return { ok: false, current };
      const { seq: s, ops } = commit([{ parts, value: normalize(value, 'cas: ') }]);
      return { ok: true, seq: s, value: ops[0].v };
    },
    onDisconnect(connId, p, op, payload) {
      const conn = conns.get(connId);
      if (!conn) throw new HttpError(410, 'unknown or closed connection');
      const parts = writablePath(p);
      const key = parts.join('/');
      if (op === 'set') queueRemember(conn.queue, key, normalize(payload, 'onDisconnect.set: '));
      else if (op === 'remove') queueRemember(conn.queue, key, null);
      else if (op === 'cancel') queueForget(conn.queue, key);
      else if (op === 'update') {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new FakeDbError('onDisconnect.update: values must be an object');
        }
        for (const rel of Object.keys(payload)) {
          const sub = [...parts, ...parsePath(rel, 'onDisconnect.update key')].join('/');
          queueRemember(conn.queue, sub, normalize(payload[rel], 'onDisconnect.update: '));
        }
      } else throw new FakeDbError(`unknown onDisconnect op "${op}"`);
      return { ok: true, queued: conn.queue.size };
    },
    // Clear the tree (or replace it with `next`), forget every queued
    // onDisconnect op, then drop every stream: clients reconnect within a
    // moment, see `.info/connected` go false → true and re-arm their hooks.
    reset(next = null) {
      for (const conn of conns.values()) conn.queue.clear();
      commit([{ parts: [], value: normalize(next, 'reset: ') }]);
      for (const conn of [...conns.values()]) {
        try {
          conn.res.end();
        } catch {
          /* ignore */
        }
      }
      return { ok: true, seq };
    },
    // Write a pending save now (process exit).
    flush() {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      save();
    },
    openStream,
  };
  return api;
}

// --- HTTP ----------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body, pretty = false) {
  const text = JSON.stringify(body, null, pretty ? 2 : 0);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

// (req, res, next) middleware for every URL under `prefix`; anything else is
// passed to next(). `handler.store` is the store it serves.
export function createFakeDbHandler({ store = null, prefix = '/__fakedb', ...options } = {}) {
  const db = store || createFakeDb(options);
  const handler = async function fakeDbMiddleware(req, res, next) {
    const url = new URL(req.url || '/', 'http://fakedb.local');
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return next?.();
    const route = url.pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
        });
        res.end();
        return;
      }
      if (req.method === 'GET') {
        if (route === 'stream') return db.openStream(req, res);
        if (route === 'dump' || route === '') return sendJson(res, 200, db.tree ?? {}, true);
        if (route === 'get') {
          const parts = parsePath(url.searchParams.get('path') || '', 'path', { allowEmpty: true });
          return sendJson(res, 200, { value: getAt(db.tree, parts), seq: db.seq });
        }
        throw new HttpError(404, `unknown fakedb route GET /${route}`);
      }
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      const body = await readBody(req);
      let out;
      switch (route) {
        case 'set': out = db.set(body.path, body.value); break;
        case 'update': out = db.update(body.path, body.values); break;
        case 'remove': out = db.remove(body.path); break;
        case 'cas': out = db.cas(body.path, body.expected, body.value); break;
        case 'ondisconnect': out = db.onDisconnect(body.conn, body.path, body.op, body.value ?? body.values ?? null); break;
        case 'reset': out = db.reset(body.tree ?? null); break;
        default: throw new HttpError(404, `unknown fakedb route POST /${route}`);
      }
      sendJson(res, 200, { ok: true, ...out, ops: undefined });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof FakeDbError ? 400 : 500;
      if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message });
      else res.end();
    }
  };
  handler.store = db;
  return handler;
}

// --- Vite plugin -------------------------------------------------------------

// One store per database file per process, so a dev-server restart (Astro
// restarts Vite when its config changes) keeps the data and the open streams.
function sharedStore(file, log) {
  const all = (globalThis.__fakedbStores ??= new Map());
  if (!all.has(file)) {
    const store = createFakeDb({ file, log });
    all.set(file, store);
    process.once('exit', () => store.flush());
  }
  return all.get(file);
}

export function fakeDbPlugin({ file = null, prefix = '/__fakedb' } = {}) {
  let root = process.cwd();
  return {
    name: 'wavelength-fakedb',
    apply: 'serve',
    configResolved(config) {
      root = config.root || root;
    },
    configureServer(server) {
      const dbFile = file || path.join(root, 'node_modules', '.fakedb', 'db.json');
      const logger = server.config.logger;
      const store = sharedStore(dbFile, (msg) => logger.warn(msg));
      const handler = createFakeDbHandler({ store, prefix });
      logger.info(`  fakedb  in-memory Firebase stand-in at ${prefix}/ (saved to ${path.relative(root, dbFile)})`);
      // Registered last but put first: Astro's own base-path middleware
      // (also unshifted) would otherwise answer /__fakedb/dump with a 404 page.
      return () => {
        server.middlewares.stack.unshift({ route: '', handle: handler });
      };
    },
  };
}
