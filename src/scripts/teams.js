// Team identities for pass-and-play: a random adjective + critter, a colour,
// and the critter's low-poly logo. Critter ids match the SVG file names in
// src/data/critters/.

import { critterSvg } from './critters.js';

export const CRITTERS = [
  { id: 'fox', plural: 'Foxes' },
  { id: 'owl', plural: 'Owls' },
  { id: 'bear', plural: 'Bears' },
  { id: 'cat', plural: 'Cats' },
  { id: 'wolf', plural: 'Wolves' },
  { id: 'panda', plural: 'Pandas' },
  { id: 'rabbit', plural: 'Rabbits' },
  { id: 'frog', plural: 'Frogs' },
  { id: 'penguin', plural: 'Penguins' },
  { id: 'raccoon', plural: 'Raccoons' },
  { id: 'koala', plural: 'Koalas' },
  { id: 'tiger', plural: 'Tigers' },
  { id: 'lion', plural: 'Lions' },
  { id: 'pig', plural: 'Pigs' },
  { id: 'mouse', plural: 'Mice' },
  { id: 'hedgehog', plural: 'Hedgehogs' },
  { id: 'deer', plural: 'Deer' },
  { id: 'monkey', plural: 'Monkeys' },
  { id: 'otter', plural: 'Otters' },
  { id: 'sloth', plural: 'Sloths' },
  { id: 'axolotl', plural: 'Axolotls' },
  { id: 'octopus', plural: 'Octopuses' },
  { id: 'badger', plural: 'Badgers' },
  { id: 'llama', plural: 'Llamas' },
];

export const ADJECTIVES = [
  'Atomic', 'Bashful', 'Bouncy', 'Brave', 'Breezy', 'Bubbly', 'Caffeinated', 'Cheeky',
  'Chilly', 'Clever', 'Cosmic', 'Cozy', 'Crafty', 'Daring', 'Dapper', 'Disco',
  'Dizzy', 'Electric', 'Epic', 'Fabulous', 'Fancy', 'Fearless', 'Feisty', 'Fluffy',
  'Frosty', 'Funky', 'Fuzzy', 'Galactic', 'Gentle', 'Giddy', 'Glittery', 'Golden',
  'Groovy', 'Grumpy', 'Hasty', 'Humble', 'Hungry', 'Jazzy', 'Jolly', 'Lucky',
  'Lunar', 'Majestic', 'Mellow', 'Mighty', 'Mischievous', 'Mystic', 'Neon', 'Nimble',
  'Noble', 'Peppy', 'Plucky', 'Polite', 'Quirky', 'Radiant', 'Rowdy', 'Royal',
  'Rumbling', 'Rusty', 'Salty', 'Sassy', 'Scrappy', 'Secret', 'Shiny', 'Silly',
  'Sleepy', 'Snappy', 'Snazzy', 'Sneaky', 'Sparkly', 'Speedy', 'Spicy', 'Spooky',
  'Stealthy', 'Stormy', 'Sturdy', 'Suave', 'Sunny', 'Swift', 'Tiny', 'Turbo',
  'Velvet', 'Wacky', 'Wild', 'Wise', 'Witty', 'Wobbly', 'Zany', 'Zesty', 'Zippy',
];

// One colour per seat, in seat order. Kept apart in hue so six teams side by
// side still read as six. Tokens in base.css mirror these (--team-0 … --team-5).
export const TEAM_COLORS = ['#ff6b5b', '#2ec4b6', '#8b6cff', '#ffb703', '#4cc26b', '#3fa7ff'];

export const MAX_TEAMS = TEAM_COLORS.length;

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

// A name not already taken by `others` (critters never repeat in one game,
// adjectives try not to).
function freshIdentity(others, rng) {
  const usedCritters = new Set(others.map((t) => t.critter));
  const usedAdjectives = new Set(others.map((t) => t.adjective));
  const critters = CRITTERS.filter((c) => !usedCritters.has(c.id));
  const adjectives = ADJECTIVES.filter((a) => !usedAdjectives.has(a));
  const critter = pick(critters.length ? critters : CRITTERS, rng);
  const adjective = pick(adjectives.length ? adjectives : ADJECTIVES, rng);
  return { adjective, critter: critter.id, name: `${adjective} ${critter.plural}` };
}

// `n` teams, seat i coloured TEAM_COLORS[i].
export function makeTeams(n, rng = Math.random) {
  const teams = [];
  for (let i = 0; i < n; i++) {
    teams.push({ id: i, color: TEAM_COLORS[i % TEAM_COLORS.length], score: 0, ...freshIdentity(teams, rng) });
  }
  return teams;
}

// A new name and critter for team `i`; colour and score stay.
export function rerollTeam(teams, i, rng = Math.random) {
  const others = teams.filter((_, k) => k !== i);
  const next = teams.slice();
  next[i] = { ...teams[i], ...freshIdentity([...others, teams[i]], rng) };
  return next;
}

// Grow or shrink a team list to `n`, keeping the teams already named.
export function resizeTeams(teams, n, rng = Math.random) {
  const next = teams.slice(0, n);
  for (let i = next.length; i < n; i++) {
    next.push({ id: i, color: TEAM_COLORS[i % TEAM_COLORS.length], score: 0, ...freshIdentity(next, rng) });
  }
  return next;
}

// The round badge: the critter on a disc of the team colour.
// Styling: .team-badge in src/styles/base.css; --badge-size sets the diameter.
export function teamBadgeHtml(team, { size = 48 } = {}) {
  return `<span class="team-badge" style="--team:${team.color};--badge-size:${size}px" aria-hidden="true">${critterSvg(team.critter)}</span>`;
}
