# Battleships

**Sink your mates in five minutes. No signups, no downloads — send a link, they're in.**

▶ Play (once deployed): **https://battleships.darksgames.app**

Battleships is a fast, juicy, lobbied multiplayer take on the classic. One player
creates a room, taps **Share**, and sends the link over WhatsApp/Discord/SMS.
The friend clicks it and lands straight in the lobby. Sixty seconds of ship
placement, then the signature **Blitz mode**: both players aim *simultaneously*
every round and the volleys land together in one cinematic barrage. Nobody ever
sits waiting for "their turn".

## Why it's fun (the pitch)

- **Zero friction** — link → nickname → playing, in under 15 seconds.
- **No dead time** — simultaneous volley rounds mean both players are always
  aiming, always sweating the same 15-second clock.
- **Real decisions, not just luck** — each surviving ship grants an ability
  (recon flight, cross-pattern barrage, sonar ping, decoy buoy, emergency
  relocation). Protecting ships matters; losing one hurts twice.
- **Comebacks are designed in** — losing a ship grants bonus Energy, so the
  player who's behind unlocks abilities faster. Games stay tense to the end.
- **Juice everywhere** — shell arcs, water plumes, screen shake, hit streaks on
  fire, a "MUTUAL DESTRUCTION" screen for the 1-in-a-thousand double KO.
- **Built for rematches** — one tap, best-of-3/5 series scoring, 3–6 minute games.
- **Nobody around? Fight a bot** — five ranks from Deckhand (fires wild) to
  Admiral (shows no mercy), added from the lobby in one tap. Bots see only
  what a human sees — your decoy fools them too.

## Modes & settings (host chooses in the lobby)

| Setting | Options |
|---|---|
| Mode | **Blitz** (simultaneous volleys + abilities, default) · Classic (alternating single shots) |
| Grid | 10×10 standard · 8×8 quick |
| Aim timer | 15s standard · 10s turbo |
| Series | Best of 1 · 3 · 5 |

## Repo contents

- [SDD.md](SDD.md) — the full software design document: game design, protocol,
  server/client architecture, security, testing, deployment.
- [PLAN.md](PLAN.md) — the milestone-by-milestone implementation plan, written
  to be executed by Claude Code running on the DarksGames production server.

## Tech at a glance

Plain Node.js (`ws` is the only runtime dependency) with a server-authoritative
game core — ship positions never leave the server until the reveal, so
cheating by packet inspection is impossible by construction. The client is
dependency-free vanilla JS + canvas, served as static files. No build step,
in keeping with the rest of the DarksGames catalog.

## Running locally

```
npm install
npm start          # serves http://localhost:3000 and ws://localhost:3000/ws
```

Open two browser windows, create a room in one, paste the link in the other.

`npm run check` runs syntax checks plus the unit suite (`node:test`):
placement validation, volley resolution, abilities, state machine, reconnect,
and a malformed-message fuzz pass.

## Deployment (DarksGames server)

The game deploys like every other catalog title: the tree goes to
`/srv/darksgames/games/battleships` (owned by `darks`), then

```
add-game battleships.darksgames.app battleships
```

allocates the port, writes the nginx vhost (static from `public/`, everything
else — including the WebSocket upgrade — proxied to Node), obtains the
certificate, and starts `darksgame@battleships`. See SDD §10 and PLAN.md M5
for the staging-first rollout.
