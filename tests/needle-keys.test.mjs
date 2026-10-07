// Dial keyboard input (src/scripts/dial.js, Dial#_onKey): arrows nudge the
// needle, Shift is the ×5 step, and Alt/Ctrl/Cmd combos are left to the
// browser (Alt+← is Back). Run with `node --test tests/`.
// _onKey only reads a few fields, so it runs here on a stand-in for the instance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Dial } from '../src/scripts/dial.js';

const classList = (...names) => {
  const set = new Set(names);
  return { remove: (n) => set.delete(n), contains: (n) => set.has(n) };
};

// Pressed on just before (.is-pointer hides the focus ring until a key is used).
const dial = (value) => ({
  _interactive: true,
  _value: value,
  _moveTo(v) {
    this._value = v;
  },
  root: { classList: classList('dial', 'is-pointer') },
});

function press(d, key, mods = {}) {
  const e = { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods, defaultPrevented: false };
  e.preventDefault = () => {
    e.defaultPrevented = true;
  };
  Dial.prototype._onKey.call(d, e);
  return e;
}

test('arrows nudge the needle; Shift steps by five', () => {
  const d = dial(50);
  assert.ok(press(d, 'ArrowLeft').defaultPrevented);
  assert.equal(d._value, 49);
  press(d, 'ArrowRight', { shiftKey: true });
  assert.equal(d._value, 54);
  press(d, 'End');
  assert.equal(d._value, 100);
});

test('a key on the dial brings its focus ring back after a press', () => {
  const d = dial(50);
  press(d, 'ArrowLeft');
  assert.equal(d.root.classList.contains('is-pointer'), false);
});

test('Alt, Ctrl and Cmd combos stay with the browser', () => {
  for (const mod of ['altKey', 'ctrlKey', 'metaKey']) {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp']) {
      const d = dial(50);
      const e = press(d, key, { [mod]: true });
      assert.equal(e.defaultPrevented, false, `${mod}+${key}`);
      assert.equal(d._value, 50, `${mod}+${key}`);
      assert.equal(d._keyMoved, undefined, `${mod}+${key}`);
    }
  }
});

test('a locked dial ignores keys', () => {
  const d = { ...dial(50), _interactive: false };
  assert.equal(press(d, 'ArrowLeft').defaultPrevented, false);
  assert.equal(d._value, 50);
});
