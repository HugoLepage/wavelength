// Stand-in for `firebase/app` — DEV ONLY (astro.fakedb.config.mjs aliases it).
// An app is just a named bag of options; the fake database hangs one
// connection off each app, so a test can open two independent clients with
// initializeApp(opts, 'a') and initializeApp(opts, 'b').

const DEFAULT = '[DEFAULT]';
const apps = new Map();

export function initializeApp(options = {}, nameOrConfig = DEFAULT) {
  const name = typeof nameOrConfig === 'string' ? nameOrConfig : (nameOrConfig?.name ?? DEFAULT);
  const existing = apps.get(name);
  if (existing) {
    if (JSON.stringify(existing.options) === JSON.stringify(options)) return existing;
    throw new Error(`Firebase: Firebase App named '${name}' already exists with different options or config (app/duplicate-app).`);
  }
  const app = { name, options: { ...options }, automaticDataCollectionEnabled: false };
  apps.set(name, app);
  return app;
}

export function getApp(name = DEFAULT) {
  const app = apps.get(name);
  if (!app) throw new Error(`Firebase: No Firebase App '${name}' has been created - call initializeApp() first (app/no-app).`);
  return app;
}

export const getApps = () => [...apps.values()];
