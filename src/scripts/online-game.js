// Online mode, back half: the room controller and the online game screen.
// Loaded on demand by online.js (it pulls in Firebase), it wires lobby.js to
// rooms: creating the room for an accepted challenge, entering one (from a
// challenge, the recent-games list, a ?session link or the back button), and
// playing it.
//
// Everything about a room arrives through its listener (rooms.js watchRoom);
// a tap only ever asks for a move (a transaction) and waits for the room to
// change. Snapshots are applied one at a time, in order, each fully animated
// before the next is looked at, so both players — and any spectator — see the
// same story: card flip, the psychic's target spin, the clue popping in, the
// reveal and the points flying to the duo score. A first snapshot (a reload,
// a link, a reconnect) is drawn in place with nothing replayed.
//
// The live channel (live/<id>) carries the ephemeral bits: the
// guesser's needle, streamed ~10×/s so it glides on the other screens, and
// the psychic's typing dots. Values stamped with an older room `step` are
// ignored, so nothing from a previous phase or round ever leaks through.
//
// `gen` grows on every room change; async work that finds it moved on drops
// its result (the reference project's pattern).

import { Dial } from './dial.js';
import { $, armConfirm, escapeHtml, hideToast, toast } from './ui.js';
import { currentScreen, onScreenChange, showScreen } from './router.js';
import { confettiFrom, countUp, flyPoints, popIn, pulse, reducedMotion, shake, sleep, stopCount } from './fx.js';
import { currentUser } from './auth.js';
import { setPresenceRoom, watchPlayer } from './presence.js';
import {
  armLiveCleanup, createRoom, isValidRoomId, leaveRoom as leaveRoomMove, lockGuess, newRoomId, nextRound,
  redrawCard, setLive, submitClue, watchLive, watchRoom,
} from './rooms.js';
import { CLUE_MAX, EMPTY_LIVE, cleanClue, guesserOf, isFinished, maxScore, psychicOf, seatOf } from './room-logic.js';
import { finalizeOnlineMatch, onlineStartEntries } from './stats.js';
import { MAX_POINTS, RESULT_WORDS, rateScore } from './scoring.js';
import {
  challengePlayer, hasOutgoingChallenge, incomingFrom, initLobby, openLobby, outgoingTo, requireLogin,
} from './lobby.js';
import { avatarColor, avatarHtml } from './online-avatar.js';

const NEEDLE_EVERY_MS = 100; // live needle throttle (~10 writes a second)
const TYPING_IDLE_MS = 2500; // typing dots stop this long after the last key
const FINALIZE_RETRY_MS = 31_000; // just past stats.js's claim TTL
const SESSION_WAIT_MS = 8000; // a ?session link waits this long for the saved sign-in
const PRESENCE_GRACE_MS = 5000; // a partner gone this long gets a notice
const LONG_CLUE = 32; // a clue longer than this (characters) is .is-long

let els = {};
let dial = null;
let gen = 0;
let online = null; // the room on screen, see newOnline()
let started = false;
let ready = Promise.resolve();
let typeTimer = null;
let dotsTimer = null;
let ignorePop = false; // our own history.back() out of a room is on its way

// History entries this page pushed for a room carry this page load's tag.
// Only such an entry is left with history.back() (the entry before it is our
// own, so Back never meets a dead duplicate); a ?session link's entry, or one
// pushed before a reload, is rewritten in place instead.
const PAGE_TAG = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;

const withTimeout = (promise, ms) => Promise.race([promise, sleep(ms).then(() => null)]);
const isMe = (p) => !!p && p.uname === currentUser()?.uname;
const cardKey = (c) => (c ? `${c.index}:${c.target}` : '');
const finePointer = () => !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

function newOnline(roomId) {
  return {
    roomId,
    seat: null, // 0 | 1, or null for a spectator
    slots: [0, 1], // header slot → seat (you on the left when seated)
    room: null, // the last room applied to the screen
    seen: null, // the last room received (may still be queued)
    latest: null,
    pumping: false,
    loaded: false,
    forceRender: false,
    unsub: null,
    unsubLive: null,
    unsubPresence: [],
    disarmLive: null,
    live: { ...EMPTY_LIVE },
    lastLive: Promise.resolve(),
    status: [null, null], // presence per seat: 'here' | 'away' | 'offline'
    noticed: [false, false], // a "lost connection" toast was shown
    noticeTimers: [null, null],
    busy: false, // a move in flight: 'clue' | 'redraw' | 'lock' | 'next' | 'leave'
    leaveQueued: false, // Leave tapped while another move was in flight
    revealing: false,
    shownScore: 0,
    cardKey: null,
    needle: { timer: null, last: 0, pending: null },
    needleTouched: false,
    liveNeedle: null, // the partner's needle as last applied
    typing: { sent: false, idle: null },
    finalizing: false,
    finalizeTimer: null,
    slowTimer: null,
    offerSeat: false, // opened from a link while signed out
  };
}

function roleOf(o, room) {
  if (!o || o.seat === null || !room) return 'spectator';
  return o.seat === psychicOf(room) ? 'psychic' : 'guesser';
}

// --- entry points ----------------------------------------------------------------

// Called once by online.js. Resolves once a saved sign-in has been checked
// (and a ?session link, if any, has been opened).
export async function startOnline() {
  if (started) return ready;
  started = true;
  cacheDom();
  dial = new Dial(els.dial);
  bindGame();

  const sessionId = urlSession();
  const lobbyReady = initLobby({
    acceptChallenge,
    enterRoom,
    roomHref: (id) => `?session=${encodeURIComponent(id)}`,
    onSignedIn: refreshSeat,
    onSigningOut: () => leaveRoom(),
    onOutgoingChange: renderRematch,
    onIncomingChange: renderRematch,
  }).catch((err) => {
    console.error('online', err);
    return null;
  });
  ready = lobbyReady;

  window.addEventListener('popstate', onPopState);
  // Going anywhere else (logo, lobby, local play) just stops watching the
  // room — it never resigns; the room can be reopened from the lobby or URL.
  onScreenChange((name) => {
    if (name !== 'online-game' && online) leaveRoom();
  });

  if (sessionId && isValidRoomId(sessionId)) {
    // The top bar works while the saved sign-in is checked: a player who walks
    // away from the spinner meanwhile (the logo, then pass & play) — or did so
    // while this chunk was loading — stays where they went, and the link is
    // dropped rather than forced on them later.
    const stopWatching = onScreenChange(() => {
      if (document.documentElement.classList.contains('joining')) abandonJoin(sessionId);
    });
    if (currentScreen() === null) await withTimeout(lobbyReady, SESSION_WAIT_MS);
    stopWatching();
    if (currentScreen() === null) joinFromUrl(sessionId);
    else abandonJoin(sessionId);
    await lobbyReady;
  } else {
    if (sessionId !== null) setUrlSession(null);
    leaveJoining('home');
    await lobbyReady;
  }
}

// The top bar's online button and the home screen's Online card. Signing in
// from the top bar while a room is on screen (a ?session link watched signed
// out) keeps a player who turns out to be seated in their game rather than
// whisking them off to the lobby.
export async function openOnline() {
  await withTimeout(ready, 4000);
  const o = online;
  if (!currentUser() && o && currentScreen() === 'online-game') {
    requireLogin(() => {
      // Normally refreshSeat has already run (lobby's onSignedIn hook); a saved
      // sign-in that lands late runs this first, so seat here too (idempotent).
      refreshSeat();
      // Seated, or still loading (firstRoomLoad seats us): stay in the room.
      if (online === o && (o.seat !== null || !o.loaded)) return;
      openLobby();
    }, 'lobby');
    return;
  }
  openLobby();
}

// Attach the screen to a room. Everything about it arrives through the
// listener; until the first snapshot the screen shows "Connecting…".
export function enterRoom(roomId, { pushUrl = true } = {}) {
  if (!isValidRoomId(roomId)) {
    toast("That game doesn't exist");
    goBackOut();
    return;
  }
  if (online && online.roomId === roomId) {
    showGameScreen();
    return;
  }
  leaveRoom({ keepUrl: true });
  gen++;
  const g = gen;
  const o = newOnline(roomId);
  online = o;
  // Room to room (a rematch, a challenge taken mid-game) reuses the current
  // entry, so Back still goes to where the first room was opened from.
  if (pushUrl) setUrlSession(roomId, { replace: urlSession() !== null });
  resetView();
  showGameScreen();
  // The database may be out of reach; say so rather than spin in silence
  // (the listener keeps trying and takes over the moment the room arrives).
  o.slowTimer = setTimeout(() => {
    if (online === o && !o.loaded) els.loadingText.textContent = "Can't reach the game yet — still trying…";
  }, 10_000);
  o.unsub = watchRoom(roomId, (room, err) => {
    if (g !== gen || online !== o) return;
    if (err) console.error('room', err);
    if (!room) {
      if (!o.loaded) {
        toast("That game doesn't exist");
        leaveRoom();
        goBackOut();
      }
      return; // a room removed under us: keep showing what we had
    }
    o.seen = room;
    maybeFinalize(o, room);
    o.latest = room;
    pumpRoom();
  });
  o.unsubLive = watchLive(roomId, (live) => {
    if (g !== gen || online !== o) return;
    o.live = live;
    applyLive();
  });
}

// Stop watching the room (it carries on without us — this is not Leave).
export function leaveRoom({ keepUrl = false } = {}) {
  const o = online;
  if (!o) return;
  gen++;
  online = null;
  if (o.unsub) o.unsub();
  if (o.unsubLive) o.unsubLive();
  for (const u of o.unsubPresence) u();
  stopNeedleStream(o);
  clearTimeout(o.typing.idle);
  if (o.typing.sent && o.seat !== null && o.room) {
    setLive(o.roomId, { typing: false, by: o.seat, step: o.room.step });
  }
  if (o.disarmLive) o.disarmLive();
  clearTimeout(o.finalizeTimer);
  clearTimeout(o.slowTimer);
  o.noticeTimers.forEach(clearTimeout);
  clearTimeout(typeTimer);
  setPresenceRoom(null);
  if (dial) dial.setInteractive(false);
  if (keepUrl) return;
  if (isOwnEntry(o.roomId)) {
    // We pushed this entry: step back off it rather than rewrite it, or it
    // would sit in history as a dead copy of the one before.
    ignorePop = true;
    history.back();
  } else {
    setUrlSession(null);
  }
}

// A ?session link: show the room right away (as a spectator if need be) and,
// when signed out, offer a sign-in so a player can take their seat — once the
// room has turned out to exist and still be in play (see firstRoomLoad).
function joinFromUrl(roomId) {
  enterRoom(roomId, { pushUrl: false });
  if (!currentUser() && online && online.roomId === roomId) online.offerSeat = true;
}

// Create the room for an accepted challenge: random seats (and a random
// first psychic and card, chosen by createRoom), both players' match records
// in the same write. Resolves the room id.
async function acceptChallenge(ch) {
  const me = currentUser();
  if (!me) throw new Error('signed out');
  const challenger = { uname: ch.from, name: ch.fromName || ch.from };
  const mine = { uname: me.uname, name: me.name };
  const players = Math.random() < 0.5 ? [challenger, mine] : [mine, challenger];
  const id = newRoomId();
  await createRoom({ id, players, rounds: ch.rounds, extraUpdates: onlineStartEntries(id, players, ch.rounds) });
  return id;
}

// A spectator who signs in (or was signed out when the link opened) and
// turns out to be one of the two players gets their seat.
function refreshSeat() {
  const o = online;
  const user = currentUser();
  if (!o || !o.loaded || o.seat !== null || !user) return;
  const seat = seatOf(o.room, user.uname);
  if (seat === null) return;
  o.seat = seat;
  o.status = [null, null];
  renderHeader(o.room);
  watchPresence(o, o.room);
  takeSeat(o, o.room);
  toast('Your seat is ready');
  o.forceRender = true;
  if (!o.latest) o.latest = o.room;
  pumpRoom();
}

// --- url ---------------------------------------------------------------------------

const urlSession = () => new URLSearchParams(location.search).get('session');

const isOwnEntry = (id) => history.state?.session === id && history.state?.page === PAGE_TAG;

// Point the URL at a room (a new history entry, unless `replace`) or at no
// room (always in place). A replaced entry keeps its tag: ours stays ours, a
// link's stays the link's.
function setUrlSession(id, { replace = false } = {}) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  if (url.href === location.href) return;
  const push = !!id && !replace;
  const page = push ? PAGE_TAG : (id && history.state?.page) || null;
  try {
    history[push ? 'pushState' : 'replaceState']({ session: id || null, page }, '', url);
  } catch {
    /* ignore */
  }
}

function onPopState() {
  const id = urlSession();
  if (ignorePop) {
    ignorePop = false;
    // Our own step back out of a room; the screen has already changed (and a
    // room entered since then must not be left because of it).
    if (!id) return;
  }
  if (id) {
    if (!online || online.roomId !== id) joinFromUrl(id);
  } else if (online) {
    leaveRoom({ keepUrl: true });
    goBackOut();
  }
}

// --- screens -------------------------------------------------------------------------

// Layout.astro hid every screen for a ?session link; whoever shows the first
// real screen lifts that. The fallback only fills an empty page: a screen the
// player went to themselves meanwhile stays.
function leaveJoining(fallback) {
  const html = document.documentElement;
  if (!html.classList.contains('joining')) return;
  html.classList.remove('joining');
  if (fallback && currentScreen() === null) showScreen(fallback, { direction: 'none' });
}

// The player left a ?session link's spinner before its room was opened: lift
// the joining state (so a room entered later slides in as usual) and drop the
// link from the URL, so a reload doesn't reopen a room they walked away from.
// A room entered since then owns the URL and is left alone.
function abandonJoin(sessionId) {
  document.documentElement.classList.remove('joining');
  if (!online && urlSession() === sessionId) setUrlSession(null);
}

function showGameScreen() {
  const joining = document.documentElement.classList.contains('joining');
  leaveJoining(null);
  showScreen('online-game', { direction: joining ? 'none' : 'forward' });
}

// Out of a room: the lobby when signed in, else home.
function goBackOut() {
  leaveJoining(null);
  if (currentUser()) openLobby({ direction: 'back' });
  else showScreen('home', { direction: 'back' });
}

// --- the snapshot pump ---------------------------------------------------------------

async function pumpRoom() {
  const o = online;
  if (!o || o.pumping) return;
  o.pumping = true;
  try {
    while (online === o && o.latest) {
      const room = o.latest;
      o.latest = null;
      try {
        if (!o.loaded) await firstRoomLoad(o, room);
        else await applyRoomUpdate(o, room);
      } catch (err) {
        console.error('room', err);
      }
    }
  } finally {
    o.pumping = false;
  }
}

async function firstRoomLoad(o, room) {
  const user = currentUser();
  o.seat = seatOf(room, user?.uname);
  o.room = room;
  o.loaded = true;
  hideToast();
  renderHeader(room);
  watchPresence(o, room);
  if (o.seat !== null) takeSeat(o, room);
  else if (o.offerSeat && !currentUser() && !isFinished(room)) requireLogin(() => refreshSeat(), 'join');
  else if (!isFinished(room)) toast('Watching this game');
  await renderRoom(room, { fresh: true });
}

// Seated in a running room: tell the lobby we are busy, and let the server
// clear our typing dots if this tab drops.
function takeSeat(o, room) {
  if (isFinished(room)) return;
  setPresenceRoom(o.roomId);
  armLiveCleanup(o.roomId).then((disarm) => {
    if (online === o) o.disarmLive = disarm;
    else disarm();
  });
}

async function applyRoomUpdate(o, room) {
  const prev = o.room;
  if (o.forceRender) {
    o.forceRender = false;
    o.room = room;
    await renderRoom(room);
    return;
  }
  if (room.step <= prev.step) {
    o.room = room; // bookkeeping only (e.g. the stats flag)
    return;
  }
  o.room = room;
  const stepped = room.step === prev.step + 1;

  if (isFinished(room)) {
    if (!isFinished(prev)) onEnded(o, room);
    await showFinal(room, { animate: !isFinished(prev) });
    return;
  }
  if (stepped && prev.phase === 'guess' && room.phase === 'reveal') return revealRound(room);
  if (stepped && prev.phase === 'reveal' && room.phase === 'clue' && room.round === prev.round + 1) {
    return startRound(room);
  }
  if (stepped && prev.phase === 'clue' && room.phase === 'clue' && room.round === prev.round) return redrawn(room);
  if (stepped && prev.phase === 'clue' && room.phase === 'guess') return clueArrived(room);
  // Missed steps (a reconnect, a background tab): redraw in place.
  return renderRoom(room);
}

function onEnded(o, room) {
  setPresenceRoom(null);
  if (room.endReason === 'left' && room.leftBy !== o.seat) {
    const who = room.players[room.leftBy];
    if (who) toast(`${who.name} left the game`, 3200);
  }
}

// --- drawing the room ------------------------------------------------------------------

// Draw `room` as it is, with no story — a first load, a seat change, or a
// catch-up after missed steps. fresh: flip the card in. The one exception is
// a brand-new room (nothing played, nothing redrawn — how both players arrive
// from a challenge): its psychic gets round 1's target whirling in, just as
// every later round's does.
async function renderRoom(room, { fresh = false } = {}) {
  const o = online;
  const g = gen;
  renderHeader(room);
  renderTurn(room);
  renderRound(room);
  setScore(room.score);
  if (isFinished(room)) {
    await showFinal(room, { animate: false });
    return;
  }
  hideFinal();
  const role = roleOf(o, room);
  const story = fresh && role === 'psychic' && room.phase === 'clue' && room.step === 0;
  const card = room.card;
  dial.clearReveal();
  dial.setAccent(avatarColor(room.players[guesserOf(room)].uname));
  const key = cardKey(card);
  const flip = dial.setSpectrum(card.left, card.right, { animate: fresh || key !== o.cardKey });
  o.cardKey = key;
  o.revealing = false;

  if (room.phase === 'reveal') {
    dial.setInteractive(false);
    o.revealing = true;
    renderPanel(room, { revealPending: true });
    await flip;
    if (g !== gen) return;
    await dial.reveal({ guess: room.guess, target: card.target });
    if (g !== gen) return;
    o.revealing = false;
    renderPanel(room);
    return;
  }
  if (role === 'psychic' && !story) {
    dial.setTarget(card.target);
    dial.openShutter();
  } else {
    dial.closeShutter();
  }
  o.liveNeedle = null;
  dial.setNeedle(restingNeedle(o, room));
  dial.setInteractive(role === 'guesser' && room.phase === 'guess');
  renderPanel(room);
  if (story) {
    // As startRound: the card flips in, then the shutter opens on the spin
    // (not awaited — the pump only waits for the flip).
    await flip;
    if (g !== gen || online !== o || o.room !== room) return;
    showTarget(room, 3);
  }
}

// Where the needle sits when a guess phase is drawn: the guesser's last
// streamed position (so a reload keeps it), else the middle.
function restingNeedle(o, room) {
  if (room.phase !== 'guess') return 50;
  const l = o.live;
  if (l && l.step === room.step && l.by === guesserOf(room) && l.needle != null) return l.needle;
  return 50;
}

// reveal → next round: shutter down, needle home, new card, and for the
// psychic the target whirls in.
async function startRound(room) {
  const o = online;
  const g = gen;
  const role = roleOf(o, room);
  o.revealing = false;
  o.needleTouched = false;
  resetTyping(o);
  dial.setInteractive(false);
  dial.clearReveal();
  dial.setAccent(avatarColor(room.players[guesserOf(room)].uname));
  renderTurn(room);
  renderRound(room, { animate: true });
  els.clueInput.value = '';
  updateCount();
  renderPanel(room);
  const closing = dial.closeShutter();
  dial.setNeedle(50, { animate: true });
  await closing;
  if (g !== gen) return;
  o.cardKey = cardKey(room.card);
  await dial.setSpectrum(room.card.left, room.card.right);
  if (g !== gen) return;
  if (role === 'psychic') showTarget(room, 3);
}

// The psychic's target: shutter swings open while the wheel whirls in.
function showTarget(room, turns) {
  dial.openShutter();
  dial.spinTo(room.card.target, { turns }).then(() => {
    if (finePointer() && online?.room === room && room.phase === 'clue' && document.activeElement === document.body) {
      els.clueInput.focus({ preventScroll: true });
    }
  });
}

// The psychic swapped the card.
async function redrawn(room) {
  const o = online;
  const role = roleOf(o, room);
  resetTyping(o);
  // Still a clue in the box: say so again at the new step (and let it lapse).
  if (role === 'psychic' && els.clueInput.value.trim()) touchTyping(o);
  o.cardKey = cardKey(room.card);
  renderPanel(room);
  const flip = dial.setSpectrum(room.card.left, room.card.right);
  if (role === 'psychic') showTarget(room, 2);
  await flip;
}

// clue → guess: the clue pops in for the guesser (and spectators), whose
// needle comes alive.
function clueArrived(room) {
  const o = online;
  const role = roleOf(o, room);
  o.liveNeedle = null;
  renderTurn(room);
  if (role === 'psychic') {
    els.clueInput.value = '';
    updateCount();
  }
  renderPanel(room, { animateClue: role !== 'psychic' });
  if (role === 'guesser') {
    o.needleTouched = false;
    dial.setNeedle(restingNeedle(o, room));
    dial.setInteractive(true);
  }
}

// guess → reveal, the same on every screen: shutter open, needle to the
// guess, band lit, points fly to the duo score, confetti for a bullseye.
async function revealRound(room) {
  const o = online;
  const g = gen;
  o.revealing = true;
  stopNeedleStream(o);
  dial.setInteractive(false);
  renderTurn(room);
  renderPanel(room, { revealPending: true });
  const from = o.shownScore;
  await dial.reveal({ guess: room.guess, target: room.card.target });
  if (g !== gen) return;
  const points = room.points || 0;
  if (points > 0) {
    const bubble = els.dial.querySelector('.dial-bubble');
    if (points === MAX_POINTS) confettiFrom(bubble, { count: 120 });
    await flyPoints(bubble, els.scoreChip, `+${points}`, {
      color: points === MAX_POINTS ? 'var(--c-band-4)' : 'var(--c-primary)',
    });
    if (g !== gen) return;
    countUp(els.score, from, room.score, { duration: 650 });
    o.shownScore = room.score;
  } else {
    setScore(room.score);
  }
  o.revealing = false;
  renderPanel(room);
  popIn(els.result);
  if (o.seat !== null) popIn(els.next);
}

// --- the final card ----------------------------------------------------------------------

async function showFinal(room, { animate = false } = {}) {
  const o = online;
  const g = gen;
  o.revealing = false;
  stopNeedleStream(o);
  stopTyping(o);
  dial.setInteractive(false);
  renderHeader(room);
  renderTurn(room);
  renderRound(room);
  setScore(room.score);

  const max = maxScore(room);
  const left = room.endReason === 'left';
  const tier = rateScore(room.score, max);
  els.finalDuo.innerHTML = room.players.map((p) => avatarHtml(p.uname, 58)).join('');
  els.finalTier.textContent = left ? 'Game over' : tier.title;
  els.finalTier.classList.toggle('is-left', left);
  els.finalMax.textContent = String(max);
  let note = tier.line;
  if (left) {
    const who = room.players[room.leftBy];
    note = room.leftBy === o.seat ? 'You left the game' : `${who ? who.name : 'Your partner'} left the game`;
  }
  els.finalNote.textContent = note;
  els.finalPips.innerHTML = Array.from({ length: room.rounds }, (_, i) => {
    const h = room.history[i];
    if (!h) return `<li class="og-pip is-empty" style="--i:${i}"><span class="sr-only">Round ${i + 1}: not played</span></li>`;
    const label = `Round ${i + 1}: ${h.left} to ${h.right}, clue “${h.clue}”, ${h.points} points`;
    return `<li class="og-pip p${h.points}" style="--i:${i}" title="${escapeHtml(label)}">` +
      `<span aria-hidden="true">${h.points}</span><span class="sr-only">${escapeHtml(label)}</span></li>`;
  }).join('');

  els.stage.classList.add('is-final');
  els.final.classList.remove('hidden');
  els.final.classList.toggle('is-entering', animate && !reducedMotion());
  renderPanel(room);

  if (animate && !reducedMotion()) {
    els.finalScore.textContent = '0';
    popIn(els.final);
    await sleep(250);
    if (g !== gen) return;
    await countUp(els.finalScore, 0, room.score, { duration: 1100 });
    if (g !== gen) return;
    pulse(els.finalScore);
    if (!left && tier.celebrate) confettiFrom(els.finalScore, { count: 140 });
  } else {
    els.finalScore.textContent = String(room.score);
  }
}

function hideFinal() {
  els.stage.classList.remove('is-final');
  els.final.classList.add('hidden');
  els.final.classList.remove('is-entering');
}

// --- header ------------------------------------------------------------------------------

function renderHeader(room) {
  const o = online;
  if (!o || !room) return;
  o.slots = o.seat === null ? [0, 1] : [o.seat, 1 - o.seat];
  o.slots.forEach((seat, i) => {
    const p = room.players[seat];
    const el = els.slots[i];
    el.dataset.seat = String(seat);
    if (el.dataset.uname !== p.uname) {
      el.dataset.uname = p.uname;
      el.querySelector('.og-avatar').innerHTML = avatarHtml(p.uname, 34);
    }
    el.querySelector('.og-name').textContent = p.name;
    el.classList.toggle('is-me', isMe(p));
  });
  renderPresence();
  els.max.textContent = `/${maxScore(room)}`;
  const seatedActive = o.seat !== null && !isFinished(room);
  els.leave.classList.toggle('hidden', !seatedActive);
  els.exit.classList.toggle('hidden', seatedActive);
  els.exit.setAttribute('aria-label', currentUser() ? 'Back to the lobby' : 'Back home');
}

// Whose move it is (ringed) and who is the psychic this round.
function renderTurn(room) {
  const active = isFinished(room) ? null
    : room.phase === 'clue' ? psychicOf(room)
      : room.phase === 'guess' ? guesserOf(room) : null;
  for (const el of els.slots) {
    const seat = Number(el.dataset.seat);
    el.classList.toggle('is-turn', seat === active);
    el.classList.toggle('is-psychic', !isFinished(room) && seat === psychicOf(room));
  }
}

function renderRound(room, { animate = false } = {}) {
  const n = Math.min(room.round + 1, room.rounds);
  els.roundNum.textContent = String(n);
  els.roundTotal.textContent = String(room.rounds);
  els.round.setAttribute('aria-label', `Round ${n} of ${room.rounds}`);
  if (animate) popIn(els.round.querySelector('.game-round-v'));
}

// The header score, set outright. A count-up still rolling (a reveal the pump
// has already moved past) is stopped first, or it would land on its old
// target over this one.
function setScore(n) {
  stopCount(els.score);
  els.score.textContent = String(n);
  if (online) online.shownScore = n;
}

function renderPresence() {
  const o = online;
  for (const el of els.slots) {
    const seat = Number(el.dataset.seat);
    const status = o ? o.status[seat] || 'unknown' : 'unknown';
    el.dataset.status = status;
    const name = el.querySelector('.og-name').textContent;
    const word = { here: 'here', away: 'away', offline: 'offline' }[status];
    el.setAttribute('aria-label', word ? `${name}, ${word}` : name);
  }
}

// Presence dots: green when in this room, amber when online elsewhere, grey
// when gone. A seated player hears about their partner coming and going.
function watchPresence(o, room) {
  const g = gen;
  for (const u of o.unsubPresence) u();
  o.unsubPresence = [];
  if (o.seat !== null) o.status[o.seat] = 'here';
  const seats = o.seat === null ? [0, 1] : [1 - o.seat];
  for (const seat of seats) {
    const p = room.players[seat];
    o.unsubPresence.push(watchPlayer(p.uname, (pr) => {
      if (g !== gen || online !== o) return;
      const finished = isFinished(o.room);
      const status = !pr.online ? 'offline' : finished || pr.room === o.roomId ? 'here' : 'away';
      const prev = o.status[seat];
      o.status[seat] = status;
      renderPresence();
      refreshWait();
      if (o.seat !== null && !finished && prev && prev !== status) noticePresence(o, seat, p, status);
    }));
  }
}

// A partner who drops out is announced only if they stay gone for a few
// seconds (a reload is not news); their return only if the drop was.
function noticePresence(o, seat, p, status) {
  clearTimeout(o.noticeTimers[seat]);
  if (status === 'here') {
    if (o.noticed[seat]) toast(`${p.name} is back`);
    o.noticed[seat] = false;
    return;
  }
  o.noticeTimers[seat] = setTimeout(() => {
    if (online !== o || o.status[seat] !== status || isFinished(o.room)) return;
    toast(status === 'offline' ? `${p.name} lost connection` : `${p.name} stepped away`, 3200);
    o.noticed[seat] = true;
  }, PRESENCE_GRACE_MS);
}

// --- the panel ---------------------------------------------------------------------------

function showView(name) {
  if (els.panel.dataset.view === name) return;
  els.panel.dataset.view = name;
  for (const v of els.views) v.classList.toggle('hidden', v.dataset.view !== name);
}

function renderPanel(room, { revealPending = false, animateClue = false } = {}) {
  const o = online;
  if (!o || !room) return;
  const role = roleOf(o, room);
  const guesser = room.players[guesserOf(room)];
  let view;
  if (isFinished(room)) view = 'done';
  else if (room.phase === 'clue') view = role === 'psychic' ? 'clue' : 'wait';
  else if (room.phase === 'guess') view = role === 'guesser' ? 'guess' : 'wait';
  else view = 'reveal';
  showView(view);
  setClue(room, { animate: animateClue });

  if (view === 'clue') {
    els.clueInput.placeholder = `Clue for ${guesser.name}…`;
  } else if (view === 'wait') {
    refreshWait();
  } else if (view === 'reveal') {
    const pts = room.points || 0;
    els.result.innerHTML = revealPending ? '&nbsp;'
      : `<b class="og-result-word p${pts}">${RESULT_WORDS[pts] || ''}</b>`;
    els.result.classList.toggle('is-pending', revealPending);
    els.nextLabel.textContent = room.round + 1 >= room.rounds ? 'See results' : 'Next round';
    els.next.classList.toggle('hidden', revealPending || o.seat === null);
  } else if (view === 'done') {
    els.rematch.classList.toggle('hidden', o.seat === null);
    renderRematch();
  }
  setBusyUi();
  restoreFocus(o);
}

// Keyboard focus across a move. The button that made the move is disabled
// while it is on its way, which drops focus to <body>, and the view it lived
// in may be replaced once the room moves on (Next round → the clue box, Lock
// in → the reveal's Next). Remember where focus was, then hand it back to that
// control — or to the first control of the view now showing — as soon as one
// is usable. Anything the player focuses meanwhile wins.
const REFOCUS_MS = 8000;

function noteFocus(o) {
  const a = document.activeElement;
  o.refocus = a && (els.panel.contains(a) || a === dial.svg)
    ? { el: a, until: performance.now() + REFOCUS_MS } : null;
}

function restoreFocus(o) {
  const r = o?.refocus;
  if (!r || o.busy) return; // mid-move every control is disabled: wait for it to settle
  // Focus counts as lost while it sits on <body>, on the control we noted, or
  // on one that is disabled or no longer rendered (browsers keep reporting a
  // just-hidden button as focused until their next focus fix-up).
  const a = document.activeElement;
  const lost = !a || a === document.body || a === r.el || a.disabled || a.offsetParent === null;
  if (performance.now() > r.until || !lost) {
    o.refocus = null;
    return;
  }
  const usable = (el) => !!el && (el === dial.svg
    ? dial.root.classList.contains('is-interactive')
    : !el.disabled && el.offsetParent !== null && els.panel.contains(el));
  const view = [...els.views].find((v) => v.dataset.view === els.panel.dataset.view);
  const target = usable(r.el) ? r.el
    : [...(view?.querySelectorAll('button, input, textarea') || [])].find(usable);
  if (!target) return; // nothing to land on yet: the next render tries again
  o.refocus = null;
  target.focus({ preventScroll: true });
}

// The "someone else's move" line: who, what they are doing, and whether
// they are actually here to do it.
function refreshWait() {
  const o = online;
  const room = o?.room;
  if (!room || els.panel.dataset.view !== 'wait' || isFinished(room)) return;
  const seat = room.phase === 'clue' ? psychicOf(room) : guesserOf(room);
  const who = room.players[seat];
  if (els.waitAvatar.dataset.uname !== who.uname) {
    els.waitAvatar.dataset.uname = who.uname;
    els.waitAvatar.innerHTML = avatarHtml(who.uname, 30);
  }
  els.waitName.textContent = who.name;
  const status = o.status[seat];
  const gone = status === 'offline' || status === 'away';
  els.waitVerb.textContent = status === 'offline' ? 'is offline'
    : status === 'away' ? 'stepped away'
      : room.phase === 'clue' ? 'is thinking' : 'is turning the dial';
  els.wait.classList.toggle('is-gone', gone);
  applyLive();
}

// The clue speech bubble: shown from the guess phase on. When it first
// arrives it pops out of the psychic's avatar and types itself out.
function setClue(room, { animate = false } = {}) {
  const show = !!room && !isFinished(room) && (room.phase === 'guess' || room.phase === 'reveal') && !!room.clue;
  els.clue.classList.toggle('hidden', !show);
  if (!show) {
    els.clue.dataset.key = '';
    clearTimeout(typeTimer);
    return;
  }
  const key = `${room.id}:${room.round}:${room.clue}`;
  if (els.clue.dataset.key === key) return;
  els.clue.dataset.key = key;
  const psychic = room.players[psychicOf(room)];
  els.clueAvatar.innerHTML = avatarHtml(psychic.uname, 34);
  els.clueFull.textContent = `${psychic.name}'s clue: ${room.clue}`;
  typeClue(room.clue, animate && !reducedMotion());
}

// Every character is laid out from the start (so the bubble never grows
// while it types); they just switch on one after another. A long clue gets a
// smaller face on small phones (online.css), so the panel stays on screen.
function typeClue(text, animate) {
  clearTimeout(typeTimer);
  const chars = [...text];
  els.clueBubble.classList.toggle('is-long', chars.length > LONG_CLUE);
  els.clueText.innerHTML = chars.map((c) => `<span>${c === ' ' ? ' ' : escapeHtml(c)}</span>`).join('');
  const spans = [...els.clueText.children];
  if (!animate) {
    for (const s of spans) s.classList.add('on');
    els.clueBubble.classList.remove('is-typing');
    return;
  }
  els.clueBubble.classList.add('is-typing');
  els.clue.classList.remove('pop');
  void els.clue.offsetWidth;
  els.clue.classList.add('pop');
  const step = Math.max(22, Math.min(60, 1100 / Math.max(1, chars.length)));
  let i = 0;
  const tick = () => {
    if (i < spans.length) spans[i++].classList.add('on');
    if (i < spans.length) typeTimer = setTimeout(tick, step);
    else els.clueBubble.classList.remove('is-typing');
  };
  typeTimer = setTimeout(tick, 260);
}

function updateCount() {
  const n = els.clueInput.value.length;
  els.clueCount.textContent = n >= CLUE_MAX - 15 ? String(CLUE_MAX - n) : '';
  els.clueCount.classList.toggle('is-low', CLUE_MAX - n <= 5);
}

function setBusyUi() {
  const busy = online?.busy || false;
  els.send.disabled = !!busy;
  els.send.classList.toggle('is-busy', busy === 'clue');
  els.redraw.disabled = !!busy;
  els.redraw.classList.toggle('is-busy', busy === 'redraw');
  els.lock.disabled = !!busy;
  els.lock.classList.toggle('is-busy', busy === 'lock');
  els.next.disabled = !!busy;
  els.next.classList.toggle('is-busy', busy === 'next');
  // Leave spins while it is on its way, or waiting for the move ahead of it.
  const leaving = busy === 'leave' || !!online?.leaveQueued;
  els.leave.disabled = leaving;
  els.leave.classList.toggle('is-busy', leaving);
  els.clueInput.readOnly = busy === 'clue';
}

function renderRematch() {
  const o = online;
  if (!els.rematch || !o || !o.room || o.seat === null) return;
  const partner = o.room.players[1 - o.seat];
  const theirs = incomingFrom(partner.uname);
  const waiting = !theirs && outgoingTo() === partner.uname;
  // Short on screen (it shares a row with Lobby on a phone), full for
  // screen readers.
  els.rematchLabel.textContent = theirs ? 'Accept' : waiting ? 'Waiting…' : 'Rematch';
  if (theirs) els.rematch.setAttribute('aria-label', `Accept ${partner.name}'s rematch`);
  else els.rematch.removeAttribute('aria-label');
  els.rematch.classList.toggle('is-waiting', waiting);
  els.rematch.classList.toggle('is-invited', !!theirs);
}

// --- the live channel ----------------------------------------------------------------------

function applyLive() {
  const o = online;
  const room = o?.room;
  if (!o || !o.loaded || !room || isFinished(room)) return;
  const live = o.live;
  const fresh = live.step === room.step;
  if (room.phase === 'clue') {
    const typing = fresh && live.typing && live.by === psychicOf(room) && o.status[psychicOf(room)] !== 'offline';
    clearTimeout(dotsTimer);
    dotsTimer = null;
    els.dots.classList.toggle('is-on', typing);
    return;
  }
  if (room.phase !== 'guess' || o.revealing) return;
  if (!(fresh && live.by === guesserOf(room) && live.needle != null)) {
    if (!dotsTimer) els.dots.classList.remove('is-on');
    return;
  }
  if (roleOf(o, room) !== 'guesser') {
    if (live.needle === o.liveNeedle) return;
    o.liveNeedle = live.needle;
    dial.setNeedle(live.needle, { animate: true });
    // The dots dance while the needle moves.
    els.dots.classList.add('is-on');
    clearTimeout(dotsTimer);
    dotsTimer = setTimeout(() => {
      dotsTimer = null;
      els.dots.classList.remove('is-on');
    }, 700);
  } else if (!o.needleTouched) {
    dial.setNeedle(live.needle); // our own position, back after a reload
  }
}

const canStream = (o) => !!o && online === o && o.loaded && o.seat !== null && !!o.room &&
  !isFinished(o.room) && o.room.phase === 'guess' && o.seat === guesserOf(o.room) && !o.busy && !o.revealing;

function onNeedle(v) {
  const o = online;
  if (!canStream(o)) return;
  o.needleTouched = true;
  const n = o.needle;
  n.pending = v;
  if (n.timer) return;
  const wait = Math.max(0, n.last + NEEDLE_EVERY_MS - performance.now());
  n.timer = setTimeout(() => flushNeedle(o), wait);
}

function flushNeedle(o) {
  const n = o.needle;
  n.timer = null;
  if (n.pending == null || !canStream(o)) return;
  const v = n.pending;
  n.pending = null;
  n.last = performance.now();
  o.lastLive = setLive(o.roomId, { needle: v, by: o.seat, step: o.room.step });
}

function stopNeedleStream(o) {
  if (!o) return;
  clearTimeout(o.needle.timer);
  o.needle.timer = null;
  o.needle.pending = null;
}

function onClueInput() {
  updateCount();
  const o = online;
  if (!o || roleOf(o, o.room) !== 'psychic' || o.room.phase !== 'clue' || isFinished(o.room) || o.busy) return;
  const has = els.clueInput.value.trim().length > 0;
  if (has) {
    touchTyping(o);
    return;
  }
  clearTimeout(o.typing.idle);
  sendTyping(o, false);
}

// The psychic is typing: announce it once, and that it stopped after a pause.
function touchTyping(o) {
  clearTimeout(o.typing.idle);
  if (!o.typing.sent) sendTyping(o, true);
  o.typing.idle = setTimeout(() => sendTyping(o, false), TYPING_IDLE_MS);
}

function sendTyping(o, on) {
  if (!o || online !== o || o.seat === null || !o.room) return;
  if (!on && !o.typing.sent) return;
  o.typing.sent = on;
  o.lastLive = setLive(o.roomId, { typing: on, by: o.seat, step: o.room.step });
}

function stopTyping(o) {
  if (!o) return;
  clearTimeout(o.typing.idle);
  if (o.typing.sent && !isFinished(o.room)) sendTyping(o, false);
  o.typing.sent = false;
}

// A new step (redraw, new round) makes old typing flags stale anyway.
function resetTyping(o) {
  clearTimeout(o.typing.idle);
  o.typing.sent = false;
}

// Let our last live write land before a move's transaction starts. The two
// touch different nodes (see rooms.js), so this only keeps them in order.
const settleLive = (o) => withTimeout(o.lastLive, 1500);

// --- moves -----------------------------------------------------------------------------------

async function runMove(kind, fn) {
  const o = online;
  if (!o || !o.loaded || o.busy || o.seat === null) return null;
  const g = gen;
  if (!o.refocus) noteFocus(o);
  o.busy = kind;
  setBusyUi();
  try {
    await settleLive(o);
    if (g !== gen) return null;
    const res = await fn(o);
    if (g !== gen) return null;
    if (!res.committed && res.error) toast('Connection trouble — try again');
    return res;
  } catch (err) {
    console.error('room', err);
    if (g === gen) toast('Connection trouble — try again');
    return null;
  } finally {
    if (online === o) {
      o.busy = false;
      // Leave was tapped while this move was on its way: it goes now — on
      // the next task, so the caller deals with this move's result first.
      if (o.leaveQueued) {
        setTimeout(() => {
          if (online !== o) return;
          o.leaveQueued = false;
          leave();
          setBusyUi(); // nothing left to send (the game is over): Leave idles
        }, 0);
      }
      setBusyUi();
      restoreFocus(o); // a move that changed nothing (or failed) leaves the view as it was
    }
  }
}

async function sendClue(e) {
  e.preventDefault();
  const o = online;
  if (!o || !o.room || roleOf(o, o.room) !== 'psychic' || o.room.phase !== 'clue' || o.busy) return;
  const text = cleanClue(els.clueInput.value);
  if (!text) {
    shake(els.clueForm);
    els.clueInput.focus();
    return;
  }
  clearTimeout(o.typing.idle);
  const res = await runMove('clue', (x) => submitClue(x.roomId, x.seat, text));
  if (online !== o) return;
  sendTyping(o, false); // only now, so the dots never flicker off early
  if (res && res.committed) {
    els.clueInput.value = '';
    updateCount();
    els.clueInput.blur();
  }
}

function redraw() {
  const o = online;
  if (!o || !o.room || roleOf(o, o.room) !== 'psychic' || o.room.phase !== 'clue') return;
  runMove('redraw', (x) => redrawCard(x.roomId, x.seat));
}

async function lockIn() {
  const o = online;
  if (!canStream(o)) return;
  const guess = dial.needle;
  stopNeedleStream(o);
  const hadFocus = document.activeElement === dial.svg; // locked with Enter on the dial
  noteFocus(o); // before the dial lets go of focus
  dial.setInteractive(false); // (drops the dial's focus)
  const res = await runMove('lock', (x) => lockGuess(x.roomId, x.seat, guess));
  if (online !== o) return;
  // Not taken (and the room did not move on): the needle is ours again.
  if (!(res && res.committed) && o.room.phase === 'guess' && !o.revealing) {
    dial.setInteractive(true);
    if (hadFocus && document.activeElement === document.body) dial.svg.focus({ preventScroll: true });
  }
}

function next() {
  const o = online;
  if (!o || !o.room || o.room.phase !== 'reveal' || o.revealing) return;
  runMove('next', (x) => nextRound(x.roomId, x.seat));
}

// Leave. Moves go one at a time, so while another is still on its way (a slow
// or dropped connection: a transaction waits for the database however long
// it takes) Leave is queued behind it rather than lost, and spins meanwhile.
function leave() {
  const o = online;
  // The latest room received, which may still be queued for the screen: a
  // move that just landed may have ended the game.
  if (!o || !o.room || o.seat === null || isFinished(o.seen || o.room)) return;
  if (o.busy) {
    if (o.busy !== 'leave' && !o.leaveQueued) {
      o.leaveQueued = true;
      setBusyUi();
      toast('Leaving once your last move goes through…');
    }
    return;
  }
  stopNeedleStream(o);
  stopTyping(o);
  runMove('leave', (x) => leaveRoomMove(x.roomId, x.seat));
}

async function rematch() {
  const o = online;
  if (!o || !o.room || o.seat === null) return;
  const partner = o.room.players[1 - o.seat];
  // Their rematch is waiting: challengePlayer accepts it (and takes back any
  // challenge of ours), so none of these checks apply.
  if (!incomingFrom(partner.uname)) {
    if (outgoingTo() === partner.uname) {
      toast(`Waiting for ${partner.name}…`);
      return;
    }
    if (hasOutgoingChallenge()) {
      toast('You already have a challenge out');
      return;
    }
    if (o.status[1 - o.seat] === 'offline') {
      toast(`${partner.name} is offline`);
      return;
    }
  }
  els.rematch.disabled = true;
  try {
    await challengePlayer(partner, o.room.rounds);
  } finally {
    els.rematch.disabled = false;
    renderRematch();
  }
}

// --- stats -------------------------------------------------------------------------------------

// Every finished room gets its stats written once (stats.js claims the job);
// a claim left by a vanished tab expires, so try again a little later.
function maybeFinalize(o, room) {
  if (!isFinished(room) || room.statsRecorded === true || o.finalizing) return;
  o.finalizing = true;
  finalizeOnlineMatch(room, currentUser()?.uname)
    .catch((err) => {
      console.error('stats', err);
      return false;
    })
    .then((ok) => {
      o.finalizing = false;
      if (ok || online !== o) return;
      clearTimeout(o.finalizeTimer);
      o.finalizeTimer = setTimeout(() => {
        if (online === o && o.seen) maybeFinalize(o, o.seen);
      }, FINALIZE_RETRY_MS);
    });
}

// --- setup ---------------------------------------------------------------------------------------

function resetView() {
  dial.reset();
  dial.setInteractive(false);
  dial.clearSpectrum();
  hideFinal();
  showView('loading');
  els.loadingText.textContent = 'Connecting…';
  els.clue.classList.add('hidden');
  els.clue.dataset.key = '';
  els.clueInput.value = '';
  updateCount();
  setScore(0); // also stops a count still rolling from the last room
  els.max.textContent = '';
  els.roundNum.textContent = '1';
  els.roundTotal.textContent = '–';
  for (const el of els.slots) {
    el.dataset.uname = '';
    el.dataset.status = 'unknown';
    el.querySelector('.og-avatar').innerHTML = '';
    el.querySelector('.og-name').textContent = '';
    el.classList.remove('is-turn', 'is-psychic', 'is-me');
  }
  els.leave.classList.add('hidden');
  els.exit.classList.remove('hidden');
  setBusyUi();
}

function cacheDom() {
  const panel = $('online-panel');
  els = {
    screen: document.querySelector('.screen[data-screen="online-game"]'),
    leave: $('online-leave'),
    exit: $('online-exit'),
    slots: [$('online-slot-0'), $('online-slot-1')],
    scoreChip: $('online-score-chip'),
    score: $('online-score'),
    max: $('online-max'),
    round: $('online-round'),
    roundNum: $('online-round-num'),
    roundTotal: $('online-round-total'),
    stage: $('online-stage'),
    dial: $('online-dial'),
    final: $('online-final'),
    finalDuo: $('online-final-duo'),
    finalTier: $('online-final-tier'),
    finalScore: $('online-final-score'),
    finalMax: $('online-final-max'),
    finalNote: $('online-final-note'),
    finalPips: $('online-final-pips'),
    panel,
    views: [...panel.querySelectorAll('[data-view]')],
    loadingText: $('online-loading-text'),
    clue: $('online-clue'),
    clueAvatar: $('online-clue-avatar'),
    clueBubble: $('online-clue-bubble'),
    clueFull: $('online-clue-full'),
    clueText: $('online-clue-text'),
    clueForm: $('online-clue-form'),
    clueInput: $('online-clue-input'),
    clueCount: $('online-clue-count'),
    send: $('online-send'),
    redraw: $('online-redraw'),
    wait: panel.querySelector('[data-view="wait"]'),
    waitAvatar: $('online-wait-avatar'),
    waitName: $('online-wait-name'),
    waitVerb: $('online-wait-verb'),
    dots: $('online-dots'),
    lock: $('online-lock'),
    result: $('online-result'),
    next: $('online-next'),
    nextLabel: $('online-next-label'),
    rematch: $('online-rematch'),
    rematchLabel: $('online-rematch-label'),
    lobby: $('online-lobby'),
  };
}

function bindGame() {
  els.clueInput.maxLength = CLUE_MAX;
  els.clueForm.addEventListener('submit', sendClue);
  els.clueInput.addEventListener('input', onClueInput);
  els.redraw.addEventListener('click', redraw);
  els.lock.addEventListener('click', lockIn);
  els.next.addEventListener('click', next);
  els.rematch.addEventListener('click', rematch);
  els.lobby.addEventListener('click', goBackOut);
  els.exit.addEventListener('click', goBackOut);
  armConfirm(els.leave, 'Leave?', leave);

  dial.onInput(onNeedle);
  dial.onChange(onNeedle);
  // Keyboard players lock in from the dial itself.
  dial.svg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && els.panel.dataset.view === 'guess') {
      e.preventDefault();
      lockIn();
    }
  });
}
