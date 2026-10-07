// Online game rooms: /rooms/<id> holds the whole game (see room-logic.js for
// the shape and the rules of every move) plus a `step` counter. Every move is
// a transaction that runs the pure transition against the server's copy and
// bumps `step` by one, so two clients can never both apply a move to the same
// state (the database rules refuse anything else, too).
//
// /live/<id> is the room's scratch channel for the guesser's needle and the
// psychic's typing dots, written many times a second without a step bump.
// It sits outside /rooms/<id> on purpose: a transaction compares the whole
// node it runs on, so a needle streaming inside the room would make every
// move from the other screen (a Leave above all) come back stale over and
// over. watchLive follows it; watchRoom never sees it.
//
// A room deals from one deck for its whole life: `deck`, 'classic' or
// 'spicy', fixed when the room is created (from the challenge, so both
// players agreed to it) and never written again. Every draw comes from
// deckList(room.deck), and room.used indexes into that deck.

import { get, onDisconnect, onValue, ref, serverTimestamp, update } from 'firebase/database';
import { db, dbRef, transact } from './firebase.js';
import { deckList, resolveDeck } from './spectra.js';
import { displayNameOf } from './auth.js';
import {
  EMPTY_LIVE, applyClue, applyGuess, applyLeave, applyNext, applyRedraw, cleanDeck, createRoomState, drawCard,
  settleMove,
} from './room-logic.js';

// The SDK throws on `undefined` anywhere in a value; a JSON round trip drops
// such fields (server-value sentinels are plain objects and survive it).
const clean = (v) => JSON.parse(JSON.stringify(v));

// Unambiguous characters only — the id ends up in a URL people may read aloud.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newRoomId(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export const isValidRoomId = (id) => /^[a-z0-9]{6,20}$/.test(String(id || ''));

// --- (de)serialisation ------------------------------------------------------
// The database drops null fields and returns dense integer-keyed objects as
// arrays (and sparse ones as objects), so reading is made explicit here.

export function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (typeof v !== 'object') return [];
  return Object.keys(v)
    .sort((a, b) => a - b)
    .map((k) => v[k])
    .filter((x) => x != null);
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const seatOrNull = (v) => (v === 0 || v === 1 ? v : null);

export function normalizeLive(v) {
  const l = v && typeof v === 'object' ? v : {};
  return {
    needle: numOrNull(l.needle),
    typing: l.typing === true,
    by: l.by ?? null,
    step: numOrNull(l.step),
    at: num(l.at),
  };
}

function normalizeCard(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    index: num(c.index),
    left: String(c.left ?? ''),
    right: String(c.right ?? ''),
    target: num(c.target, 50),
  };
}

function normalizeEntry(h) {
  return {
    left: String(h.left ?? ''),
    right: String(h.right ?? ''),
    target: num(h.target, 50),
    clue: String(h.clue ?? ''),
    guess: num(h.guess, 50),
    points: num(h.points),
    psychic: num(h.psychic),
  };
}

const PHASES = ['clue', 'guess', 'reveal', 'done'];

// Raw database value → the room shape room-logic.js works on. null when the
// node is missing or is not a room (e.g. only a stray `live` child, from when
// the live channel sat under the room). `live` is only ever such a leftover —
// the real one comes from watchLive.
export function normalizeRoom(r) {
  if (!r || typeof r !== 'object' || !r.id) return null;
  const players = toArray(r.players)
    .filter((p) => p && typeof p === 'object' && p.uname)
    .map((p) => ({ uname: String(p.uname), name: displayNameOf(p.name, p.uname) }));
  if (players.length !== 2) return null;
  const rounds = num(r.rounds, 1);
  return {
    id: String(r.id),
    status: r.status === 'finished' ? 'finished' : 'active',
    step: num(r.step),
    players,
    rounds,
    round: Math.min(num(r.round), Math.max(0, rounds - 1)),
    firstPsychic: seatOrNull(r.firstPsychic) ?? 0,
    deck: cleanDeck(r.deck), // a room from before spicy mode has none: classic
    phase: PHASES.includes(r.phase) ? r.phase : 'clue',
    card: normalizeCard(r.card),
    used: toArray(r.used).filter((i) => typeof i === 'number'),
    clue: typeof r.clue === 'string' ? r.clue : null,
    guess: numOrNull(r.guess),
    points: numOrNull(r.points),
    score: num(r.score),
    history: toArray(r.history).filter((h) => typeof h === 'object').map(normalizeEntry),
    endReason: r.endReason === 'complete' || r.endReason === 'left' ? r.endReason : null,
    leftBy: seatOrNull(r.leftBy),
    live: normalizeLive(r.live),
    // true once written; an object { by, at } while some client is claiming the job
    statsRecorded: r.statsRecorded ?? false,
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  };
}

// What decides whether watchRoom fires (a leftover `live` child aside).
const signature = (room) => JSON.stringify({ ...room, live: null });

// --- lifecycle --------------------------------------------------------------

// `players`: [{ uname, name }, { uname, name }] (seat 0, seat 1).
// `deck`: 'classic' (the default) or 'spicy', resolved here — a room only
// ever turns out spicy when there are spicy cards to deal.
// `firstPsychic` (0 | 1) and `card` (from that deck) default to random ones.
// `extraUpdates` (multi-path entries, e.g. stats.js onlineStartEntries) land
// in the same write as the room, so a room can never exist without them.
// Resolves the id; rejects on bad input or when the write is refused.
export async function createRoom({ id, players, rounds, firstPsychic, deck, card, extraUpdates = {} }) {
  if (!isValidRoomId(id)) throw new Error('createRoom: bad room id');
  const first = firstPsychic === 0 || firstPsychic === 1 ? firstPsychic : (Math.random() < 0.5 ? 0 : 1);
  const d = resolveDeck(deck);
  const state = createRoomState({
    id, players, rounds, firstPsychic: first, deck: d, card: card || drawCard([], deckList(d)), now: Date.now(),
  });
  if (!state) throw new Error('createRoom: bad room settings');
  const { live, ...room } = state; // nobody has said anything on the live channel yet
  room.createdAt = serverTimestamp();
  room.updatedAt = serverTimestamp();
  await update(ref(db), clean({ [`rooms/${id}`]: room, ...extraUpdates }));
  return id;
}

// One read of the room (e.g. to check a ?session link). null when missing.
export async function fetchRoom(id) {
  if (!isValidRoomId(id)) return null;
  const snap = await get(dbRef('rooms', id));
  return snap.exists() ? normalizeRoom(snap.val()) : null;
}

// cb(room | null, error?) — null when the room does not exist (or the id is
// bad). Fires only when the room really changed; the live channel is
// watchLive's. Returns an unsubscribe.
export function watchRoom(id, cb) {
  if (!isValidRoomId(id)) {
    cb(null);
    return () => {};
  }
  let last;
  return onValue(dbRef('rooms', id), (snap) => {
    const room = snap.exists() ? normalizeRoom(snap.val()) : null;
    const sig = room ? signature(room) : 'null';
    if (sig === last) return;
    last = sig;
    cb(room);
  }, (err) => {
    last = undefined;
    cb(null, err);
  });
}

// --- the live channel ---------------------------------------------------------

// The fields the database rules accept under /live/<id> (`at` is set here,
// as a server timestamp, on every write). The rules only let a room that
// exists have one.
const LIVE_FIELDS = ['needle', 'typing', 'by', 'step'];

const liveRef = (id) => dbRef('live', id);

// cb({ needle, typing, by, step, at }) on every live change. Returns an unsubscribe.
export function watchLive(id, cb) {
  if (!isValidRoomId(id)) {
    cb({ ...EMPTY_LIVE });
    return () => {};
  }
  return onValue(liveRef(id), (snap) => cb(normalizeLive(snap.val())),
    () => cb({ ...EMPTY_LIVE }));
}

// Merge `fields` into the live channel — fire and forget, safe to call often
// (the caller throttles). Unknown fields are dropped (the rules refuse them).
// Resolves true when written.
export function setLive(id, fields = {}) {
  if (!isValidRoomId(id)) return Promise.resolve(false);
  const out = {};
  for (const k of LIVE_FIELDS) {
    if (!(k in fields)) continue;
    let v = fields[k];
    if (k === 'needle' && v != null) v = Math.round(Math.min(100, Math.max(0, Number(v) || 0)) * 10) / 10;
    if (k === 'typing') v = v === true;
    out[k] = v ?? null;
  }
  out.at = serverTimestamp();
  return update(liveRef(id), out)
    .then(() => true)
    .catch((err) => {
      console.error('live', err);
      return false;
    });
}

// If this tab drops off mid-sentence, the server clears its typing dots.
// Resolves a function that disarms it again (call it when leaving the room).
export async function armLiveCleanup(id) {
  if (!isValidRoomId(id)) return () => {};
  const od = onDisconnect(liveRef(id));
  try {
    await od.update({ typing: false });
  } catch (err) {
    console.error('live', err);
  }
  return () => od.cancel().catch(() => {});
}

// --- moves --------------------------------------------------------------------

// Run one pure transition against the server's copy of the room. The result
// keeps every raw field the transition did not produce — `statsRecorded`,
// `createdAt` and `deck` above all — exactly as the server has them (a
// leftover `live` child is dropped). No move ever writes `deck`: a room from
// before spicy mode has none (normalizeRoom reads it as classic) and must
// keep having none, since the rules refuse any change to it.
//
// Resolves { committed, room } (room = the server's current room either way;
// not committed and no error = the move no longer applies, e.g. the
// partner's Next landed first), or
// { committed: false, room: null, error } when the database refused / failed.
// Retries follow room-logic.js settleMove.
async function move(id, apply) {
  if (!isValidRoomId(id)) return { committed: false, room: null, error: new Error('bad room id') };
  const res = await settleMove(apply, {
    tx: async () => {
      const r = await transact(dbRef('rooms', id), (cur) => {
        const room = normalizeRoom(cur);
        const next = room && apply(room);
        if (!next) return undefined;
        const { live: _leftover, ...base } = cur;
        const { live, statsRecorded, createdAt, deck, ...fields } = next;
        return clean({ ...base, ...fields });
      });
      return { committed: r.committed, room: normalizeRoom(r.snapshot.val()) };
    },
    reload: () => fetchRoom(id),
  });
  if (res.error) console.error('room', res.error);
  return res;
}

// Psychic, clue phase: a different card and target.
export const redrawCard = (id, seat) =>
  move(id, (room) => applyRedraw(room, seat, drawCard(room.used, deckList(room.deck)), Date.now()));

// Psychic, clue phase: send the clue (trimmed, 1–60 characters) → guess phase.
export const submitClue = (id, seat, clue) =>
  move(id, (room) => applyClue(room, seat, clue, Date.now()));

// Guesser, guess phase: lock the needle at `guess` (0–100) → reveal phase.
export const lockGuess = (id, seat, guess) =>
  move(id, (room) => applyGuess(room, seat, guess, Date.now()));

// Either player, reveal phase: next round with a fresh card, or the end.
export const nextRound = (id, seat) =>
  move(id, (room) => applyNext(room, seat, drawCard(room.used, deckList(room.deck)), Date.now()));

// Either player, any time while active: the game ends for both.
export const leaveRoom = (id, seat) =>
  move(id, (room) => applyLeave(room, seat, Date.now()));
