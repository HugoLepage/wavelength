// The pass-and-play results screen: the winner(s) on a little podium, every
// team ranked with a score bar that grows in and a number that counts up,
// confetti for the winners (no crowns or confetti when nobody scored). One
// team means co-op: the score out of the maximum, and a title for how well
// the team read each other's minds — crowned, with confetti, only when that
// rating earns a celebration.

import { $, escapeHtml } from './ui.js';
import { confettiFrom, countUp, popIn, reducedMotion, sleep } from './fx.js';
import { teamBadgeHtml } from './teams.js';
import { coopRating, maxScore, ranking } from './local-logic.js';

const CROWN_SVG =
  '<svg class="local-crown" viewBox="0 0 48 32" aria-hidden="true">' +
  '<path class="local-crown-body" d="M5 27L2.5 7.5l11 8.5L24 2l10.5 14 11-8.5L43 27z"/>' +
  '<rect class="local-crown-band" x="5" y="25" width="38" height="5" rx="2.5"/>' +
  '<circle class="local-crown-gem" cx="24" cy="18" r="3"/></svg>';

// Band colours plus the winner's own, for the winner's confetti.
const PARTY = ['#ffc93c', '#ff8f3a', '#1fa5e0', '#ff5a4e'];

let token = 0;

const pointsWord = (n) => (n === 1 ? 'point' : 'points');

function rowHtml({ team, place }, k, pct, tied, crowned) {
  return (
    `<li class="local-rank${crowned ? ' is-winner' : ''}" style="--team:${team.color};--pct:${pct.toFixed(3)};--i:${k}">` +
    `<span class="local-rank-place" aria-label="${tied ? 'Tied ' : ''}place ${place}">${place}</span>` +
    teamBadgeHtml(team, { size: 42 }) +
    `<span class="local-rank-main"><span class="local-rank-name">${escapeHtml(team.name)}</span>` +
    `<span class="local-rank-bar" aria-hidden="true"><span class="local-rank-fill"></span></span></span>` +
    `<b class="local-rank-score" aria-label="${team.score} ${pointsWord(team.score)}">0</b></li>`
  );
}

// Fill the (already showing) results screen for a finished game and play
// its entrance. Safe to call again: a newer call cancels the older one.
export async function showResults(game) {
  const t = ++token;
  const coop = game.teams.length === 1;
  const ranked = ranking(game.teams);
  const max = maxScore(game);
  const top = Math.max(1, ...game.teams.map((x) => x.score));
  const winners = ranked.filter((r) => r.place === 1);
  // Nobody scored (an easy 0-0 in a short game): a draw, but no crowns.
  const scoreless = !coop && winners[0].team.score === 0;
  // Co-op has nobody to beat: the crown goes with a rating worth celebrating,
  // so "Lost signal" never looks like a win.
  const rating = coop ? coopRating(game.teams[0].score, max) : null;
  const crowned = coop ? rating.celebrate : !scoreless;
  const placeCount = new Map();
  for (const r of ranked) placeCount.set(r.place, (placeCount.get(r.place) || 0) + 1);

  const title = $('local-results-title');
  const sub = $('local-results-sub');
  const podium = $('local-podium');
  let celebrate = true;

  if (coop) {
    const team = game.teams[0];
    title.textContent = rating.title;
    sub.innerHTML = `<b>${team.score}</b> / ${max} ${pointsWord(max)}`;
    celebrate = rating.celebrate;
  } else if (scoreless) {
    title.textContent = 'No points scored';
    sub.textContent = 'Nobody found the wavelength';
    celebrate = false;
  } else if (winners.length === 1) {
    title.textContent = `${winners[0].team.name} win!`;
    sub.textContent = `${winners[0].team.score} ${pointsWord(winners[0].team.score)}`;
  } else {
    title.textContent = "It's a tie!";
    sub.textContent = `${winners[0].team.score} ${pointsWord(winners[0].team.score)} each`;
  }

  // Always reassigned: the screen is reused, so old crowns must not linger.
  // An uncrowned co-op team still stands on the podium, just without a crown.
  podium.innerHTML = scoreless
    ? ''
    : winners
        .map(
          (w) =>
            `<span class="local-podium-team" style="--team:${w.team.color}">${crowned ? CROWN_SVG : ''}` +
            `${teamBadgeHtml(w.team, { size: winners.length > 2 ? 64 : 84 })}</span>`,
        )
        .join('');
  podium.classList.toggle('is-many', winners.length > 2);

  const list = $('local-ranking');
  list.classList.toggle('is-coop', coop);
  list.innerHTML = ranked
    .map((r, k) => rowHtml(r, k, coop ? r.team.score / max : r.team.score / top, placeCount.get(r.place) > 1, r.place === 1 && crowned))
    .join('');

  const rows = [...list.children];
  const scores = rows.map((li) => li.querySelector('.local-rank-score'));
  const reduce = reducedMotion();

  if (reduce) {
    rows.forEach((li) => li.classList.add('is-in'));
    ranked.forEach((r, k) => (scores[k].textContent = String(r.team.score)));
  } else {
    // Let the screen slide in, then the rows drop in one after another, the
    // bars grow and the numbers count up.
    for (const li of rows) li.classList.add('is-pre');
    for (const p of podium.children) p.style.opacity = '0';
    await sleep(160);
    if (t !== token) return;
    for (const p of podium.children) {
      p.style.opacity = '';
      popIn(p);
    }
    rows.forEach((li, k) => {
      setTimeout(() => {
        if (t !== token) return;
        li.classList.remove('is-pre');
        li.classList.add('is-in');
        countUp(scores[k], 0, ranked[k].team.score, { duration: 900 + k * 80 });
      }, 220 + k * 110);
    });
  }

  if (!celebrate) return;
  await sleep(reduce ? 0 : 420);
  if (t !== token) return;
  const badges = [...podium.querySelectorAll('.team-badge')];
  badges.forEach((b, k) => {
    const color = winners[k]?.team.color;
    setTimeout(() => {
      if (t === token) confettiFrom(b, { count: winners.length > 1 ? 70 : 120, colors: color ? [color, color, ...PARTY] : PARTY });
    }, k * 180);
  });
}

// Stop a running entrance (the screen is being left).
export function cancelResults() {
  token++;
}
