// Motion helpers shared by every screen: number tickers, flying point chips,
// confetti and the little one-shot pops, pulses and shakes.
//
// Everything here is fire-and-forget and returns a Promise that resolves when
// the motion is over, so a caller can `await` a whole celebration before it
// moves on. All of it honours prefers-reduced-motion by shortening or
// skipping the movement — never by skipping the end state. Every promise
// also settles on a timer, because animation frames stop in a background
// tab and a caller awaiting a celebration must never hang there.

const REDUCED = '(prefers-reduced-motion: reduce)';

export const reducedMotion = () => !!window.matchMedia?.(REDUCED).matches;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

// Band, brand and team colours — the confetti default. Kept as literals so a
// burst never has to read computed styles mid-celebration.
const CONFETTI_COLORS = ['#ff5a4e', '#ffc93c', '#ff8f3a', '#1fa5e0', '#2ec4b6', '#8b6cff', '#4cc26b', '#3446c8'];

// A layer above everything (overlays, toasts) for chips and confetti.
function fxLayer() {
  let layer = document.getElementById('fx-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'fx-layer';
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

// --- number ticker ------------------------------------------------------------

const tickers = new WeakMap(); // el → stop() of the count running on it

// Eased count from `from` to `to`, written into el.textContent as integers.
// A new count on the same element supersedes the old one: the old promise
// resolves at once and never writes its (now stale) number again.
export function countUp(el, from, to, { duration = 900 } = {}) {
  if (!el) return Promise.resolve();
  stopCount(el);
  const a = Number(from) || 0;
  const b = Number(to) || 0;
  if (reducedMotion() || duration <= 0 || a === b) {
    el.textContent = String(Math.round(b));
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const start = performance.now();
    el.classList.add('is-counting');
    let raf = 0;
    let done = false;
    // Clean up and resolve without touching the text.
    const stop = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf); // this count's own frame, never a newer one's
      clearTimeout(fallback);
      el.classList.remove('is-counting');
      if (tickers.get(el) === stop) tickers.delete(el);
      resolve();
    };
    const finish = () => {
      if (done) return;
      el.textContent = String(Math.round(b));
      stop();
    };
    const frame = (now) => {
      if (done) return;
      const t = Math.min(1, (now - start) / duration);
      el.textContent = String(Math.round(a + (b - a) * easeOutCubic(t)));
      if (t < 1) raf = requestAnimationFrame(frame);
      else finish();
    };
    const fallback = setTimeout(finish, duration + 250);
    tickers.set(el, stop);
    raf = requestAnimationFrame(frame);
  });
}

// Stop a count on el where it stands (its promise resolves), e.g. before
// writing a number straight into the element.
export function stopCount(el) {
  if (el) tickers.get(el)?.();
}

// --- one-shots ------------------------------------------------------------------

function play(el, keyframes, options) {
  if (!el?.animate) return Promise.resolve();
  const anim = el.animate(keyframes, { fill: 'none', ...options });
  return Promise.race([
    anim.finished.catch(() => {}), // a cancelled animation is not an error
    sleep((options.duration || 0) + 250),
  ]);
}

// Springs in from nothing — for anything newly shown.
export function popIn(el) {
  if (reducedMotion()) return play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
  return play(
    el,
    [
      { transform: 'scale(0.6)', opacity: 0 },
      { transform: 'scale(1.08)', opacity: 1, offset: 0.6 },
      { transform: 'scale(0.97)', offset: 0.8 },
      { transform: 'scale(1)', opacity: 1 },
    ],
    { duration: 420, easing: 'cubic-bezier(.2,.8,.3,1)' },
  );
}

// A happy throb — for a score that just went up, a team whose turn it is.
export function pulse(el) {
  if (reducedMotion()) return play(el, [{ opacity: 0.6 }, { opacity: 1 }], { duration: 160 });
  return play(
    el,
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.18)', offset: 0.35 },
      { transform: 'scale(0.95)', offset: 0.7 },
      { transform: 'scale(1)' },
    ],
    { duration: 460, easing: 'ease-out' },
  );
}

// A gentle "nope".
export function shake(el) {
  if (reducedMotion()) return play(el, [{ opacity: 0.55 }, { opacity: 1 }], { duration: 200 });
  return play(
    el,
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-7px) rotate(-1deg)', offset: 0.15 },
      { transform: 'translateX(6px) rotate(1deg)', offset: 0.35 },
      { transform: 'translateX(-4px)', offset: 0.55 },
      { transform: 'translateX(2px)', offset: 0.75 },
      { transform: 'translateX(0)' },
    ],
    { duration: 480, easing: 'ease-out' },
  );
}

// --- flying points ----------------------------------------------------------------

const centerOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

// A "+3" chip that hops from one element to another along an arc, lands with
// a squash, and gives the destination a pulse. `color` tints the chip.
export async function flyPoints(fromEl, toEl, text, { color } = {}) {
  if (!fromEl || !toEl) return;
  const a = centerOf(fromEl);
  const b = centerOf(toEl);
  const chip = document.createElement('div');
  chip.className = 'fly-chip';
  chip.textContent = text;
  if (color) chip.style.setProperty('--chip', color);
  chip.style.left = `${a.x}px`;
  chip.style.top = `${a.y}px`;
  fxLayer().appendChild(chip);

  try {
    if (reducedMotion()) {
      await play(chip, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 400 });
    } else {
      // Sample a quadratic arc whose peak sits above the higher of the two ends.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lift = Math.min(160, 60 + Math.hypot(dx, dy) * 0.35);
      const cx = a.x + dx / 2;
      const cy = Math.min(a.y, b.y) - lift;
      const frames = [];
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cx + t * t * b.x - a.x;
        const y = (1 - t) ** 2 * a.y + 2 * (1 - t) * t * cy + t * t * b.y - a.y;
        const s = i === 0 ? 0.4 : 1 + 0.25 * Math.sin(Math.PI * t);
        frames.push({ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${s})`, opacity: 1, offset: t * 0.82 });
      }
      // Landing: squash flat, spring back, vanish into the target.
      const end = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`;
      frames.push({ transform: `${end} scale(1.35, 0.7)`, opacity: 1, offset: 0.89 });
      frames.push({ transform: `${end} scale(0.9, 1.12)`, opacity: 1, offset: 0.95 });
      frames.push({ transform: `${end} scale(0.4)`, opacity: 0, offset: 1 });
      await play(chip, frames, { duration: 900, easing: 'cubic-bezier(.45,.05,.4,1)' });
    }
  } finally {
    chip.remove();
  }
  await pulse(toEl);
}

// --- confetti ------------------------------------------------------------------------

// A burst of paper from a point (viewport px). Draws on one throwaway canvas
// that removes itself when the last piece has fallen.
export function confetti({ x = innerWidth / 2, y = innerHeight / 2, count = 90, colors = CONFETTI_COLORS } = {}) {
  if (document.hidden) return Promise.resolve(); // nobody to see it
  const reduce = reducedMotion();
  const n = reduce ? Math.min(18, count) : count;
  const life = reduce ? 700 : 1900;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-confetti';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = innerWidth;
  const h = innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  fxLayer().appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return Promise.resolve();
  }
  ctx.scale(dpr, dpr);

  const parts = Array.from({ length: n }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15;
    const speed = (reduce ? 3 : 7) + Math.random() * (reduce ? 3 : 9);
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 7,
      h: 4 + Math.random() * 5,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.4,
      wobble: Math.random() * Math.PI * 2,
      round: Math.random() < 0.28,
      color: colors[Math.floor(Math.random() * colors.length)],
    };
  });

  return new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      clearTimeout(fallback);
      canvas.remove();
      resolve();
    };
    const fallback = setTimeout(end, life + 600);
    const frame = (now) => {
      if (over) return;
      const dt = Math.min(2.5, (now - last) / 16.67); // in 60fps frames
      last = now;
      const age = now - start;
      ctx.clearRect(0, 0, w, h);
      const fade = Math.max(0, Math.min(1, (life - age) / 450));
      for (const p of parts) {
        p.vx *= 0.985 ** dt;
        p.vy = p.vy * 0.985 ** dt + 0.32 * dt;
        p.wobble += 0.12 * dt;
        p.x += (p.vx + Math.sin(p.wobble) * 0.6) * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.h * 0.6, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // A flat strip that flutters: its height follows the wobble.
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.wobble)) + 1);
        }
        ctx.restore();
      }
      if (age < life) requestAnimationFrame(frame);
      else end();
    };
    requestAnimationFrame(frame);
  });
}

// Confetti from the middle of an element.
export function confettiFrom(el, opts = {}) {
  if (!el) return confetti(opts);
  const { x, y } = centerOf(el);
  return confetti({ x, y, ...opts });
}
