# Wavelength

The mind-reading party game, built with [Astro](https://astro.build) and vanilla
JavaScript. Fully static — hosted on GitHub Pages at
<https://hugolepage.github.io/wavelength/>.

## How to play

- **Draw a card** — every turn deals a spectrum card with two opposite ends, like
  *Bland ⟷ Spicy* or *Overrated ⟷ Underrated*.
- **The psychic peeks** — one player taps **Show target**: the shutter swings open and the
  target wheel spins in to a secret spot somewhere on the dial. They can hide it again,
  peek once more, or draw a new card (and a new target) before giving a clue.
- **Give a clue** — something that sits where the target is between the two ends: for
  *Bland ⟷ Spicy*, "salsa" belongs somewhere right of centre.
- **Turn the dial** — the others swing the needle to where they think the clue points
  (press or drag anywhere on the dial, or use the arrow keys), and **Lock in**.

The target is five bands, 2 · 3 · 4 · 3 · 2 points, centred on the secret spot. The
needle's band is what the turn scores; a bullseye (4) gets confetti.

There are 1000 spectrum cards (`src/data/spectra.json`), dealt from a shuffled deck so
none repeats within a game. The chili in the top bar swaps in a deck of grown-up cards
instead — see [Spicy mode](#spicy-mode).

### Pass & play

One device, passed around the table. Pick 1–6 teams and 1–10 rounds; each round every
team takes one turn. Every team gets a random name — an adjective and a critter, like
*Sneaky Foxes* — with that critter's low-poly logo on a disc of the team's colour (tap
the die to roll another). The screen always says who should be holding the device: each
turn opens on the pass to that team's psychic, whose one tap is **Show target**.

With two or more teams there is an optional **rival guess**: after a team locks in, the
next team calls whether the target is left or right of the needle, for 1 point — unless
the team hit the bullseye. With a single team the game is co-op: the final score is out
of rounds × 4 and earns a title, from *Lost signal* up to *Telepathic!*

The game is saved in `localStorage` after every step, so a reload or the home button
never loses it — the home screen offers **Resume**.

### Online

Two players on two devices, as a duo: they score together, and the psychic swaps every
round. The psychic types the clue, which pops up on the partner's screen as a speech
bubble; the partner's needle moves live on the psychic's screen while they turn it.
Either player can move on to the next round, and at the end the duo's score out of
rounds × 4 earns the same titles as co-op pass & play. **Rematch** sends a new challenge.

## Spicy mode

The chili pepper in the top bar, next to the moon/sun, switches to a second deck of
grown-up cards — dating, drinking, innuendo; adults only. Off it is a plain outline;
on, a red pepper with a green stem. The first time it is switched on in a browser a
small notice asks first (**Turn on** / **Not now**); a yes is remembered
(`localStorage['wavelength.spicy.ok']`) and never asked again, and switching it off
never asks. The setting itself is per browser (`localStorage['wavelength.spicy']`) and,
like the theme, is stamped on `<html data-spicy>` before the page paints, so the chili
never flashes the wrong colour.

- **Pass & play** deals each new card from whichever deck is on at that moment, so the
  chili can be flipped mid-game: a card whose target nobody has seen yet is swapped
  straight away, otherwise the change starts with the next card (a toast says so). The
  game keeps its own shuffled order of each deck, so no card repeats within a deck —
  across **Play again** too — and flipping back picks a deck up where it left off.
- **Online**, both players agree to the deck before a game starts. A challenge carries
  the challenger's setting at the moment it is sent (a rematch too), and a spicy one
  arrives with a red *Spicy* chip on its card; while your chili is on, the lobby shows
  the same chip next to the rounds, since your challenges will be spicy. The room
  records its deck when it is created and never changes it — every card of that game,
  redraws included, comes from it, and the game's header wears a little chili.
  Flipping the chili during an online game only affects the next one.

The 500 spicy cards live in `src/data/spicy_spectra.json`, in the same format as
`src/data/spectra.json` (pairs of opposite ends). If that list is empty (`[]`) the
chili still switches and shows its state, but every card — and every challenge — stays
classic. `src/scripts/spectra.js` holds both decks (`deckList`, `resolveDeck`) and
`src/scripts/spicy.js` the setting (`currentDeck()`).

## Multiplayer

**Before going live:** publish `database.rules.json` — Firebase console → Realtime
Database → Rules → replace everything → **Publish** (or `npm run deploy:rules`, see
[Deploying](#deploying)). Until then the database runs on the rules it was created with:
in test mode those let anyone overwrite or delete anything, and about 30 days in they
refuse every read and write, which ends online play.

The **Sign in** button in the top bar (or the Online card) signs you in with just a name
and a password — a name nobody has used yet becomes a new account on the spot. Once
signed in it opens the lobby: everyone else who is online, with a **Challenge** button
next to each name and a stepper for how many rounds (3–12) a challenge asks for, plus
your games, best score, points per round, bullseyes and your recent games.

A challenged player gets a card on their screen wherever they are (even mid pass &
play) and can accept or decline within a minute. Accepting creates a game room and sends
both players to `?session=ROOM_ID`; the link can be shared, reloaded or bookmarked — a
reload picks the game up exactly where it was, and anyone who is not one of the two
players just watches (without seeing the target before the reveal). **Leave** (tap twice)
ends the game for both; going back to the lobby or home only stops watching it, and the
game can be reopened from *Recent games*.

Everything lives in a Firebase Realtime Database — there is no server:

| Path | What it holds |
| --- | --- |
| `users/<name>/auth` | per-user salt, a verifier (SHA-256 of the PBKDF2-derived key) and `createdAt` |
| `users/<name>/profile` | the display name with the capitals it was signed up with (`name`), `createdAt`, and `lastLogin` (updated on every sign-in) |
| `users/<name>/stats` | `totals` (games, completed, abandoned, incomplete, rounds, points, bullseyes, best) and, under `partners/<partner>`, name, games, rounds, points, bullseyes, best |
| `users/<name>/matches` | one record per online game, whose `result` is `incomplete` until it ends, then `complete` or `abandoned` |
| `presence/<name>` | who is online and which room they are in |
| `challenges/<name>` | pending challenges addressed to that player: who from, how many `rounds`, and `spicy` (whether the game deals spicy cards) |
| `rooms/<id>` | the whole game: both players, its `deck` (`classic` or `spicy`, fixed when the room is created), the card and its target, the cards already dealt (indices into that deck), the clue, the guess, the score, every round's history and a step counter |
| `live/<id>` | the room's passing moment: the guesser's needle and the psychic's typing dots |

Every move is a database transaction that must advance the room's step counter by
exactly one, so two clients can never apply a move to the same moment of the game. The
`live` channel is written freely, outside the room, so a needle streaming ten times a
second never makes the other player's move collide with it. A game abandoned without
**Leave** stays `incomplete` in both players' records; the client that sees a game end,
from either side, completes both records at once.

The database URL is in `src/scripts/firebase.js`. `database.rules.json` holds the
security rules (published as above). They stop anyone from overwriting an existing
account's password and reject room writes that do not advance the step counter (or that
touch a finished game, change its players, its number of rounds or its deck). They also
type- and range-check the core room fields (`id`, `status`, `step`, `players`, `rounds`,
`round`, `firstPsychic`, `deck`, `phase`, the card's `target`, `clue`, `guess`,
`points`, `score`, `endReason`, `leftBy`, `statsRecorded`), the `live` channel, the
account's salt and verifier, the profile's `name` and the stats counters. They do not
shape-check a room's `history`, `used`, `createdAt` or `updatedAt`, the rest of a
profile, match records, presence or challenges (`spicy` included: a forged challenge
can only ask for a deck, and its card says so before anyone accepts). A room from
before spicy mode has no `deck` and is read as classic. Note that this is a casual game
login, not Firebase Authentication: the verifiers are readable, so players should not
reuse a password they care about, and the room — target included — is readable by
anyone who goes looking.

## Appearance

The moon/sun button in the top bar switches between the light theme and a dark one.
Until it is pressed the game follows the operating system's own light/dark setting; the
first press writes an explicit choice to `localStorage`. Every colour is a CSS custom
property declared twice in `src/styles/base.css` — once for each theme, the same
declarations in the same order. The theme is stamped onto `<html data-theme>` by an
inline script in `src/layouts/Layout.astro` before the page paints; that script cannot
import, so it repeats the storage key and the two `theme-color` values from
`src/scripts/theme.js` — keep the two in sync. A second inline script does the same for
[spicy mode](#spicy-mode) (`<html data-spicy>`, the storage key from
`src/scripts/spicy.js`).

The 24 critters are hand-built low-poly SVGs in `src/data/critters/`, inlined at build
time; online players wear one too, picked from their name.

## Development

```sh
npm install
npm run dev          # dev server at http://localhost:4321/wavelength (real Firebase)
npm run dev:fakedb   # dev server at http://localhost:4322/wavelength (fake database)
npm test             # unit tests (node --test)
npm run build        # static build into dist/
npm run preview      # serve the build
npm run deploy:rules # publish database.rules.json (after `npx firebase-tools login`)
```

### Trying online play on one machine

`npm run dev:fakedb` runs the site against an in-memory stand-in for the Firebase
database (`src/dev/fakedb/`, wired in by `astro.fakedb.config.mjs`), so nothing ever
reaches the real one. Open the game twice, on two different origins:

- <http://localhost:4322/wavelength/>
- <http://p2.localhost:4322/wavelength/>

Each origin keeps its own `localStorage`, so each can be signed in as a different
player, while both talk to the same database. Make up any names and passwords there.
Any `<name>.localhost` is one more such origin — `p3.localhost:4322` for a spectator, say.
Chrome, Edge and Firefox send `*.localhost` to this machine and treat it, like
`localhost`, as a secure context, which sign-in needs for its crypto. (Avoid
`npm run dev:fakedb -- --host`: the network address it prints cannot sign in, and it
opens the fake database, reset included, to everyone on your network.)

The fake database lives in the dev server's memory and is saved to
`node_modules/.fakedb/db.json`. `/__fakedb/dump` shows the whole tree, and
`fetch('/__fakedb/reset', { method: 'POST' })` from the browser console empties it. It
does not enforce `database.rules.json`, and the production build never includes it.

### Deploying

Pushes to `main` deploy automatically to GitHub Pages via `.github/workflows/deploy.yml`
(set the repository's Pages source to "GitHub Actions"). The site is built for the
`/wavelength` base path (`astro.config.mjs`).

**Before going live,** and again whenever `database.rules.json` changes, publish the
rules — the workflow does not. Paste them into the Firebase console (Realtime Database →
Rules → replace everything → Publish), or run `npx firebase-tools login` once and then
`npm run deploy:rules` (`firebase.json` and `.firebaserc` point it at this project).
A new database's test-mode rules are wide open and lock everyone out about 30 days in.
To check, append `/.json?shallow=true` to the database URL: it must now answer 401
*Permission denied*, while `/presence.json?shallow=true` still answers 200. Then play
one online game for real — sign up on two devices, challenge, accept, play a round,
**Leave** — since the fake database never runs the rules.
