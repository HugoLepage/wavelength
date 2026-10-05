// Per-player statistics for online games, under /users/<name>:
//   stats/totals               { games, completed, abandoned, incomplete,
//                                rounds, points, bullseyes, best }
//   stats/partners/<partner>   { name, games, rounds, points, bullseyes, best }
//   matches/<roomId>           one record per online game
//
// Every game is written as `incomplete` (in the same write that creates the
// room) and flipped to 'complete' or 'abandoned' when the room finishes, so a
// game both players walked away from mid-round simply stays incomplete.
// Counters only ever move through increment() on leaf paths, and `best`
// through a max() transaction, so concurrent writers never wipe each other.
// `best` only counts completed games — a half-played game is not a record.

import {
  increment, limitToLast, onValue, orderByChild, query, ref, runTransaction, serverTimestamp, update,
} from 'firebase/database';
import { db, dbRef } from './firebase.js';
import { displayNameOf } from './auth.js';
import { MAX_POINTS } from './scoring.js';
import { clampRounds } from './room-logic.js';

// A stats claim on a finished room older than this is considered abandoned
// (the claiming tab died between claiming and writing) and may be retaken.
const CLAIM_TTL_MS = 30_000;

const rootUpdate = (updates) => update(ref(db), updates);

// Both players' "game started" records, as multi-path entries so the caller
// can write them in the same update that creates the room:
//   createRoom({ ..., extraUpdates: onlineStartEntries(id, players, rounds) })
// Names arrive from world-writable places (a challenge, a profile), and the
// rules refuse a partner name that is not a short string — which would sink
// the room with it — so anything but a spelling of the uname becomes the uname.
export function onlineStartEntries(roomId, players, rounds) {
  const out = {};
  players.forEach((p, seat) => {
    const partner = players[1 - seat];
    const partnerName = displayNameOf(partner.name, partner.uname);
    const u = `users/${p.uname}`;
    out[`${u}/matches/${roomId}`] = {
      mode: 'online',
      roomId,
      seat,
      partner: partner.uname,
      partnerName,
      rounds: clampRounds(rounds),
      played: 0,
      score: 0,
      bullseyes: 0,
      result: 'incomplete',
      startedAt: serverTimestamp(),
    };
    out[`${u}/stats/totals/games`] = increment(1);
    out[`${u}/stats/totals/incomplete`] = increment(1);
    out[`${u}/stats/partners/${partner.uname}/name`] = partnerName;
    out[`${u}/stats/partners/${partner.uname}/games`] = increment(1);
  });
  return out;
}

// What a finished room adds to each player's record.
export function matchSummary(room) {
  const history = room.history || [];
  return {
    result: room.endReason === 'left' ? 'abandoned' : 'complete',
    score: room.score || 0,
    played: history.length,
    bullseyes: history.filter((h) => h.points === MAX_POINTS).length,
  };
}

// Raise a stored best to `score` (never lower it).
function raiseBest(path, score) {
  return runTransaction(dbRef(...path), (v) =>
    (typeof v === 'number' && v >= score ? undefined : score));
}

// Called by whoever sees the room finished (both players, any spectator). A
// transaction on the room's `statsRecorded` flag hands the job to exactly one
// client at a time: it records a timestamped claim, raises the bests (safe to
// repeat), then writes both players' results together with the final `true`
// in one update. A claim left behind by a tab that died in between can be
// retaken after CLAIM_TTL_MS, so a player who closed the tab still gets their
// record completed by the other side (or a later visit to the room).
// Resolves true when this call wrote the stats.
export async function finalizeOnlineMatch(room, myUname) {
  if (!room || room.status !== 'finished' || room.statsRecorded === true) return false;
  let guard;
  try {
    guard = await runTransaction(dbRef('rooms', room.id, 'statsRecorded'), (v) => {
      if (v === true) return undefined;
      if (v && typeof v === 'object' && Date.now() - (v.at || 0) < CLAIM_TTL_MS) return undefined;
      return { by: myUname || 'anon', at: Date.now() };
    });
  } catch (err) {
    console.error('stats', err);
    return false;
  }
  if (!guard.committed) return false;

  const sum = matchSummary(room);
  const complete = sum.result === 'complete';
  const updates = { [`rooms/${room.id}/statsRecorded`]: true };
  room.players.forEach((p, seat) => {
    const partner = room.players[1 - seat];
    const u = `users/${p.uname}`;
    const m = `${u}/matches/${room.id}`;
    Object.assign(updates, {
      [`${m}/result`]: sum.result,
      [`${m}/score`]: sum.score,
      [`${m}/played`]: sum.played,
      [`${m}/bullseyes`]: sum.bullseyes,
      [`${m}/endReason`]: room.endReason || null,
      [`${m}/leftBy`]: room.leftBy === 0 || room.leftBy === 1 ? room.players[room.leftBy].uname : null,
      [`${m}/endedAt`]: serverTimestamp(),
      [`${u}/stats/totals/incomplete`]: increment(-1),
      [`${u}/stats/totals/${complete ? 'completed' : 'abandoned'}`]: increment(1),
      [`${u}/stats/totals/rounds`]: increment(sum.played),
      [`${u}/stats/totals/points`]: increment(sum.score),
      [`${u}/stats/totals/bullseyes`]: increment(sum.bullseyes),
      [`${u}/stats/partners/${partner.uname}/rounds`]: increment(sum.played),
      [`${u}/stats/partners/${partner.uname}/points`]: increment(sum.score),
      [`${u}/stats/partners/${partner.uname}/bullseyes`]: increment(sum.bullseyes),
    });
  });
  try {
    if (complete) {
      await Promise.all(room.players.flatMap((p, seat) => {
        const partner = room.players[1 - seat];
        return [
          raiseBest(['users', p.uname, 'stats', 'totals', 'best'], sum.score),
          raiseBest(['users', p.uname, 'stats', 'partners', partner.uname, 'best'], sum.score),
        ];
      }));
    }
    await rootUpdate(updates);
    return true;
  } catch (err) {
    console.error('stats', err);
    return false; // the claim expires and someone retries
  }
}

// --- lobby views ------------------------------------------------------------------

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);

const TOTAL_KEYS = ['games', 'completed', 'abandoned', 'incomplete', 'rounds', 'points', 'bullseyes', 'best'];

export function normalizeTotals(v) {
  const t = {};
  for (const k of TOTAL_KEYS) t[k] = n(v && v[k]);
  return t;
}

// cb({ totals, partners }) on every change:
//   totals   { games, completed, abandoned, incomplete, rounds, points, bullseyes, best }
//   partners [{ uname, name, games, rounds, points, bullseyes, best }], most games first
// Returns an unsubscribe.
export function watchStats(uname, cb) {
  return onValue(dbRef('users', uname, 'stats'), (snap) => {
    const v = snap.val() || {};
    const partners = Object.entries(v.partners || {})
      .filter(([, p]) => p && typeof p === 'object')
      .map(([key, p]) => ({
        uname: key,
        name: displayNameOf(p.name, key),
        games: n(p.games),
        rounds: n(p.rounds),
        points: n(p.points),
        bullseyes: n(p.bullseyes),
        best: n(p.best),
      }))
      .filter((p) => p.games > 0)
      .sort((a, b) => b.games - a.games || b.points - a.points || a.name.localeCompare(b.name));
    cb({ totals: normalizeTotals(v.totals), partners });
  }, () => cb({ totals: normalizeTotals(null), partners: [] }));
}

// cb([match]) newest first, at most `limit`:
//   { id, mode, roomId, seat, partner, partnerName, rounds, played, score,
//     bullseyes, result: 'incomplete'|'complete'|'abandoned', endReason,
//     leftBy, startedAt, endedAt }
// Returns an unsubscribe.
export function watchRecentMatches(uname, cb, limit = 10) {
  const q = query(dbRef('users', uname, 'matches'), orderByChild('startedAt'), limitToLast(limit));
  return onValue(q, (snap) => {
    const list = [];
    snap.forEach((child) => {
      const m = child.val() || {};
      list.push({
        id: child.key,
        mode: m.mode || 'online',
        roomId: m.roomId || child.key,
        seat: m.seat === 1 ? 1 : 0,
        partner: m.partner || '',
        partnerName: displayNameOf(m.partnerName, m.partner || '?'),
        rounds: n(m.rounds),
        played: n(m.played),
        score: n(m.score),
        bullseyes: n(m.bullseyes),
        result: m.result === 'complete' || m.result === 'abandoned' ? m.result : 'incomplete',
        endReason: m.endReason || null,
        leftBy: m.leftBy || null,
        startedAt: n(m.startedAt),
        endedAt: n(m.endedAt),
      });
    });
    list.sort((a, b) => b.startedAt - a.startedAt);
    cb(list);
  }, () => cb([]));
}
