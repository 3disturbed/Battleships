# Battleships — Software Design Document

Version 1.0 · 2026-08-19 · Target platform: browsers (mobile-first), hosted on
the DarksGames server at `battleships.darksgames.app`.

---

## 1. Vision & design pillars

Battleships is the game you play when a friend says "got five minutes?". It is
the classic pen-and-paper game rebuilt around three pillars, in priority order:

1. **Never make anyone wait.** No accounts, no downloads, no matchmaking queue,
   and — in the default mode — no turns. Every second of a session either has
   the player doing something or watching something worth watching.
2. **Decisions beat dice.** Classic Battleships is ~80% luck. Ship abilities,
   intel gathering, and shot-pattern choice move the skill share up without
   burying the casual player in rules. A new player must be able to play their
   first game with zero tutorial and lose *wanting a rematch*.
3. **Juice is a feature.** Every shot has an arc, a splash or a plume, a sound
   and a screen response. The reveal at the end of a game is a moment, not a
   table.

**Success criteria (v1):** median session ≥ 2 games (rematch rate > 50%);
median game length 3–6 minutes; a first-time guest reaches the placement screen
in < 15 seconds from clicking the invite link.

## 2. Market position

The browser Battleships space is crowded with ad-heavy, login-walled, or
turn-based-by-email implementations. None of the popular ones (papergames.io,
battleship-game.org, plays.org variants) offer *simultaneous* play, abilities,
or a friction-free invite loop on a fast independent domain. Our differentiators:

- **Blitz simultaneous volleys** — genuinely novel in this genre; kills the
  single biggest complaint (waiting).
- **Invite-link-first** — the URL *is* the lobby. Web Share API on mobile.
- **No ads, no login, no cookie walls** — DarksGames house style.
- **Comeback mechanics** — rubber-band Energy keeps both players engaged, which
  directly drives the rematch rate.

## 3. Game design

### 3.1 The fleet

Both players place the same five ships on their grid (10×10 default):

| Ship | Size | Ability (usable while the ship is afloat) | Energy cost |
|---|---|---|---|
| Carrier | 5 | **Recon Flight** — reveal ship-presence in a chosen 3×3 area (marks persist) | 5 |
| Battleship | 4 | **Big Guns** — one shot in your next volley becomes a cross pattern (center + 4 orthogonal) | 4 |
| Cruiser | 3 | **Decoy Buoy** — place a hidden decoy on an empty cell; the first enemy shot to hit it reports HIT (then reveals as a decoy at game end) | 3 |
| Submarine | 3 | **Sonar Ping** — pick any cell; learn the Chebyshev distance from it to the nearest surviving enemy ship | 3 |
| Destroyer | 2 | **Full Steam** — relocate the destroyer to any legal position (only if it is unhit; once per game) | 4 |

Abilities die with their ship — protecting the carrier is worth something, and
sinking one visibly weakens the opponent (the kill banner names the lost
ability). At most **one ability per round** may be activated.

### 3.2 Energy & the comeback curve

- +1 Energy per round, automatically.
- +2 Energy each time one of **your** ships is sunk.
- Energy caps at 8; unspent Energy carries over.

The player who is behind reaches ability thresholds faster. This is deliberate
rubber-banding: it does not hand out free hits (abilities gather intel or shape
shots, they don't auto-win), but it keeps the losing player making interesting
choices instead of passively dying.

### 3.3 Blitz mode (default) — the round loop

1. **Aim phase (15s, or 10s turbo).** Each player places their volley: number
   of shots = number of their surviving ships (minimum 2). Tap cells to arm,
   tap again to disarm; optionally trigger one ability. A visible clock ticks;
   at zero the volley locks. Unaimed shots auto-scatter over unrevealed cells
   so an AFK opponent never stalls the game.
2. **Resolve phase (~2.5s, server-timed lockstep).** Both volleys land
   *simultaneously* in one choreographed barrage: shells arc, splashes and
   plumes bloom, sinks get a banner. Both players watch the same moment.
3. Repeat. First fleet fully sunk loses.

**Mutual destruction:** if both fleets die in the same resolve, the winner is
the player who fired *fewer shells* to do it (efficiency tiebreak — hit totals
are always equal when both fleets are fully sunk); if tied, the game is a
genuine draw with a full-screen "MUTUAL DESTRUCTION" moment — rare and
screenshot-worthy.

**Forfeit rules:** 3 consecutive fully-auto-scattered volleys (no player input)
= forfeit. Disconnection beyond the reconnect grace period (§6.4) = forfeit,
claimable by the opponent.

### 3.4 Classic mode

Alternating single shots, no abilities, no Energy — the pen-and-paper rules
for purists, selectable in lobby settings. Hit grants another shot (house
rule toggle, default off). Shares every screen and system with Blitz; only the
round engine differs.

### 3.5 Placement phase

60-second timer, running for both players concurrently (whoever finishes first
sees "waiting — opponent still placing"). Drag to move, tap/press-space to
rotate, **Shuffle** for a fresh random legal layout, **Ready** to lock early.
Ships may touch but not overlap. At timeout, unplaced ships are auto-placed.
Placement is where casuals feel safe — the shuffle button means nobody is ever
stuck being bad at layout.

### 3.6 Match flow & rematch loop

```
Create room ──► Lobby (share link, settings, ready-up)
                  │ both ready
                  ▼
             Placement (60s) ──► Battle (round loop) ──► Victory screen
                  ▲                                          │
                  └────────────── Rematch (both tap, 30s) ◄──┘
```

The victory screen shows: winner, series score (best-of-N), full board reveal
with a quick replay of the killing volley, and stats — accuracy, longest hit
streak, biggest volley, decoy dupes. The **Rematch** button is the largest
element on the screen. Series alternates nothing (placement is simultaneous;
there is no first-move advantage in Blitz).

### 3.7 Juice specification

- **Shots:** shell arc with travel time (~450ms, staggered 80ms per shell),
  whistle → splash (miss, ring ripple) or plume + flash + 150ms screen shake
  (hit). Hits leave a burning marker; streaks of 3+ set the streak counter on
  fire.
- **Sinks:** slow-mo 300ms, ship silhouette revealed, banner ("Destroyer down!
  Enemy lost: Full Steam"), deep thud + bubbles.
- **Ambient:** subtle sea shimmer on the boards, gull cries at low frequency,
  sonar ping loop during aim phase that tightens as the clock runs down.
- **Emotes:** 8 canned quick-chats ("gg", "lucky!", "nooo", "😱", …) shown as
  speech bubbles; throttled to 1 per 4s; mutable.
- **Haptics:** `navigator.vibrate` pulses on hit received / ship lost (mobile).
- All audio behind a mute toggle persisted in localStorage; everything renders
  fine with reduced-motion media query honored (no shake, instant resolves).

### 3.8 Bot opponents

No friend around? The host can seat a bot from the lobby (empty seat, host
only) at one of five levels, and dismiss it any time in the lobby or after a
game to free the seat for a human:

| Lv | Rank | Behavior |
|---|---|---|
| 1 | Deckhand 🐣 | random fire, no follow-up, no abilities |
| 2 | Ensign 🪝 | chases hits with adjacent shots |
| 3 | Captain 🧭 | parity hunting, line-following target mode, occasional sonar |
| 4 | Commodore 🎖️ | probability-density hunting, purposeful abilities (big guns, recon, decoy) |
| 5 | Admiral 👑 | exact density, recon-led targeting, the full ability book incl. escape-by-full-steam |

Fairness is structural: the bot decides from `project(state, seat)` — the same
masked per-player view a human client renders from — and plays through the
same validated actions. It cannot see hidden ships, and a decoy dupes it
exactly like a person (levels 2+ will waste shells hunting the buoy). Bots
"think" on humanlike delays (~1–3s), ready up instantly, always accept a
rematch, are always "present" (no claim-victory against a bot), and never
keep a room alive — empty-room GC applies as usual.

### 3.9 Identity

Nickname (2–16 chars, sanitized) + a color/emoji avatar pair chosen from a
fixed palette; persisted in localStorage. No accounts in v1 — see §12 for the
dg-accounts integration path.

## 4. UX flows

### 4.1 Host

1. Land on `battleships.darksgames.app` → big **Play with a friend** button.
2. Nickname prompt (pre-filled from localStorage on return visits).
3. Room created → lobby screen with the invite link front and center:
   `https://battleships.darksgames.app/#QK7F3M` — **Share** button (Web Share
   API where available, clipboard copy fallback with "Copied!" toast).
4. Settings panel (mode/grid/timer/series) — host only; guests see them live.
5. Both players tap **Ready** → placement begins.

### 4.2 Guest

1. Click the link anywhere → page loads, sees "«Ash» invited you to
   Battleships" + nickname prompt → in the lobby. **Two taps total.**
2. Room full? Offer spectate (v1.1, §12) or "start your own game".
3. Room gone/expired? Clear message + **Play with a friend** button.

### 4.3 Reconnect

Mid-battle refresh or connection blip: the client auto-reconnects with its
`reconnectToken` (localStorage). The opponent sees "Ash is reconnecting… 90s"
with a claim-victory button that arms when the grace expires. A reconnected
player gets a full state snapshot and play resumes at the current phase.

### 4.4 Errors

Every failure path lands on a human sentence and one button. No dead ends:
"Room QK7F3M has expired — start a new game and send a fresh link."

## 5. Architecture overview

```
Browser A ──┐  wss://battleships.darksgames.app/ws
            ├──► nginx (TLS, static public/, WS upgrade passthrough)
Browser B ──┘            │
                         ▼ proxy 127.0.0.1:<PORT from .env>
                  node server.js  (darksgame@battleships, user "darks")
                  ├── HTTP: /healthz, static fallback (dev only)
                  ├── WS hub: connection registry, heartbeats
                  └── Rooms (in-memory Map<code, Room>)
                        └── Game core (pure, deterministic, fully unit-tested)
```

- **Single Node process, in-memory state.** A room is a few KB; thousands of
  concurrent rooms fit in tens of MB. No database in v1. A process restart
  drops live games — acceptable at this stage (games last minutes) and made
  rare by `Restart=on-failure` + the deploy procedure (PLAN M5).
- **Server-authoritative by construction.** Ship layouts live only server-side.
  The client is a renderer + input device; it receives exactly the information
  a player is entitled to see. There is nothing to cheat with in the wire
  format or devtools.
- **The game core is pure.** `game/` modules have no I/O, no timers, no
  sockets — functions from (state, action) → (state', events). All timers and
  transport live at the edges. This is what makes the test suite (§9) cheap
  and the Classic/Blitz mode split clean.

## 6. Server design

### 6.1 Modules

```
server.js            — boot: env, HTTP + WS listeners, wiring, /healthz
lib/hub.js           — connection lifecycle, heartbeat (30s ping), rate limiting
lib/rooms.js         — room registry: create/join/GC, code allocation
lib/protocol.js      — message parse/validate (schema per type), version gate
lib/timers.js        — per-room phase deadline scheduling (single setTimeout each)
game/state.js        — room state machine: LOBBY→PLACEMENT→BATTLE→GAMEOVER
game/placement.js    — layout validation, auto-place, shuffle
game/battle.js       — volley resolution, hits/sinks, energy, win/draw logic
game/abilities.js    — the five abilities: validation + effects
game/view.js         — per-player state projection (what each side may see)
```

### 6.2 Room lifecycle

- Codes: 6 chars from a 32-symbol alphabet (A–Z minus I/O, digits 2–9) —
  ~1.07 × 10⁹ combinations; collision-checked on allocation.
- GC sweep every 60s: empty rooms after 10 min, finished rooms 5 min after
  game over, abandoned mid-game rooms 5 min after the last socket drops.
- Cap: 500 concurrent rooms (config `MAX_ROOMS`); beyond it, creation fails
  with a friendly "server is packed" message. (Capacity, not expectation.)

### 6.3 Phase state machine

States: `LOBBY → PLACEMENT → AIM ⇄ RESOLVE → GAMEOVER (→ PLACEMENT on rematch)`.
Every client message type is legal in exactly one (or two) states —
`protocol.js` rejects anything else without touching game state. Every timed
phase has exactly one server-side deadline; client clocks render countdowns
from `deadlineAt` timestamps but the server's timer is the only authority.

### 6.4 Reconnect & presence

Each seat in a room holds `{ playerId, reconnectToken (uuid), ws | null }`.
Socket drop in LOBBY: seat is freed after 60s. In battle: game pauses (AIM
deadline frozen), opponent notified, 90s grace; token rejoin restores the
seat, sends a full snapshot (via `game/view.js`), unfreezes. After grace, the
opponent's claim-victory becomes active — the game does not auto-forfeit,
letting a merciful opponent wait longer.

### 6.5 Fairness & anti-abuse

- All state transitions validated server-side; volley legality (count, bounds,
  no repeats vs. already-resolved cells) enforced on lock, not trusted.
- Auto-scatter for missing shots is drawn server-side from unrevealed cells.
- Join attempts rate-limited (per-IP token bucket, 10/min) — room brute force
  at 32⁶ keyspace is hopeless at that rate.
- Per-connection message rate limit (20/s soft-drop, 60/s disconnect).
- Nicknames: length-clamped, control/zero-width chars stripped, rendered as
  text only (no HTML paths anywhere — canvas + `textContent`).
- WS origin check against the canonical host (belt-and-braces; the state
  machine is safe regardless).

## 7. Protocol specification

JSON text frames over a single WS connection, `{ "t": <type>, ... }`,
protocol-versioned in the hello (`v: 1`); mismatch → `error{code:"version"}`.

### 7.1 Client → server

| Type | Payload | Legal in |
|---|---|---|
| `hello` | `v, name, avatar, reconnectToken?` | on connect |
| `create` | `settings {mode, grid, aimTimer, series}` | after hello |
| `join` | `roomCode` | after hello |
| `settings` | partial settings (host only) | LOBBY |
| `ready` | `ready: bool` | LOBBY |
| `layout` | `ships: [{id, x, y, dir}]` (lock placement) | PLACEMENT |
| `aim` | `cells: [{x,y}]` (idempotent full set) | AIM |
| `ability` | `kind, target {…kind-specific}` | AIM |
| `lock` | — (early volley lock) | AIM |
| `emote` | `id (0–7)` | any in-room |
| `rematch` | — | GAMEOVER |
| `addBot` | `level (1–5)` (host only, empty seat) | LOBBY |
| `removeBot` | — (host only) | LOBBY, GAMEOVER |
| `claim` | — (claim win after grace) | BATTLE paused |
| `leave` | — | any |

### 7.2 Server → client

| Type | Payload highlights |
|---|---|
| `welcome` | `playerId, reconnectToken, roomCode?` |
| `room` | full lobby view: seats, names/avatars, settings, ready flags |
| `phase` | `phase, deadlineAt, round` |
| `placed` | own layout ack / auto-place result |
| `resolve` | both volleys: per-shot `{x, y, result: miss|hit|sink|decoy}`, sink details, streaks, energy deltas — the client choreographs the barrage from this one message |
| `intel` | ability results visible to you (recon marks, sonar distance) |
| `snapshot` | full per-player state projection (on reconnect) |
| `presence` | opponent connected/reconnecting/grace-expired |
| `over` | winner, reason (sunk/forfeit/claim/draw), reveal boards, stats, series |
| `error` | `code, message` (human-readable, client shows verbatim) |

The `resolve` message is the heart of the wire format: one atomic message per
round carrying everything both animations need, so client and server never
negotiate mid-animation and a dropped frame can't desync the game.

## 8. Client design

No framework, no build step (DarksGames house style). ES modules served as-is.

```
public/index.html      — single page, all screens as <section>s
public/css/game.css    — layout + screen transitions (mobile-first)
public/js/app.js       — screen router, boot, localStorage identity
public/js/net.js       — WS connect/reconnect/backoff, message dispatch
public/js/lobby.js     — lobby screen, share link, settings
public/js/place.js     — placement board: drag/rotate/shuffle
public/js/battle.js    — aim input + resolve choreography
public/js/board.js     — canvas board renderer (two instances: yours/theirs)
public/js/fx.js        — particles, shake, arcs, streak fire
public/js/sfx.js       — WebAudio: generated/sampled one-shots, mute toggle
```

- **Rendering:** each board is a `<canvas>` (devicePixelRatio-aware). Grid,
  ships, markers, and FX draw in layered passes in one rAF loop that idles
  (no scheduled frame) outside animations — battery-friendly.
- **Layout:** phones show ONE board at a time behind a two-tab bar — "My
  Shots" (enemy waters) and "My Ships" — auto-switched by game flow: aiming
  selects My Shots, an incoming barrage flips to My Ships (your volley plays
  out first, then the view flips for theirs), targeting a self-board ability
  (decoy, full steam) flips to My Ships, and in Classic mode the enemy's turn
  watches your own fleet. A manual tab tap holds until the flow moves on.
  Desktop (≥760px) hides the tabs and shows both boards side by side. Hit
  targets ≥ 40px.
- **Resilience:** `net.js` owns reconnect with exponential backoff and resumes
  from `snapshot`; every screen renders purely from the latest server state,
  so a refresh at any moment lands you exactly where you were.

## 9. Testing

House style (per the snerf precedent): **`npm run check`** is the gate and
must pass on the deployed tree.

- `check:syntax` — `node --check` over every server + client module.
- `check:unit` — `node:test` suites over the pure game core:
  - placement: bounds, overlap, auto-place always legal, shuffle legality;
  - battle: volley resolution truth table, salvo counts, minimum-2 rule,
    streaks, energy accrual incl. comeback bonus, win/draw/tiebreak;
  - abilities: each of the five — legality windows, effects, one-per-round,
    death-disables;
  - state machine: every message type × every phase (illegal = rejected, state
    untouched);
  - reconnect: snapshot round-trips (project → restore → identical view);
  - protocol fuzz: malformed/truncated/type-confused JSON never throws, never
    mutates state.
- `check:smoke` — jsdom boot of `public/js/*.js` against a mocked WS: create →
  join → place → one full round → resolve renders without error. (jsdom is a
  devDependency; the smoke script lives in the repo and runs in checkouts —
  keep it copied on deploy so the live tree stays checkable.)

Manual playtest gates are defined per-milestone in PLAN.md — "feels fun" has
human sign-off, not a unit test.

## 10. Deployment & operations (DarksGames server)

- **Tree:** `/srv/darksgames/games/battleships`, owner `darks:darks`.
- **Registration:** `add-game battleships.darksgames.app battleships` —
  allocates the next free port into `.env` (merge-safe), writes the vhost
  (static from `public/`, `@node` fallback carries the WebSocket upgrade via
  `snippets/darksgames/proxy.conf`), gets the certificate (the
  `*.darksgames.app` wildcard DNS already points here), enables
  `darksgame@battleships`.
- **Process:** `npm start` → `node server.js`; `PORT` from `.env`;
  `NODE_ENV=production` from the unit. The unit sandboxes writes to the game
  dir — the server writes nothing to disk anyway (logs to stdout →
  `journalctl -u darksgame@battleships`).
- **`proxy_read_timeout` is 300s** — the 30s WS heartbeat keeps idle
  connections comfortably inside it.
- **Staging first:** every risky change ships to a disposable wildcard
  subdomain (`battleships-staging.darksgames.app`) via `add-game`, is
  playtested, then promoted; the staging vhost is torn down after. Full
  procedure in PLAN.md M5.
- **Health:** `GET /healthz` → `{ ok, rooms, uptime }` for spot checks.

## 11. Performance targets

- Action → opposing client broadcast: < 100ms server-side budget (in practice
  sub-ms; the budget covers GC pauses).
- Steady-state memory: < 10KB per active room; 500 rooms ≪ 100MB.
- Client: 60fps resolve animation on a mid-range phone; initial page weight
  < 150KB uncompressed (no frameworks, generated audio where feasible).

## 12. Future (explicitly out of v1 scope)

- **Spectators** — third+ visitors on a full room's link watch the battle
  (seeing only revealed information for both sides).
- **dg-accounts integration** — optional sign-in via the existing accounts
  service (`darksgames.app/api`, port 3018) for cross-device stats,
  leaderboards, and cosmetic unlocks. The s2s pattern already exists.
- **Quick match** — a lightweight public queue once traffic justifies it.
- **Cosmetics** — ship skins / shot trails; the only place monetization would
  ever live. Never pay-for-power.
- **Bots** — a practice opponent (the auto-scatter + a probability-density
  targeter is 80% of one already).

## 13. Open decisions (deliberately deferred to playtests)

- Aim timer defaults (15s may prove too generous once players are warm).
- Energy tuning (costs 3–5, +2 on ship loss) — numbers in `game/abilities.js`
  are constants, expected to move after M4 playtesting.
- Whether Classic mode's "hit grants another shot" toggle defaults on.
