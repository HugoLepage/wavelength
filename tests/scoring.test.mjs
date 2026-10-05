// Scoring rules (src/scripts/scoring.js): zone edges, the rival call and the
// dial value ⟷ angle mapping. Run with `node --test tests/`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND, MAX_POINTS, RATINGS, RESULT_WORDS, ZONES, angleToValue, clampValue, randomTarget, rateScore, rivalPoints,
  scoreFor, sideOf, valueToAngle,
} from '../src/scripts/scoring.js';

test('zones are 2-3-4-3-2 bands of BAND units', () => {
  assert.equal(BAND, 4);
  assert.equal(MAX_POINTS, 4);
  assert.deepEqual(ZONES.map((z) => [z.points, z.reach]), [[4, 2], [3, 6], [2, 10]]);
});

test('scoreFor: zone boundaries on both sides', () => {
  const t = 50;
  const cases = [
    [50, 4], [52, 4], [48, 4], [52.1, 3], [47.9, 3],
    [56, 3], [44, 3], [56.1, 2], [43.9, 2],
    [60, 2], [40, 2], [60.1, 0], [39.9, 0],
    [100, 0], [0, 0],
  ];
  for (const [guess, points] of cases) {
    assert.equal(scoreFor(t, guess), points, `target ${t}, guess ${guess}`);
  }
});

test('scoreFor is symmetric and clamps out-of-range values', () => {
  for (const [a, b] of [[10, 13], [30, 35.5], [70, 61], [97, 100]]) {
    assert.equal(scoreFor(a, b), scoreFor(b, a));
  }
  assert.equal(scoreFor(3, -20), scoreFor(3, 0));
  assert.equal(scoreFor(97, 140), scoreFor(97, 100));
  assert.equal(scoreFor(97, 140), 3); // |97 − 100| = 3
  assert.equal(clampValue('nope'), 0);
});

test('randomTarget stays within [3, 97] with one decimal', () => {
  assert.equal(randomTarget(() => 0), 3);
  assert.equal(randomTarget(() => 0.999999), 97);
  assert.equal(randomTarget(() => 0.5), 50);
  for (let i = 0; i < 2000; i++) {
    const v = randomTarget();
    assert.ok(v >= 3 && v <= 97, `out of range: ${v}`);
    assert.equal(Math.round(v * 10) / 10, v);
  }
});

test('sideOf: where the target sits relative to the needle', () => {
  assert.equal(sideOf(30, 50), 'left');
  assert.equal(sideOf(70, 50), 'right');
  assert.equal(sideOf(50, 50), null);
});

test('rivalPoints: +1 for the right call, 0 on a bullseye', () => {
  assert.equal(rivalPoints(30, 50, 'left'), 1);
  assert.equal(rivalPoints(30, 50, 'right'), 0);
  assert.equal(rivalPoints(70, 50, 'right'), 1);
  assert.equal(rivalPoints(70, 50, 'left'), 0);
  // the active team hit the 4 → the rival is shut out even with the right call
  assert.equal(rivalPoints(51, 50, 'right'), 0);
  assert.equal(rivalPoints(49, 50, 'left'), 0);
  assert.equal(rivalPoints(50, 50, 'left'), 0);
  // a 3-point guess still lets the rival score
  assert.equal(rivalPoints(54, 50, 'right'), 1);
});

test('valueToAngle / angleToValue map 0..100 onto −90..+90 and back', () => {
  assert.equal(valueToAngle(0), -90);
  assert.equal(valueToAngle(50), 0);
  assert.equal(valueToAngle(100), 90);
  assert.equal(valueToAngle(-10), -90);
  assert.equal(valueToAngle(130), 90);
  assert.equal(angleToValue(-90), 0);
  assert.equal(angleToValue(0), 50);
  assert.equal(angleToValue(90), 100);
  assert.equal(angleToValue(200), 100);
  for (const v of [0, 12.5, 33, 50, 81.2, 100]) {
    assert.ok(Math.abs(angleToValue(valueToAngle(v)) - v) < 1e-9);
  }
});

test('every possible score has a result word', () => {
  for (const p of [0, 2, 3, 4]) assert.ok(RESULT_WORDS[p]);
});

test('co-op ratings run best first and cover every share', () => {
  for (let i = 1; i < RATINGS.length; i++) assert.ok(RATINGS[i].min < RATINGS[i - 1].min);
  assert.equal(RATINGS[RATINGS.length - 1].min, 0);
  assert.equal(rateScore(20, 20).tier, 0);
  assert.equal(rateScore(0, 20).tier, RATINGS.length - 1);
  assert.equal(rateScore(-3, 20).share, 0);
  assert.equal(rateScore(5, 0).share, 0);
  assert.equal(rateScore(10, 20).celebrate, true);
  assert.equal(rateScore(9, 20).celebrate, false);
});
