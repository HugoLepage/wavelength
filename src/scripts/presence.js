// Who is online right now. Every signed-in tab owns one entry under
// /presence/<name>/conns and registers an onDisconnect removal for it, so the
// server drops the entry when that socket dies — no heartbeat needed, and a
// player with two tabs open stays online until the last one goes.

import { onDisconnect, onValue, push, ref, remove, serverTimestamp, update } from 'firebase/database';
import { db, dbRef } from './firebase.js';
import { displayNameOf } from './auth.js';

let me = null;
let connRef = null;
let armedConn = null; // connRef once its onDisconnect removal is registered
let unsubConnected = null;
let currentRoom = null;

export function startPresence(user) {
  stopPresence();
  me = user;
  const conn = push(dbRef('presence', user.uname, 'conns'));
  connRef = conn;
  // `.info/connected` turns true on every (re)connection, so the onDisconnect
  // hook is re-armed and the entry rewritten after a dropped connection too.
  unsubConnected = onValue(dbRef('.info/connected'), (snap) => {
    if (me !== user || connRef !== conn) return;
    if (snap.val() !== true) {
      armedConn = null;
      return;
    }
    onDisconnect(conn).remove()
      .then(() => {
        if (me !== user || connRef !== conn) return undefined; // stopped meanwhile
        armedConn = conn;
        return update(ref(db), {
          [`presence/${user.uname}/name`]: user.name,
          [`presence/${user.uname}/lastSeen`]: serverTimestamp(),
          [`presence/${user.uname}/conns/${conn.key}`]: { room: currentRoom, since: serverTimestamp() },
        });
      })
      .catch((err) => console.error('presence', err));
  });
}

export async function stopPresence() {
  if (unsubConnected) {
    unsubConnected();
    unsubConnected = null;
  }
  const user = me;
  const conn = connRef;
  me = null;
  connRef = null;
  armedConn = null;
  currentRoom = null;
  if (!user || !conn) return;
  try {
    await onDisconnect(conn).cancel();
    await remove(conn);
    await update(dbRef('presence', user.uname), { lastSeen: serverTimestamp() });
  } catch (err) {
    console.error('presence', err);
  }
}

// Which room this tab is sitting in (null when in the lobby / a local game).
// Written straight away only once the entry is armed for removal: a write
// before that could outlive a tab that closes in between, leaving a ghost
// "in a game" entry nothing ever removes. (Until then the arming write above
// picks up `currentRoom` itself.)
export function setPresenceRoom(roomId) {
  currentRoom = roomId || null;
  if (me && connRef && armedConn === connRef) update(connRef, { room: currentRoom }).catch(() => {});
}

// Collapse one player's node into { uname, name, online, room, lastSeen }.
// Anyone can write presence, so the name is checked (a number would even
// break the sort below).
export function summarizePresence(uname, v) {
  const conns = v && v.conns ? Object.values(v.conns).filter(Boolean) : [];
  return {
    uname,
    name: displayNameOf(v && v.name, uname),
    online: conns.length > 0,
    room: conns.map((c) => c.room).find(Boolean) || null,
    lastSeen: (v && v.lastSeen) || 0,
  };
}

// cb receives [{ uname, name, online, room, lastSeen }] for every *other*
// online player, sorted by name. Returns an unsubscribe.
export function watchOnlinePlayers(cb) {
  return onValue(dbRef('presence'), (snap) => {
    const list = [];
    snap.forEach((child) => {
      const p = summarizePresence(child.key, child.val());
      if (p.online && child.key !== me?.uname) list.push(p);
    });
    list.sort((a, b) => a.name.localeCompare(b.name));
    cb(list);
  }, (err) => {
    console.error('presence', err);
    cb([]);
  });
}

// cb receives { uname, name, online, room, lastSeen } for one player.
export function watchPlayer(uname, cb) {
  return onValue(dbRef('presence', uname), (snap) => cb(summarizePresence(uname, snap.val())),
    () => cb(summarizePresence(uname, null)));
}
