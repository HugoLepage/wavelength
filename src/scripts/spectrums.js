// The spectrum cards: pairs of opposite ends, e.g. ["Cold", "Hot"].
// The list itself lives in src/data/spectrums.json.

import LIST from '../data/spectrums.json';

export const SPECTRUMS = LIST.map(([left, right], index) => ({ index, left, right }));

// Fisher–Yates over every card index — deal from the front, so no card
// repeats until the whole list has been seen.
export function shuffledDeck(rng = Math.random) {
  const deck = SPECTRUMS.map((s) => s.index);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// One random card whose index is not in `exclude` (any iterable of indices).
export function randomSpectrum(exclude = [], rng = Math.random) {
  const skip = new Set(exclude);
  const pool = skip.size < SPECTRUMS.length ? SPECTRUMS.filter((s) => !skip.has(s.index)) : SPECTRUMS;
  return pool[Math.floor(rng() * pool.length)];
}

export const spectrumAt = (index) => SPECTRUMS[index] || SPECTRUMS[0];
