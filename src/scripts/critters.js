// Low-poly critter logos. Each critter is one hand-built SVG in
// src/data/critters/<id>.svg (flat-shaded polygons only — no ids, defs or
// gradients, so any number of copies can share a page). They are inlined at
// build time as raw strings.

const files = import.meta.glob('../data/critters/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const CRITTER_SVGS = Object.fromEntries(
  Object.entries(files).map(([path, svg]) => [path.match(/([\w-]+)\.svg$/)[1], svg]),
);

// Shown for any critter whose icon has not been drawn yet.
const FALLBACK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true">' +
  '<polygon points="50,12 86,34 86,72 50,92 14,72 14,34" fill="#c9c4ba"/>' +
  '<polygon points="50,12 86,34 50,52" fill="#d9d4ca"/><polygon points="14,72 50,52 50,92" fill="#b3ada2"/></svg>';

export function critterSvg(id) {
  return CRITTER_SVGS[id] || FALLBACK;
}
