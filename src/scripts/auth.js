// Username + password accounts stored in the Realtime Database.
//
// There is no Firebase Auth here (the project only exposes its database URL),
// so accounts are plain records under /users/<name>/auth. The browser derives
// a 256-bit key K = PBKDF2(password, salt) and the database stores only
// verifier = SHA-256(K). Signing in means proving you can produce K; the
// saved session keeps K locally, so the world-readable verifier alone is no
// use for forging one. This keeps the login as simple as asked — but it is a
// casual-game login, not a security boundary: anyone can read the verifiers,
// so players should not reuse a password they care about.

import { get, runTransaction, serverTimestamp, update } from 'firebase/database';
import { dbRef } from './firebase.js';

const SESSION_KEY = 'wavelength.session';
const NAME_RE = /^[a-z0-9_-]{2,20}$/;
const PBKDF2_ITERATIONS = 100000;
// How long a sign-in waits on the database before saying it can't reach it.
const NETWORK_WAIT_MS = 8000;

let user = null; // { uname, name, key }
const listeners = new Set();

export const currentUser = () => user;
export const isSignedIn = () => user !== null;

// fn(user | null) after every sign-in / sign-out. Returns an unsubscribe.
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(user);
}

// Database keys may not contain . # $ [ ] / — the allowed set is stricter
// still so names stay readable everywhere they are shown.
export function normalizeName(raw) {
  const name = String(raw || '').trim();
  const uname = name.toLowerCase();
  return NAME_RE.test(uname) ? { uname, name } : null;
}

// How to show `uname`: `raw` when it is that very name (in any capitals, as
// typed when the account was made), else the bare uname. Names copied around
// the database (profiles, presence, challenges, partner records) are
// world-writable, so every reader passes them through here — a number or a
// 500-character string never reaches the screen or a write that copies it on.
export function displayNameOf(raw, uname) {
  const key = String(uname ?? '');
  const name = typeof raw === 'string' ? raw.trim() : '';
  return name && name.toLowerCase() === key ? name : key;
}

export class AuthError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // 'name' | 'password' | 'wrong' | 'crypto' | 'network'
  }
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));

function subtle() {
  if (!globalThis.crypto?.subtle) throw new AuthError('crypto');
  return crypto.subtle;
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// The secret: PBKDF2-SHA256 of the password, as hex.
async function deriveKey(password, saltHex) {
  const enc = new TextEncoder();
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(saltHex), iterations: PBKDF2_ITERATIONS },
    base,
    256,
  );
  return toHex(bits);
}

// What the database stores: SHA-256 of the key.
async function verifierOf(keyHex) {
  return toHex(await subtle().digest('SHA-256', fromHex(keyHex)));
}

function saveSession() {
  try {
    if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: the session simply won't persist */
  }
}

// `promise`, or AuthError('network') once `ms` have passed without it
// settling (no `ms`: no limit). While it cannot reach the server the SDK
// queues reads and transactions without ever timing them out, so a sign-in
// would otherwise spin until the network came back. Whatever was queued may
// still land later — harmless: a later sign-in reads the record afresh.
function timed(promise, ms) {
  if (!ms) return promise;
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AuthError('network')), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// The account record, or null. A sign-in passes `ms`; restoreSession does
// not, so a saved session waits for the network and signs in once it is back.
async function readAuth(uname, ms) {
  try {
    return (await timed(get(dbRef('users', uname, 'auth')), ms)).val();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    console.error(err);
    throw new AuthError('network');
  }
}

// The account's display name — the capitals it was created with. A stored
// name that is missing or not a spelling of `uname` (profiles are
// world-writable) gives way to `fallback`, itself a sound name, which is also
// written back (best effort) so the next sign-in finds it. Out of reach:
// `fallback`, nothing written.
async function readDisplayName(uname, fallback, ms) {
  let stored;
  try {
    stored = (await timed(get(dbRef('users', uname, 'profile', 'name')), ms)).val();
  } catch {
    return fallback;
  }
  if (typeof stored === 'string' && displayNameOf(stored, uname) === stored) return stored;
  update(dbRef('users', uname, 'profile'), { name: fallback }).catch(() => {});
  return fallback;
}

// Sign in, creating the account if the name is free. Resolves to the user.
export async function login(rawName, password) {
  const parsed = normalizeName(rawName);
  if (!parsed) throw new AuthError('name');
  if (typeof password !== 'string' || password.length === 0 || password.length > 64) {
    throw new AuthError('password');
  }
  const { uname, name } = parsed;
  const authRef = dbRef('users', uname, 'auth');

  let existing = await readAuth(uname, NETWORK_WAIT_MS);

  if (!existing) {
    const salt = randomSalt();
    const key = await deriveKey(password, salt);
    const verifier = await verifierOf(key);
    // The transaction only creates the record if nobody registered the same
    // name in the meantime; if someone did, fall through to a normal check.
    // (One that times out may still create it later — then the next sign-in
    // simply checks the password against it.)
    let result;
    try {
      result = await timed(runTransaction(authRef, (cur) =>
        (cur ? undefined : { salt, verifier, createdAt: Date.now() })), NETWORK_WAIT_MS);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      console.error(err);
      throw new AuthError('network');
    }
    if (result.committed) {
      update(dbRef('users', uname, 'profile'), {
        name, createdAt: serverTimestamp(), lastLogin: serverTimestamp(),
      }).catch((err) => console.error(err)); // not fatal: the account exists
      user = { uname, name, key };
      saveSession();
      emit();
      return user;
    }
    existing = result.snapshot.val();
  }

  if (!existing || !existing.salt || !existing.verifier) throw new AuthError('wrong');
  const key = await deriveKey(password, existing.salt);
  if ((await verifierOf(key)) !== existing.verifier) throw new AuthError('wrong');

  const displayName = await readDisplayName(uname, name, NETWORK_WAIT_MS);
  update(dbRef('users', uname, 'profile'), { lastLogin: serverTimestamp() }).catch(() => {});
  user = { uname, name: displayName, key };
  saveSession();
  emit();
  return user;
}

// Restore a saved session by proving the stored key still matches the
// account's verifier — a hand-edited localStorage entry never counts.
export async function restoreSession() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (typeof saved?.uname !== 'string' || !NAME_RE.test(saved.uname) ||
    typeof saved.key !== 'string' || !/^[0-9a-f]{64}$/.test(saved.key)) {
    if (saved) saveSession(); // drop an old-format or damaged entry
    return null;
  }
  try {
    const auth = await readAuth(saved.uname);
    if (!auth?.verifier || (await verifierOf(saved.key)) !== auth.verifier) {
      user = null;
      saveSession();
      return null;
    }
    // The saved name may be a bad one an earlier session picked up.
    const name = await readDisplayName(saved.uname, displayNameOf(saved.name, saved.uname));
    user = { uname: saved.uname, name, key: saved.key };
    saveSession();
    emit();
    return user;
  } catch (err) {
    console.error(err);
    return null; // offline: stay signed out for now
  }
}

export function logout() {
  user = null;
  saveSession();
  emit();
}
