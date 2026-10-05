// Online mode, front half. This file stays tiny on purpose: it binds the two
// "online" buttons straight away and loads everything that touches Firebase
// (online-game.js → lobby.js, rooms.js, the SDK) as a separate chunk, so the
// home screen and pass-and-play are usable before — and without — any of it.
// If that chunk cannot load (offline, blocked), local play is untouched and
// the online buttons just say so.

import { $, toast } from './ui.js';
import { currentScreen, showScreen } from './router.js';

const SESSION_KEY = 'wavelength.session'; // auth.js's saved session

let loading = null; // Promise<module | null>

function load() {
  if (!loading) {
    loading = import('./online-game.js').catch((err) => {
      console.error('online', err);
      loading = null; // a later tap may retry
      return null;
    });
  }
  return loading;
}

async function openOnline() {
  const mod = await load();
  if (mod) mod.openOnline();
  else toast("Online play isn't available right now");
}

// The saved name, shown dimmed in the top bar while the session is checked,
// so a returning player never sees "Sign in" flash first.
function hintSavedUser() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved?.name) return;
  $('online-dot')?.classList.remove('hidden');
  $('online-dot')?.classList.add('is-pending');
  $('online-label')?.classList.add('hidden');
  const name = $('online-name');
  if (name) {
    name.textContent = saved.name;
    name.classList.remove('hidden');
  }
}

function clearHint() {
  $('online-dot')?.classList.add('hidden');
  $('online-dot')?.classList.remove('is-pending');
  $('online-label')?.classList.remove('hidden');
  $('online-name')?.classList.add('hidden');
}

// A ?session link whose room cannot be shown: fall back to home — unless the
// player has already gone somewhere (the logo, pass & play) while waiting.
function leaveJoining() {
  if (!document.documentElement.classList.contains('joining')) return;
  document.documentElement.classList.remove('joining');
  if (currentScreen() === null) showScreen('home', { direction: 'none' });
}

export async function initOnline() {
  $('btn-home-online')?.addEventListener('click', openOnline);
  $('btn-online')?.addEventListener('click', openOnline);
  hintSavedUser();
  const mod = await load();
  if (!mod) {
    clearHint();
    leaveJoining();
    return;
  }
  try {
    await mod.startOnline();
  } catch (err) {
    console.error('online', err);
    leaveJoining();
  }
}
