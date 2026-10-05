// Scoring for one Wavelength turn. Every position on the dial is a value from
// 0 (hard left) to 100 (hard right); the dial is a half circle, so one unit is
// 1.8°. The target is five bands of BAND units each: 2 · 3 · 4 · 3 · 2.

export const BAND = 4; // width of one scoring band, in dial units (7.2°)

// Half-widths of the 4, 3 and 2 point zones around the target's centre.
export const ZONES = [
  { points: 4, reach: BAND / 2 },       // ±2
  { points: 3, reach: BAND * 1.5 },     // ±6
  { points: 2, reach: BAND * 2.5 },     // ±10
];

export const MAX_POINTS = 4;

export const clampValue = (v) => Math.min(100, Math.max(0, Number(v) || 0));

// Points for a needle at `guess` when the target centre is `target`.
export function scoreFor(target, guess) {
  const d = Math.abs(clampValue(target) - clampValue(guess));
  for (const z of ZONES) if (d <= z.reach) return z.points;
  return 0;
}

// A fresh target centre. The ends are avoided a little so the bullseye is
// always fully on the dial (the outer bands may still run off the edge).
export function randomTarget(rng = Math.random) {
  return Math.round((3 + rng() * 94) * 10) / 10;
}

// Which side of the needle the target sits on, for the rival team's
// left/right call. null when the needle is dead centre on the target.
export function sideOf(target, guess) {
  if (target < guess) return 'left';
  if (target > guess) return 'right';
  return null;
}

// The rival's call scores 1 point when it is right — unless the active team
// hit the bullseye, which shuts the rival out.
export function rivalPoints(target, guess, call) {
  if (scoreFor(target, guess) === MAX_POINTS) return 0;
  return sideOf(target, guess) === call ? 1 : 0;
}

// The one word the reveal says about a turn, by its points (both modes).
export const RESULT_WORDS = { 4: 'Bullseye!', 3: 'So close!', 2: 'Nice one!', 0: 'Missed it' };

// How a co-op game went (one team in pass & play, or an online duo), by its
// share of the maximum score. Best first; `tier` is the index into this list.
export const RATINGS = [
  { min: 0.85, title: 'Telepathic!', line: 'Are you the same person?' },
  { min: 0.7, title: 'Mind melders', line: 'Practically one brain.' },
  { min: 0.5, title: 'Same wavelength', line: 'You just get each other.' },
  { min: 0.3, title: 'Tuning in', line: 'Plenty of sparks.' },
  { min: 0, title: 'Lost signal', line: 'Next time, for sure.' },
];

// → { tier, title, line, share }. The top three tiers deserve confetti.
export function rateScore(score, max) {
  const share = max > 0 ? Math.max(0, score) / max : 0;
  const tier = RATINGS.findIndex((t) => share >= t.min);
  const { title, line } = RATINGS[tier];
  return { tier, title, line, share, celebrate: tier <= 2 };
}

// Dial value → angle in degrees for SVG rotation, where 0 = pointing straight
// up, negative = left, positive = right (−90 … +90).
export const valueToAngle = (v) => clampValue(v) * 1.8 - 90;
export const angleToValue = (deg) => clampValue((deg + 90) / 1.8);
