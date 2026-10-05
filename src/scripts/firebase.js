// Firebase Realtime Database handle. The database URL is not a secret — access
// is governed by the database rules (see database.rules.json) — so it lives in
// the bundle like any other static asset.
//
// Only a small subset of the SDK is used anywhere in the app (see the build
// notes): the dev-only fake database implements exactly that subset.

import { initializeApp } from 'firebase/app';
import { getDatabase, onValue, ref, runTransaction } from 'firebase/database';

export const DATABASE_URL =
  'https://wavelength-c679f-default-rtdb.europe-west1.firebasedatabase.app';

const app = initializeApp({ databaseURL: DATABASE_URL });

export const db = getDatabase(app);

// `dbRef('rooms', id)` → ref to /rooms/<id>
export const dbRef = (...path) => ref(db, path.join('/'));

// Keep a listener on `nodeRef` until the returned release() is called. Resolves
// once the first value has arrived, i.e. once the SDK has the node cached.
function holdValue(nodeRef) {
  return new Promise((resolve) => {
    let unsub = null;
    let settled = false;
    const release = () => {
      if (unsub) unsub();
      unsub = null;
    };
    const ready = () => {
      if (settled) return;
      settled = true;
      resolve(release);
    };
    unsub = onValue(nodeRef, ready, ready);
  });
}

// runTransaction over a node that must already exist. The SDK hands the
// update function `null` when it has nothing cached for the path (and an
// update that then returns undefined aborts on the spot), so a listener holds
// the node in the cache for the duration; `fn` never sees null — a node that
// is really missing just resolves { committed: false }. Results are only ever
// server-confirmed (no optimistic local events).
export async function transact(nodeRef, fn) {
  const release = await holdValue(nodeRef);
  try {
    return await runTransaction(nodeRef, (cur) => (cur === null ? undefined : fn(cur)), { applyLocally: false });
  } finally {
    release();
  }
}
