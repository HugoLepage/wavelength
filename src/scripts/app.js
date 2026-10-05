// Entry point: wires the shared chrome, the screen router and both game modes.

import { initUi } from './ui.js';
import { initRouter } from './router.js';
import { initLocal } from './local.js';
import { initOnline } from './online.js';

export async function initApp() {
  initUi(); // theme, toast, how-to overlay, top bar
  initRouter(); // shows the home screen unless a ?session link is being joined
  initLocal(); // pass-and-play
  await initOnline(); // sign-in, lobby, challenges, ?session rooms
}
