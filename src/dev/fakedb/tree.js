// Pure tree helpers shared by the fake database's server (server.mjs, Node)
// and its client (database.js, browser + Node). DEV ONLY — never imported by
// the production build.
//
// The tree is kept the way Firebase keeps it: plain objects all the way down
// (arrays are stored as objects keyed "0", "1", …), no nulls and no empty
// objects. Nodes are never mutated — a write copies the path it touches — so
// a snapshot can hold on to a node and still read the value it was taken at.
// Server-value sentinels ({ '.sv': … }) only live in values on their way to
// the server, which resolves them before anything is stored.

const INVALID_KEY = /[\[\].#$/\u0000-\u001F\u007F]/;
const ARRAY_KEY = /^(0|[1-9]\d*)$/; // Firebase's array heuristic
const INT_KEY = /^-?(0*)\d{1,10}$/; // keys Firebase sorts as numbers

export const isSentinel = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, '.sv');

// A branch node (a non-empty object that is not a server-value sentinel).
export const isBranch = (v) => v !== null && typeof v === 'object' && !isSentinel(v);

export const isValidKey = (key) =>
  typeof key === 'string' && key.length > 0 && !INVALID_KEY.test(key) && key !== '__proto__';

export class FakeDbError extends Error {}

// 'a/b//c' → ['a', 'b', 'c'] — no validation (use parsePath for user input).
export const splitPath = (path) => (path ? String(path).split('/').filter(Boolean) : []);

export const joinPath = (parts) => parts.join('/');

// Validate a path string as Firebase does: non-empty, no . # $ [ ] or control
// characters (slashes separate keys). `.info` is allowed as the first key
// when `allowInfo` is set. Returns the key array.
export function parsePath(path, what = 'path', { allowInfo = false, allowEmpty = false } = {}) {
  if (typeof path !== 'string' || (!allowEmpty && path.length === 0)) {
    throw new FakeDbError(`${what} was an invalid path = "${path}". Paths must be non-empty strings and can't contain ".", "#", "$", "[", or "]"`);
  }
  const parts = splitPath(path);
  parts.forEach((key, i) => {
    if (i === 0 && allowInfo && key === '.info') return;
    if (!isValidKey(key)) {
      throw new FakeDbError(`${what} was an invalid path = "${path}". Paths must be non-empty strings and can't contain ".", "#", "$", "[", or "]"`);
    }
  });
  return parts;
}

function validateSentinel(v, where) {
  const keys = Object.keys(v);
  const sv = v['.sv'];
  const ok = keys.length === 1 && (sv === 'timestamp' ||
    (sv !== null && typeof sv === 'object' && Object.keys(sv).length === 1 &&
      typeof sv.increment === 'number' && Number.isFinite(sv.increment)));
  if (!ok) throw new FakeDbError(`${where}contains an invalid server value ${JSON.stringify(v)}`);
  return sv === 'timestamp' ? { '.sv': 'timestamp' } : { '.sv': { increment: sv.increment } };
}

// Turn a JS value into a stored node, validating it like the SDK does:
// undefined, functions, NaN/Infinity and bad keys throw; nulls and empty
// objects vanish; arrays become integer-keyed objects. `where` prefixes error
// messages (e.g. "set failed: value argument ").
export function normalize(value, where = '', at = '') {
  const loc = () => (at ? ` in property '${at}'` : '');
  if (value === undefined) throw new FakeDbError(`${where}contains undefined${loc()}`);
  if (value === null) return null;
  const t = typeof value;
  if (t === 'function') throw new FakeDbError(`${where}contains a function${loc()}`);
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new FakeDbError(`${where}contains ${value}${loc()}`);
    return value;
  }
  if (t === 'string' || t === 'boolean') return value;
  if (t !== 'object') throw new FakeDbError(`${where}contains an unsupported ${t}${loc()}`);
  if (isSentinel(value)) return validateSentinel(value, where);
  let out = null;
  for (const key of Object.keys(value)) {
    if (key === '.priority' || key === '.value') {
      throw new FakeDbError(`${where}uses "${key}", which the fake database does not support${loc()}`);
    }
    if (!isValidKey(key)) {
      throw new FakeDbError(`${where}contains an invalid key (${key})${loc()}.  Keys must be non-empty strings and can't contain ".", "#", "$", "/", "[", or "]"`);
    }
    const child = normalize(value[key], where, at ? `${at}.${key}` : key);
    if (child === null) continue;
    if (!out) out = {};
    out[key] = child;
  }
  return out;
}

export function getAt(node, parts) {
  let cur = node;
  for (const key of parts) {
    if (!isBranch(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return null;
    cur = cur[key];
  }
  return cur === undefined ? null : cur;
}

// New root with `value` (a stored node, null deletes) written at `parts`.
// Empty ancestors are pruned; a leaf in the way becomes a branch, except that
// deleting below a leaf leaves the leaf alone (Firebase does the same).
export function setAt(node, parts, value, i = 0) {
  if (i === parts.length) return value;
  const key = parts[i];
  const branch = isBranch(node) ? node : null;
  const before = branch && Object.prototype.hasOwnProperty.call(branch, key) ? branch[key] : null;
  const child = setAt(before, parts, value, i + 1);
  if (child === before) return node;
  if (child === null) {
    if (!branch) return node;
    const out = { ...branch };
    delete out[key];
    return Object.keys(out).length ? out : null;
  }
  const out = branch ? { ...branch } : {};
  out[key] = child;
  return out;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (!isBranch(a) || !isBranch(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// Replace server-value sentinels in `value` with real values: timestamps
// become `now`, increments add to whatever number `existing` (the stored
// node at the same place) holds, or start from 0.
export function resolveServerValues(value, existing, now) {
  if (isSentinel(value)) {
    if (value['.sv'] === 'timestamp') return now;
    const delta = value['.sv'].increment;
    return typeof existing === 'number' ? existing + delta : delta;
  }
  if (!isBranch(value)) return value;
  let out = null;
  for (const key of Object.keys(value)) {
    const prev = isBranch(existing) && Object.prototype.hasOwnProperty.call(existing, key) ? existing[key] : null;
    const child = resolveServerValues(value[key], prev, now);
    if (child === null) continue;
    if (!out) out = {};
    out[key] = child;
  }
  return out;
}

// Firebase's key order: keys that look like 32-bit integers first, in
// numeric order, then everything else as plain strings.
function tryParseInt(s) {
  if (!INT_KEY.test(s)) return null;
  const n = Number(s);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

export function nameCompare(a, b) {
  if (a === b) return 0;
  const ia = tryParseInt(a);
  const ib = tryParseInt(b);
  if (ia !== null) {
    if (ib !== null) return ia - ib === 0 ? a.length - b.length : ia - ib;
    return -1;
  }
  if (ib !== null) return 1;
  return a < b ? -1 : 1;
}

export const sortedKeys = (node) => (isBranch(node) ? Object.keys(node).sort(nameCompare) : []);

// Firebase's value order for orderByChild: missing < false < true < numbers
// < strings < objects (objects tie with each other).
const TYPE_RANK = { boolean: 1, number: 2, string: 3 };
function rankOf(node) {
  if (node === null) return 0;
  if (isBranch(node)) return 4;
  return TYPE_RANK[typeof node] ?? 4;
}

export function valueCompare(a, b) {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0 || ra === 4) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

// The children a query selects, in query order: [[key, node], …].
// `spec`: { orderByChild: string[] | null, limitToLast: number | null }.
export function queryChildren(node, spec) {
  if (!isBranch(node)) return [];
  let entries = Object.keys(node).map((k) => [k, node[k]]);
  const by = spec && spec.orderByChild;
  if (by) {
    entries.sort((x, y) => valueCompare(getAt(x[1], by), getAt(y[1], by)) || nameCompare(x[0], y[0]));
  } else {
    entries.sort((x, y) => nameCompare(x[0], y[0]));
  }
  const limit = spec && spec.limitToLast;
  if (limit != null && entries.length > limit) entries = entries.slice(entries.length - limit);
  return entries;
}

// Stored node → the plain JS value `snapshot.val()` hands out (a fresh copy).
// Branches whose keys are all array-like integers, more than half of them
// present, come back as arrays — Firebase's array heuristic.
export function exportVal(node) {
  if (!isBranch(node)) return node === undefined ? null : node;
  const keys = Object.keys(node);
  const obj = {};
  let maxKey = 0;
  let allInts = true;
  for (const key of keys) {
    obj[key] = exportVal(node[key]);
    if (allInts && ARRAY_KEY.test(key)) maxKey = Math.max(maxKey, Number(key));
    else allInts = false;
  }
  if (allInts && keys.length > 0 && maxKey < 2 * keys.length) {
    const arr = [];
    for (const key of keys) arr[Number(key)] = obj[key];
    return arr;
  }
  return obj;
}

// Firebase push ids: 8 chars of timestamp + 12 random chars, all from an
// alphabet ordered like ASCII, so ids sort in creation order. Ids made in the
// same millisecond reuse the random part plus one.
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
const lastRandChars = [];

export function nextPushId(now) {
  const duplicateTime = now === lastPushTime;
  lastPushTime = now;
  const timeChars = new Array(8);
  for (let i = 7; i >= 0; i--) {
    timeChars[i] = PUSH_CHARS.charAt(now % 64);
    now = Math.floor(now / 64);
  }
  let id = timeChars.join('');
  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) lastRandChars[i] = Math.floor(Math.random() * 64);
  } else {
    let i = 11;
    for (; i >= 0 && lastRandChars[i] === 63; i--) lastRandChars[i] = 0;
    lastRandChars[i]++;
  }
  for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRandChars[i]);
  return id;
}
