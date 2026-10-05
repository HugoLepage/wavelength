// The pass-and-play setup screen: team and round steppers, the team list
// (each team a random adjective + critter; the die rolls another), the
// rival-guess switch (only with two or more teams — one team plays co-op),
// and Start. Rows grow in and fold away as the team count changes.
//
// local.js owns the game; this module only gathers the settings and hands
// them over through the onStart callback.

import { $, armConfirm, bindStepper, escapeHtml } from './ui.js';
import { makeTeams, rerollTeam, resizeTeams, teamBadgeHtml } from './teams.js';
import { popIn, reducedMotion } from './fx.js';
import { MAX_POINTS } from './scoring.js';
import { DEFAULT_ROUNDS, DEFAULT_TEAMS, MAX_ROUNDS, MAX_TEAMS, MIN_ROUNDS, MIN_TEAMS } from './local-logic.js';

const DIE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="none" stroke="currentColor" stroke-width="2.2"/>' +
  '<g fill="currentColor"><circle cx="8.4" cy="8.4" r="1.65"/><circle cx="15.6" cy="8.4" r="1.65"/><circle cx="12" cy="12" r="1.65"/>' +
  '<circle cx="8.4" cy="15.6" r="1.65"/><circle cx="15.6" cy="15.6" r="1.65"/></g></svg>';

let teams = [];
let teamsStepper = null;
let roundsStepper = null;
let startHandler = null; // (settings) => void, from local.js
let unarm = null;

// Start sits right where Home's "Pass & play" card and Results' "New game"
// button were, so the second tap of a double tap would land on it and start
// a game (or arm "replace it?") before anyone saw the settings. It ignores
// taps for a moment after the screen opens, like the game's main buttons.
const SETTLE_MS = 450;
let readyAt = 0; // a click whose timeStamp is before this is swallowed

const settings = () => ({
  teams: teams.slice(),
  rounds: roundsStepper.value,
  rival: teams.length > 1 && $('local-rival').checked,
});

const start = () => startHandler?.(settings());

// --- team list -----------------------------------------------------------------

const identity = (t) => `${t.adjective}|${t.critter}`;

function fillRow(li, team, i) {
  li.dataset.key = identity(team);
  li.style.setProperty('--team', team.color);
  li.innerHTML =
    `<span class="local-team-row">${teamBadgeHtml(team, { size: 44 })}` +
    `<span class="local-team-name">${escapeHtml(team.name)}</span>` +
    `<button class="btn icon ghost local-reroll" type="button" data-reroll="${i}" aria-label="New name for ${escapeHtml(team.name)}">${DIE_SVG}</button></span>`;
}

// Grow a new row open from nothing, its badge springing in.
function enterRow(li) {
  if (reducedMotion() || !li.animate) return;
  const h = li.offsetHeight;
  li.classList.add('is-moving');
  const a = li.animate(
    [
      { height: '0px', opacity: 0 },
      { height: `${h}px`, opacity: 1 },
    ],
    { duration: 260, easing: 'cubic-bezier(.2,.8,.25,1)' },
  );
  const row = li.firstElementChild;
  row?.animate(
    [
      { transform: 'translateY(-10px) scale(.92)', opacity: 0 },
      { transform: 'translateY(0) scale(1.02)', opacity: 1, offset: 0.7 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 380, easing: 'cubic-bezier(.2,.9,.3,1.2)' },
  );
  popIn(li.querySelector('.team-badge'));
  a.finished.catch(() => {}).finally(() => li.classList.remove('is-moving'));
}

// Fold a row away, then drop it.
function leaveRow(li) {
  li.classList.add('leaving');
  li.querySelector('button')?.setAttribute('disabled', '');
  if (reducedMotion() || !li.animate) {
    li.remove();
    return;
  }
  li.classList.add('is-moving');
  const a = li.animate(
    [
      { height: `${li.offsetHeight}px`, opacity: 1, transform: 'none' },
      { height: '0px', opacity: 0, transform: 'scale(.94)' },
    ],
    { duration: 220, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' },
  );
  a.finished.catch(() => {}).finally(() => li.remove());
}

function renderList(animate) {
  const list = $('local-team-list');
  const rows = [...list.children].filter((li) => !li.classList.contains('leaving'));
  teams.forEach((team, i) => {
    let li = rows[i];
    if (!li) {
      li = document.createElement('li');
      li.className = 'local-team';
      fillRow(li, team, i);
      list.appendChild(li);
      if (animate) enterRow(li);
    } else if (li.dataset.key !== identity(team)) {
      fillRow(li, team, i);
    }
  });
  for (const li of rows.slice(teams.length)) {
    if (animate) leaveRow(li);
    else li.remove();
  }
}

function reroll(i) {
  if (!teams[i]) return;
  teams = rerollTeam(teams, i);
  const li = $('local-team-list').querySelectorAll('.local-team:not(.leaving)')[i];
  if (!li) return renderList(false);
  const team = teams[i];
  li.dataset.key = identity(team);
  const badge = li.querySelector('.team-badge');
  badge.outerHTML = teamBadgeHtml(team, { size: 44 });
  const name = li.querySelector('.local-team-name');
  name.textContent = team.name;
  const btn = li.querySelector('.local-reroll');
  btn.setAttribute('aria-label', `New name for ${team.name}`);
  btn.classList.remove('rolling');
  void btn.offsetWidth; // restart the tumble on a quick second roll
  btn.classList.add('rolling');
  popIn(li.querySelector('.team-badge'));
  if (!reducedMotion() && name.animate) {
    name.animate(
      [
        { transform: 'translateY(8px)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.25,1)' },
    );
  }
}

// --- co-op vs rival ---------------------------------------------------------------

function syncMode(animate = false) {
  const coop = teams.length === 1;
  const rival = $('local-rival-row');
  const note = $('local-coop');
  const wasCoop = !note.classList.contains('hidden');
  $('local-coop-max').textContent = String(roundsStepper.value * MAX_POINTS);
  rival.classList.toggle('hidden', coop);
  note.classList.toggle('hidden', !coop);
  if (animate && wasCoop !== coop) popIn(coop ? note : rival);
}

function setTeamCount(n) {
  teams = resizeTeams(teams, n);
  renderList(true);
  syncMode(true);
}

// Start, or — over a game still in progress — "tap twice to replace it".
// The armed label stays short so it fits the big button on a 320px phone.
function bindStart(hasSaved) {
  const btn = $('local-start');
  unarm?.();
  unarm = null;
  btn.removeEventListener('click', start);
  if (hasSaved) unarm = armConfirm(btn, 'Replace game?', start);
  else btn.addEventListener('click', start);
}

// --- public -----------------------------------------------------------------------

export function initSetup({ onStart, onBack }) {
  startHandler = onStart;
  teamsStepper = bindStepper($('local-teams-stepper'), {
    min: MIN_TEAMS,
    max: MAX_TEAMS,
    value: DEFAULT_TEAMS,
    onChange: setTeamCount,
  });
  roundsStepper = bindStepper($('local-rounds-stepper'), {
    min: MIN_ROUNDS,
    max: MAX_ROUNDS,
    value: DEFAULT_ROUNDS,
    onChange: () => syncMode(),
  });
  $('local-team-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-reroll]');
    if (b && !b.disabled) reroll(Number(b.dataset.reroll));
  });
  $('local-setup-back').addEventListener('click', onBack);
  // Registered before any Start listener and in the capture phase, so it
  // stops both a plain start and armConfirm's first (arming) tap. The event's
  // own timeStamp counts, so a tap queued behind a busy frame is judged by
  // when it really happened (falling back to now if a browser leaves it 0).
  $('local-start').addEventListener(
    'click',
    (e) => {
      if ((e.timeStamp || performance.now()) < readyAt) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}

// Fill the screen afresh each time it opens. `defaults` are the counts to
// start from (the last game's, if any); `hasSaved` arms the replace-confirm.
export function openSetup({ defaults = {}, hasSaved = false } = {}) {
  const n = Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, defaults.teams ?? DEFAULT_TEAMS));
  teams = makeTeams(n);
  teamsStepper.set(n, { silent: true });
  roundsStepper.set(defaults.rounds ?? DEFAULT_ROUNDS, { silent: true });
  $('local-rival').checked = !!defaults.rival;
  $('local-team-list').innerHTML = '';
  renderList(false);
  syncMode();
  bindStart(hasSaved);
  readyAt = performance.now() + SETTLE_MS;
}
