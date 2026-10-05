// Player avatars for online play. Online players have no team, so each one
// gets a critter on a coloured disc picked from a hash of their username —
// the same badge pass-and-play teams wear (teamBadgeHtml), and the same
// critter for a player on every screen and every device, with nothing stored.

import { CRITTERS, TEAM_COLORS, teamBadgeHtml } from './teams.js';

// FNV-1a: tiny, stable, well spread for short strings.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// { color, critter } for a username (case-insensitive, like accounts).
export function avatarOf(uname) {
  const h = hash(String(uname || '').toLowerCase());
  return {
    color: TEAM_COLORS[h % TEAM_COLORS.length],
    critter: CRITTERS[Math.floor(h / TEAM_COLORS.length) % CRITTERS.length].id,
  };
}

export const avatarColor = (uname) => avatarOf(uname).color;

// The badge markup (aria-hidden — name the player next to it).
export const avatarHtml = (uname, size = 40) => teamBadgeHtml(avatarOf(uname), { size });
