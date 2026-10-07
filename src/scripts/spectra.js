// The spectrum cards: pairs of opposite ends, e.g. ["Cold", "Hot"], in two
// decks. The classic list lives in src/data/spectra.json; the grown-up one
// for spicy mode in src/data/spicy_spectra.json, which may be empty — every
// function here then quietly deals classic cards instead, so nothing that
// asks for 'spicy' ever has to check first.
//
// A card's `index` is its position in its own deck's file: two decks reuse
// the same numbers, so anything that records indices (a game's dealt cards, a
// room's `used`) must also record which deck they index into.

import CLASSIC from '../data/spectra.json';
import SPICY from '../data/spicy_spectra.json';

export const DECKS = ['classic', 'spicy'];

const toCards = (list) => (Array.isArray(list) ? list : []).map(([left, right], index) => ({ index, left, right }));

export const SPECTRA = toCards(CLASSIC);
export const SPICY_SPECTRA = toCards(SPICY);
export const hasSpicy = SPICY_SPECTRA.length > 0;

// The deck that will actually be dealt: 'spicy' only when there are spicy
// cards to deal; anything else (unknown, missing, empty spicy list) is classic.
export function resolveDeck(deck) {
  return deck === 'spicy' && hasSpicy ? 'spicy' : 'classic';
}

// The card list for a deck name, after resolveDeck's fallback.
export function deckList(deck = 'classic') {
  return resolveDeck(deck) === 'spicy' ? SPICY_SPECTRA : SPECTRA;
}

// Fisher–Yates over every card index of one deck — deal from the front, so
// no card repeats until the whole deck has been seen.
export function shuffledDeck(rng = Math.random, deck = 'classic') {
  const order = deckList(deck).map((s) => s.index);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// One random card of a deck whose index is not in `exclude` (any iterable of
// indices into that deck).
export function randomSpectrum(exclude = [], rng = Math.random, deck = 'classic') {
  const list = deckList(deck);
  const skip = new Set(exclude);
  const pool = skip.size < list.length ? list.filter((s) => !skip.has(s.index)) : list;
  return pool[Math.floor(rng() * pool.length)];
}

export function spectrumAt(index, deck = 'classic') {
  const list = deckList(deck);
  return list[index] || list[0];
}
