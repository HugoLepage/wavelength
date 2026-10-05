// Pass-and-play rules: the whole local game as plain data plus pure
// transitions. The controller (local.js) only animates what a transition
// changed, and because the state is plain JSON it is saved to localStorage
// after every step and restored exactly on Resume.
//
// Kept free of the DOM, of teams.js (which pulls in the critter SVGs through
// Vite) and of the spectrum list — card lookup is passed in as `spectrumAt` —
// so node can test it directly (tests/local-logic.test.mjs).
//
// A turn moves through the phases
//   handoff → psychic → guess → (rival) → reveal → next turn's handoff | done
// and every transition returns the next state, or null when it is not allowed
// from the current one (a double tap, a stale button), so callers can ignore
// it safely.

import { MAX_POINTS, RATINGS, clampValue, randomTarget, rateScore, rivalPoints, scoreFor } from './scoring.js';

export const VERSION = 1;
export const MIN_TEAMS = 1;
export const MAX_TEAMS = 6;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 10;
export const DEFAULT_TEAMS = 2;
export const DEFAULT_ROUNDS = 3;
export const PHASES = ['handoff', 'psychic', 'guess', 'rival', 'reveal', 'done'];

const round1 = (v) => Math.round(v * 10) / 10;

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

const stamp = (g, now) => ({ ...g, updatedAt: now ?? Date.now() });

// --- reading a game -------------------------------------------------------------

// The rival call is only played with two or more teams.
export const hasRival = (g) => !!g?.rival && g.teams.length >= 2;

// The team that calls left/right this turn: the next one round the table.
export const rivalOf = (g) => (hasRival(g) ? (g.turn + 1) % g.teams.length : null);

export const activeTeam = (g) => g.teams[g.turn];

// Who should be holding the device right now.
export const holderOf = (g) => (g.phase === 'rival' ? rivalOf(g) : g.turn);

export const maxScore = (g) => g.rounds * MAX_POINTS;

export const isLastTurn = (g) => g.round >= g.rounds - 1 && g.turn >= g.teams.length - 1;

export const inProgress = (g) => !!g && PHASES.includes(g.phase) && g.phase !== 'done';

// The team whose turn follows this one (null after the last turn).
export function nextTeamOf(g) {
  if (isLastTurn(g)) return null;
  return (g.turn + 1) % g.teams.length;
}

// --- dealing ------------------------------------------------------------------------

// The next card off the game's own deck (so cards never repeat until the whole
// list has been seen) with a fresh secret target; the turn's needle, guess and
// rival call start over.
function deal(g, spectrumAt, rng) {
  const deck = g.deck;
  const index = deck.length ? deck[g.deckPos % deck.length] : 0;
  const s = spectrumAt(index);
  return {
    ...g,
    deckPos: g.deckPos + 1,
    card: { index: s.index, left: s.left, right: s.right, target: randomTarget(rng) },
    needle: 50,
    guess: null,
    call: null,
    result: null,
  };
}

// --- transitions -----------------------------------------------------------------------

// A new game: `teams` from teams.js (scores reset here), the first card dealt
// to team 0, round 0.
export function createGame({ teams, rounds, rival, deck, deckPos = 0, spectrumAt, rng = Math.random, now }) {
  const list = (teams || []).slice(0, MAX_TEAMS).map((t, i) => ({ ...t, id: i, score: 0 }));
  if (!list.length || !Array.isArray(deck)) return null;
  const at = now ?? Date.now();
  return deal(
    {
      v: VERSION,
      teams: list,
      rounds: clampInt(rounds, MIN_ROUNDS, MAX_ROUNDS, DEFAULT_ROUNDS),
      rival: !!rival && list.length >= 2,
      round: 0,
      turn: 0,
      phase: 'handoff',
      deck: deck.slice(),
      deckPos: Math.max(0, Math.floor(deckPos) || 0),
      card: null,
      needle: 50,
      guess: null,
      call: null,
      result: null,
      history: [],
      startedAt: at,
      updatedAt: at,
    },
    spectrumAt,
    rng,
  );
}

// The psychic has the device.
export function beginPsychic(g, now) {
  if (g?.phase !== 'handoff') return null;
  return stamp({ ...g, phase: 'psychic' }, now);
}

// The psychic does not like this card: a new one, with a new target.
export function redraw(g, spectrumAt, rng = Math.random, now) {
  if (g?.phase !== 'psychic') return null;
  return stamp(deal(g, spectrumAt, rng), now);
}

// Clue given, target hidden: the team takes the dial.
export function handOver(g, now) {
  if (g?.phase !== 'psychic') return null;
  return stamp({ ...g, phase: 'guess', needle: 50 }, now);
}

// The needle as the team leaves it (saved so a reload puts it back).
export function moveNeedle(g, value) {
  if (g?.phase !== 'guess') return null;
  return { ...g, needle: round1(clampValue(value)) };
}

// Everything that a finished turn changes: the team's points, the rival's
// point, a history line, and the result the reveal animates.
function scoreTurn(g) {
  const { target } = g.card;
  const points = scoreFor(target, g.guess);
  const rivalTeam = g.call ? rivalOf(g) : null;
  const rp = g.call ? rivalPoints(target, g.guess, g.call) : 0;
  const teams = g.teams.map((t, i) => {
    if (i === g.turn) return { ...t, score: t.score + points };
    if (i === rivalTeam) return { ...t, score: t.score + rp };
    return t;
  });
  const entry = {
    round: g.round,
    team: g.turn,
    index: g.card.index,
    left: g.card.left,
    right: g.card.right,
    target,
    guess: g.guess,
    points,
    rival: rivalTeam,
    call: g.call,
    rivalPoints: rp,
  };
  return {
    ...g,
    teams,
    phase: 'reveal',
    result: { points, rivalTeam, rivalPoints: rp },
    history: [...g.history, entry],
  };
}

// The team locks the needle in: on to the rival's call, or straight to the reveal.
export function lockIn(g, guess, now) {
  if (g?.phase !== 'guess') return null;
  const v = round1(clampValue(guess));
  const next = { ...g, needle: v, guess: v };
  if (hasRival(g)) return stamp({ ...next, phase: 'rival' }, now);
  return stamp(scoreTurn(next), now);
}

// The rival team calls the target 'left' or 'right' of the needle.
export function callSide(g, call, now) {
  if (g?.phase !== 'rival' || (call !== 'left' && call !== 'right')) return null;
  return stamp(scoreTurn({ ...g, call }), now);
}

// After the reveal: the next team's turn (a new round after the last team),
// or the end of the game.
export function nextTurn(g, spectrumAt, rng = Math.random, now) {
  if (g?.phase !== 'reveal') return null;
  if (isLastTurn(g)) return stamp({ ...g, phase: 'done' }, now);
  const wrap = g.turn >= g.teams.length - 1;
  return stamp(
    deal({ ...g, phase: 'handoff', turn: wrap ? 0 : g.turn + 1, round: wrap ? g.round + 1 : g.round }, spectrumAt, rng),
    now,
  );
}

// Same teams, same settings, scores back to zero — and the deck carries on,
// so the rematch deals cards nobody has seen yet.
export function rematch(g, spectrumAt, rng = Math.random, now) {
  if (!g) return null;
  return createGame({
    teams: g.teams,
    rounds: g.rounds,
    rival: g.rival,
    deck: g.deck,
    deckPos: g.deckPos,
    spectrumAt,
    rng,
    now,
  });
}

// --- results ------------------------------------------------------------------------------

// Teams best first. Ties share a place (1, 1, 3); equal scores keep seat order.
export function ranking(teams) {
  const sorted = teams.map((team, i) => ({ team, i })).sort((a, b) => b.team.score - a.team.score || a.i - b.i);
  let place = 0;
  return sorted.map((row, k) => {
    if (k === 0 || row.team.score !== sorted[k - 1].team.score) place = k + 1;
    return { ...row, place };
  });
}

// One team plays co-op: the score out of the maximum earns a title — the same
// ratings an online duo gets (scoring.js).
export const COOP_TIERS = RATINGS;
export const coopRating = rateScore;

// --- storage ---------------------------------------------------------------------------------

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isStr = (s) => typeof s === 'string';
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// A saved game, checked field by field. Anything malformed (an old version, a
// hand-edited entry, a half-written save) returns null rather than a game
// that would break the screen.
export function normalizeGame(raw) {
  if (!isObj(raw) || raw.v !== VERSION) return null;
  if (!Array.isArray(raw.teams) || raw.teams.length < MIN_TEAMS || raw.teams.length > MAX_TEAMS) return null;
  const teams = [];
  for (const [i, t] of raw.teams.entries()) {
    if (!isObj(t) || !isStr(t.name) || !isStr(t.color) || !isStr(t.critter) || !isNum(t.score)) return null;
    teams.push({
      id: i,
      color: t.color,
      score: Math.max(0, Math.round(t.score)),
      adjective: isStr(t.adjective) ? t.adjective : '',
      critter: t.critter,
      name: t.name,
    });
  }
  if (!PHASES.includes(raw.phase)) return null;
  const rounds = clampInt(raw.rounds, MIN_ROUNDS, MAX_ROUNDS, DEFAULT_ROUNDS);
  const c = raw.card;
  if (!isObj(c) || !isStr(c.left) || !isStr(c.right) || !isNum(c.target)) return null;
  const deck = Array.isArray(raw.deck) ? raw.deck.filter((n) => Number.isInteger(n) && n >= 0) : [];
  const g = {
    v: VERSION,
    teams,
    rounds,
    rival: !!raw.rival && teams.length >= 2,
    round: clampInt(raw.round, 0, rounds - 1, 0),
    turn: clampInt(raw.turn, 0, teams.length - 1, 0),
    phase: raw.phase,
    deck,
    deckPos: clampInt(raw.deckPos, 0, Number.MAX_SAFE_INTEGER, 0),
    card: { index: Number.isInteger(c.index) ? c.index : 0, left: c.left, right: c.right, target: clampValue(c.target) },
    needle: isNum(raw.needle) ? round1(clampValue(raw.needle)) : 50,
    guess: isNum(raw.guess) ? round1(clampValue(raw.guess)) : null,
    call: raw.call === 'left' || raw.call === 'right' ? raw.call : null,
    result: null,
    history: Array.isArray(raw.history) ? raw.history.filter(isObj) : [],
    startedAt: isNum(raw.startedAt) ? raw.startedAt : Date.now(),
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
  // Phases past the lock-in need the guess; the rival phase needs a rival.
  if (['rival', 'reveal'].includes(g.phase) && g.guess == null) return null;
  if (g.phase === 'rival' && !hasRival(g)) return null;
  if (g.phase === 'reveal') {
    const r = raw.result;
    if (!isObj(r) || !isNum(r.points)) return null;
    const rivalTeam = Number.isInteger(r.rivalTeam) && r.rivalTeam >= 0 && r.rivalTeam < teams.length ? r.rivalTeam : null;
    g.result = { points: r.points, rivalTeam, rivalPoints: rivalTeam == null ? 0 : isNum(r.rivalPoints) ? r.rivalPoints : 0 };
  }
  return g;
}
