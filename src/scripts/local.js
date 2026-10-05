// Pass & play controller: one device passed round the table.
//
// The rules live in local-logic.js as pure transitions; this file wires them
// to the setup, game and results screens and animates what each transition
// changed. The game is saved to localStorage after every transition, so a
// reload (or the exit button) never loses it — Home offers Resume.
//
// Every phase says who should be holding the device (the team's badge and
// colour, also on the needle's knob) and offers one big next step. The secret
// target is only ever on show while the psychic holds the device: every
// entry into the game screen starts from a closed shutter, "Hand over" closes
// it before the team gets the dial, and the wheel is only set to a target by
// the psychic's own spin or by the reveal.

import { $ } from './ui.js';
import { currentScreen, onScreenChange, showScreen } from './router.js';
import { Dial } from './dial.js';
import { confettiFrom, countUp, flyPoints, popIn, pulse, reducedMotion, shake, sleep } from './fx.js';
import { RESULT_WORDS } from './scoring.js';
import { shuffledDeck, spectrumAt } from './spectrums.js';
import { teamBadgeHtml } from './teams.js';
import {
  activeTeam, beginPsychic, callSide, createGame, handOver, holderOf, inProgress, isLastTurn, lockIn,
  moveNeedle, nextTeamOf, nextTurn, normalizeGame, redraw, rematch,
} from './local-logic.js';
import { initSetup, openSetup } from './local-setup.js';
import { cancelResults, showResults } from './local-results.js';

const STORAGE_KEY = 'wavelength.local';

const PANEL_BUTTONS = ['local-ready', 'local-show', 'local-handover', 'local-lock', 'local-call-left', 'local-call-right', 'local-next'];

// Small role marks pinned to the holder's badge.
const ROLE_SVG = {
  psychic:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>',
  team:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 17a8.5 8.5 0 0 1 17 0"/><path d="M12 17l4.2-6"/></svg>',
  rival:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 7L4 12l4.5 5M15.5 7L20 12l-4.5 5"/></svg>',
  result:
    '<svg viewBox="0 0 24 24"><path d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.5l-5.4 2.9 1.2-5.9-4.4-4.1 6-.7z" fill="currentColor"/></svg>',
};

const TROPHY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0z" fill="currentColor"/><path d="M7 6H4.5a3 3 0 0 0 3 4M17 6h2.5a3 3 0 0 1-3 4M12 14v3.5M8 20.5h8"/></svg>';

let game = null; // the local game, exactly as saved
let dial = null;
let token = 0; // bumped on every entry to / exit from the game screen; stale awaits bail out
let busy = false; // an animation owns the panel: its buttons are disabled
let focusBack = null; // the panel control that had focus when a busy step began
let spun = false; // psychic: the wheel has whirled to this card's target
let shown = false; // psychic: the shutter is open
let revealing = false; // reveal: the dial is still opening (no result line yet)
let panelSet = ''; // the main button(s) the panel shows, e.g. "local-lock"
let armedAt = 0; // a just-shown main button ignores taps until then

// A new main button appears where the last one was, right under the finger
// that pressed it, so the second tap of a double tap would press it too:
// lock in at 50, make the rival's call for them, skip the handoff, wipe the
// results. Each new one ignores taps for about as long as it springs in.
const SETTLE_MS = 450;
const arm = (ms = SETTLE_MS) => {
  armedAt = performance.now() + ms;
};
const settling = () => performance.now() < armedAt;

// --- storage ----------------------------------------------------------------------

function loadGame() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeGame(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveGame() {
  try {
    if (game) localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode or full: the game still lives in memory for this visit */
  }
}

// Adopt a transition's result (null = not allowed now) and save it.
function commit(next) {
  if (!next) return false;
  game = next;
  saveGame();
  return true;
}

// --- home ------------------------------------------------------------------------------

function refreshResume() {
  const btn = $('btn-home-resume');
  if (!btn) return;
  const live = inProgress(game);
  btn.classList.toggle('hidden', !live);
  const meta = $('home-resume-meta');
  if (meta) meta.textContent = live ? `${game.round + 1} / ${game.rounds}` : '';
  btn.setAttribute('aria-label', live ? `Resume game, round ${game.round + 1} of ${game.rounds}` : 'Resume game');
}

// --- header strip ---------------------------------------------------------------------------

const chipEl = (i) => $('local-scores').children[i];
const chipScore = (i) => chipEl(i)?.querySelector('.local-chip-score');

// The score a chip shows. During a fresh reveal the points are already in the
// game but have not "landed" yet, so the chips show the old totals until the
// flying points arrive.
function shownScore(i, pending) {
  const t = game.teams[i];
  const r = game.result;
  if (!pending || !r) return t.score;
  if (i === game.turn) return t.score - r.points;
  if (i === r.rivalTeam) return t.score - r.rivalPoints;
  return t.score;
}

function setChipLabel(i, score) {
  chipEl(i)?.setAttribute('aria-label', `${game.teams[i].name}: ${score}`);
}

function renderHead({ pending = false } = {}) {
  const n = $('local-round-n');
  const before = n.textContent;
  n.textContent = String(game.round + 1);
  $('local-round-of').textContent = String(game.rounds);
  $('local-round').setAttribute('aria-label', `Round ${game.round + 1} of ${game.rounds}`);
  if (before && before !== n.textContent) popIn(n.parentElement);

  const box = $('local-scores');
  const sig = game.teams.map((t) => `${t.critter}${t.color}${t.name}`).join('|');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.classList.toggle('is-many', game.teams.length > 3);
    box.innerHTML = game.teams
      .map(
        (t, i) =>
          `<span class="chip local-chip" role="listitem" data-team="${i}" style="--chip-accent:${t.color};--team:${t.color}">` +
          `${teamBadgeHtml(t, { size: 28 })}<b class="local-chip-score">0</b></span>`,
      )
      .join('');
  }
  const holder = holderOf(game);
  game.teams.forEach((t, i) => {
    const chip = chipEl(i);
    const s = shownScore(i, pending);
    chipScore(i).textContent = String(s);
    setChipLabel(i, s);
    chip.classList.toggle('active', i === holder);
    if (i === holder) chip.setAttribute('aria-current', 'true');
    else chip.removeAttribute('aria-current');
  });
  scrollChipIntoView(holder);
}

// When the chips outgrow the strip, its edges fade wherever more chips hide.
function syncScoresEdges() {
  const box = $('local-scores');
  const over = box.scrollWidth > box.clientWidth + 1;
  box.classList.toggle('is-overflow', over);
  box.classList.toggle('at-start', !over || box.scrollLeft <= 2);
  box.classList.toggle('at-end', !over || box.scrollLeft + box.clientWidth >= box.scrollWidth - 2);
}

// With many teams the strip scrolls inside itself; keep chip i in view.
// Resolves once the strip has stopped, so points can be aimed at the chip.
function scrollChipIntoView(i) {
  const box = $('local-scores');
  const chip = chipEl(i);
  syncScoresEdges();
  if (!chip || box.scrollWidth <= box.clientWidth + 1) return Promise.resolve();
  const b = box.getBoundingClientRect();
  const c = chip.getBoundingClientRect();
  let dx = 0;
  if (c.left < b.left + 6) dx = c.left - b.left - 10;
  else if (c.right > b.right - 6) dx = c.right - b.right + 10;
  const goal = Math.max(0, Math.min(box.scrollWidth - box.clientWidth, box.scrollLeft + dx));
  if (Math.abs(goal - box.scrollLeft) < 1) return Promise.resolve();
  const smooth = !reducedMotion();
  box.scrollBy({ left: dx, behavior: smooth ? 'smooth' : 'auto' });
  if (!smooth) return Promise.resolve();
  return new Promise((resolve) => {
    let frame = 0;
    const done = () => {
      cancelAnimationFrame(frame);
      clearTimeout(give);
      resolve();
    };
    const give = setTimeout(done, 700); // a finger on the strip, or no frames
    const check = () => {
      if (Math.abs(goal - box.scrollLeft) < 1) done();
      else frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
  });
}

// --- phase panel -------------------------------------------------------------------------------

function roleOf(phase) {
  if (phase === 'handoff' || phase === 'psychic') return 'psychic';
  if (phase === 'rival') return 'rival';
  if (phase === 'reveal') return 'result';
  return 'team';
}

function lineFor(phase) {
  switch (phase) {
    case 'handoff':
      return 'Pass the device to your psychic';
    case 'psychic':
      if (!spun) return 'Psychic only — no peeking, team!';
      return shown ? 'Think of a clue…' : 'Say your clue, then hand over';
    case 'guess':
      return 'Turn the dial to the clue';
    case 'rival':
      return 'Is the target left or right?';
    case 'reveal':
      return revealing ? 'And the target is…' : RESULT_WORDS[game.result.points] ?? '';
    default:
      return '';
  }
}

function buttonsFor(phase) {
  switch (phase) {
    case 'handoff':
      return ['local-ready'];
    case 'psychic':
      return [spun ? 'local-handover' : 'local-show'];
    case 'guess':
      return ['local-lock'];
    case 'rival':
      return ['local-call-left', 'local-call-right'];
    case 'reveal':
      // Next only once the points have landed, so it springs in as the
      // celebration ends rather than waiting greyed out through it.
      return revealing || busy ? [] : ['local-next'];
    default:
      return [];
  }
}

function renderNext() {
  const last = isLastTurn(game);
  $('local-next-label').textContent = last ? 'Results' : 'Next';
  const badge = $('local-next-badge');
  if (last) {
    badge.innerHTML = TROPHY_SVG;
    $('local-next').setAttribute('aria-label', 'See the results');
  } else {
    const next = game.teams[nextTeamOf(game)];
    badge.innerHTML = teamBadgeHtml(next, { size: 30 });
    $('local-next').setAttribute('aria-label', `Next: ${next.name}`);
  }
}

// Redraw the panel for the current phase. animate: the who-strip and the new
// button spring in (a phase change); otherwise it updates in place. Whenever
// a different main button shows, it settles before it takes a tap.
function renderPanel({ animate = false } = {}) {
  const phase = game.phase;
  const panel = $('local-panel');
  const holder = holderOf(game);
  const team = game.teams[holder];
  const who = $('local-who');
  const role = roleOf(phase);
  const prevKey = panel.dataset.key;
  const key = `${phase}:${holder}:${spun}:${revealing}`;
  panel.dataset.phase = phase;
  panel.dataset.key = key;

  who.style.setProperty('--team', team.color);
  // Keyed on the team's identity, not just its seat: a new game can put a
  // different team in the same seat.
  const badgeKey = `${team.critter}|${team.color}|${role}`;
  if (who.dataset.badge !== badgeKey) {
    who.dataset.badge = badgeKey;
    $('local-who-badge').innerHTML = `${teamBadgeHtml(team, { size: 46 })}<span class="local-who-role" aria-hidden="true">${ROLE_SVG[role]}</span>`;
  }
  $('local-who-name').textContent = team.name;
  $('local-who-line').textContent = lineFor(phase);
  if (phase !== 'reveal') $('local-who-extra').classList.add('hidden');

  const visible = new Set(buttonsFor(phase));
  const set = [...visible].join(' ');
  if (set !== panelSet) {
    panelSet = set;
    if (set) arm();
  }
  // A busy step disables (or hides) every panel button, so the browser drops
  // the focused one's focus to the page; remember it to hand focus back.
  if (busy && panel.contains(document.activeElement)) focusBack = document.activeElement;
  for (const id of PANEL_BUTTONS) {
    const b = $(id);
    b.classList.toggle('hidden', !visible.has(id));
    b.disabled = busy;
  }
  if (phase === 'reveal') renderNext();

  // Psychic extras: peek (once the target has been shown) and a new card.
  const sub = $('local-sub');
  sub.classList.toggle('hidden', phase !== 'psychic');
  const peek = $('local-peek');
  peek.classList.toggle('hidden', !spun);
  peek.disabled = busy;
  peek.classList.toggle('is-shut', !shown); // its label is the action, so no aria-pressed
  $('local-peek-label').textContent = shown ? 'Hide' : 'Peek';
  $('local-newcard').disabled = busy;

  if (animate && prevKey !== key) {
    if (who.dataset.shown !== badgeKey) popIn(who);
    for (const id of visible) popIn($(id));
  }
  who.dataset.shown = badgeKey;

  // Keyboard players keep their place: when the focused button went away, or
  // a busy step that dropped focus has ended, focus goes back to that button
  // if it is still on offer (New card), else to the phase's main control —
  // the needle itself while guessing, so the arrow keys work at once. Focus
  // the player has moved elsewhere in the meantime is left alone.
  if (!busy) {
    const active = document.activeElement;
    const lost = !active || active === document.body;
    const gone = active && panel.contains(active) && active.closest('.hidden');
    if (gone || (focusBack && lost)) {
      const usable = (el) => el && panel.contains(el) && !el.closest('.hidden') && !el.disabled;
      const main = phase === 'guess' ? dial.svg : [...visible].map($).find(usable);
      (usable(focusBack) ? focusBack : main)?.focus({ preventScroll: true });
    }
    focusBack = null;
  }
}

// --- entering the game screen -------------------------------------------------------------------

// Show the game screen at whatever phase the saved game is in. Always starts
// from a closed shutter: whoever holds the device now, the target is not
// theirs to see until they ask for it.
function enterGame() {
  if (!game) return;
  if (game.phase === 'done') return openResults();
  token++;
  busy = false;
  focusBack = null;
  spun = false;
  shown = false;
  revealing = false;
  panelSet = ''; // whatever the panel shows first settles (a double tap on Resume)
  showScreen('local-game');

  dial.reset();
  dial.setAccent(game.teams[holderOf(game)].color);
  dial.setSpectrum(game.card.left, game.card.right);
  if (game.phase === 'guess') {
    dial.setNeedle(game.needle);
    dial.setInteractive(true);
  } else if (game.phase === 'rival' || game.phase === 'reveal') {
    dial.setNeedle(game.guess);
  }
  renderHead();
  if (game.phase === 'reveal') {
    playReveal({ celebrate: false });
    return;
  }
  renderPanel({ animate: true });
}

function leaveGame() {
  token++;
  busy = false;
  focusBack = null;
  revealing = false;
  dial.setInteractive(false);
  // Shut the target away once the screen has faded out.
  setTimeout(() => {
    if (currentScreen() !== 'local-game') dial.reset();
  }, 320);
}

// --- phase actions ----------------------------------------------------------------------------------

function onReady() {
  if (busy || settling() || !commit(beginPsychic(game))) return;
  spun = false;
  shown = false;
  renderPanel({ animate: true });
}

// The first look: the shutter swings away while the wheel whirls in.
async function onShow() {
  if (busy || settling() || game.phase !== 'psychic') return;
  const t = token;
  busy = true;
  spun = true;
  shown = true;
  renderPanel({ animate: true });
  await Promise.all([dial.openShutter(), dial.spinTo(game.card.target, { turns: 3, duration: 2400 })]);
  if (t !== token) return;
  busy = false;
  renderPanel();
}

function onPeek() {
  if (busy || game.phase !== 'psychic' || !spun) return;
  shown = !shown;
  renderPanel();
  if (shown) dial.openShutter();
  else dial.closeShutter();
}

async function onNewCard() {
  if (busy || !commit(redraw(game, spectrumAt))) return;
  const t = token;
  busy = true;
  if (spun) shown = true;
  renderPanel();
  const flip = dial.setSpectrum(game.card.left, game.card.right);
  if (spun) await Promise.all([flip, dial.openShutter(), dial.spinTo(game.card.target, { turns: 2, duration: 2000 })]);
  else await flip;
  if (t !== token) return;
  busy = false;
  renderPanel();
}

async function onHandOver() {
  if (busy || settling() || game.phase !== 'psychic' || !spun) return;
  const t = token;
  busy = true;
  shown = false;
  renderPanel();
  await dial.closeShutter();
  if (t !== token) return;
  busy = false;
  if (!commit(handOver(game))) return renderPanel();
  dial.setNeedle(game.needle, { animate: true });
  dial.setInteractive(true);
  renderHead();
  renderPanel({ animate: true });
}

function onLock() {
  if (busy || settling() || game.phase !== 'guess') return;
  dial.setInteractive(false);
  if (!commit(lockIn(game, dial.needle))) return;
  if (game.phase === 'rival') {
    dial.setAccent(game.teams[holderOf(game)].color);
    renderHead();
    renderPanel({ animate: true });
  } else {
    playReveal({ celebrate: true });
  }
}

function onCall(side) {
  if (busy || settling() || !commit(callSide(game, side))) return;
  playReveal({ celebrate: true });
}

// The rival's outcome, pinned to the right of the who-strip.
function showRivalResult() {
  const r = game.result;
  const extra = $('local-who-extra');
  if (r.rivalTeam == null) {
    extra.classList.add('hidden');
    return null;
  }
  const rival = game.teams[r.rivalTeam];
  extra.classList.remove('hidden');
  extra.classList.toggle('is-miss', !r.rivalPoints);
  extra.style.setProperty('--team', rival.color);
  extra.innerHTML = `${teamBadgeHtml(rival, { size: 26 })}<b>${r.rivalPoints ? '+1' : '0'}</b>`;
  extra.setAttribute('aria-label', `${rival.name}: ${r.rivalPoints ? 'right call, plus 1' : 'no point'}`);
  return extra;
}

// Open the dial on the guess, then (celebrate) fly the points to the score
// chips and count them up. Without celebrate — a resumed reveal — the scores
// are simply shown.
async function playReveal({ celebrate }) {
  const t = token;
  const team = activeTeam(game);
  const { points, rivalTeam, rivalPoints } = game.result;
  busy = true;
  revealing = true;
  dial.setInteractive(false);
  dial.setAccent(team.color);
  renderHead({ pending: celebrate });
  renderPanel({ animate: true });

  await dial.reveal({ guess: game.guess, target: game.card.target });
  if (t !== token) return;
  revealing = false;
  renderPanel();
  popIn($('local-who-line'));

  const bubble = dial.root.querySelector('.dial-bubble');
  if (celebrate && points > 0) {
    if (points === 4) confettiFrom(bubble, { count: 110, colors: [team.color, '#ffc93c', '#ff8f3a', '#1fa5e0', '#ff5a4e'] });
    const fly = flyPoints(bubble, chipEl(game.turn), `+${points}`, { color: team.color });
    await sleep(reducedMotion() ? 0 : 760);
    if (t !== token) return;
    countUp(chipScore(game.turn), team.score - points, team.score, { duration: 650 });
    setChipLabel(game.turn, team.score);
    await fly;
    if (t !== token) return;
  }

  const extra = showRivalResult();
  if (extra) {
    // With many teams the rival's chip can be scrolled out of the strip (the
    // last team's rival is the first chip): bring it in while the result
    // pops, and only aim the +1 once it has stopped.
    const inView = celebrate && rivalPoints ? scrollChipIntoView(rivalTeam) : null;
    if (celebrate) await popIn(extra);
    if (t !== token) return;
    if (celebrate && rivalPoints) {
      await inView;
      if (t !== token) return;
      const rival = game.teams[rivalTeam];
      const fly = flyPoints(extra, chipEl(rivalTeam), '+1', { color: rival.color });
      await sleep(reducedMotion() ? 0 : 760);
      if (t !== token) return;
      countUp(chipScore(rivalTeam), rival.score - rivalPoints, rival.score, { duration: 400 });
      setChipLabel(rivalTeam, rival.score);
      await fly;
    } else if (celebrate) {
      await shake(extra);
    }
    if (t !== token) return;
  }

  if (!celebrate) renderHead();
  busy = false;
  renderPanel();
  popIn($('local-next'));
  if (document.activeElement === document.body || !document.activeElement) $('local-next').focus({ preventScroll: true });
}

// After the reveal: the next team's turn on the same screen, or the results.
// The shutter closes over the old (already public) target while the new card
// flips in; the handoff is usable as soon as its button has settled — a
// quick "Show target" simply takes over the shutter mid-swing.
function onNext() {
  if (busy || settling() || !commit(nextTurn(game, spectrumAt))) return;
  if (game.phase === 'done') return openResults();
  spun = false;
  shown = false;
  const team = activeTeam(game);
  dial.clearReveal();
  dial.setInteractive(false);
  dial.setAccent(team.color);
  dial.setNeedle(50, { animate: true });
  dial.closeShutter();
  dial.setSpectrum(game.card.left, game.card.right);
  renderHead();
  renderPanel({ animate: true });
  pulse(chipEl(game.turn));
}

// --- setup and results ----------------------------------------------------------------------------------

function openSetupScreen() {
  showScreen('local-setup');
  openSetup({
    defaults: game ? { teams: game.teams.length, rounds: game.rounds, rival: game.rival } : {},
    hasSaved: inProgress(game),
  });
}

function startGame({ teams, rounds, rival }) {
  if (!commit(createGame({ teams, rounds, rival, deck: shuffledDeck(), spectrumAt }))) return;
  enterGame();
}

// The results lay out where the game was, so "Play again" can land right
// under the finger that pressed "Results": it settles first too, a little
// longer, as it would wipe the final scores.
function openResults() {
  arm(600);
  showScreen('local-results');
  showResults(game);
}

function playAgain() {
  if (settling() || !commit(rematch(game, spectrumAt))) return;
  enterGame();
}

// --- init ------------------------------------------------------------------------------------------------

export function initLocal() {
  const root = $('local-dial');
  if (!root) return;
  dial = new Dial(root);
  game = loadGame();

  initSetup({ onStart: startGame, onBack: () => showScreen('home', { direction: 'back' }) });

  $('btn-home-local')?.addEventListener('click', openSetupScreen);
  $('btn-home-resume')?.addEventListener('click', () => {
    if (inProgress(game)) enterGame();
    else refreshResume();
  });

  $('local-exit').addEventListener('click', () => showScreen('home', { direction: 'back' }));
  $('local-ready').addEventListener('click', onReady);
  $('local-show').addEventListener('click', onShow);
  $('local-peek').addEventListener('click', onPeek);
  $('local-newcard').addEventListener('click', onNewCard);
  $('local-handover').addEventListener('click', onHandOver);
  $('local-lock').addEventListener('click', onLock);
  $('local-call-left').addEventListener('click', () => onCall('left'));
  $('local-call-right').addEventListener('click', () => onCall('right'));
  $('local-next').addEventListener('click', onNext);
  $('local-again').addEventListener('click', playAgain);
  $('local-new').addEventListener('click', () => {
    if (!settling()) openSetupScreen();
  });
  // Focus follows the main button from phase to phase, so a held Enter would
  // repeat its way through them: only a fresh press counts.
  $('local-panel').addEventListener('keydown', (e) => {
    if (e.repeat && e.key === 'Enter') e.preventDefault();
  });

  $('local-scores').addEventListener('scroll', syncScoresEdges, { passive: true });
  window.addEventListener('resize', syncScoresEdges, { passive: true });

  // The needle's resting place is saved as the team settles it.
  dial.onChange((v) => {
    if (game?.phase === 'guess' && currentScreen() === 'local-game') commit(moveNeedle(game, v));
  });

  onScreenChange((name, prev) => {
    if (prev === 'local-game' && name !== 'local-game') leaveGame();
    if (prev === 'local-results' && name !== 'local-results') cancelResults();
    if (name === 'home') refreshResume();
  });
  refreshResume();
}
