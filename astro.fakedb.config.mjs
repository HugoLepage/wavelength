// @ts-check
// DEV ONLY: the normal site, but with `firebase/app` and `firebase/database`
// swapped for the in-memory fake in src/dev/fakedb, served by this dev server
// under /__fakedb/. Lets online play be tried end to end on one machine:
// http://localhost:4322/wavelength/ and http://p2.localhost:4322/wavelength/
// are two origins (two separate signed-in players) sharing one database.
// (Not 127.0.0.1: without --host the server listens on whatever `localhost`
// resolves to first, which may be ::1 only; *.localhost reaches it either way.)
//
//   npm run dev:fakedb        (astro dev --config astro.fakedb.config.mjs --port 4322)
//
// The production build (astro.config.mjs) never references any of this.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import baseConfig from './astro.config.mjs';
import { fakeDbPlugin } from './src/dev/fakedb/server.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  ...baseConfig,
  // The dev toolbar sits over the bottom-centre of the screen — right where
  // the game's main buttons are — in every one of the test tabs.
  devToolbar: { enabled: false },
  vite: {
    ...baseConfig.vite,
    // Its own optimizer cache, so running next to the real-Firebase dev
    // server never makes either one re-bundle the other's dependencies.
    cacheDir: here('./node_modules/.vite-fakedb/'),
    resolve: {
      alias: [
        { find: /^firebase\/app$/, replacement: here('./src/dev/fakedb/app.js') },
        { find: /^firebase\/database$/, replacement: here('./src/dev/fakedb/database.js') },
      ],
    },
    // The aliases already make these local files; never pre-bundle the SDK.
    optimizeDeps: {
      exclude: ['firebase', 'firebase/app', 'firebase/database', '@firebase/app', '@firebase/database'],
    },
    plugins: [...(baseConfig.vite?.plugins || []), fakeDbPlugin()],
  },
});
