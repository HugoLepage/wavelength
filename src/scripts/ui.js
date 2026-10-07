// Shared chrome and small UI helpers: the top bar buttons (theme, spicy mode
// and its one-time notice, how-to), the toast, the overlay (modal) stack,
// "tap twice to confirm" buttons and the − value + stepper. Screens import
// from here rather than each growing their own.

import { initTheme, toggleTheme, resolvedTheme } from './theme.js';
import {
  acknowledgeSpicy, initSpicy, isSpicy, onSpicyChange, setSpicy, spicyAcknowledged,
} from './spicy.js';
import { showScreen } from './router.js';
import { popIn, reducedMotion } from './fx.js';

export const $ = (id) => document.getElementById(id);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// --- toast -------------------------------------------------------------------

let toastTimer = null;

// toast(message), toast(message, ms) or toast(message, { ms, underBar }).
// underBar is for feedback on a top-bar control (the chili): in a game, where
// toasts drop in over the top bar, it starts the toast just below the bar so
// the control it reports on stays in sight. Set on every call, so the next
// plain toast goes back to the usual place.
export function toast(message, opts = {}) {
  const { ms = 2600, underBar = false } = typeof opts === 'number' ? { ms: opts } : opts;
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('show');
  el.classList.toggle('under-bar', underBar);
  void el.offsetWidth; // restart the slide-in when a toast replaces a toast
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function hideToast() {
  clearTimeout(toastTimer);
  $('toast')?.classList.remove('show');
}

// --- overlays ----------------------------------------------------------------
// <div class="overlay" id="…"><div class="modal" role="dialog" aria-modal="true">…</div></div>
// Shown with .show. Escape and a backdrop click close the top-most one unless
// it carries data-sticky. Any [data-close] inside closes its overlay.
// Dispatches 'overlay:open' / 'overlay:close' (bubbling) on the overlay.

const stack = []; // open overlays, top-most last
const returnFocus = new WeakMap();
const closeTimers = new WeakMap(); // overlay → pending end of its close animation

const FOCUSABLE =
  'button:not([disabled]):not(.hidden), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const isOverlayOpen = (el) => !!el && el.classList.contains('show') && !el.classList.contains('closing');

export function openOverlay(el) {
  if (!el || isOverlayOpen(el)) return;
  // Reopened mid-close: the pending hide must not fire on the open overlay.
  clearTimeout(closeTimers.get(el));
  closeTimers.delete(el);
  el.getAnimations?.({ subtree: true }).forEach((a) => a.cancel());
  el.classList.remove('closing');
  returnFocus.set(el, document.activeElement);
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
  stack.push(el);
  el.classList.add('show');
  document.documentElement.classList.add('has-overlay');
  const modal = el.querySelector('.modal') || el;
  const first = el.querySelector('[autofocus], [data-autofocus]') || modal.querySelector(FOCUSABLE);
  (first || modal).focus?.({ preventScroll: true });
  el.dispatchEvent(new CustomEvent('overlay:open', { bubbles: true }));
}

export function closeOverlay(el) {
  if (!el || !el.classList.contains('show') || el.classList.contains('closing')) return;
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
  if (!stack.length) document.documentElement.classList.remove('has-overlay');

  const done = () => {
    closeTimers.delete(el);
    el.classList.remove('show', 'closing');
  };
  clearTimeout(closeTimers.get(el));
  if (reducedMotion()) done();
  else {
    el.classList.add('closing');
    closeTimers.set(el, setTimeout(done, 170)); // matches the overlay-out animation in base.css
  }
  const back = returnFocus.get(el);
  if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  el.dispatchEvent(new CustomEvent('overlay:close', { bubbles: true }));
}

const topOverlay = () => {
  for (let i = stack.length - 1; i >= 0; i--) if (isOverlayOpen(stack[i])) return stack[i];
  return null;
};

function bindOverlays() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const top = topOverlay();
      if (top && !top.hasAttribute('data-sticky')) {
        e.preventDefault();
        closeOverlay(top);
      }
    } else if (e.key === 'Tab') {
      // Keep Tab inside the top-most modal.
      const top = topOverlay();
      if (!top) return;
      const items = [...top.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // Backdrop clicks: only when the press both started and ended on the scrim,
  // so a text selection dragged out of the modal never closes it.
  let downOn = null;
  document.addEventListener('pointerdown', (e) => {
    downOn = e.target;
  });
  document.addEventListener('click', (e) => {
    const closer = e.target.closest?.('[data-close]');
    if (closer) {
      const ov = closer.closest('.overlay');
      if (ov) closeOverlay(ov);
      return;
    }
    const t = e.target;
    if (t.classList?.contains('overlay') && downOn === t && isOverlayOpen(t) && !t.hasAttribute('data-sticky')) {
      closeOverlay(t);
    }
  });
}

// --- tap twice to confirm ------------------------------------------------------

// First tap arms the button (new label, .danger .armed, a draining bar), a
// second tap within `ms` runs onConfirm; otherwise it quietly disarms.
// The label swapped is the button's .btn-label child if it has one (so an
// icon can stay), else the whole button. Returns an unbind function.
//
// A tap that lands within CONFIRM_GUARD_MS of arming is swallowed (still
// armed, timer untouched): it is the second half of a double tap or
// double-click, or a bouncy screen — not someone who has read the new label.
const CONFIRM_GUARD_MS = 400;

export function armConfirm(button, confirmLabel, onConfirm, ms = 3000) {
  if (!button) return () => {};
  const labelEl = () => button.querySelector('.btn-label') || button;
  let armed = false;
  let armedAt = 0;
  let timer = null;
  let original = null;
  let hadDanger = false;

  const disarm = () => {
    if (!armed) return;
    armed = false;
    clearTimeout(timer);
    labelEl().innerHTML = original;
    button.classList.remove('armed');
    if (!hadDanger) button.classList.remove('danger');
    button.style.removeProperty('--arm-ms');
  };

  const onClick = (e) => {
    if (!armed) {
      e.preventDefault();
      e.stopImmediatePropagation();
      armed = true;
      armedAt = performance.now();
      original = labelEl().innerHTML;
      hadDanger = button.classList.contains('danger');
      labelEl().textContent = confirmLabel;
      button.style.setProperty('--arm-ms', `${ms}ms`);
      button.classList.add('danger', 'armed');
      popIn(button);
      timer = setTimeout(disarm, ms);
      return;
    }
    if (performance.now() - armedAt < CONFIRM_GUARD_MS) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    disarm();
    onConfirm?.();
  };
  // A held Enter repeats clicks: only a fresh press may confirm.
  const onKey = (e) => {
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
  };
  const onBlur = () => setTimeout(() => document.activeElement !== button && disarm(), 0);

  button.addEventListener('click', onClick);
  button.addEventListener('keydown', onKey);
  button.addEventListener('blur', onBlur);
  return () => {
    disarm();
    button.removeEventListener('click', onClick);
    button.removeEventListener('keydown', onKey);
    button.removeEventListener('blur', onBlur);
  };
}

// --- stepper -------------------------------------------------------------------

// <div class="stepper"><button class="stepper-btn" data-step="-1">−</button>
//   <output class="stepper-value">2</output><button class="stepper-btn" data-step="1">+</button></div>
// Returns { get value, set(v, {silent}), destroy }. onChange(value) on taps.
export function bindStepper(el, { min = 1, max = 10, value = min, onChange } = {}) {
  const out = el.querySelector('.stepper-value');
  const minus = el.querySelector('[data-step="-1"]');
  const plus = el.querySelector('[data-step="1"]');
  let v = value;

  const render = (dir = 0) => {
    out.textContent = String(v);
    minus.disabled = v <= min;
    plus.disabled = v >= max;
    el.setAttribute('aria-valuenow', String(v));
    if (dir && !reducedMotion() && out.animate) {
      out.animate(
        [
          { transform: `translateY(${dir * -10}px) scale(.8)`, opacity: 0.2 },
          { transform: 'translateY(0) scale(1)', opacity: 1 },
        ],
        { duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.3)' },
      );
    }
  };
  const set = (next, { silent = false } = {}) => {
    const n = Math.min(max, Math.max(min, Math.round(next)));
    if (n === v) return render();
    const dir = Math.sign(n - v);
    v = n;
    render(dir);
    if (!silent) onChange?.(v);
  };
  const onClick = (e) => {
    const b = e.target.closest('[data-step]');
    if (b && el.contains(b)) set(v + Number(b.dataset.step));
  };
  el.addEventListener('click', onClick);
  render();
  return {
    get value() {
      return v;
    },
    set,
    destroy: () => el.removeEventListener('click', onClick),
  };
}

// --- top bar ---------------------------------------------------------------------

// An action label, like the icon (where a tap takes you), so no aria-pressed:
// "Switch to light theme, pressed" would read as the opposite of the truth.
function syncThemeButton() {
  const btn = $('btn-theme');
  if (!btn) return;
  const dark = resolvedTheme() === 'dark';
  btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}

// The chili is a state, not an action (it shows the mode, lit or not), so a
// fixed label and aria-pressed. Its colours follow <html data-spicy> (CSS).
function syncSpicyButton() {
  const btn = $('btn-spicy');
  if (!btn) return;
  const on = isSpicy();
  btn.setAttribute('aria-pressed', String(on));
  btn.title = `Spicy mode: ${on ? 'on' : 'off'}`;
}

// Switched on: the chili pops and wiggles (once the notice, if any, is gone).
function popChili(delay = 0) {
  const btn = $('btn-spicy');
  if (!btn || reducedMotion()) return;
  setTimeout(() => {
    btn.classList.remove('is-popping');
    void btn.offsetWidth; // restart it on a quick off → on
    btn.classList.add('is-popping');
  }, delay);
}

// Off → on asks the grown-ups question the first time in this browser; on →
// off never asks.
function bindSpicy() {
  const btn = $('btn-spicy');
  const notice = $('spicy-overlay');
  if (!btn) return;
  onSpicyChange(syncSpicyButton);
  btn.addEventListener('animationend', () => btn.classList.remove('is-popping'));
  btn.addEventListener('click', () => {
    if (isSpicy()) {
      setSpicy(false);
    } else if (spicyAcknowledged() || !notice) {
      setSpicy(true);
      popChili();
    } else {
      openOverlay(notice);
    }
  });
  $('spicy-confirm')?.addEventListener('click', () => {
    acknowledgeSpicy();
    closeOverlay(notice);
    setSpicy(true);
    popChili(180); // as the notice's close animation ends (closeOverlay)
  });
}

export function initUi() {
  initTheme(syncThemeButton);
  syncThemeButton();
  initSpicy();
  syncSpicyButton();
  bindOverlays();
  bindSpicy();

  $('btn-theme')?.addEventListener('click', () => {
    document.documentElement.classList.add('theme-switching');
    toggleTheme();
    syncThemeButton();
    setTimeout(() => document.documentElement.classList.remove('theme-switching'), 400);
  });
  $('btn-logo')?.addEventListener('click', () => showScreen('home', { direction: 'back' }));
  $('btn-help')?.addEventListener('click', () => openOverlay($('howto-overlay')));
}
