// The online room as a pure state machine. Every function here takes a
// normalised room (see rooms.js normalizeRoom) and returns the NEXT room — a
// fresh object, the input is never touched — or null when the move is not
// allowed (wrong phase, wrong seat, finished room, bad input). rooms.js runs
// each transition inside a database transaction, so the same checks guard
// against stale clicks and two tabs racing each other.
//
// Kept free of the database and of the spectrum list (which Vite imports as
// JSON) so it runs in plain Node for the tests: cards are passed in, and so
// are the database calls of settleMove (how rooms.js retries a move).
//
// Room shape (also what normalizeRoom returns):
//   { id, status: 'active'|'finished', step, players: [{uname,name}] ×2,
//     rounds, round (0-based), firstPsychic: 0|1,
//     phase: 'clue'|'guess'|'reveal'|'done',
//     card: { index, left, right, target }, used: [card indices dealt],
//     clue, guess, points, score, history: [{ left, right, target, clue,
//     guess, points, psychic }], endReason: null|'complete'|'left',
//     leftBy: null|seat, live, statsRecorded, createdAt, updatedAt }

import { MAX_POINTS, clampValue, randomTarget, scoreFor } from './scoring.js';

export const MIN_ROUNDS = 3;
export const MAX_ROUNDS = 12;
export const DEFAULT_ROUNDS = 5;
export const CLUE_MAX = 60;

export const clampRounds = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_ROUNDS;
  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, v));
};

// Live channel defaults: needle null = "the guesser has not moved it yet".
export const EMPTY_LIVE = Object.freeze({ needle: null, typing: false, by: null, step: null, at: 0 });

// --- roles -------------------------------------------------------------------

// The psychic alternates every round, starting with `firstPsychic`.
export const psychicOf = (room) => ((room.firstPsychic || 0) + (room.round || 0)) % 2;
export const guesserOf = (room) => 1 - psychicOf(room);

// Seat (0 | 1) of `uname` in the room, or null for a spectator.
export function seatOf(room, uname) {
  if (!room || !uname) return null;
  const i = (room.players || []).findIndex((p) => p && p.uname === uname);
  return i === 0 || i === 1 ? i : null;
}

export const isFinished = (room) => !!room && room.status === 'finished';

// Points a perfect game would score — for "17 / 24" style summaries.
export const maxScore = (room) => (room ? room.rounds * MAX_POINTS : 0);

// --- cards -------------------------------------------------------------------

// `spectrums` is the card list: [{ index, left, right }] (SPECTRUMS) or raw
// [left, right] pairs whose position is the index.
function cardAt(spectrums, i) {
  const s = spectrums[i];
  if (Array.isArray(s)) return { index: i, left: s[0], right: s[1] };
  return { index: s.index ?? i, left: s.left, right: s.right };
}

// A random card that has not been dealt in this room yet, with a fresh
// target. When every card has been used (never, with a full deck) any card
// goes.
export function drawCard(used = [], spectrums = [], rng = Math.random) {
  if (!spectrums.length) throw new Error('drawCard: empty spectrum list');
  const seen = new Set(used);
  const free = [];
  for (let i = 0; i < spectrums.length; i++) {
    if (!seen.has(cardAt(spectrums, i).index)) free.push(i);
  }
  const pool = free.length ? free : spectrums.map((_, i) => i);
  const pick = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  const card = cardAt(spectrums, pick);
  return { index: card.index, left: card.left, right: card.right, target: randomTarget(rng) };
}

const isSeat = (s) => s === 0 || s === 1;

function validCard(card) {
  return !!card && Number.isInteger(card.index) && card.index >= 0 &&
    typeof card.left === 'string' && typeof card.right === 'string' &&
    typeof card.target === 'number' && Number.isFinite(card.target) &&
    card.target >= 0 && card.target <= 100;
}

const copyCard = (c) => ({ index: c.index, left: c.left, right: c.right, target: c.target });

// The shared preconditions of every in-game move.
const playable = (room, seat) => !!room && room.status === 'active' && room.phase !== 'done' && isSeat(seat);

// Next room = a copy of `room` with `changes`, one step on, stamped `now`.
function advance(room, changes, now) {
  const sr = room.statsRecorded;
  return {
    ...room,
    players: room.players.map((p) => ({ ...p })),
    card: room.card ? copyCard(room.card) : null,
    used: [...(room.used || [])],
    history: (room.history || []).map((h) => ({ ...h })),
    live: { ...EMPTY_LIVE, ...(room.live || {}) },
    statsRecorded: sr && typeof sr === 'object' ? { ...sr } : (sr ?? false),
    ...changes,
    step: (room.step || 0) + 1,
    updatedAt: now,
  };
}

// --- transitions ----------------------------------------------------------------

// A brand-new room in the first round's clue phase. null on bad input.
export function createRoomState({ id, players, rounds, firstPsychic = 0, card, now = Date.now() } = {}) {
  if (typeof id !== 'string' || !id) return null;
  if (!Array.isArray(players) || players.length !== 2) return null;
  if (!players.every((p) => p && typeof p.uname === 'string' && p.uname)) return null;
  if (players[0].uname === players[1].uname) return null;
  if (!Number.isInteger(rounds) || rounds < MIN_ROUNDS || rounds > MAX_ROUNDS) return null;
  if (!isSeat(firstPsychic) || !validCard(card)) return null;
  return {
    id,
    status: 'active',
    step: 0,
    players: players.map((p) => ({ uname: p.uname, name: p.name || p.uname })),
    rounds,
    round: 0,
    firstPsychic,
    phase: 'clue',
    card: copyCard(card),
    used: [card.index],
    clue: null,
    guess: null,
    points: null,
    score: 0,
    history: [],
    endReason: null,
    leftBy: null,
    live: { ...EMPTY_LIVE },
    statsRecorded: false,
    createdAt: now,
    updatedAt: now,
  };
}

// Psychic swaps the card (and target) before giving a clue.
export function applyRedraw(room, seat, card, now = Date.now()) {
  if (!playable(room, seat) || room.phase !== 'clue' || seat !== psychicOf(room)) return null;
  if (!validCard(card)) return null;
  return advance(room, { card: copyCard(card), used: [...(room.used || []), card.index] }, now);
}

// Clean up what the psychic typed: one line, trimmed. '' when unusable.
export function cleanClue(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

// Psychic sends the clue: clue → guess.
export function applyClue(room, seat, clue, now = Date.now()) {
  if (!playable(room, seat) || room.phase !== 'clue' || seat !== psychicOf(room)) return null;
  const text = cleanClue(clue);
  if (text.length < 1 || text.length > CLUE_MAX) return null;
  return advance(room, { phase: 'guess', clue: text }, now);
}

// Guesser locks the needle in: guess → reveal, points scored and recorded.
export function applyGuess(room, seat, guess, now = Date.now()) {
  if (!playable(room, seat) || room.phase !== 'guess' || seat !== guesserOf(room)) return null;
  if (typeof guess !== 'number' || !Number.isFinite(guess) || !room.card) return null;
  const value = Math.round(clampValue(guess) * 10) / 10;
  const points = scoreFor(room.card.target, value);
  const entry = {
    left: room.card.left,
    right: room.card.right,
    target: room.card.target,
    clue: room.clue || '',
    guess: value,
    points,
    psychic: psychicOf(room),
  };
  return advance(room, {
    phase: 'reveal',
    guess: value,
    points,
    score: (room.score || 0) + points,
    history: [...(room.history || []).map((h) => ({ ...h })), entry],
  }, now);
}

// Either player moves on from the reveal: the next round's clue phase with
// `card`, or — after the last round — the end of the game (`card` unused).
export function applyNext(room, seat, card, now = Date.now()) {
  if (!playable(room, seat) || room.phase !== 'reveal') return null;
  if (room.round + 1 >= room.rounds) {
    return advance(room, { phase: 'done', status: 'finished', endReason: 'complete' }, now);
  }
  if (!validCard(card)) return null;
  return advance(room, {
    round: room.round + 1,
    phase: 'clue',
    card: copyCard(card),
    used: [...(room.used || []), card.index],
    clue: null,
    guess: null,
    points: null,
  }, now);
}

// A player walks out: the game ends for both. The phase becomes 'done' (the
// last reveal, if any, stays in clue/guess/points/history).
export function applyLeave(room, seat, now = Date.now()) {
  if (!room || room.status !== 'active' || !isSeat(seat)) return null;
  return advance(room, { phase: 'done', status: 'finished', endReason: 'left', leftBy: seat }, now);
}

// --- running a move ---------------------------------------------------------------
// How rooms.js runs a transition against the database, with the database
// calls passed in so the policy can be tested here:
//   tx()      one transaction of `apply` on the server's copy → { committed, room }
//   reload()  one fresh read of the room → room | null
// The SDK rejects a failed transaction with an Error whose message is the
// server's verdict:
//   'set'                a write of our own landed under the room while the
//                        transaction waited — only a collision with ourselves,
//                        so it simply runs again.
//   'permission_denied'  the server may have judged a stale copy: the partner's
//   'maxretry'           move landed first (the rules refuse a step that is not
//                        one past the server's — both players may press Next,
//                        and Leave races everything), or the room kept changing.
//                        One fresh read decides: a move that no longer applies
//                        settles quietly with that room, one that still does
//                        runs again.
//   anything else        a real failure.
// At most `tries` transactions. Resolves { committed, room } — no `error` when
// the move was merely overtaken — or { committed: false, room: null, error }.
export async function settleMove(apply, { tx, reload, tries = 3 }) {
  let error = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await tx();
    } catch (err) {
      error = err;
      const reason = err?.message;
      if (reason === 'set') continue;
      if (reason !== 'permission_denied' && reason !== 'maxretry') break;
      let fresh;
      try {
        fresh = await reload();
      } catch {
        break; // offline with nothing cached: the original error stands
      }
      if (!fresh || !apply(fresh)) return { committed: false, room: fresh ?? null };
    }
  }
  return { committed: false, room: null, error };
}
