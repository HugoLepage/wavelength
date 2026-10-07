// Pass-and-play rules (src/scripts/local-logic.js): turn order, scoring with
// and without the rival call, refusals from the wrong phase, the decks (spicy
// mode's switch included), the results ranking and the saved-game check (old
// saves included). Run with `node --test tests/`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ROUNDS, callSide, coopRating, createGame, handOver, hasRival, holderOf, inProgress, isLastTurn,
  lockIn, maxScore, moveNeedle, nextTeamOf, nextTurn, normalizeGame, ranking, redraw, rematch, rivalOf,
  showTarget, switchDeck, targetSeen,
} from '../src/scripts/local-logic.js';

// Two small decks whose card indices overlap, as the real two lists do.
const SPECTRA = {
  classic: Array.from({ length: 12 }, (_, i) => ({ index: i, left: `L${i}`, right: `R${i}` })),
  spicy: Array.from({ length: 5 }, (_, i) => ({ index: i, left: `Hot L${i}`, right: `Hot R${i}` })),
};
// Each deck's "shuffle", fixed so the cards are known in advance.
const ORDERS = { classic: [5, 3, 9, 0, 1, 2, 4, 6, 7, 8, 10, 11], spicy: [2, 4, 0, 3, 1] };
const DECK = ORDERS.classic;

// A dealer as local.js builds one (spectra.js + spicy.js), for the deck in force.
const dealerFor = (deck, shuffledDeck = (_rng, d) => ORDERS[d].slice()) => ({
  deck,
  spectrumAt: (i, d) => SPECTRA[d][i] || SPECTRA[d][0],
  shuffledDeck,
});
const classic = dealerFor('classic');
const spicy = dealerFor('spicy');

// A real Fisher–Yates over a deck, for the no-repeat checks.
const shuffling = (deck) =>
  dealerFor(deck, (rng, d) => {
    const order = SPECTRA[d].map((s) => s.index);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  });

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

function newGame(n = 2, rounds = 2, rival = false, dealer = classic) {
  return createGame({ teams: teams(n), rounds, rival, dealer, rng: rngFrom(7), now: 1 });
}

// A clean copy, as localStorage would give it back.
const saved = (g) => JSON.parse(JSON.stringify(g));

// Plays one whole turn; `guessFor` picks the guess from the target.
function playTurn(g, guessFor = (t) => t, call = 'left') {
  g = showTarget(g);
  g = handOver(g);
  g = lockIn(g, guessFor(g.card.target));
  if (g.phase === 'rival') g = callSide(g, call);
  return g;
}

test('a new game: scores reset, first card dealt off the deck to team 0', () => {
  const g = newGame(3, 4);
  assert.equal(g.phase, 'psychic');
  assert.equal(g.targetShown, false);
  assert.equal(holderOf(g), 0);
  assert.equal(g.round, 0);
  assert.equal(g.turn, 0);
  assert.deepEqual(g.teams.map((t) => t.score), [0, 0, 0]);
  assert.equal(g.card.index, 5);
  assert.equal(g.card.deck, 'classic');
  assert.equal(g.card.left, 'L5');
  assert.ok(g.card.target >= 3 && g.card.target <= 97);
  assert.deepEqual(g.decks, { classic: { order: DECK, pos: 1 } }); // the spicy one only when needed
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
  assert.equal(handOver(g), null); // the psychic has not seen the target yet
  assert.equal(lockIn(g, 50), null);
  assert.equal(callSide(g, 'left'), null);
  assert.equal(nextTurn(g, classic), null);
  assert.equal(moveNeedle(g, 20), null);
  const p = showTarget(g);
  assert.equal(showTarget(p).targetShown, true); // looking again is fine
  const q = handOver(p);
  assert.equal(showTarget(q), null);
  assert.equal(handOver(q), null);
  assert.equal(redraw(q, classic), null);
  assert.equal(callSide(q, 'left'), null); // no rival in this game
});

test('every turn starts with the target hidden; only Show target reveals it', () => {
  let g = newGame(2, 2);
  assert.equal(g.targetShown, false);
  g = showTarget(g, 5);
  assert.equal(g.phase, 'psychic');
  assert.equal(g.targetShown, true);
  assert.equal(g.updatedAt, 5);
  g = handOver(g);
  assert.equal(g.phase, 'guess');
  g = nextTurn(lockIn(g, 50), classic, rngFrom(4));
  assert.equal(g.phase, 'psychic');
  assert.equal(g.turn, 1);
  assert.equal(g.targetShown, false);
  assert.equal(handOver(g), null);

  // The rematch opens the same way.
  g = nextTurn(playTurn(g), classic);
  g = nextTurn(playTurn(g), classic);
  g = nextTurn(playTurn(g), classic);
  assert.equal(g.phase, 'done');
  const r = rematch(g, classic, rngFrom(3));
  assert.equal(r.phase, 'psychic');
  assert.equal(r.targetShown, false);
});

test('redraw deals the next card and a new target, still the psychic', () => {
  const g = newGame();
  const r = redraw(g, classic, rngFrom(99));
  assert.equal(r.phase, 'psychic');
  assert.equal(r.card.index, 3);
  assert.equal(r.decks.classic.pos, 2);
  assert.equal(r.targetShown, false); // before the first look: still hidden
  const s = redraw(showTarget(r), classic, rngFrom(98));
  assert.equal(s.card.index, 9);
  assert.equal(s.targetShown, true); // after it: the new target is on show
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
  let g = handOver(showTarget(newGame()));
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
  g = nextTurn(g, classic, rngFrom(1));
  g = nextTurn(playTurn(g), classic, rngFrom(2));
  assert.equal(g.turn, 2);
  g = lockIn(handOver(showTarget(g)), 50);
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
    g = nextTurn(g, classic, rngFrom(seen.length));
    if (g.phase === 'done') break;
    assert.equal(g.phase, 'psychic');
    assert.equal(g.targetShown, false);
  }
  assert.deepEqual(seen, [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
  assert.equal(g.history.length, 6);
  assert.equal(inProgress(g), false);
  assert.equal(nextTurn(g, classic), null);
});

test('cards do not repeat within a game', () => {
  let g = newGame(2, 5);
  const cards = [g.card.index];
  while (g.phase !== 'done') {
    g = nextTurn(playTurn(g), classic, rngFrom(cards.length));
    if (g.phase !== 'done') cards.push(g.card.index);
  }
  assert.equal(new Set(cards).size, cards.length);
});

test('rematch keeps teams and settings, resets scores, continues the deck', () => {
  let g = newGame(2, 1, true);
  g = nextTurn(playTurn(g), classic);
  g = nextTurn(playTurn(g), classic);
  assert.equal(g.phase, 'done');
  const r = rematch(g, classic, rngFrom(3));
  assert.equal(r.phase, 'psychic');
  assert.equal(r.targetShown, false);
  assert.deepEqual(r.teams.map((t) => t.name), ['Team 0', 'Team 1']);
  assert.deepEqual(r.teams.map((t) => t.score), [0, 0]);
  assert.equal(r.rival, true);
  assert.equal(r.history.length, 0);
  assert.equal(r.card.index, DECK[g.decks.classic.pos]);
  assert.equal(r.decks.classic.pos, g.decks.classic.pos + 1);
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
  assert.deepEqual(normalizeGame(saved(g)), g);
  for (const step of [showTarget, handOver]) {
    g = step(g);
    assert.deepEqual(normalizeGame(saved(g)), g);
  }
  g = lockIn(g, 40);
  assert.deepEqual(normalizeGame(saved(g)), g);
  g = callSide(g, 'right');
  assert.deepEqual(normalizeGame(saved(g)), g);

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

test('an old save in the handoff phase resumes as the psychic, target hidden', () => {
  // How a game looked between "Next" and "I'm the psychic" before that step went.
  const next = nextTurn(playTurn(newGame(2, 2)), classic, rngFrom(5));
  const { targetShown, ...old } = saved(next);
  old.phase = 'handoff';
  const g = normalizeGame(old);
  assert.equal(g.phase, 'psychic');
  assert.equal(g.targetShown, false);
  assert.equal(g.turn, 1);
  assert.deepEqual(g.card, next.card);
  assert.deepEqual(g.teams, next.teams);
  assert.ok(inProgress(g));
  assert.equal(holderOf(g), 1);
  assert.equal(handOver(g), null);
  assert.equal(handOver(showTarget(g)).phase, 'guess');

  // A first-turn handoff, and the old psychic phase (the target maybe seen).
  const first = { ...saved(newGame(3, 1)), phase: 'handoff' };
  delete first.targetShown;
  assert.equal(normalizeGame(first).phase, 'psychic');
  assert.equal(normalizeGame(first).targetShown, false);
  assert.equal(normalizeGame({ ...first, phase: 'psychic' }).targetShown, false);
  assert.equal(normalizeGame({ ...first, phase: 'psychic', targetShown: 'yes' }).targetShown, false);
  // Past the psychic the target has been seen, whatever the save says.
  const guess = saved(handOver(showTarget(newGame())));
  delete guess.targetShown;
  assert.equal(normalizeGame(guess).targetShown, true);
  assert.equal(normalizeGame({ ...guess, targetShown: false }).targetShown, true);
});

// --- decks (spicy mode) -------------------------------------------------------------

test('every card records its deck; a deck is only shuffled once a card comes from it', () => {
  let g = newGame(2, 2, false, spicy);
  assert.deepEqual([g.card.deck, g.card.index, g.card.left], ['spicy', 2, 'Hot L2']);
  assert.deepEqual(g.decks, { spicy: { order: ORDERS.spicy, pos: 1 } });
  g = redraw(g, classic);
  assert.deepEqual([g.card.deck, g.card.index, g.card.left], ['classic', 5, 'L5']);
  assert.deepEqual(g.decks, { spicy: { order: ORDERS.spicy, pos: 1 }, classic: { order: DECK, pos: 1 } });
  // A played turn says which deck its card came from, too.
  g = playTurn(g);
  assert.deepEqual([g.history[0].deck, g.history[0].index, g.history[0].left], ['classic', 5, 'L5']);
  g = playTurn(nextTurn(g, spicy));
  assert.deepEqual([g.history[1].deck, g.history[1].index, g.history[1].left], ['spicy', 4, 'Hot L4']);
});

test('each deck keeps its own order: no repeats within a deck, picked up where it left off', () => {
  let g = newGame(1, 10);
  const dealt = [[g.card.deck, g.card.index]];
  for (const d of [spicy, classic, spicy, spicy, classic, classic, spicy]) {
    g = redraw(g, d);
    dealt.push([g.card.deck, g.card.index]);
  }
  assert.deepEqual(dealt, [
    ['classic', 5], ['spicy', 2], ['classic', 3], ['spicy', 4], ['spicy', 0], ['classic', 9], ['classic', 0], ['spicy', 3],
  ]);
  // The last spicy card; after it the whole deck has been seen, so it is shuffled afresh.
  g = redraw(g, spicy);
  assert.deepEqual([g.card.index, g.decks.spicy.pos], [1, 5]);
  g = redraw(g, spicy);
  assert.deepEqual([g.card.index, g.decks.spicy.pos], [2, 1]);
  assert.equal(g.decks.classic.pos, 4); // untouched meanwhile

  // Real shuffles, decks interleaved: a whole deck goes by before any of its cards comes back.
  const rng = rngFrom(11);
  let h = createGame({ teams: teams(1), rounds: 1, dealer: shuffling('classic'), rng });
  const seen = { classic: [h.card.index], spicy: [] };
  for (let k = 1; k < 17; k++) {
    const d = k % 3 ? 'classic' : 'spicy';
    h = redraw(h, shuffling(d), rng);
    seen[d].push(h.card.index);
  }
  assert.deepEqual([seen.classic.length, new Set(seen.classic).size], [12, 12]);
  assert.deepEqual([seen.spicy.length, new Set(seen.spicy).size], [5, 5]);
});

test('switching deck mid-game: the card is swapped until the psychic looks, then waits for the next card', () => {
  const g = newGame(2, 2);
  assert.equal(targetSeen(g), false);
  const s = switchDeck(g, spicy, rngFrom(3), 9);
  assert.equal(s.phase, 'psychic');
  assert.equal(s.turn, 0);
  assert.equal(s.targetShown, false);
  assert.equal(s.updatedAt, 9);
  assert.deepEqual([s.card.deck, s.card.index, s.card.left], ['spicy', 2, 'Hot L2']);
  assert.equal(switchDeck(s, spicy), null); // already from that deck
  // And back: the classic deck carries on past the card that was swapped away.
  assert.deepEqual([switchDeck(s, classic).card.deck, switchDeck(s, classic).card.index], ['classic', 3]);

  // Once the target is on show it is too late, for the rest of the turn.
  let t = showTarget(s);
  assert.equal(targetSeen(t), true);
  assert.equal(switchDeck(t, classic), null);
  t = handOver(t);
  assert.equal(switchDeck(t, classic), null);
  t = lockIn(t, 50);
  assert.equal(switchDeck(t, classic), null);
  // The next turn's card comes from the deck in force by then...
  t = nextTurn(t, classic);
  assert.deepEqual([t.card.deck, t.card.index], ['classic', 3]);
  assert.equal(switchDeck(t, spicy).card.deck, 'spicy');
  // ... and so does a new card, before or after the look.
  assert.equal(redraw(t, spicy).card.deck, 'spicy');
  assert.equal(redraw(showTarget(t), spicy).card.deck, 'spicy');
  assert.equal(switchDeck(null, spicy), null);
});

test('play again keeps every deck\'s order', () => {
  let g = newGame(1, 1, false, spicy);
  g = redraw(g, classic);
  g = nextTurn(playTurn(g), classic);
  assert.equal(g.phase, 'done');
  assert.equal(switchDeck(g, spicy), null);
  const r = rematch(g, spicy, rngFrom(2));
  assert.deepEqual([r.card.deck, r.card.index], ['spicy', 4]);
  assert.deepEqual(r.decks, { classic: { order: DECK, pos: 1 }, spicy: { order: ORDERS.spicy, pos: 2 } });
});

test('normalizeGame keeps every deck\'s order and cleans it', () => {
  let g = playTurn(redraw(newGame(2, 2), spicy));
  assert.deepEqual(normalizeGame(saved(g)), g); // both decks, a spicy card, its history line
  g = nextTurn(g, classic);
  assert.deepEqual(normalizeGame(saved(g)), g);

  const raw = saved(g);
  raw.decks = {
    classic: { order: [5, -1, 3.5, 'x', 3], pos: 9 },
    spicy: { order: [2], pos: -4 },
    party: { order: [1], pos: 0 },
  };
  raw.card.deck = 'party';
  const n = normalizeGame(raw);
  assert.deepEqual(n.decks, { classic: { order: [5, 3], pos: 2 }, spicy: { order: [2], pos: 0 } });
  assert.equal(n.card.deck, 'classic');
  assert.deepEqual(normalizeGame({ ...raw, decks: 'lost' }).decks, {});
});

test('an old save with a single deck (deck + deckPos) carries on as the classic order', () => {
  // How a game was saved before spicy mode: one order, and cards that name no deck.
  const old = saved(showTarget(redraw(newGame(2, 2), classic)));
  delete old.decks;
  delete old.card.deck;
  old.deck = DECK.slice();
  old.deckPos = 2;
  const m = normalizeGame(old);
  assert.deepEqual(m.decks, { classic: { order: DECK, pos: 2 } });
  assert.deepEqual([m.card.deck, m.card.index], ['classic', 3]);
  assert.equal(m.targetShown, true);
  assert.equal('deck' in m || 'deckPos' in m, false);
  // It deals on from where it was; a spicy card starts that deck's own order.
  const n = nextTurn(playTurn(m), classic);
  assert.deepEqual([n.card.deck, n.card.index], ['classic', 9]);
  const s = switchDeck(n, spicy);
  assert.deepEqual(s.decks, { classic: { order: DECK, pos: 3 }, spicy: { order: ORDERS.spicy, pos: 1 } });

  // A position past the end of its order (cards wrapped round back then): shuffled afresh next.
  const over = normalizeGame({ ...old, deckPos: 40 });
  assert.equal(over.decks.classic.pos, DECK.length);
  assert.deepEqual([redraw(over, classic).card.index, redraw(over, classic).decks.classic.pos], [5, 1]);
  // No usable order at all: a fresh one comes with the next card.
  const lost = normalizeGame({ ...old, deck: 'lost' });
  assert.deepEqual(lost.decks, {});
  assert.deepEqual(redraw(lost, classic).decks, { classic: { order: DECK, pos: 1 } });
});
