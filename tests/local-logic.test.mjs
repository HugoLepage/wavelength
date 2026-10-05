// Pass-and-play rules (src/scripts/local-logic.js): turn order, scoring with
// and without the rival call, refusals from the wrong phase, the deck, the
// results ranking and the saved-game check. Run with `node --test tests/`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ROUNDS, beginPsychic, callSide, coopRating, createGame, handOver, hasRival, holderOf, inProgress,
  isLastTurn, lockIn, maxScore, moveNeedle, nextTeamOf, nextTurn, normalizeGame, ranking, redraw, rematch,
  rivalOf,
} from '../src/scripts/local-logic.js';

const SPECTRUMS = Array.from({ length: 12 }, (_, i) => ({ index: i, left: `L${i}`, right: `R${i}` }));
const spectrumAt = (i) => SPECTRUMS[i] || SPECTRUMS[0];
const DECK = [5, 3, 9, 0, 1, 2, 4, 6, 7, 8, 10, 11];

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

const team = (i) => ({ id: i, color: `#00000${i}`, score: 99, adjective: 'Silly', critter: 'fox', name: `Team ${i}` });
const teams = (n) => Array.from({ length: n }, (_, i) => team(i));

function newGame(n = 2, rounds = 2, rival = false) {
  return createGame({ teams: teams(n), rounds, rival, deck: DECK, spectrumAt, rng: rngFrom(7), now: 1 });
}

// Plays one whole turn; `guessFor` picks the guess from the target.
function playTurn(g, guessFor = (t) => t, call = 'left') {
  g = beginPsychic(g);
  g = handOver(g);
  g = lockIn(g, guessFor(g.card.target));
  if (g.phase === 'rival') g = callSide(g, call);
  return g;
}

test('a new game: scores reset, first card dealt off the deck to team 0', () => {
  const g = newGame(3, 4);
  assert.equal(g.phase, 'handoff');
  assert.equal(g.round, 0);
  assert.equal(g.turn, 0);
  assert.deepEqual(g.teams.map((t) => t.score), [0, 0, 0]);
  assert.equal(g.card.index, 5);
  assert.equal(g.card.left, 'L5');
  assert.ok(g.card.target >= 3 && g.card.target <= 97);
  assert.equal(g.deckPos, 1);
  assert.equal(maxScore(g), 16);
  assert.ok(inProgress(g));
});

test('rival is off with one team, even when asked for', () => {
  const g = newGame(1, 2, true);
  assert.equal(g.rival, false);
  assert.equal(hasRival(g), false);
  assert.equal(rivalOf(g), null);
});

test('rounds are clamped', () => {
  assert.equal(newGame(2, 99).rounds, MAX_ROUNDS);
  assert.equal(newGame(2, 0).rounds, 1);
});

test('transitions refuse the wrong phase', () => {
  const g = newGame();
  assert.equal(handOver(g), null);
  assert.equal(lockIn(g, 50), null);
  assert.equal(callSide(g, 'left'), null);
  assert.equal(nextTurn(g, spectrumAt), null);
  assert.equal(moveNeedle(g, 20), null);
  const p = beginPsychic(g);
  assert.equal(beginPsychic(p), null);
  const q = handOver(p);
  assert.equal(redraw(q, spectrumAt), null);
  assert.equal(callSide(q, 'left'), null); // no rival in this game
});

test('redraw deals the next card and a new target, still the psychic', () => {
  const p = beginPsychic(newGame());
  const r = redraw(p, spectrumAt, rngFrom(99));
  assert.equal(r.phase, 'psychic');
  assert.equal(r.card.index, 3);
  assert.equal(r.deckPos, 2);
});

test('a bullseye scores 4 for the active team and goes to reveal', () => {
  const g = playTurn(newGame(2, 2));
  assert.equal(g.phase, 'reveal');
  assert.deepEqual(g.result, { points: 4, rivalTeam: null, rivalPoints: 0 });
  assert.deepEqual(g.teams.map((t) => t.score), [4, 0]);
  assert.equal(g.history.length, 1);
  assert.equal(g.history[0].points, 4);
});

test('needle moves are kept during the guess and clamped', () => {
  let g = handOver(beginPsychic(newGame()));
  g = moveNeedle(g, 140);
  assert.equal(g.needle, 100);
  g = moveNeedle(g, 33.333);
  assert.equal(g.needle, 33.3);
});

test('rival call: +1 when right, none when the team hit the bullseye', () => {
  // Guess 8 to the right of the target: the target is LEFT of the needle.
  let g = playTurn(newGame(2, 2, true), (t) => t + 8, 'left');
  assert.equal(g.result.points, 2);
  assert.equal(g.result.rivalTeam, 1);
  assert.equal(g.result.rivalPoints, 1);
  assert.deepEqual(g.teams.map((t) => t.score), [2, 1]);

  g = playTurn(newGame(2, 2, true), (t) => t + 8, 'right');
  assert.equal(g.result.rivalPoints, 0);

  g = playTurn(newGame(2, 2, true), (t) => t, 'left');
  assert.equal(g.result.points, 4);
  assert.equal(g.result.rivalPoints, 0);
});

test('the rival is the next team round the table and holds the device', () => {
  let g = newGame(3, 1, true);
  g = playTurn(g);
  g = nextTurn(g, spectrumAt, rngFrom(1));
  g = nextTurn(playTurn(g), spectrumAt, rngFrom(2));
  assert.equal(g.turn, 2);
  g = lockIn(handOver(beginPsychic(g)), 50);
  assert.equal(g.phase, 'rival');
  assert.equal(rivalOf(g), 0);
  assert.equal(holderOf(g), 0);
});

test('turn order: every team once per round, then done', () => {
  let g = newGame(3, 2);
  const seen = [];
  for (;;) {
    seen.push([g.round, g.turn]);
    g = playTurn(g, (t) => (t > 50 ? t - 30 : t + 30));
    const last = isLastTurn(g);
    assert.equal(nextTeamOf(g), last ? null : (g.turn + 1) % 3);
    g = nextTurn(g, spectrumAt, rngFrom(seen.length));
    if (g.phase === 'done') break;
    assert.equal(g.phase, 'handoff');
  }
  assert.deepEqual(seen, [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
  assert.equal(g.history.length, 6);
  assert.equal(inProgress(g), false);
  assert.equal(nextTurn(g, spectrumAt), null);
});

test('cards do not repeat within a game', () => {
  let g = newGame(2, 5);
  const cards = [g.card.index];
  while (g.phase !== 'done') {
    g = nextTurn(playTurn(g), spectrumAt, rngFrom(cards.length));
    if (g.phase !== 'done') cards.push(g.card.index);
  }
  assert.equal(new Set(cards).size, cards.length);
});

test('rematch keeps teams and settings, resets scores, continues the deck', () => {
  let g = newGame(2, 1, true);
  g = nextTurn(playTurn(g), spectrumAt);
  g = nextTurn(playTurn(g), spectrumAt);
  assert.equal(g.phase, 'done');
  const r = rematch(g, spectrumAt, rngFrom(3));
  assert.equal(r.phase, 'handoff');
  assert.deepEqual(r.teams.map((t) => t.name), ['Team 0', 'Team 1']);
  assert.deepEqual(r.teams.map((t) => t.score), [0, 0]);
  assert.equal(r.rival, true);
  assert.equal(r.history.length, 0);
  assert.equal(r.card.index, DECK[g.deckPos % DECK.length]);
});

test('ranking: ties share a place', () => {
  const t = [5, 9, 5, 2, 9].map((score, i) => ({ ...team(i), score }));
  const r = ranking(t);
  assert.deepEqual(r.map((x) => [x.i, x.place]), [[1, 1], [4, 1], [0, 3], [2, 3], [3, 5]]);
});

test('co-op rating tiers', () => {
  assert.equal(coopRating(12, 12).title, 'Telepathic!');
  assert.equal(coopRating(0, 12).title, 'Lost signal');
  assert.equal(coopRating(6, 12).tier, 2);
});

test('normalizeGame round-trips a saved game and rejects junk', () => {
  let g = newGame(3, 2, true);
  for (const step of [beginPsychic, handOver]) {
    g = step(g);
    assert.deepEqual(normalizeGame(JSON.parse(JSON.stringify(g))), g);
  }
  g = lockIn(g, 40);
  assert.deepEqual(normalizeGame(JSON.parse(JSON.stringify(g))), g);
  g = callSide(g, 'right');
  assert.deepEqual(normalizeGame(JSON.parse(JSON.stringify(g))), g);

  assert.equal(normalizeGame(null), null);
  assert.equal(normalizeGame({ ...g, v: 0 }), null);
  assert.equal(normalizeGame({ ...g, phase: 'party' }), null);
  assert.equal(normalizeGame({ ...g, teams: [] }), null);
  assert.equal(normalizeGame({ ...g, card: null }), null);
  assert.equal(normalizeGame({ ...g, result: null }), null);
  assert.equal(normalizeGame({ ...g, phase: 'rival', rival: false }), null);
  // Out-of-range positions are pulled back in.
  const fixed = normalizeGame({ ...g, turn: 12, round: -3 });
  assert.equal(fixed.turn, 2);
  assert.equal(fixed.round, 0);
});
