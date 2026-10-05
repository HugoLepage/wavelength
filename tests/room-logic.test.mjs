// The online room state machine (src/scripts/room-logic.js): every
// transition's happy path and every refusal. Run with `node --test tests/`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUE_MAX, MAX_ROUNDS, MIN_ROUNDS, applyClue, applyGuess, applyLeave, applyNext, applyRedraw,
  clampRounds, cleanClue, createRoomState, drawCard, guesserOf, maxScore, psychicOf, seatOf, settleMove,
} from '../src/scripts/room-logic.js';

const SPECTRUMS = Array.from({ length: 30 }, (_, i) => ({ index: i, left: `L${i}`, right: `R${i}` }));
const PLAYERS = [{ uname: 'ana', name: 'Ana' }, { uname: 'bo', name: 'Bo' }];
const T0 = 1_000;

// Deterministic rng (mulberry32).
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const card = (index, target = 50) => ({ index, left: `L${index}`, right: `R${index}`, target });

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function newRoom(over = {}) {
  return createRoomState({
    id: 'room123abc', players: PLAYERS, rounds: 3, firstPsychic: 0, card: card(0, 40), now: T0, ...over,
  });
}

// Every transition: a fresh object, step + 1, updatedAt = now, input untouched.
function checkStep(before, after, now) {
  assert.ok(after, 'transition refused');
  assert.notEqual(after, before);
  assert.equal(after.step, before.step + 1);
  assert.equal(after.updatedAt, now);
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(after.players, before.players);
}

test('createRoomState: a fresh room in round 1, clue phase', () => {
  const r = newRoom();
  assert.equal(r.id, 'room123abc');
  assert.equal(r.status, 'active');
  assert.equal(r.step, 0);
  assert.equal(r.round, 0);
  assert.equal(r.rounds, 3);
  assert.equal(r.phase, 'clue');
  assert.deepEqual(r.card, card(0, 40));
  assert.deepEqual(r.used, [0]);
  assert.equal(r.clue, null);
  assert.equal(r.guess, null);
  assert.equal(r.points, null);
  assert.equal(r.score, 0);
  assert.deepEqual(r.history, []);
  assert.equal(r.endReason, null);
  assert.equal(r.leftBy, null);
  assert.equal(r.statsRecorded, false);
  assert.equal(r.createdAt, T0);
  assert.equal(r.updatedAt, T0);
  assert.equal(r.live.needle, null);
  assert.equal(r.live.typing, false);
  assert.deepEqual(r.players, PLAYERS);
  assert.notEqual(r.players, PLAYERS);
});

test('createRoomState: bad settings → null', () => {
  assert.equal(newRoom({ rounds: MIN_ROUNDS - 1 }), null);
  assert.equal(newRoom({ rounds: MAX_ROUNDS + 1 }), null);
  assert.equal(newRoom({ rounds: 4.5 }), null);
  assert.equal(newRoom({ firstPsychic: 2 }), null);
  assert.equal(newRoom({ players: [PLAYERS[0]] }), null);
  assert.equal(newRoom({ players: [PLAYERS[0], PLAYERS[0]] }), null);
  assert.equal(newRoom({ card: null }), null);
  assert.equal(newRoom({ card: { ...card(1), target: 120 } }), null);
  assert.equal(newRoom({ id: '' }), null);
  assert.ok(newRoom({ rounds: MIN_ROUNDS }));
  assert.ok(newRoom({ rounds: MAX_ROUNDS }));
});

test('roles alternate every round, starting with firstPsychic', () => {
  const r = newRoom({ firstPsychic: 1 });
  assert.equal(psychicOf(r), 1);
  assert.equal(guesserOf(r), 0);
  assert.equal(psychicOf({ ...r, round: 1 }), 0);
  assert.equal(guesserOf({ ...r, round: 1 }), 1);
  assert.equal(psychicOf({ ...r, round: 2 }), 1);
  assert.equal(seatOf(r, 'ana'), 0);
  assert.equal(seatOf(r, 'bo'), 1);
  assert.equal(seatOf(r, 'eve'), null);
  assert.equal(maxScore(r), 12);
});

test('applyRedraw: psychic swaps the card in the clue phase', () => {
  const r = deepFreeze(newRoom());
  const next = applyRedraw(r, 0, card(5, 77), T0 + 1);
  checkStep(r, next, T0 + 1);
  assert.deepEqual(next.card, card(5, 77));
  assert.deepEqual(next.used, [0, 5]);
  assert.equal(next.phase, 'clue');
  assert.equal(next.round, 0);
});

test('applyRedraw: refused for the guesser, outside the clue phase, bad cards, finished rooms', () => {
  const r = newRoom();
  assert.equal(applyRedraw(r, 1, card(5), T0), null); // guesser
  assert.equal(applyRedraw(r, 2, card(5), T0), null); // not a seat
  assert.equal(applyRedraw(r, 0, null, T0), null);
  assert.equal(applyRedraw(r, 0, { ...card(5), target: -1 }, T0), null);
  const guessing = applyClue(r, 0, 'warm', T0);
  assert.equal(applyRedraw(guessing, 0, card(5), T0), null);
  const left = applyLeave(r, 1, T0);
  assert.equal(applyRedraw(left, 0, card(5), T0), null);
});

test('applyClue: psychic sends a trimmed clue → guess phase', () => {
  const r = deepFreeze(newRoom());
  const next = applyClue(r, 0, '   tepid \n bath  ', T0 + 5);
  checkStep(r, next, T0 + 5);
  assert.equal(next.phase, 'guess');
  assert.equal(next.clue, 'tepid bath');
  assert.equal(cleanClue('  a\t\tb  '), 'a b');
});

test('applyClue: refused for empty / too long clues, the guesser, wrong phase', () => {
  const r = newRoom();
  assert.equal(applyClue(r, 0, '', T0), null);
  assert.equal(applyClue(r, 0, '    ', T0), null);
  assert.equal(applyClue(r, 0, null, T0), null);
  assert.equal(applyClue(r, 0, 'x'.repeat(CLUE_MAX + 1), T0), null);
  assert.ok(applyClue(r, 0, 'x'.repeat(CLUE_MAX), T0));
  assert.ok(applyClue(r, 0, `  ${'x'.repeat(CLUE_MAX)}  `, T0)); // trimmed first
  assert.equal(applyClue(r, 1, 'warm', T0), null); // guesser
  const guessing = applyClue(r, 0, 'warm', T0);
  assert.equal(applyClue(guessing, 0, 'again', T0), null); // already sent
});

test('applyGuess: guesser locks in → reveal, scored, recorded in history', () => {
  const r = deepFreeze(applyClue(newRoom(), 0, 'warm', T0 + 1));
  const next = applyGuess(r, 1, 41.234, T0 + 2);
  checkStep(r, next, T0 + 2);
  assert.equal(next.phase, 'reveal');
  assert.equal(next.guess, 41.2);
  assert.equal(next.points, 4);
  assert.equal(next.score, 4);
  assert.deepEqual(next.history, [
    { left: 'L0', right: 'R0', target: 40, clue: 'warm', guess: 41.2, points: 4, psychic: 0 },
  ]);
  // the card stays up for the reveal
  assert.deepEqual(next.card, card(0, 40));
});

test('applyGuess: points per zone and clamping', () => {
  const r = applyClue(newRoom(), 0, 'warm', T0);
  assert.equal(applyGuess(r, 1, 45, T0).points, 3);
  assert.equal(applyGuess(r, 1, 49, T0).points, 2);
  assert.equal(applyGuess(r, 1, 90, T0).points, 0);
  const clamped = applyGuess(r, 1, 250, T0);
  assert.equal(clamped.guess, 100);
  assert.equal(clamped.points, 0);
});

test('applyGuess: refused for the psychic, wrong phase, bad values, finished rooms', () => {
  const clue = newRoom();
  assert.equal(applyGuess(clue, 1, 50, T0), null); // still the clue phase
  const r = applyClue(clue, 0, 'warm', T0);
  assert.equal(applyGuess(r, 0, 50, T0), null); // psychic
  assert.equal(applyGuess(r, 1, NaN, T0), null);
  assert.equal(applyGuess(r, 1, '50', T0), null);
  assert.equal(applyGuess(r, 1, null, T0), null);
  const revealed = applyGuess(r, 1, 50, T0);
  assert.equal(applyGuess(revealed, 1, 50, T0), null); // already locked
  assert.equal(applyGuess(applyLeave(r, 0, T0), 1, 50, T0), null);
});

test('applyNext: either player starts the next round with a new card, roles swap', () => {
  const r = applyGuess(applyClue(newRoom(), 0, 'warm', T0), 1, 44, T0);
  for (const seat of [0, 1]) {
    const before = deepFreeze(structuredClone(r));
    const next = applyNext(before, seat, card(9, 12), T0 + 9);
    checkStep(before, next, T0 + 9);
    assert.equal(next.round, 1);
    assert.equal(next.phase, 'clue');
    assert.deepEqual(next.card, card(9, 12));
    assert.deepEqual(next.used, [0, 9]);
    assert.equal(next.clue, null);
    assert.equal(next.guess, null);
    assert.equal(next.points, null);
    assert.equal(next.score, 3); // kept
    assert.equal(next.history.length, 1);
    assert.equal(psychicOf(next), 1);
    assert.equal(guesserOf(next), 0);
    assert.equal(next.status, 'active');
  }
});

test('applyNext: refused outside the reveal phase, for non-seats, without a card', () => {
  const r = newRoom();
  assert.equal(applyNext(r, 0, card(3), T0), null); // clue phase
  const guessing = applyClue(r, 0, 'warm', T0);
  assert.equal(applyNext(guessing, 1, card(3), T0), null);
  const revealed = applyGuess(guessing, 1, 50, T0);
  assert.equal(applyNext(revealed, 2, card(3), T0), null);
  assert.equal(applyNext(revealed, -1, card(3), T0), null);
  assert.equal(applyNext(revealed, 0, null, T0), null); // not the last round: a card is needed
});

test('a full game: the last round ends in done / finished / complete', () => {
  let r = newRoom({ rounds: 3, firstPsychic: 1 });
  let now = T0;
  const targets = [40, 70, 20];
  const guesses = [40, 75, 35]; // 4, 3, 0
  const psychics = [];
  for (let round = 0; round < 3; round++) {
    assert.equal(r.round, round);
    const p = psychicOf(r);
    const g = guesserOf(r);
    psychics.push(p);
    r = applyClue(r, p, `clue ${round}`, ++now);
    r = applyGuess(r, g, guesses[round], ++now);
    if (round < 2) r = applyNext(r, round % 2, card(round + 1, targets[round + 1]), ++now);
  }
  assert.deepEqual(psychics, [1, 0, 1]);
  assert.equal(r.score, 7);
  assert.equal(r.step, 8);
  assert.equal(r.phase, 'reveal');
  const before = deepFreeze(r);
  const done = applyNext(before, 0, null, ++now); // no card needed for the end
  checkStep(before, done, now);
  assert.equal(done.phase, 'done');
  assert.equal(done.status, 'finished');
  assert.equal(done.endReason, 'complete');
  assert.equal(done.leftBy, null);
  assert.equal(done.round, 2); // stays on the last round
  assert.equal(done.score, 7);
  assert.deepEqual(done.history.map((h) => h.points), [4, 3, 0]);
  assert.deepEqual(done.history.map((h) => h.psychic), [1, 0, 1]);
  assert.deepEqual(done.used, [0, 1, 2]);
  // nothing moves a finished room
  assert.equal(applyNext(done, 0, card(4), now), null);
  assert.equal(applyRedraw(done, psychicOf(done), card(4), now), null);
  assert.equal(applyClue(done, psychicOf(done), 'x', now), null);
  assert.equal(applyGuess(done, guesserOf(done), 50, now), null);
  assert.equal(applyLeave(done, 0, now), null);
});

test('applyLeave: either seat ends the game for both, in any phase', () => {
  const clue = newRoom();
  const guessing = applyClue(clue, 0, 'warm', T0);
  const revealed = applyGuess(guessing, 1, 50, T0);
  for (const room of [clue, guessing, revealed]) {
    for (const seat of [0, 1]) {
      const before = deepFreeze(structuredClone(room));
      const next = applyLeave(before, seat, T0 + 50);
      checkStep(before, next, T0 + 50);
      assert.equal(next.status, 'finished');
      assert.equal(next.phase, 'done');
      assert.equal(next.endReason, 'left');
      assert.equal(next.leftBy, seat);
      assert.equal(next.score, room.score);
    }
  }
  assert.equal(applyLeave(clue, 2, T0), null);
  assert.equal(applyLeave(clue, null, T0), null);
  assert.equal(applyLeave(null, 0, T0), null);
});

test('transitions never mutate their input', () => {
  const base = newRoom();
  const snapshot = structuredClone(base);
  deepFreeze(base);
  const a = applyRedraw(base, 0, card(7), T0);
  const b = applyClue(a, 0, 'hi', T0);
  const c = applyGuess(b, 1, 20, T0);
  const d = applyNext(c, 1, card(8), T0);
  applyLeave(d, 0, T0);
  assert.deepEqual(base, snapshot);
  // and the outputs share no nested objects with the inputs
  assert.notEqual(a.used, base.used);
  assert.notEqual(a.players[0], base.players[0]);
  assert.notEqual(c.history, b.history);
  assert.notEqual(a.live, base.live);
});

test('clampRounds keeps challenges within 3..12', () => {
  assert.equal(clampRounds(1), 3);
  assert.equal(clampRounds(99), 12);
  assert.equal(clampRounds('7'), 7);
  assert.equal(clampRounds(6.6), 7);
  assert.equal(clampRounds('x'), 5);
});

test('drawCard: never repeats a used card, fresh target in range', () => {
  const rng = rngFrom(42);
  const used = [];
  for (let i = 0; i < SPECTRUMS.length; i++) {
    const c = drawCard(used, SPECTRUMS, rng);
    assert.ok(!used.includes(c.index), `card ${c.index} dealt twice`);
    assert.equal(c.left, `L${c.index}`);
    assert.equal(c.right, `R${c.index}`);
    assert.ok(c.target >= 3 && c.target <= 97);
    used.push(c.index);
  }
  assert.deepEqual([...used].sort((a, b) => a - b), SPECTRUMS.map((s) => s.index));
  // every card used: any card goes rather than failing
  const extra = drawCard(used, SPECTRUMS, rng);
  assert.ok(extra.index >= 0 && extra.index < SPECTRUMS.length);
});

test('drawCard: picks from the only free card, accepts raw [left, right] pairs', () => {
  const used = SPECTRUMS.map((s) => s.index).filter((i) => i !== 17);
  for (let k = 0; k < 20; k++) assert.equal(drawCard(used, SPECTRUMS, Math.random).index, 17);
  const pairs = [['Cold', 'Hot'], ['Soft', 'Hard'], ['Dull', 'Sharp']];
  const c = drawCard([0, 2], pairs, () => 0.999);
  assert.deepEqual([c.index, c.left, c.right], [1, 'Soft', 'Hard']);
  assert.throws(() => drawCard([], []));
});

test('drawCard with random rngs over many games never deals a used card', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = rngFrom(seed);
    const used = [];
    for (let i = 0; i < 12; i++) {
      const c = drawCard(used, SPECTRUMS, rng);
      assert.ok(!used.includes(c.index));
      used.push(c.index);
    }
  }
});

// --- settleMove: how rooms.js retries a move ----------------------------------------

// A stand-in database for settleMove: tx() runs `apply` on `server` unless the
// next scripted failure says otherwise; reload() returns `server`.
function fakeDb(server, failures = []) {
  const db = { server, txCalls: 0, reloads: 0, reloadError: false };
  db.io = (apply) => ({
    tx: async () => {
      db.txCalls++;
      const fail = failures.shift();
      if (fail) throw new Error(fail);
      const next = apply(db.server);
      if (!next) return { committed: false, room: db.server };
      db.server = next;
      return { committed: true, room: next };
    },
    reload: async () => {
      db.reloads++;
      if (db.reloadError) throw new Error('Client is offline');
      return db.server;
    },
  });
  return db;
}

const runMove = (db, apply) => settleMove(apply, db.io(apply));

// Round 1's reveal.
const revealRoom = () => applyGuess(applyClue(newRoom(), 0, 'tea', T0 + 1), 1, 40, T0 + 2);

test('settleMove: a plain move commits on the first try', async () => {
  const db = fakeDb(newRoom());
  const res = await runMove(db, (r) => applyClue(r, 0, 'tea', T0 + 1));
  assert.equal(res.committed, true);
  assert.equal(res.error, undefined);
  assert.equal(res.room.phase, 'guess');
  assert.equal(db.txCalls, 1);
  assert.equal(db.reloads, 0);
});

test("settleMove: 'set' (our own write under the room) just runs again", async () => {
  const db = fakeDb(newRoom(), ['set', 'set']);
  const res = await runMove(db, (r) => applyClue(r, 0, 'tea', T0 + 1));
  assert.equal(res.committed, true);
  assert.equal(db.txCalls, 3);
  assert.equal(db.reloads, 0);
});

test('settleMove: both pressed Next — the one refused on a stale step settles quietly', async () => {
  // The partner's Next landed first: the server is already in round 2.
  const db = fakeDb(applyNext(revealRoom(), 0, card(5), T0 + 3), ['permission_denied']);
  const res = await runMove(db, (r) => applyNext(r, 1, card(6), T0 + 4));
  assert.equal(res.committed, false);
  assert.equal(res.error, undefined, 'no error, so no "Connection trouble" toast');
  assert.equal(res.room, db.server, 'the fresh room comes back');
  assert.equal(res.room.round, 1);
  assert.equal(db.txCalls, 1, 'not run again: the move no longer applies');
  assert.equal(db.reloads, 1);
});

test("settleMove: a Leave overtaken by the partner's Next still applies — it runs again and lands", async () => {
  const db = fakeDb(applyNext(revealRoom(), 0, card(5), T0 + 3), ['permission_denied']);
  const res = await runMove(db, (r) => applyLeave(r, 1, T0 + 4));
  assert.equal(res.committed, true);
  assert.equal(res.error, undefined);
  assert.equal(res.room.status, 'finished');
  assert.equal(res.room.leftBy, 1);
  assert.equal(db.txCalls, 2);
});

test("settleMove: 'maxretry' on a room that finished meanwhile settles quietly", async () => {
  const db = fakeDb(applyLeave(newRoom(), 0, T0 + 1), ['maxretry']);
  const res = await runMove(db, (r) => applyLeave(r, 1, T0 + 2));
  assert.equal(res.committed, false);
  assert.equal(res.error, undefined);
  assert.equal(res.room.leftBy, 0);
});

test('settleMove: a refusal that persists on a fresh room is a real error after `tries` attempts', async () => {
  const db = fakeDb(newRoom(), Array(5).fill('permission_denied'));
  const res = await runMove(db, (r) => applyClue(r, 0, 'tea', T0 + 1));
  assert.equal(res.committed, false);
  assert.equal(res.room, null);
  assert.equal(res.error.message, 'permission_denied');
  assert.equal(db.txCalls, 3);
});

test('settleMove: other failures, and a reload that fails, are errors straight away', async () => {
  const db = fakeDb(newRoom(), ['disconnect']);
  const res = await runMove(db, (r) => applyClue(r, 0, 'tea', T0 + 1));
  assert.equal(res.committed, false);
  assert.equal(res.room, null);
  assert.equal(res.error.message, 'disconnect');
  assert.equal(db.txCalls, 1);
  assert.equal(db.reloads, 0);

  const offline = fakeDb(newRoom(), ['permission_denied']);
  offline.reloadError = true;
  const res2 = await runMove(offline, (r) => applyClue(r, 0, 'tea', T0 + 1));
  assert.equal(res2.committed, false);
  assert.equal(res2.error.message, 'permission_denied', 'the original error stands');
  assert.equal(offline.txCalls, 1);
});

test('settleMove: a room gone missing settles quietly with null', async () => {
  const db = fakeDb(null, ['permission_denied']);
  const res = await runMove(db, (r) => applyLeave(r, 0, T0 + 1));
  assert.deepEqual(res, { committed: false, room: null });
});
