// The dial controller: one instance per <Dial> on the page.
//
// Three things move, all on one requestAnimationFrame loop that only runs
// while something is in motion:
//   - the needle follows its logical value through a light spring, so a drag
//     feels direct but lands with a soft settle, and remote updates glide;
//   - the target wheel tweens (wind-up, whirl, ease-out, tiny wobble) and
//     drags a fading trail of ghost bands behind it while it is fast;
//   - the shutter swings about the pivot with a playful overshoot (under
//     reduced motion it never turns: it stays over the face and fades).
// Transforms are written straight onto SVG attributes — no layout, no style
// recalculation — which keeps a drag at 60fps even on modest phones.
//
// Values are dial units, 0 (hard left) … 100 (hard right); see scoring.js.

import { scoreFor, valueToAngle, clampValue, BAND } from './scoring.js';
import { reducedMotion, shake, sleep } from './fx.js';

// Spring presets for the needle: k = stiffness (1/s²), z = damping ratio.
const SPRING_DRAG = { k: 700, z: 0.72 };
const SPRING_GLIDE = { k: 85, z: 0.86 };
const SPRING_REVEAL = { k: 60, z: 0.78 };

const SHUTTER_OPEN = 180; // degrees about the pivot: 0 covers the face, 180 hides below it
const GHOSTS = 4; // trailing copies of the bands drawn while the wheel is fast
const PIVOT_DEAD = 26; // viewBox units around the pivot (cap r = 18) that never move the needle

// Colour pairs for the spectrum card ends, picked by a hash of the card text
// so the same card always looks the same on both players' screens.
const CARD_COLORS = [
  ['#2ec4b6', '#ff5a4e'],
  ['#3fa7ff', '#ffb703'],
  ['#8b6cff', '#ff8f3a'],
  ['#4cc26b', '#e5487f'],
  ['#3446c8', '#ffc93c'],
  ['#1fa5e0', '#ff6b5b'],
  ['#8b6cff', '#2ec4b6'],
  ['#e5487f', '#ffc93c'],
];

const easeOutBack = (c1) => (t) => 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
const easeOutQuad = (t) => 1 - (1 - t) ** 2;
const easeOutQuart = (t) => 1 - (1 - t) ** 4;
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const round1 = (v) => Math.round(v * 10) / 10;
const norm180 = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Dial {
  constructor(root) {
    if (!root) throw new Error('Dial: no element');
    this.root = root;
    this.svg = root.querySelector('.dial-svg');
    this.body = root.querySelector('.dial-body');
    const n = (k) => Number(root.dataset[k]);
    this.cx = n('cx');
    this.cy = n('cy');
    this.vw = n('w');
    this.vh = n('h');
    this.r = n('r');

    this.el = {
      wheel: root.querySelector('.dial-wheel'),
      ghosts: root.querySelector('.dial-ghosts'),
      bands: [...root.querySelectorAll('.dial-band')],
      glows: [...root.querySelectorAll('.dial-glow')],
      nums: [...root.querySelectorAll('.dial-num')],
      shutter: root.querySelector('.dial-shutter'),
      needle: root.querySelector('.dial-needle'),
      needleShadow: root.querySelector('.dial-needle-rot'),
      bubble: root.querySelector('.dial-bubble'),
      bubbleText: root.querySelector('.dial-bubble-text'),
      card: root.querySelector('.dial-card-face'),
      left: root.querySelector('.dial-end-left .dial-end-text'),
      right: root.querySelector('.dial-end-right .dial-end-text'),
    };

    // Ghost copies of the five bands for the motion trail.
    this.ghosts = [];
    for (let i = 0; i < GHOSTS; i++) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'dial-ghost');
      for (const b of this.el.bands) g.appendChild(b.cloneNode(false));
      g.style.opacity = '0';
      this.el.ghosts.appendChild(g);
      this.ghosts.push(g);
    }

    // Needle: logical value, plus the spring's displayed position/velocity.
    this._value = 50;
    this._pos = 50;
    this._vel = 0;
    this._spring = SPRING_DRAG;
    // Wheel and shutter angles in degrees.
    this._targetValue = 50;
    this._wheel = 0;
    this._wheelTween = null;
    this._ghostSpread = 0;
    this._shutter = 0;
    this._shutterOpen = false;
    this._shutterTween = null;

    this._interactive = false;
    this._drag = null; // { id, rect }
    this._keyMoved = false;
    this._raf = 0;
    this._last = 0;
    this._input = new Set();
    this._change = new Set();
    this._revealToken = 0;
    this._cardToken = 0;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._frame = this._frame.bind(this);

    this.svg.addEventListener('pointerdown', this._onDown);
    this.svg.addEventListener('pointermove', this._onMove);
    this.svg.addEventListener('pointerup', this._onUp);
    this.svg.addEventListener('pointercancel', this._onUp);
    this.svg.addEventListener('lostpointercapture', this._onUp);
    this.svg.addEventListener('keydown', this._onKey);
    this.svg.addEventListener('keyup', this._onKeyUp);

    const l = this.el.left.textContent.trim();
    const r = this.el.right.textContent.trim();
    if (l || r) this._paintCard(l, r);
    this.root.classList.toggle('no-card', !(l || r));

    this._renderNeedle();
    this._renderWheel();
    this._renderShutter();
  }

  // --- public API -----------------------------------------------------------------

  get needle() {
    return this._value;
  }

  get target() {
    return this._targetValue;
  }

  get shutterOpen() {
    return this._shutterOpen;
  }

  get interactive() {
    return this._interactive;
  }

  onInput(cb) {
    this._input.add(cb);
    return () => this._input.delete(cb);
  }

  onChange(cb) {
    this._change.add(cb);
    return () => this._change.delete(cb);
  }

  setInteractive(on) {
    this._interactive = !!on;
    this.root.classList.toggle('is-interactive', this._interactive);
    this.svg.setAttribute('tabindex', this._interactive ? '0' : '-1');
    this.svg.setAttribute('aria-disabled', String(!this._interactive));
    if (!this._interactive && this._drag) this._endDrag(true);
    // A locked dial gives focus back (to body): its focus ring goes out and the
    // next screen can claim focus (e.g. the psychic's clue box).
    if (!this._interactive && document.activeElement === this.svg) this.svg.blur();
  }

  setAccent(color) {
    if (color) this.root.style.setProperty('--dial-accent', color);
    else this.root.style.removeProperty('--dial-accent');
  }

  // Move the needle. animate: glide there on a soft spring (remote updates).
  setNeedle(value, { animate = false } = {}) {
    this._value = round1(clampValue(value));
    this._syncAria();
    if (animate && !reducedMotion()) {
      this._spring = SPRING_GLIDE;
      this._kick();
    } else {
      this._pos = this._value;
      this._vel = 0;
      this._renderNeedle();
    }
  }

  // Place the target wheel instantly.
  setTarget(value) {
    this._finishWheel();
    this._targetValue = clampValue(value);
    this._wheel = valueToAngle(this._targetValue);
    this._ghostSpread = 0;
    this._renderWheel();
  }

  // Whirl the wheel several turns clockwise and settle on `value`.
  // Reduced motion: no whirl at all (even the shortest way round can be a
  // 180° sweep) — the wheel is simply there, with a brief fade as the cue.
  spinTo(value, { turns = 3, duration = 2400 } = {}) {
    if (reducedMotion()) {
      this.setTarget(value);
      this.el.wheel.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200 });
      return Promise.resolve();
    }
    this._finishWheel();
    this._targetValue = clampValue(value);
    const goal = valueToAngle(this._targetValue);
    const from = this._wheel;
    const delta = (((goal - from) % 360) + 360) % 360;
    const to = from + delta + Math.max(0, Math.round(turns)) * 360;
    if (to === from) {
      this._renderWheel();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const tw = {
        from,
        to,
        start: performance.now(),
        duration: Math.max(400, duration),
        resolve,
      };
      // requestAnimationFrame stops in a background tab; the timer makes
      // sure the promise still settles there.
      tw.timer = setTimeout(() => this._wheelTween === tw && this._finishWheel(), tw.duration + 300);
      this._wheelTween = tw;
      this.root.classList.add('is-spinning');
      this._kick();
    });
  }

  openShutter() {
    return this._swingShutter(true);
  }

  closeShutter() {
    return this._swingShutter(false);
  }

  // The payoff: open the shutter, glide the needle to the guess, light the
  // band it landed in with its "+N" (or shake on a miss). Resolves with the
  // points after ~1.4s.
  async reveal({ guess, target } = {}) {
    const token = ++this._revealToken;
    this.clearReveal();
    if (target != null && clampValue(target) !== this._targetValue) {
      if (this._shutterOpen) await this.spinTo(target, { turns: 1, duration: 1100 });
      else this.setTarget(target);
    }
    if (guess != null) {
      this._value = round1(clampValue(guess));
      this._syncAria();
    }
    const t0 = performance.now();
    const opening = this.openShutter();
    if (!reducedMotion()) {
      this._spring = SPRING_REVEAL;
      this._kick();
    } else {
      this._pos = this._value;
      this._renderNeedle();
    }
    await opening;
    await this._needleSettled(900);
    if (token !== this._revealToken) return scoreFor(this._targetValue, this._value);

    const points = scoreFor(this._targetValue, this._value);
    this.root.classList.add('is-revealed');
    if (points > 0) {
      const d = this._value - this._targetValue;
      const k = points === 4 ? 0 : Math.sign(d) * (4 - points);
      this._lightBand(k, points);
    } else {
      this._showBubble('0', 'miss');
      shake(this.body);
    }
    const total = reducedMotion() ? 700 : 1400;
    await sleep(Math.max(reducedMotion() ? 150 : 650, total - (performance.now() - t0)));
    return points;
  }

  clearReveal() {
    this.root.classList.remove('is-revealed', 'is-bullseye');
    for (const n of [...this.el.bands, ...this.el.glows, ...this.el.nums]) n.classList.remove('is-hit');
    this.el.bubble.classList.remove('show', 'miss');
    this.el.bubble.style.removeProperty('--bubble');
  }

  // A new spectrum card, flipped in. Resolves when it has landed.
  setSpectrum(left, right, { animate = true } = {}) {
    const token = ++this._cardToken;
    const face = this.el.card;
    this.root.classList.remove('no-card');
    // Any flip still running is superseded — including its flip-out, whose
    // forwards fill would otherwise leave the card edge-on (invisible).
    face.getAnimations?.().forEach((a) => a.cancel());
    if (!animate || reducedMotion() || !face.animate) {
      this._paintCard(left, right);
      return Promise.resolve();
    }
    const out = face.animate(
      [
        { transform: 'perspective(700px) rotateX(0deg)', opacity: 1 },
        { transform: 'perspective(700px) rotateX(88deg)', opacity: 0.4 },
      ],
      { duration: 170, easing: 'cubic-bezier(.5,0,.9,.5)', fill: 'forwards' },
    );
    return Promise.race([out.finished.catch(() => {}), sleep(420)])
      .then(() => {
        if (token !== this._cardToken) {
          out.cancel(); // only our own flip-out: a newer flip may be running
          return;
        }
        this._paintCard(left, right);
        const back = face.animate(
          [
            { transform: 'perspective(700px) rotateX(-92deg)', opacity: 0.4 },
            { transform: 'perspective(700px) rotateX(14deg)', opacity: 1, offset: 0.62 },
            { transform: 'perspective(700px) rotateX(-5deg)', offset: 0.84 },
            { transform: 'perspective(700px) rotateX(0deg)', opacity: 1 },
          ],
          { duration: 460, easing: 'cubic-bezier(.2,.7,.3,1)' },
        );
        out.cancel();
        return Promise.race([back.finished.catch(() => {}), sleep(710)]);
      });
  }

  // No card at all: the empty dotted face. Stops a flip still in progress so
  // it cannot paint an old card back.
  clearSpectrum() {
    this._cardToken++;
    this.el.card.getAnimations?.().forEach((a) => a.cancel());
    this.el.left.textContent = '';
    this.el.right.textContent = '';
    this.root.style.removeProperty('--end-l');
    this.root.style.removeProperty('--end-r');
    this.svg.setAttribute('aria-label', 'Needle');
    this.root.classList.add('no-card');
  }

  // Shutter closed, needle centred, nothing highlighted, no accent.
  reset() {
    this._revealToken++;
    this._finishWheel();
    this._finishShutter();
    this._shutter = 0;
    this._shutterOpen = false;
    this.root.classList.remove('shutter-open');
    this._renderShutter();
    if (this._drag) this._endDrag(true);
    this._value = 50;
    this._pos = 50;
    this._vel = 0;
    this._syncAria();
    this._renderNeedle();
    this.clearReveal();
    this.setAccent(null);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._finishWheel();
    this._finishShutter();
    this.svg.removeEventListener('pointerdown', this._onDown);
    this.svg.removeEventListener('pointermove', this._onMove);
    this.svg.removeEventListener('pointerup', this._onUp);
    this.svg.removeEventListener('pointercancel', this._onUp);
    this.svg.removeEventListener('lostpointercapture', this._onUp);
    this.svg.removeEventListener('keydown', this._onKey);
    this.svg.removeEventListener('keyup', this._onKeyUp);
    this._input.clear();
    this._change.clear();
    for (const g of this.ghosts) g.remove();
    this.ghosts = [];
  }

  // --- the card ---------------------------------------------------------------------

  _paintCard(left, right) {
    this.el.left.textContent = left ?? '';
    this.el.right.textContent = right ?? '';
    const [cl, cr] = CARD_COLORS[hash(`${left}|${right}`) % CARD_COLORS.length];
    this.root.style.setProperty('--end-l', cl);
    this.root.style.setProperty('--end-r', cr);
    this.svg.setAttribute('aria-label', left || right ? `Needle, from ${left} to ${right}` : 'Needle');
  }

  // --- reveal pieces ----------------------------------------------------------------

  _lightBand(k, points) {
    const pick = (list) => list.find((n) => Number(n.dataset.k) === k);
    for (const list of [this.el.bands, this.el.glows, this.el.nums]) pick(list)?.classList.add('is-hit');
    this.root.classList.toggle('is-bullseye', points === 4);
    this._showBubble(`+${points}`, `p${points}`);
  }

  // The "+N" floats just beside the needle, on the side with more room, so
  // neither the needle nor the lit band hides it.
  _showBubble(text, kind) {
    const b = this.el.bubble;
    const v = this._value + (this._value <= 50 ? 1 : -1) * BAND * 2.8;
    const a = (valueToAngle(clampValue(v)) * Math.PI) / 180;
    const r = this.r * 0.52;
    const x = this.cx + r * Math.sin(a);
    const y = this.cy - r * Math.cos(a);
    b.style.left = `${(x / this.vw) * 100}%`;
    b.style.top = `${(y / this.vh) * 100}%`;
    b.className = `dial-bubble ${kind}`;
    this.el.bubbleText.textContent = text;
    void b.offsetWidth; // restart the pop
    b.classList.add('show');
  }

  // Polled on a timer, not a frame, so it also settles in a background tab
  // (where the needle simply snaps to its value).
  _needleSettled(maxMs) {
    const start = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        if (document.hidden) {
          this._pos = this._value;
          this._vel = 0;
          this._renderNeedle();
        }
        const done = Math.abs(this._pos - this._value) < 0.15 && Math.abs(this._vel) < 0.5;
        if (done || performance.now() - start > maxMs) resolve();
        else setTimeout(check, 32);
      };
      check();
    });
  }

  // --- shutter ----------------------------------------------------------------------

  _swingShutter(open) {
    const to = open ? SHUTTER_OPEN : 0;
    this._shutterOpen = open;
    this.root.classList.toggle('shutter-open', open);
    if (!this._shutterTween && this._shutter === to) return Promise.resolve();
    // Roughly how much of the face the plate hides right now (1 = all of it),
    // so a fade that takes over from another tween starts where that one was.
    const prev = this._shutterTween;
    const cover = prev?.fade ? prev.cover : Math.min(1, Math.max(0, 1 - this._shutter / SHUTTER_OPEN));
    this._finishShutter(false);
    // Reduced motion: no 180° sweep across the dial (spinTo fades for the
    // same reason) — the plate stays over the face and fades out or in. The
    // frame loop drives it, not CSS: base.css cuts CSS transitions to 1ms
    // under reduced motion, which would turn the fade into a snap.
    const fade = reducedMotion();
    const goal = open ? 0 : 1; // the cover a fade ends on
    return new Promise((resolve) => {
      const tw = fade
        ? {
            fade,
            from: cover,
            goal,
            cover,
            to,
            start: performance.now(),
            duration: Math.max(60, 180 * Math.abs(goal - cover)),
            ease: easeOutQuad,
            resolve,
          }
        : {
            from: this._shutter,
            to,
            start: performance.now(),
            duration: open ? 760 : 640,
            ease: easeOutBack(open ? 1.05 : 1.25),
            resolve,
          };
      tw.timer = setTimeout(() => this._shutterTween === tw && this._finishShutter(true), tw.duration + 300);
      this._shutterTween = tw;
      if (tw.fade) {
        this._shutter = 0;
        this.el.shutter.style.opacity = String(cover);
        this._renderShutter();
      }
      this._kick();
    });
  }

  // Stop a swing. jump: snap to where it was heading (else leave it mid-air
  // for a new tween to pick up from). A fade always lands on its end state:
  // a plate left half-transparent would show the target through it.
  _finishShutter(jump = true) {
    const tw = this._shutterTween;
    if (!tw) return;
    this._shutterTween = null;
    clearTimeout(tw.timer);
    if (tw.fade) this.el.shutter.style.opacity = '';
    if (jump || tw.fade) {
      this._shutter = tw.to;
      this._renderShutter();
    }
    tw.resolve();
  }

  _stepShutter(now) {
    const tw = this._shutterTween;
    if (!tw) return false;
    const t = Math.min(1, (now - tw.start) / tw.duration);
    const k = tw.ease(t);
    if (tw.fade) {
      tw.cover = tw.from + (tw.goal - tw.from) * k;
      this.el.shutter.style.opacity = tw.cover.toFixed(3);
    } else {
      this._shutter = tw.from + (tw.to - tw.from) * k;
    }
    this._renderShutter();
    if (t >= 1) {
      this._shutter = tw.to;
      this._shutterTween = null;
      clearTimeout(tw.timer);
      if (tw.fade) this.el.shutter.style.opacity = '';
      this._renderShutter();
      tw.resolve();
      return false;
    }
    return true;
  }

  _renderShutter() {
    this.el.shutter.setAttribute('transform', `rotate(${this._shutter.toFixed(2)} ${this.cx} ${this.cy})`);
    // Fully tucked away below the baseline: stop painting it at all.
    this.el.shutter.style.visibility = this._shutter >= SHUTTER_OPEN - 0.5 && !this._shutterTween ? 'hidden' : '';
  }

  // --- wheel ------------------------------------------------------------------------

  _finishWheel() {
    const tw = this._wheelTween;
    if (!tw) return;
    this._wheelTween = null;
    clearTimeout(tw.timer);
    this._wheel = norm180(tw.to);
    this._ghostSpread = 0;
    this.root.classList.remove('is-spinning');
    this._renderWheel();
    tw.resolve();
  }

  // Wind back a touch, whirl, decelerate past the mark, wobble home.
  _wheelAngle(tw, t) {
    const span = tw.to - tw.from;
    const WIND = 0.09; // fraction of the time spent pulling back
    const SETTLE = 0.84; // where the main whirl stops (just past the mark)
    const windBack = -9;
    const over = Math.min(7, 2 + span * 0.004);
    if (t < WIND) return tw.from + windBack * easeInOutSine(t / WIND);
    if (t < SETTLE) {
      const u = (t - WIND) / (SETTLE - WIND);
      return tw.from + windBack + (span - windBack + over) * easeOutQuart(u);
    }
    const v = (t - SETTLE) / (1 - SETTLE);
    return tw.to + over * Math.cos(Math.PI * 1.5 * v) * (1 - v) ** 2;
  }

  _stepWheel(now) {
    const tw = this._wheelTween;
    if (!tw) {
      if (this._ghostSpread > 0.05) {
        this._ghostSpread *= 0.7;
        this._renderWheel();
        return true;
      }
      return false;
    }
    const t = Math.min(1, (now - tw.start) / tw.duration);
    const prev = this._wheel;
    this._wheel = this._wheelAngle(tw, t);
    // Trail length ≈ how far the wheel moved this frame (capped), smoothed.
    const moved = Math.min(46, Math.max(0, this._wheel - prev));
    this._ghostSpread += (moved - this._ghostSpread) * 0.5;
    this._renderWheel();
    if (t >= 1) {
      this._finishWheel();
      return this._ghostSpread > 0.05;
    }
    return true;
  }

  _renderWheel() {
    const a = this._wheel;
    this.el.wheel.setAttribute('transform', `rotate(${a.toFixed(2)} ${this.cx} ${this.cy})`);
    // Numbers stay upright wherever the wheel stops. dial.css gives them
    // transform-box: fill-box + transform-origin: center (for their pop), and
    // that origin applies to this attribute too — so the rotation needs no
    // centre of its own; adding one would turn them about the wrong point.
    for (const n of this.el.nums) {
      n.setAttribute('transform', `rotate(${(-a).toFixed(2)})`);
    }
    const s = this._ghostSpread;
    for (let i = 0; i < this.ghosts.length; i++) {
      const g = this.ghosts[i];
      if (s < 1.5) {
        if (g.style.opacity !== '0') g.style.opacity = '0';
        continue;
      }
      const f = (i + 1) / this.ghosts.length;
      g.setAttribute('transform', `rotate(${(-s * f).toFixed(2)} ${this.cx} ${this.cy})`);
      g.style.opacity = String(Math.min(1, s / 18) * 0.42 * (1 - f * 0.7));
    }
    this.el.nums.forEach((n) => (n.style.opacity = s > 9 ? String(Math.max(0, 1 - (s - 9) / 12)) : ''));
  }

  // --- needle -----------------------------------------------------------------------

  _stepNeedle(dt) {
    if (this._pos === this._value && this._vel === 0) return false;
    const { k, z } = this._spring;
    const c = 2 * z * Math.sqrt(k);
    // Fixed substeps keep a stiff spring stable on a slow frame.
    let left = dt;
    while (left > 0) {
      const h = Math.min(left, 1 / 240);
      const acc = k * (this._value - this._pos) - c * this._vel;
      this._vel += acc * h;
      this._pos += this._vel * h;
      left -= h;
    }
    if (Math.abs(this._value - this._pos) < 0.01 && Math.abs(this._vel) < 0.05) {
      this._pos = this._value;
      this._vel = 0;
    }
    this._renderNeedle();
    return true;
  }

  _renderNeedle() {
    const a = valueToAngle(Math.min(100.6, Math.max(-0.6, this._pos)));
    const tr = `rotate(${a.toFixed(2)} ${this.cx} ${this.cy})`;
    this.el.needle.setAttribute('transform', tr);
    this.el.needleShadow.setAttribute('transform', tr);
  }

  _syncAria() {
    this.svg.setAttribute('aria-valuenow', String(Math.round(this._value)));
  }

  // --- loop ---------------------------------------------------------------------------

  _kick() {
    if (this._raf) return;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._frame);
  }

  _frame(now) {
    this._raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    let busy = this._stepNeedle(dt);
    busy = this._stepWheel(now) || busy;
    busy = this._stepShutter(now) || busy;
    if (busy) this._raf = requestAnimationFrame(this._frame);
  }

  // --- input ----------------------------------------------------------------------------

  // Pointer position → dial value, from its angle about the pivot.
  _valueAt(e, rect) {
    const s = rect.width / this.vw;
    const dx = e.clientX - (rect.left + this.cx * s);
    const dy = rect.top + this.cy * s - e.clientY; // up is positive
    // On the hub, a pixel either way is a huge swing in angle: hold the value
    // (a thumb resting there, or a drag passing through, never flings it).
    if (Math.hypot(dx, dy) < Math.max(PIVOT_DEAD * s, 14)) return this._value;
    if (dy < -6 * s) {
      // Below the baseline: pin to the end on that side, but not while the
      // pointer hovers right under the pivot (it would flick end to end).
      if (Math.abs(dx) < 14 * s) return this._value;
      return dx < 0 ? 0 : 100;
    }
    const deg = (Math.atan2(dx, Math.max(dy, 0)) * 180) / Math.PI;
    return round1(clampValue((deg + 90) / 1.8));
  }

  _emit(set, v) {
    for (const cb of set) {
      try {
        cb(v);
      } catch (err) {
        console.error(err);
      }
    }
  }

  _moveTo(v) {
    if (v === this._value) return;
    this._value = v;
    this._spring = SPRING_DRAG;
    this._syncAria();
    this._kick();
    this._emit(this._input, v);
  }

  _onDown(e) {
    if (!this._interactive || this._drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const rect = this.svg.getBoundingClientRect();
    // Only presses on the dome itself (not the empty corners) grab the needle.
    const s = rect.width / this.vw;
    const dx = e.clientX - (rect.left + this.cx * s);
    const dy = e.clientY - (rect.top + this.cy * s);
    if (Math.hypot(dx, Math.min(0, dy)) > (this.r + 22) * s) return;
    try {
      this.svg.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events cannot be captured; dragging still works inside */
    }
    this._drag = { id: e.pointerId, rect };
    this.root.classList.add('is-dragging');
    this.svg.focus({ preventScroll: true });
    this._moveTo(this._valueAt(e, rect));
  }

  _onMove(e) {
    if (!this._drag || e.pointerId !== this._drag.id) return;
    e.preventDefault();
    this._moveTo(this._valueAt(e, this._drag.rect));
  }

  _onUp(e) {
    if (!this._drag || (e && e.pointerId !== this._drag.id)) return;
    this._endDrag(false);
  }

  _endDrag(silent) {
    const d = this._drag;
    this._drag = null;
    this.root.classList.remove('is-dragging');
    try {
      if (d && this.svg.hasPointerCapture?.(d.id)) this.svg.releasePointerCapture(d.id);
    } catch {
      /* already released */
    }
    if (!silent) this._emit(this._change, this._value);
  }

  _onKey(e) {
    // Alt/Ctrl/Cmd combos stay with the browser (Alt+← is Back, Ctrl+End scrolls…);
    // Shift is ours: the ×5 step.
    if (!this._interactive || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? 5 : 1;
    let v = this._value;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        v -= step;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        v += step;
        break;
      case 'PageDown':
        v -= 10;
        break;
      case 'PageUp':
        v += 10;
        break;
      case 'Home':
        v = 0;
        break;
      case 'End':
        v = 100;
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = round1(clampValue(Math.round(v)));
    if (next !== this._value) {
      this._keyMoved = true;
      this._moveTo(next);
    }
  }

  _onKeyUp() {
    if (!this._keyMoved) return;
    this._keyMoved = false;
    this._emit(this._change, this._value);
  }
}
