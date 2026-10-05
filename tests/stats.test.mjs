// Online stats entries (src/scripts/stats.js) and the display-name check every
// reader of a world-writable name goes through (src/scripts/auth.js
// displayNameOf). Run with `node --test tests/`.
//
// Importing these pulls in the Firebase SDK, but nothing here touches the
// network: the entries are plain objects with server-value sentinels.

import test from 'node:test';
import assert from 'node:assert/strict';
import { displayNameOf } from '../src/scripts/auth.js';
import { onlineStartEntries } from '../src/scripts/stats.js';

test('displayNameOf: only a spelling of the uname itself counts', () => {
  assert.equal(displayNameOf('Ana', 'ana'), 'Ana');
  assert.equal(displayNameOf('  ANA ', 'ana'), 'ANA');
  assert.equal(displayNameOf('Bo', 'ana'), 'ana');
  assert.equal(displayNameOf('x'.repeat(50), 'ana'), 'ana');
  assert.equal(displayNameOf(42, 'ana'), 'ana');
  assert.equal(displayNameOf({ name: 'Ana' }, 'ana'), 'ana');
  assert.equal(displayNameOf(null, 'ana'), 'ana');
  assert.equal(displayNameOf('', 'ana'), 'ana');
  assert.equal(displayNameOf('Ana', undefined), '');
});

test('onlineStartEntries: sound names are copied as they are', () => {
  const out = onlineStartEntries('room123abc', [{ uname: 'ana', name: 'Ana' }, { uname: 'bo', name: 'BO' }], 5);
  assert.equal(out['users/ana/matches/room123abc'].partnerName, 'BO');
  assert.equal(out['users/ana/stats/partners/bo/name'], 'BO');
  assert.equal(out['users/bo/matches/room123abc'].partnerName, 'Ana');
  assert.equal(out['users/bo/stats/partners/ana/name'], 'Ana');
  assert.equal(out['users/ana/matches/room123abc'].partner, 'bo');
  assert.equal(out['users/ana/matches/room123abc'].rounds, 5);
});

test('onlineStartEntries: a bad partner name (number, too long, someone else) falls back to the uname', () => {
  for (const bad of [7, 'x'.repeat(50), 'Mallory', undefined]) {
    const out = onlineStartEntries('room123abc', [{ uname: 'ana', name: 'Ana' }, { uname: 'bo', name: bad }], 5);
    assert.equal(out['users/ana/stats/partners/bo/name'], 'bo', `partner name ${String(bad)}`);
    assert.equal(out['users/ana/matches/room123abc'].partnerName, 'bo');
    // The rules: a string of at most 40 characters.
    const name = out['users/ana/stats/partners/bo/name'];
    assert.ok(typeof name === 'string' && name.length <= 40);
  }
});
