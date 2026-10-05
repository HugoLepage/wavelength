// Theme preference: light, dark, or follow the system.
//
// The resolved theme is written to <html data-theme>, which is what every
// colour token in base.css keys off. It is stamped a first time by the inline
// script in Layout.astro, before first paint, so a dark-mode player never gets
// a full screen of cream on the way in.
//
// NOTE: STORAGE_KEY, the data-theme values and the two theme-color hexes are
// duplicated verbatim in that inline script — an is:inline script cannot
// import. Keep the two in sync.

export const THEMES = ['light', 'dark', 'system'];
export const DEFAULT_THEME = 'system';
const STORAGE_KEY = 'wavelength.theme';
const THEME_COLOR = { light: '#f5f1ea', dark: '#0f1222' };

let current = DEFAULT_THEME;

const media = () => window.matchMedia?.('(prefers-color-scheme: dark)');

export const getTheme = () => current; // 'light' | 'dark' | 'system'

// What is actually on screen: 'system' asks the OS, everything else is itself.
export const resolvedTheme = () =>
  current === 'system' ? (media()?.matches ? 'dark' : 'light') : current;

function apply() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

// `persist: false` changes the theme without touching the saved preference.
export function setTheme(name, persist = true) {
  current = THEMES.includes(name) ? name : DEFAULT_THEME;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, current);
    } catch {
      /* private mode: the choice simply won't stick */
    }
  }
  apply();
}

// The saved choice, else follow the system.
export function detectTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (THEMES.includes(saved)) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

// A two-state toggle: it always writes an explicit choice, so 'system' is only
// ever the initial, never-yet-chosen state. Returns the theme now showing.
export function toggleTheme() {
  setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
  return resolvedTheme();
}

// `onSystemChange` is called when the OS flips the preference out from under
// us, so the caller can re-sync anything it derived from the theme.
export function initTheme(onSystemChange) {
  current = detectTheme();
  apply(); // re-applies what the inline script already stamped, so no flicker
  // Only while the player has never chosen: follow the OS if it changes.
  media()?.addEventListener?.('change', () => {
    if (current !== 'system') return;
    apply();
    onSystemChange?.();
  });
}
