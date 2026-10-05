// Dial pointer mapping (src/scripts/dial.js, Dial#_valueAt): pointer position
// → needle value, from its angle about the pivot. Run with `node --test tests/`.
// _valueAt is pure geometry, so it runs here on a stand-in for the instance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Dial } from '../src/scripts/dial.js';

// Geometry from Dial.astro: viewBox 420 wide, pivot at (210, 210).
const dial = (value) => ({ cx: 210, cy: 210, vw: 420, _value: value });
const at = (d, x, y, width = 420) => Dial.prototype._valueAt.call(d, { clientX: x, clientY: y }, { left: 0, top: 0, width });

test('angle above the pivot maps across the dial', () => {
  const d = dial(37);
  assert.equal(at(d, 210, 20), 50);
  assert.equal(at(d, 20, 210), 0);
  assert.equal(at(d, 400, 210), 100);
  assert.equal(at(d, 345, 75), 75);
});

test('presses on or right around the hub hold the current value', () => {
  const d = dial(37);
  for (const [x, y] of [[213, 208], [212, 212], [208, 212], [210, 210], [228, 196]]) {
    assert.equal(at(d, x, y), 37, `(${x}, ${y})`);
  }
});

test('the base strip pins to the end on its side, but not under the pivot', () => {
  const d = dial(37);
  assert.equal(at(d, 240, 222), 100);
  assert.equal(at(d, 180, 222), 0);
  assert.equal(at(d, 215, 240), 37);
});

test('the hub dead zone keeps a usable size on a small dial', () => {
  // At ~210px wide (s = 0.5) the zone is at least 14 CSS px across.
  const d = dial(62);
  assert.equal(at(d, 105 + 12, 105 - 5, 210), 62);
  assert.equal(at(d, 105, 20, 210), 50);
});
