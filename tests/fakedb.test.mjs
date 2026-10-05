// The dev-only fake Firebase (src/dev/fakedb): the server handler mounted on
// an ephemeral node:http server and two independent clients talking to it,
// checking the SDK semantics the app relies on. Run with `node --test tests/`.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFakeDbHandler } from '../src/dev/fakedb/server.mjs';
import { initializeApp } from '../src/dev/fakedb/app.js';
import {
  child, get, getDatabase, goOffline, goOnline, increment, limitToLast, onDisconnect, onValue, orderByChild, push,
  query, ref, remove, runTransaction, serverTimestamp, set, update,
} from '../src/dev/fakedb/database.js';

let server;
let handler;
let dbA;
let dbB;

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves with the first value of `q` that satisfies `pred` (or rejects).
function waitFor(q, pred, ms = 2000) {
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting on ${q.toString()}`));
    }, ms);
    unsub = onValue(q, (snap) => {
      if (!pred(snap.val(), snap)) return;
      clearTimeout(timer);
      queueMicrotask(() => unsub());
      resolve(snap);
    });
  });
}

before(async () => {
  handler = createFakeDbHandler();
  server = http.createServer((req, res) => handler(req, res, () => {
    res.statusCode = 404;
    res.end();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  globalThis.__FAKEDB_URL__ = `http://127.0.0.1:${server.address().port}/__fakedb`;
  dbA = getDatabase(initializeApp({ databaseURL: 'https://fake.example' }, 'a'));
  dbB = getDatabase(initializeApp({ databaseURL: 'https://fake.example' }, 'b'));
  await Promise.all([
    waitFor(ref(dbA, '.info/connected'), (v) => v === true),
    waitFor(ref(dbB, '.info/connected'), (v) => v === true),
  ]);
});

after(async () => {
  goOffline(dbA);
  goOffline(dbB);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('set on one client reaches get and onValue on the other', async () => {
  const seen = [];
  const unsub = onValue(ref(dbB, 't1/greeting'), (snap) => seen.push(snap.val()));
  await tick(20);
  assert.deepEqual(seen, [null], 'fires once with null for a missing node');

  await set(ref(dbA, 't1/greeting'), { text: 'hi', n: 1 });
  assert.deepEqual((await get(ref(dbB, 't1/greeting'))).val(), { text: 'hi', n: 1 });
  await waitFor(ref(dbB, 't1/greeting'), (v) => v?.n === 1);
  assert.deepEqual(seen.at(-1), { text: 'hi', n: 1 });

  // A change below the path fires; an unrelated sibling and a same-value write do not.
  const before = seen.length;
  await set(ref(dbA, 't1/other'), 5);
  await set(ref(dbA, 't1/greeting/n'), 1);
  await tick(30);
  assert.equal(seen.length, before, 'no event for siblings or identical values');
  await set(ref(dbA, 't1/greeting/n'), 2);
  await waitFor(ref(dbB, 't1/greeting/n'), (v) => v === 2);
  await tick(10);
  assert.deepEqual(seen.at(-1), { text: 'hi', n: 2 });

  // A write above the path (the parent) fires too, and remove() deletes.
  await set(ref(dbA, 't1'), { greeting: { text: 'yo' } });
  await waitFor(ref(dbB, 't1/greeting'), (v) => v?.text === 'yo' && v.n === undefined);
  await remove(child(ref(dbA, 't1'), 'greeting'));
  const snap = await get(ref(dbB, 't1/greeting'));
  assert.equal(snap.exists(), false);
  assert.equal(snap.val(), null);
  assert.equal(snap.key, 'greeting');
  unsub();
});

test('await set() means this client already saw its own write', async () => {
  const seen = [];
  const unsub = onValue(ref(dbA, 't2/x'), (snap) => seen.push(snap.val()));
  await tick(10);
  await set(ref(dbA, 't2/x'), 'one');
  assert.equal(seen.at(-1), 'one');
  // Writes leave in call order even without awaiting each one.
  set(ref(dbA, 't2/x'), 'two');
  set(ref(dbA, 't2/x'), 'three');
  await set(ref(dbA, 't2/y'), true);
  assert.equal((await get(ref(dbB, 't2/x'))).val(), 'three');
  unsub();
});

test('multi-path update: relative paths, null deletes, overlapping paths throw', async () => {
  await set(ref(dbA, 't3'), { keep: 1, gone: 2, nested: { a: 1, b: 2 } });
  await update(ref(dbA, 't3'), {
    gone: null,
    'nested/b': 20,
    'nested/c': { deep: true },
    'fresh/leaf': 'x',
  });
  assert.deepEqual((await get(ref(dbB, 't3'))).val(), {
    keep: 1, nested: { a: 1, b: 20, c: { deep: true } }, fresh: { leaf: 'x' },
  });
  // An update from the root, as the app does for multi-node writes.
  await update(ref(dbB), { 't3/keep': 2, 't3b/also': 'yes' });
  assert.equal((await get(ref(dbA, 't3/keep'))).val(), 2);
  assert.equal((await get(ref(dbA, 't3b/also'))).val(), 'yes');

  assert.throws(() => update(ref(dbA, 't3'), { nested: {}, 'nested/a': 1 }), /ancestor/);
  assert.throws(() => update(ref(dbA, 't3'), { 'bad.key': 1 }), /invalid path/);
  assert.throws(() => set(ref(dbA, 't3/u'), { a: undefined }), /undefined/);
  assert.throws(() => set(ref(dbA, 't3/u'), { 'a.b': 1 }), /invalid key/);
  assert.throws(() => set(ref(dbA, 't3/u'), Number.NaN), /NaN/);
  assert.throws(() => ref(dbA, 'a#b'), /invalid path/);
  assert.throws(() => set(ref(dbA, '.info/connected'), true), /\.info/);
});

test('transaction: a conflicting server value makes it retry with that value', async () => {
  await set(ref(dbA, 't4/counter'), 10);
  await waitFor(ref(dbB, 't4/counter'), (v) => v === 10);
  const seenByFn = [];
  const res = await runTransaction(ref(dbA, 't4/counter'), (cur) => {
    seenByFn.push(cur);
    // Someone else writes on the server between our read and our commit.
    if (seenByFn.length === 1) handler.store.set('t4/counter', 100);
    return (cur ?? 0) + 1;
  });
  assert.deepEqual(seenByFn, [10, 100]);
  assert.equal(res.committed, true);
  assert.equal(res.snapshot.val(), 101);
  assert.equal(res.snapshot.key, 'counter');
  await waitFor(ref(dbB, 't4/counter'), (v) => v === 101);

  // Returning undefined aborts with the current value.
  const aborted = await runTransaction(ref(dbB, 't4/counter'), () => undefined);
  assert.equal(aborted.committed, false);
  assert.equal(aborted.snapshot.val(), 101);

  // A create-only transaction (auth.js style) loses to an existing record.
  const claim = await runTransaction(ref(dbB, 't4/counter'), (cur) => (cur ? undefined : 1));
  assert.equal(claim.committed, false);

  // Two clients racing on one counter: every increment lands exactly once.
  await set(ref(dbA, 't4/race'), 0);
  const bump = (db) => runTransaction(ref(db, 't4/race'), (v) => (v || 0) + 1);
  await Promise.all(Array.from({ length: 10 }, (_, i) => bump(i % 2 ? dbA : dbB)));
  assert.equal((await get(ref(dbA, 't4/race'))).val(), 10);
});

test('onDisconnect writes run when a client stream closes; cancel() takes them back', async () => {
  await set(ref(dbB, 't5'), { status: 'online', conns: { c1: true }, keep: 'me', note: 'n' });
  const od = onDisconnect(ref(dbB, 't5/status'));
  await od.set('offline');
  await onDisconnect(ref(dbB, 't5/conns/c1')).remove();
  await onDisconnect(ref(dbB, 't5')).update({ lastSeen: serverTimestamp(), 'meta/by': 'b' });
  await onDisconnect(ref(dbB, 't5/keep')).remove();
  await onDisconnect(ref(dbB, 't5/keep')).cancel();
  await onDisconnect(ref(dbB, 't5/note')).set('bye');
  await onDisconnect(ref(dbB, 't5/note')).cancel();

  await tick(30);
  assert.equal((await get(ref(dbA, 't5/status'))).val(), 'online', 'nothing happens while connected');

  const t0 = Date.now();
  goOffline(dbB);
  const snap = await waitFor(ref(dbA, 't5'), (v) => v?.status === 'offline');
  const v = snap.val();
  assert.equal(v.conns, undefined, 'conns/c1 removed and the empty parent vanished');
  assert.equal(v.keep, 'me', 'cancelled remove did not run');
  assert.equal(v.note, 'n', 'cancelled set did not run');
  assert.equal(v.meta.by, 'b');
  assert.ok(v.lastSeen >= t0 && v.lastSeen <= Date.now() + 5, 'server timestamp resolved');

  // Back online: .info/connected flips to true again, and the ops ran only once.
  goOnline(dbB);
  await waitFor(ref(dbB, '.info/connected'), (c) => c === true);
  await set(ref(dbA, 't5/status'), 'online');
  goOffline(dbB);
  await tick(50);
  assert.equal((await get(ref(dbA, 't5/status'))).val(), 'online');
  goOnline(dbB);
  await waitFor(ref(dbB, '.info/connected'), (c) => c === true);
});

test('.info/connected and .info/serverTimeOffset', async () => {
  const states = [];
  const unsub = onValue(ref(dbA, '.info/connected'), (snap) => states.push(snap.val()));
  assert.equal((await get(ref(dbA, '.info/serverTimeOffset'))).val(), 0);
  await tick(10);
  goOffline(dbA);
  await tick(10);
  goOnline(dbA);
  await waitFor(ref(dbA, '.info/connected'), (c) => c === true);
  await tick(10);
  assert.deepEqual(states, [true, false, true]);
  unsub();
});

test('increment and serverTimestamp resolve on the server', async () => {
  const t0 = Date.now();
  await update(ref(dbA, 't6'), { n: increment(2), at: serverTimestamp(), str: 'x' });
  await update(ref(dbB, 't6'), { n: increment(3), str: increment(1), missing: increment(-4) });
  await set(ref(dbA, 't6/obj'), { created: serverTimestamp(), count: increment(7) });
  const v = (await get(ref(dbB, 't6'))).val();
  assert.equal(v.n, 5);
  assert.equal(v.str, 1, 'incrementing a non-number starts from the delta');
  assert.equal(v.missing, -4);
  assert.equal(v.obj.count, 7);
  assert.ok(v.at >= t0 && v.at <= Date.now() + 5);
  assert.ok(v.obj.created >= v.at);
});

test('push keys sort in creation order; push() is a thenable reference', async () => {
  const parent = ref(dbA, 't7');
  const keys = Array.from({ length: 200 }, () => push(parent).key);
  assert.ok(keys.every((k) => typeof k === 'string' && k.length === 20));
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), keys);

  const pending = push(parent, { n: 1 });
  assert.equal(typeof pending.then, 'function');
  const done = await pending;
  assert.equal(done.key, pending.key);
  assert.equal(done.then, undefined, 'resolves to a plain reference');
  assert.deepEqual((await get(child(ref(dbB, 't7'), done.key))).val(), { n: 1 });

  // forEach walks children in key order, so pushed children come out in order.
  for (let i = 2; i <= 5; i++) await push(parent, { n: i });
  const order = [];
  (await get(ref(dbB, 't7'))).forEach((c) => {
    order.push(c.val().n);
  });
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('query: orderByChild + limitToLast, live', async () => {
  await set(ref(dbA, 't8'), {
    m1: { startedAt: 30, name: 'c' },
    m2: { startedAt: 10, name: 'a' },
    m3: { startedAt: 50, name: 'e' },
    m4: { name: 'no time' },
    m5: { startedAt: 20, name: 'b' },
    m6: { startedAt: 40, name: 'd' },
  });
  const q = query(ref(dbB, 't8'), orderByChild('startedAt'), limitToLast(3));
  const names = (snap) => {
    const out = [];
    snap.forEach((c) => {
      out.push(c.val().name);
    });
    return out;
  };
  const snap = await get(q);
  assert.deepEqual(names(snap), ['c', 'd', 'e']);
  assert.deepEqual(Object.keys(snap.val()).sort(), ['m1', 'm3', 'm6']);

  const all = await get(query(ref(dbB, 't8'), orderByChild('startedAt')));
  assert.deepEqual(names(all), ['no time', 'a', 'b', 'c', 'd', 'e'], 'missing values sort first');

  const lists = [];
  const unsub = onValue(q, (s) => lists.push(names(s)));
  await tick(10);
  await set(ref(dbA, 't8/m7'), { startedAt: 60, name: 'f' });
  await tick(20);
  await set(ref(dbA, 't8/m2/name'), 'A'); // outside the window: no event
  await tick(20);
  assert.deepEqual(lists, [['c', 'd', 'e'], ['d', 'e', 'f']]);
  unsub();

  // forEach stops when the callback returns true.
  let visited = 0;
  assert.equal(snap.forEach(() => {
    visited++;
    return true;
  }), true);
  assert.equal(visited, 1);
});

test("Firebase value semantics: arrays, empty objects, key order", async () => {
  await set(ref(dbA, 't9/list'), ['a', 'b', 'c']);
  const list = (await get(ref(dbB, 't9/list'))).val();
  assert.ok(Array.isArray(list));
  assert.deepEqual(list, ['a', 'b', 'c']);
  assert.equal((await get(ref(dbB, 't9/list/1'))).val(), 'b');

  // Holes are fine while more than half the indices are present...
  await set(ref(dbA, 't9/sparse'), { 0: 'a', 2: 'c' });
  const sparse = (await get(ref(dbB, 't9/sparse'))).val();
  assert.ok(Array.isArray(sparse));
  assert.equal(sparse.length, 3);
  assert.equal(sparse[2], 'c');
  assert.equal(1 in sparse, false);
  // ...otherwise it stays an object.
  await set(ref(dbA, 't9/obj'), { 0: 'a', 5: 'f' });
  assert.deepEqual((await get(ref(dbB, 't9/obj'))).val(), { 0: 'a', 5: 'f' });

  // Nulls inside arrays drop out, empty objects vanish.
  await set(ref(dbA, 't9/withNull'), ['x', null, 'z']);
  const withNull = (await get(ref(dbB, 't9/withNull'))).val();
  assert.ok(Array.isArray(withNull));
  assert.equal(withNull.length, 3);
  assert.equal(1 in withNull, false);
  assert.equal(withNull[2], 'z');
  await set(ref(dbA, 't9/gapped'), ['x', null, null, null, 'y']);
  assert.deepEqual((await get(ref(dbB, 't9/gapped'))).val(), { 0: 'x', 4: 'y' }, 'too sparse: an object');
  await set(ref(dbA, 't9/empty'), { a: {}, b: { c: {} } });
  assert.equal((await get(ref(dbB, 't9/empty'))).exists(), false);

  // Removing the last child removes the parent.
  await set(ref(dbA, 't9/one'), { only: 1 });
  await set(ref(dbA, 't9/one/only'), null);
  assert.equal((await get(ref(dbB, 't9/one'))).exists(), false);

  // Keys: integers first (numerically), then strings.
  await set(ref(dbA, 't9/keys'), { b: 1, 10: 1, a: 1, 2: 1, '-1': 1 });
  const keys = [];
  (await get(ref(dbB, 't9/keys'))).forEach((c) => {
    keys.push(c.key);
  });
  assert.deepEqual(keys, ['-1', '2', '10', 'a', 'b']);

  // Snapshot helpers.
  const s = await get(ref(dbB, 't9'));
  assert.equal(s.child('list/2').val(), 'c');
  assert.equal(s.child('nope/deeper').exists(), false);
  assert.equal(s.child('keys').key, 'keys');
});

test('reset clears the tree and clients reconnect', async () => {
  await set(ref(dbA, 't10/x'), 1);
  const res = await fetch(`${globalThis.__FAKEDB_URL__}/reset`, { method: 'POST' });
  assert.equal(res.status, 200);
  await waitFor(ref(dbB, '.info/connected'), (c) => c === true);
  await waitFor(ref(dbA, '.info/connected'), (c) => c === true);
  assert.equal((await get(ref(dbB, 't10/x'))).exists(), false);
  const dump = await (await fetch(`${globalThis.__FAKEDB_URL__}/dump`)).json();
  assert.deepEqual(dump, {});
});
