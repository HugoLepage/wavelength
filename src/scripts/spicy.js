// Spicy mode: grown-up cards (src/data/spicy_spectra.json) instead of the
// classic ones, switched with the chili in the top bar.
//
// The setting is a per-browser preference, like the theme: '1' | '0' under
// STORAGE_KEY, mirrored on <html data-spicy="on|off"> — which is what the
// chili's colours key off. The inline script in Layout.astro stamps that
// attribute before first paint, so a returning spicy player never sees the
// outline flash red; it repeats STORAGE_KEY (an is:inline script cannot
// import), so keep the two in sync.
//
// Turning it on the first time asks a grown-ups question once (ui.js shows
// the notice); OK_KEY remembers the answer. Turning it off never asks.
//
// What it changes is decided by whoever deals: pass & play deals each card
// from currentDeck(); an online challenge carries it, and the room it makes
// keeps that deck for good (rooms.js). With an empty spicy list the chili
// still switches, and every deck quietly stays classic.

import { hasSpicy } from './spectra.js';

const STORAGE_KEY = 'wavelength.spicy';
const OK_KEY = 'wavelength.spicy.ok';

let on = false;
const listeners = new Set();

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode: nothing saved
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice simply won't stick */
  }
}

const stamp = () => document.documentElement.setAttribute('data-spicy', on ? 'on' : 'off');

// The saved setting (the pre-paint stamp agrees with it). Call once at start-up.
export function initSpicy() {
  on = read(STORAGE_KEY) === '1';
  stamp();
}

export const isSpicy = () => on;

// `persist: false` switches without touching the saved preference.
// Listeners hear only real changes.
export function setSpicy(next, { persist = true } = {}) {
  const value = !!next;
  if (persist) write(STORAGE_KEY, value ? '1' : '0');
  if (value === on) return;
  on = value;
  stamp();
  for (const cb of [...listeners]) {
    try {
      cb(on);
    } catch (err) {
      console.error('spicy', err);
    }
  }
}

// cb(on) after every switch. Returns an unsubscribe.
export function onSpicyChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// The deck a card dealt right now comes from: 'spicy' only when the mode is
// on and there are spicy cards to deal.
export const currentDeck = () => (on && hasSpicy ? 'spicy' : 'classic');

// Has this browser said yes to the grown-ups notice?
export const spicyAcknowledged = () => read(OK_KEY) === '1';

export const acknowledgeSpicy = () => write(OK_KEY, '1');
