// The chili pepper icon of spicy mode, in the outline style of the top bar's
// other icons (24×24, 2.2 stroke, round caps and joins). Two parts, so CSS
// can colour them apart: .chili-body (red when on) and .chili-stem (green).
// chiliSvg('chili is-lit') is always the red-and-green one (base.css): for
// the chips and badges that mean "these cards are spicy".
// One copy of the drawing for everywhere it shows: the top bar button and the
// lobby / game header chips (Astro components, via set:html) and the
// challenge cards (lobby.js). Colours live in base.css.

const BODY = 'M12.2 8.4C10.2 9.5 9.4 13 7.2 16 6.1 17.5 4.8 18.7 3.2 19.6c.9 1.4 2.9 1.9 5.1 1.6C14 20.4 19.4 16.4 20.2 11.4c.3-1.8-.4-3.3-1.9-4-1.8-.8-3.9-.3-6.1 1z';
const STEM = 'M11.4 9.2c1.1-1.9 3.7-3 6-2.2.9.3 1.6.9 2.1 1.6M15.6 7.1c-.1-2 .7-3.6 2.6-4.6';

export function chiliSvg(className = 'chili') {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ` +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `<path class="chili-body" d="${BODY}"></path><path class="chili-stem" d="${STEM}"></path></svg>`;
}
