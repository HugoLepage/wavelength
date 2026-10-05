// Screen router. The app is one page of <section class="screen"> elements,
// one visible at a time. Showing a screen slides it in from the side it
// "lives" on (forward = from the right, back = from the left) while the old
// one fades out underneath, then hands focus to the new screen so keyboard
// and screen-reader users land in the right place.
//
// There is no URL routing: a refresh lands on home (or the ?session room).

import { reducedMotion } from './fx.js';

const DURATION = 280;
const listeners = new Set();
let current = null;

const screenEl = (name) => document.querySelector(`.screen[data-screen="${name}"]`);

export const currentScreen = () => current;

// cb(name, prev) after every change. Returns an unsubscribe function.
export function onScreenChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// The element a screen wants focused first: [data-autofocus], else its first
// heading, else its first enabled button.
function focusTarget(el) {
  const target =
    el.querySelector('[data-autofocus]') ||
    el.querySelector('h1, h2') ||
    el.querySelector('button:not([disabled]):not(.hidden)');
  if (target && target.matches('h1, h2') && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  return target;
}

export function showScreen(name, { direction = 'forward' } = {}) {
  const next = screenEl(name);
  if (!next) return;
  // Normally the screen we showed last; on the first call, whatever the
  // markup marked active (if anything).
  const prev = (current && screenEl(current)) || document.querySelector('.screen.active:not(.leaving)');
  const prevName = prev?.dataset.screen ?? null;
  if (prev === next) {
    current = name;
    document.body.dataset.screen = name;
    return;
  }

  current = name;
  document.body.dataset.screen = name;
  const animate = direction !== 'none' && !reducedMotion() && !!next.animate;
  const sign = direction === 'back' ? -1 : 1;

  if (prev) {
    prev.getAnimations?.().forEach((a) => a.cancel());
    if (animate) {
      // The old screen leaves out of flow, so the new one lays out in place.
      prev.classList.add('leaving');
      prev
        .animate(
          [
            { opacity: 1, transform: 'translateX(0)' },
            { opacity: 0, transform: `translateX(${-sign * 28}px)` },
          ],
          { duration: DURATION * 0.6, easing: 'ease-in' },
        )
        .finished.catch(() => {})
        .finally(() => {
          prev.classList.remove('leaving');
          if (current !== prevName) prev.classList.remove('active');
        });
    } else {
      prev.classList.remove('active', 'leaving');
    }
  }

  next.classList.remove('leaving');
  next.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });

  if (animate) {
    next.getAnimations?.().forEach((a) => a.cancel());
    next.animate(
      [
        { opacity: 0, transform: `translateX(${sign * 36}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: DURATION, easing: 'cubic-bezier(.2,.8,.25,1)' },
    );
  } else if (direction !== 'none' && next.animate) {
    next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
  }

  focusTarget(next)?.focus({ preventScroll: true });
  for (const cb of listeners) {
    try {
      cb(name, prevName);
    } catch (err) {
      console.error(err);
    }
  }
}

// Home, unless a ?session link is being joined — then the inline script in
// Layout.astro has already set html.joining and online.js decides what shows.
export function initRouter() {
  if (document.documentElement.classList.contains('joining')) return;
  showScreen('home', { direction: 'none' });
}
