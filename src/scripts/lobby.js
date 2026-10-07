// Online front door: the sign-in overlay, the lobby screen (who is online,
// your stats, recent games) and the challenge cards that pop up wherever the
// player is. Room-side effects (creating the room for an accepted challenge,
// entering a room) are delegated to online-game.js through `hooks` — the same
// split as the reference project's lobby.js / game.js, and the same
// challenge protocol: the challenger writes a pending challenge, exactly one
// answer (accept / decline / cancel / expire) wins a transaction, and the
// acceptor builds the room and hands its id back on the challenge.

import { AuthError, currentUser, login, logout, normalizeName, onAuthChange, restoreSession } from './auth.js';
import { startPresence, stopPresence, watchOnlinePlayers } from './presence.js';
import {
  CHALLENGE_TTL_MS, isChallengeFresh, removeChallenge, sendChallenge, serverNow, setChallengeStatus,
  updateChallenge, watchChallenge, watchIncoming,
} from './challenges.js';
import { normalizeTotals, watchRecentMatches, watchStats } from './stats.js';
import { DEFAULT_ROUNDS, MAX_ROUNDS, MIN_ROUNDS, clampRounds } from './room-logic.js';
import { MAX_POINTS } from './scoring.js';
import { $, bindStepper, closeOverlay, escapeHtml, isOverlayOpen, openOverlay, toast } from './ui.js';
import { showScreen } from './router.js';
import { countUp, popIn, reducedMotion, shake, sleep, stopCount } from './fx.js';
import { avatarHtml } from './online-avatar.js';
import { currentDeck, onSpicyChange } from './spicy.js';
import { chiliSvg } from './chili.js';

// How long the challenger waits for the room id after the challenge was
// claimed (the acceptor is writing the room).
const ROOM_WAIT_MS = 30_000;
// Signing out gives a pending challenge this long to be withdrawn, but never
// waits on an unreachable database.
const SIGNOUT_WAIT_MS = 1500;
const ROUNDS_KEY = 'wavelength.rounds';
const LAST_NAME_KEY = 'wavelength.lastName';

let hooks = {};
let els = {};

let players = []; // other online players, from presence
let stats = { totals: normalizeTotals(null), partners: [] };
let recent = [];
let incoming = []; // fresh pending challenges addressed to me
let outgoing = null; // { id, to, toName, rounds, spicy, unsub, timer, roomTimer, expiresAt }
let sending = null; // { to, aborted } while a challenge is on its way out (holds the slot)
let userUnsubs = [];
let pruneTimer = null;
let afterLogin = null; // run once a sign-in prompted for a purpose succeeds
let loginBusy = false;
let loginAttempt = 0; // bumped per sign-in, and when one is abandoned (overlay closed)
let loginClosingOk = false;
let roundsStepper = null;
let shownStats = null; // what the stat tiles show, for count-ups
let shownPlayers = new Set(); // rows already on screen (new ones pop in)

// --- public API --------------------------------------------------------------

// hooks: { acceptChallenge(ch) → Promise<roomId>, enterRoom(id), roomHref(id),
//          onSignedIn(user), onSigningOut(), onLoginDismissed(),
//          onOutgoingChange(o | null), onIncomingChange(list) }
// Resolves once a saved session has been checked (user or null).
export async function initLobby(h) {
  hooks = h || {};
  els = {
    btnOnline: $('btn-online'),
    dot: $('online-dot'),
    label: $('online-label'),
    name: $('online-name'),
    loginOverlay: $('login-overlay'),
    loginAvatar: $('login-avatar'),
    loginSub: $('login-sub'),
    loginForm: $('login-form'),
    loginName: $('login-name'),
    loginNameField: $('login-name-field'),
    loginPassword: $('login-password'),
    loginPasswordField: $('login-password-field'),
    loginError: $('login-error'),
    btnLogin: $('btn-login'),
    lobbyAvatar: $('lobby-avatar'),
    lobbyTitle: $('lobby-title'),
    signout: $('lobby-signout'),
    statGames: $('lobby-stat-games'),
    statBest: $('lobby-stat-best'),
    statAvg: $('lobby-stat-avg'),
    statBulls: $('lobby-stat-bulls'),
    count: $('lobby-count'),
    rounds: $('lobby-rounds'),
    spicy: $('lobby-spicy'),
    playerList: $('lobby-players'),
    playersEmpty: $('lobby-players-empty'),
    recentList: $('lobby-recent'),
    recentEmpty: $('lobby-recent-empty'),
    stack: $('challenge-stack'),
  };
  bind();
  onAuthChange(onUserChange);
  // online.js may already show the saved name, dimmed (.is-pending), while the
  // session is checked: leave it up until the check is done rather than flash
  // "Sign in" in between.
  if (!els.dot.classList.contains('is-pending')) renderTopbar();
  const user = await restoreSession();
  renderTopbar(); // the real name, or "Sign in" (a stale key, a failed read)
  return user;
}

// Show the lobby — after a sign-in when signed out.
export function openLobby({ direction = 'forward' } = {}) {
  if (!currentUser()) {
    requireLogin(() => openLobby({ direction }), 'lobby');
    return;
  }
  renderLobby();
  showScreen('lobby', { direction });
  animateStats(true);
}

// Ask for a sign-in and run `then(user)` afterwards (used when a ?session link
// is opened while signed out). hint: 'join' | 'lobby'.
export function requireLogin(then, hint = 'lobby') {
  const user = currentUser();
  if (user) {
    then(user);
    return;
  }
  afterLogin = then;
  openLogin(hint);
}

export function closeLogin() {
  if (isOverlayOpen(els.loginOverlay)) closeOverlay(els.loginOverlay);
}

export const hasOutgoingChallenge = () => outgoing !== null || sending !== null;
export const outgoingTo = () => (outgoing ? outgoing.to : null);
export const incomingFrom = (uname) => incoming.find((c) => c.from === uname) || null;

// Send a challenge to `player` ({ uname, name }) for `rounds` rounds (the
// lobby stepper's value by default), with spicy cards when spicy mode is on
// right now (and there are spicy cards). Used by the lobby rows and the
// game-over Rematch button. Resolves true when a challenge is out (or theirs
// accepted — on their terms, deck included).
export async function challengePlayer(player, rounds = roundsStepper ? roundsStepper.value : DEFAULT_ROUNDS) {
  const me = currentUser();
  if (!me || !player || player.uname === me.uname) return false;
  // They challenged us (both hit "Rematch", or "Challenge" at once — or we
  // are waiting on someone else): accept theirs instead of crossing it with a
  // second challenge. acceptIncoming takes back whatever we have out.
  const crossing = incoming.find((c) => c.from === player.uname);
  if (crossing) {
    await acceptIncoming(crossing);
    return true;
  }
  if (outgoing || sending) return false;
  const n = clampRounds(rounds);
  const spicy = currentDeck() === 'spicy';
  // Hold the slot while the challenge is written, so a second tap (on this
  // row or another) cannot send a second one.
  const s = { to: player.uname, aborted: false };
  sending = s;
  renderPlayers();
  let id;
  try {
    id = await sendChallenge({ from: me, to: player, rounds: n, spicy });
  } catch (err) {
    console.error(err);
    toast("Couldn't send the challenge");
    return false;
  } finally {
    if (sending === s) sending = null;
  }
  // Signed out, or we accepted someone else's challenge meanwhile: take this
  // one back before anyone answers it.
  if (s.aborted || currentUser() !== me || outgoing) {
    withdrawChallenge(player.uname, id);
    return false;
  }
  const o = {
    id, to: player.uname, toName: player.name, rounds: n, spicy,
    unsub: null, timer: null, roomTimer: null, expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };
  outgoing = o;
  o.timer = setTimeout(() => {
    if (outgoing === o) setChallengeStatus(player.uname, id, 'expired').catch(() => {});
  }, CHALLENGE_TTL_MS);
  const finish = (msg) => {
    if (outgoing !== o) return;
    clearOutgoing();
    removeChallenge(player.uname, id);
    renderPlayers();
    if (msg) toast(msg);
  };
  o.unsub = watchChallenge(player.uname, id, (ch) => {
    if (outgoing !== o) return;
    if (!ch) {
      // Removed under us (e.g. the recipient's litter sweep).
      clearOutgoing();
      renderPlayers();
      return;
    }
    switch (ch.status) {
      case 'pending':
        return;
      case 'accepted':
        if (ch.roomId) {
          finish(null);
          hooks.enterRoom?.(ch.roomId);
        } else if (!o.roomTimer) {
          // Claimed; the acceptor is writing the room. Stop the expiry clock
          // and give them a while to finish.
          clearTimeout(o.timer);
          o.roomTimer = setTimeout(() => finish("Couldn't start the game"), ROOM_WAIT_MS);
        }
        return;
      case 'declined':
        finish(`${player.name} said not now`);
        return;
      case 'expired':
        finish(`${player.name} didn't answer`);
        return;
      case 'failed':
        finish("Couldn't start the game");
        return;
      default:
        finish(null);
    }
  });
  toast(`${spicy ? 'Spicy challenge' : 'Challenge'} sent to ${player.name}`);
  notifyOutgoing();
  renderPlayers();
  return true;
}

// Withdraw our pending challenge. Resolves true when nothing is left
// outstanding; false when the other side got in first (they accepted, and
// the watcher is taking us to their room).
export async function cancelOutgoing() {
  if (!outgoing) return true;
  const o = outgoing;
  let res;
  try {
    res = await setChallengeStatus(o.to, o.id, 'cancelled');
  } catch (err) {
    console.error(err);
    res = { ok: false, current: null };
  }
  if (outgoing !== o) return res.ok || !(res.current && res.current.status === 'accepted');
  if (res.ok || !res.current || res.current.status !== 'accepted') {
    clearOutgoing();
    removeChallenge(o.to, o.id);
    renderPlayers();
    return true;
  }
  return false;
}

// Take back a challenge nobody follows for us any more (one that landed after
// its slot was given up, or ours once we took theirs instead). Through the
// status transaction rather than a plain remove: a recipient who claimed it
// in that instant keeps their claim and the node they write the room id to.
function withdrawChallenge(to, id) {
  setChallengeStatus(to, id, 'cancelled')
    .then((res) => {
      if (res.ok || res.current?.status !== 'accepted') removeChallenge(to, id);
    })
    .catch(() => removeChallenge(to, id));
}

// --- sign in / out ---------------------------------------------------------------

function onUserChange(user) {
  stopUserWatchers();
  renderTopbar();
  shownStats = null;
  shownPlayers = new Set();
  if (user) {
    startPresence(user);
    userUnsubs.push(watchOnlinePlayers((list) => {
      players = list;
      renderPlayers();
    }));
    userUnsubs.push(watchIncoming(user.uname, (list) => {
      incoming = list;
      renderChallengeCards();
      renderPlayers();
      hooks.onIncomingChange?.(incoming);
    }));
    userUnsubs.push(watchStats(user.uname, (s) => {
      stats = s;
      renderStats();
    }));
    userUnsubs.push(watchRecentMatches(user.uname, (list) => {
      recent = list;
      renderRecent();
    }));
    // A challenger who closed their tab never marks their challenge expired;
    // re-check ages every few seconds so stale cards disappear anyway.
    pruneTimer = setInterval(() => {
      const fresh = incoming.filter(isChallengeFresh);
      if (fresh.length !== incoming.length) {
        incoming = fresh;
        renderChallengeCards();
        renderPlayers();
        hooks.onIncomingChange?.(incoming);
      }
    }, 3000);
    renderLobby();
    // A saved sign-in that finished late (slow network) while the sign-in
    // overlay was already up for it: the overlay has nothing left to ask.
    if (isOverlayOpen(els.loginOverlay) && !loginBusy) {
      const then = afterLogin;
      afterLogin = null;
      loginClosingOk = true;
      closeOverlay(els.loginOverlay);
      loginClosingOk = false;
      if (then) then(user);
    }
    hooks.onSignedIn?.(user);
  } else {
    players = [];
    incoming = [];
    stats = { totals: normalizeTotals(null), partners: [] };
    recent = [];
    renderChallengeCards();
    renderLobby();
    hooks.onIncomingChange?.(incoming);
  }
}

function stopUserWatchers() {
  for (const u of userUnsubs) u();
  userUnsubs = [];
  clearInterval(pruneTimer);
  pruneTimer = null;
  if (sending) {
    sending.aborted = true; // challengePlayer takes it back once it lands
    sending = null;
  }
  clearOutgoing();
}

function clearOutgoing() {
  if (!outgoing) return;
  if (outgoing.unsub) outgoing.unsub();
  clearTimeout(outgoing.timer);
  clearTimeout(outgoing.roomTimer);
  outgoing = null;
  notifyOutgoing();
}

function notifyOutgoing() {
  hooks.onOutgoingChange?.(outgoing ? { to: outgoing.to, toName: outgoing.toName } : null);
}

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function openLogin(hint) {
  els.loginSub.textContent = hint === 'join'
    ? 'Sign in to take your seat — or close this to watch.'
    : 'A new name creates an account.';
  setLoginError(null);
  if (!els.loginName.value) els.loginName.value = readStored(LAST_NAME_KEY) || '';
  els.loginPassword.value = '';
  renderLoginAvatar();
  openOverlay(els.loginOverlay);
  // A remembered name: straight to the password.
  if (els.loginName.value) els.loginPassword.focus({ preventScroll: true });
}

function renderLoginAvatar() {
  const parsed = normalizeName(els.loginName.value);
  const key = parsed ? parsed.uname : '';
  if (els.loginAvatar.dataset.key === key) return;
  els.loginAvatar.dataset.key = key;
  els.loginAvatar.classList.toggle('is-empty', !parsed);
  els.loginAvatar.innerHTML = avatarHtml(key || '?', 72);
  if (parsed) popIn(els.loginAvatar.firstElementChild);
}

function setLoginError(code) {
  const text = code ? loginErrorText(code) : '';
  els.loginError.textContent = text;
  els.loginNameField.classList.toggle('invalid', code === 'name');
  els.loginPasswordField.classList.toggle('invalid', code === 'password' || code === 'wrong');
}

function loginErrorText(code) {
  switch (code) {
    case 'name':
      return 'Names are 2–20 letters, numbers, _ or -';
    case 'password':
      return 'Pick a password';
    case 'wrong':
      return "That password doesn't match this name";
    case 'crypto':
      return "This browser can't sign in here";
    default:
      return "Can't reach the server — try again";
  }
}

function setLoginBusy(busy) {
  loginBusy = busy;
  els.btnLogin.disabled = busy;
  els.btnLogin.classList.toggle('is-busy', busy);
  els.loginName.readOnly = busy;
  els.loginPassword.readOnly = busy;
  els.loginOverlay.toggleAttribute('data-sticky', busy);
}

async function submitLogin(e) {
  e.preventDefault();
  if (loginBusy) return;
  const name = els.loginName.value;
  const password = els.loginPassword.value;
  const local = !normalizeName(name) ? 'name' : !password ? 'password' : null;
  if (local) {
    setLoginError(local);
    shake(els.loginForm);
    (local === 'name' ? els.loginName : els.loginPassword).focus();
    return;
  }
  setLoginError(null);
  setLoginBusy(true);
  const attempt = ++loginAttempt;
  try {
    const user = await login(name, password);
    // Abandoned meanwhile: it still signs in (top bar, presence), but quietly
    // — no toast, and nobody is pulled out of whatever they went on to do.
    if (attempt !== loginAttempt) return;
    writeStored(LAST_NAME_KEY, user.name);
    els.loginPassword.value = '';
    setLoginBusy(false);
    loginClosingOk = true;
    closeOverlay(els.loginOverlay);
    loginClosingOk = false;
    toast(`Hi ${user.name}!`);
    const then = afterLogin;
    afterLogin = null;
    if (then) then(user);
    else openLobby();
  } catch (err) {
    if (!(err instanceof AuthError)) console.error(err); // a wrong password is not a bug
    if (attempt !== loginAttempt) return;
    setLoginBusy(false);
    const code = err instanceof AuthError ? err.code : 'network';
    setLoginError(code);
    shake(els.loginForm);
    (code === 'name' ? els.loginName : els.loginPassword).focus();
  }
}

// Signing out is local: it never waits on the network (writes made while the
// database is out of reach only resolve once it is back). A pending challenge
// gets a moment to be withdrawn; if that cannot land, logout() still stops
// following it and the recipient's card runs out on its own. Presence is
// stopped without waiting too — its listener is dropped straight away, and
// the server's onDisconnect removal covers an entry the cleanup cannot reach.
async function signOut() {
  els.signout.disabled = true;
  try {
    await Promise.race([cancelOutgoing().catch(() => true), sleep(SIGNOUT_WAIT_MS)]);
    hooks.onSigningOut?.();
    stopPresence();
    logout();
    toast('Signed out');
    showScreen('home', { direction: 'back' });
  } finally {
    els.signout.disabled = false;
  }
}

// --- rendering -------------------------------------------------------------------

function renderTopbar() {
  const user = currentUser();
  els.dot.classList.toggle('hidden', !user);
  els.dot.classList.remove('is-pending');
  els.label.classList.toggle('hidden', !!user);
  els.name.classList.toggle('hidden', !user);
  els.name.textContent = user ? user.name : '';
  els.btnOnline.classList.toggle('signed-in', !!user);
  els.btnOnline.setAttribute('aria-label', user ? `Online lobby (signed in as ${user.name})` : 'Sign in to play online');
}

function renderLobby() {
  const user = currentUser();
  els.lobbyTitle.textContent = user ? user.name : 'Lobby';
  els.lobbyTitle.title = user ? user.name : ''; // a long name is cut short on a phone
  els.lobbyAvatar.innerHTML = user ? avatarHtml(user.uname, 56) : '';
  renderPlayers();
  renderStats();
  renderRecent();
}

function renderPlayers() {
  if (!els.playerList) return;
  const me = currentUser();
  els.count.textContent = players.length ? String(players.length) : '';
  els.playersEmpty.classList.toggle('hidden', players.length > 0);

  // Rebuilding the list must not throw keyboard focus away.
  const focused = document.activeElement?.closest?.('#lobby-players [data-uname]');
  const refocus = focused ? { uname: focused.dataset.uname, action: document.activeElement.dataset.action } : null;

  const seen = new Set();
  els.playerList.innerHTML = players.map((p) => {
    seen.add(p.uname);
    const waiting = outgoing && outgoing.to === p.uname;
    const theirs = incoming.find((c) => c.from === p.uname);
    const inGame = !!p.room;
    const uname = escapeHtml(p.uname);
    let status;
    let action;
    if (waiting) {
      const left = Math.max(0, outgoing.expiresAt - Date.now());
      status = `<small class="lp-status is-waiting">Waiting…<span class="lp-timer" style="--ttl:${left}ms"></span></small>`;
      action = `<button class="btn ghost small" type="button" data-action="cancel" data-uname="${uname}">Cancel</button>`;
    } else if (theirs) {
      const chili = theirs.spicy ? `<span class="lp-spicy" title="Spicy cards">${chiliSvg('chili is-lit')}<span class="sr-only">, spicy</span></span>` : '';
      status = `<small class="lp-status is-incoming">Challenged you!${chili}</small>`;
      action = `<button class="btn primary small" type="button" data-action="challenge" data-uname="${uname}">Play</button>`;
    } else {
      status = `<small class="lp-status${inGame ? ' is-busy' : ''}">${inGame ? 'In a game' : 'Ready'}</small>`;
      const off = inGame || !!outgoing || !!sending || !me;
      const busy = sending && sending.to === p.uname ? ' is-busy' : '';
      action = `<button class="btn primary small${busy}" type="button" data-action="challenge" data-uname="${uname}"${off ? ' disabled' : ''}>Challenge</button>`;
    }
    return `<li class="lobby-player${waiting ? ' is-waiting' : ''}${inGame ? ' in-game' : ''}" data-uname="${uname}">` +
      `<span class="lp-avatar">${avatarHtml(p.uname, 42)}<span class="lp-dot" aria-hidden="true"></span></span>` +
      `<span class="lp-text"><b class="lp-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</b>${status}</span>` +
      action + '</li>';
  }).join('');

  for (const li of els.playerList.children) {
    if (!shownPlayers.has(li.dataset.uname)) popIn(li);
  }
  shownPlayers = seen;
  if (refocus) {
    const sel = `[data-uname="${CSS.escape(refocus.uname)}"]`;
    const btn = els.playerList.querySelector(`button${sel}`) || els.playerList.querySelector(`li${sel} button`);
    btn?.focus({ preventScroll: true });
  }
}

// The chili chip by the rounds stepper: while spicy mode is on (with spicy
// cards to deal), every challenge sent from here is a spicy one.
function renderSpicy({ animate = false } = {}) {
  if (!els.spicy) return;
  const on = currentDeck() === 'spicy';
  els.spicy.classList.toggle('hidden', !on);
  if (on && animate && document.body.dataset.screen === 'lobby') popIn(els.spicy);
}

const fmtAvg = (t) => (t.rounds > 0 ? (t.points / t.rounds).toFixed(1) : '–');

function renderStats() {
  if (!els.statGames) return;
  const t = stats.totals;
  const next = { games: t.games, best: t.completed > 0 ? t.best : null, avg: fmtAvg(t), bulls: t.bullseyes };
  const prev = shownStats;
  shownStats = next;
  const lobbyVisible = document.body.dataset.screen === 'lobby';
  const tick = (el, from, to) => {
    stopCount(el); // a roll still running must not overwrite the new number
    if (to === null) {
      el.textContent = '–';
      return;
    }
    if (lobbyVisible && prev && typeof from === 'number' && from !== to) countUp(el, from, to, { duration: 700 });
    else el.textContent = String(to);
  };
  tick(els.statGames, prev?.games, next.games);
  tick(els.statBest, prev?.best, next.best);
  tick(els.statBulls, prev?.bulls, next.bulls);
  els.statAvg.textContent = next.avg;
}

// On arriving in the lobby the numbers roll up from zero.
function animateStats(fromZero) {
  if (!shownStats || !fromZero || reducedMotion()) return;
  const roll = (el, v) => {
    if (typeof v === 'number' && v > 0) countUp(el, 0, v, { duration: 800 });
  };
  roll(els.statGames, shownStats.games);
  roll(els.statBest, shownStats.best);
  roll(els.statBulls, shownStats.bulls);
}

function formatWhen(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const today = new Date();
    const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function renderRecent() {
  if (!els.recentList) return;
  els.recentEmpty.classList.toggle('hidden', recent.length > 0);
  els.recentList.innerHTML = recent.map((m) => {
    const max = m.rounds * MAX_POINTS;
    const href = escapeHtml(hooks.roomHref ? hooks.roomHref(m.roomId) : `?session=${m.roomId}`);
    let tail;
    if (m.result === 'complete') {
      tail = `<span class="lg-score"><b>${m.score}</b><small>/${max}</small></span>`;
    } else if (m.result === 'abandoned') {
      tail = `<span class="lg-score is-left"><b>${m.score}</b><small>/${max}</small></span><span class="lg-tag">Ended</span>`;
    } else {
      tail = '<span class="lg-tag is-live">Resume</span>';
    }
    // The round count first, so a narrow row cuts the date, not the count.
    const meta = [`${m.rounds} rounds`, formatWhen(m.startedAt)].filter(Boolean).join(' · ');
    return `<li><a class="lobby-game" href="${href}" data-room="${escapeHtml(m.roomId)}">` +
      `<span class="lg-avatar">${avatarHtml(m.partner, 36)}</span>` +
      `<span class="lg-text"><b>${escapeHtml(m.partnerName)}</b><small>${escapeHtml(meta)}</small></span>` +
      tail +
      '<svg class="lg-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>' +
      '</a></li>';
  }).join('');
}

function removeCard(el) {
  if (el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  if (reducedMotion()) el.remove();
  else setTimeout(() => el.remove(), 230);
}

function renderChallengeCards() {
  const stack = els.stack;
  if (!stack) return;
  const live = [...stack.children].filter((el) => !el.classList.contains('leaving'));
  const wanted = new Set(incoming.map((ch) => ch.id));
  for (const el of live) if (!wanted.has(el.dataset.id)) removeCard(el);
  const shown = new Set(live.map((el) => el.dataset.id));
  for (const ch of incoming) {
    if (shown.has(ch.id)) continue;
    const name = ch.fromName || ch.from;
    const left = typeof ch.createdAt === 'number'
      ? Math.max(0, CHALLENGE_TTL_MS - (serverNow() - ch.createdAt))
      : CHALLENGE_TTL_MS;
    const card = document.createElement('div');
    card.className = 'challenge-card';
    card.dataset.id = ch.id;
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', `${name} challenges you to ${ch.rounds} rounds${ch.spicy ? ', with spicy cards' : ''}`);
    // A spicy challenge says so before anyone accepts: the room keeps its deck.
    const spicy = ch.spicy ? `<span class="spicy-chip cc-spicy">${chiliSvg('chili is-lit')}Spicy</span>` : '';
    card.innerHTML =
      `<span class="cc-avatar">${avatarHtml(ch.from, 46)}</span>` +
      `<span class="cc-text"><b>${escapeHtml(name)}</b><small><span>wants to play · ${ch.rounds} rounds</span>${spicy}</small></span>` +
      '<span class="cc-actions">' +
      '<button class="btn icon ghost small" type="button" data-action="decline" aria-label="Decline">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>' +
      '<button class="btn primary small" type="button" data-action="accept">Play</button>' +
      '</span>' +
      `<span class="cc-timer" style="--ttl:${left}ms" aria-hidden="true"></span>`;
    stack.appendChild(card);
  }
}

// --- challenge answers -----------------------------------------------------------

function dropCard(id) {
  incoming = incoming.filter((c) => c.id !== id);
  renderChallengeCards();
  renderPlayers();
  hooks.onIncomingChange?.(incoming);
}

const cardFor = (id) => [...els.stack.children].find((el) => el.dataset.id === id && !el.classList.contains('leaving'));

async function acceptIncoming(ch) {
  const me = currentUser();
  if (!me) return;
  const name = ch.fromName || ch.from;
  if (!isChallengeFresh(ch)) {
    dropCard(ch.id);
    toast(`${name}'s challenge ran out`);
    return;
  }
  const card = cardFor(ch.id);
  if (card) {
    if (card.classList.contains('is-busy')) return;
    card.classList.add('is-busy');
    for (const b of card.querySelectorAll('button')) b.disabled = true;
  }
  if (sending) sending.aborted = true; // a challenge still being written is taken back once it lands

  // Crossed challenges (we each challenged the other): if both of us accept
  // at the same moment and each withdraws their own challenge before
  // claiming the other's, both claims fail. So the side whose name sorts
  // later claims first and withdraws after, the other the usual way round —
  // exactly one claim wins, and the loser's challenge is the one taken.
  const mine = outgoing;
  const claimFirst = !!mine && mine.to === ch.from && me.uname > ch.from;

  // Our own challenge to someone may have been accepted meanwhile — then we
  // are on our way to that room and this one is declined instead.
  if (!claimFirst && !(await cancelOutgoing())) {
    dropCard(ch.id);
    setChallengeStatus(me.uname, ch.id, 'declined').catch(() => {});
    return;
  }

  // Claim first (only one answer can win), then build the room, then tell
  // the challenger where it is.
  let claim;
  try {
    claim = await setChallengeStatus(me.uname, ch.id, 'accepted');
  } catch (err) {
    console.error(err);
    claim = { ok: false };
  }
  if (!claim.ok) {
    dropCard(ch.id);
    // Crossed: they withdrew theirs, most likely to take ours — our watcher
    // follows them into the room (or ours is simply still out, as shown).
    if (!claimFirst) toast('That challenge is gone');
    return;
  }
  dropCard(ch.id);
  if (claimFirst && outgoing === mine) {
    // Ours is moot now: stop following it and take it back.
    clearOutgoing();
    renderPlayers();
    withdrawChallenge(mine.to, mine.id);
  }
  try {
    const roomId = await hooks.acceptChallenge(ch);
    await updateChallenge(me.uname, ch.id, { roomId });
    hooks.enterRoom?.(roomId);
  } catch (err) {
    console.error(err);
    updateChallenge(me.uname, ch.id, { status: 'failed' }).catch(() => {});
    toast("Couldn't start the game");
  }
}

function declineIncoming(ch) {
  const me = currentUser();
  dropCard(ch.id);
  if (me) setChallengeStatus(me.uname, ch.id, 'declined').catch(() => {});
}

// --- wiring ------------------------------------------------------------------------

function bind() {
  els.loginForm.addEventListener('submit', submitLogin);
  els.loginName.addEventListener('input', () => {
    renderLoginAvatar();
    if (els.loginNameField.classList.contains('invalid')) setLoginError(null);
  });
  els.loginPassword.addEventListener('input', () => {
    if (els.loginPasswordField.classList.contains('invalid')) setLoginError(null);
  });
  // Closed without signing in (✕, Escape, backdrop): a sign-in that was asked
  // for a purpose (joining a room) falls back to whatever the caller wants.
  // One still under way is abandoned, so the form is usable when reopened.
  els.loginOverlay.addEventListener('overlay:close', () => {
    if (loginClosingOk) return;
    if (loginBusy) {
      loginAttempt++;
      setLoginBusy(false);
    }
    const purposeful = afterLogin !== null;
    afterLogin = null;
    if (purposeful) hooks.onLoginDismissed?.();
  });

  els.signout.addEventListener('click', signOut);

  const stored = Number(readStored(ROUNDS_KEY));
  roundsStepper = bindStepper(els.rounds, {
    min: MIN_ROUNDS,
    max: MAX_ROUNDS,
    value: Number.isFinite(stored) && stored ? clampRounds(stored) : DEFAULT_ROUNDS,
    onChange: (v) => writeStored(ROUNDS_KEY, String(v)),
  });
  renderSpicy();
  onSpicyChange(() => renderSpicy({ animate: true }));

  els.playerList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const player = players.find((p) => p.uname === btn.dataset.uname);
    if (btn.dataset.action === 'challenge' && player) {
      btn.disabled = true;
      challengePlayer(player).finally(() => renderPlayers());
    } else if (btn.dataset.action === 'cancel') {
      btn.disabled = true;
      cancelOutgoing().finally(() => renderPlayers());
    }
  });

  els.recentList.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-room]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    hooks.enterRoom?.(a.dataset.room);
  });

  els.stack.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    const card = e.target.closest('.challenge-card');
    if (!btn || !card) return;
    const ch = incoming.find((c) => c.id === card.dataset.id);
    if (!ch) return;
    if (btn.dataset.action === 'accept') acceptIncoming(ch);
    else declineIncoming(ch);
  });
}
