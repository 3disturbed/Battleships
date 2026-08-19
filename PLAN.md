# Battleships — Implementation Plan

This plan is written to be executed by **Claude Code running on the DarksGames
production server** (the box that serves `*.darksgames.app`). Development
happens in `/root/Battleships` (this repo); deployment copies the tree to
`/srv/darksgames/games/battleships` exactly like the other catalog games.
Work through the milestones in order — each has a hard acceptance gate.

Ground rules for the executing agent:

- This box **is** production. Never touch nginx, the registry, systemd, or
  `/srv/darksgames` outside of the documented M5/M6 steps. Everything before
  M5 happens entirely inside `/root/Battleships` on unprivileged ports.
- `npm run check` must pass at the end of every milestone. Commit per
  milestone at minimum; small commits preferred.
- The SDD is the spec. Where the SDD is silent, prefer the simplest thing
  that preserves the three pillars (§1) and note the decision in the commit.
- GitHub: this box's SSH key authenticates as `3disturbed`; push with
  `git push` over SSH. (Repo creation itself needs `gh` auth — see M0.)

---

## M0 — Repo & scaffold *(≈ half a session)*

**Goal:** the repo exists on GitHub (private), the process skeleton runs.

1. Docs (README.md, SDD.md, PLAN.md) — done in the authoring session.
2. Create the private GitHub repo and push (requires one-time `gh auth login`
   by the operator if not yet done):
   `gh repo create Battleships --private --source /root/Battleships --push`
3. Scaffold: `package.json` (`"start": "node server.js"`, `ws` dependency,
   `check` scripts), `.gitignore` (`node_modules/`, `.env`), `server.js` that
   serves `public/` (dev only), answers `/healthz`, and accepts a WS
   connection at `/ws` with a protocol-versioned `hello` → `welcome` echo.
4. `public/index.html` placeholder that connects and shows the welcome.

**Gate:** `npm start` on port 3000; two browser tabs both reach `welcome`;
`npm run check` green (syntax + a first trivial unit test); pushed to GitHub.

## M1 — Pure game core *(the biggest engineering chunk — do it test-first)*

**Goal:** the whole rulebook exists as pure, fully unit-tested modules with
**zero I/O** — `game/state.js`, `placement.js`, `battle.js`, `abilities.js`,
`view.js` per SDD §6.1.

Order of work: placement validator → state machine shell → volley resolution
(Blitz) → energy/streaks/win/draw → the five abilities → Classic round engine
→ per-player view projection. Write the SDD §9 unit suites *alongside* each
module, not after. The protocol fuzz test lands here too (pure `parse`).

**Gate:** `npm run check` green with the full §9 unit matrix (state machine
message×phase table complete); a scripted headless game — two fake seats
driven by the core API — plays start → mutual-destruction tiebreak correctly.

## M2 — Server: rooms, transport, timers

**Goal:** two real browsers can play a full ugly-but-correct game.

- `lib/hub.js` (heartbeat, rate limits), `lib/rooms.js` (codes, GC, cap),
  `lib/protocol.js` (schema validation per type), `lib/timers.js` (one
  deadline per room, freeze/unfreeze for reconnect pause).
- Wire the core to the hub; implement `snapshot` reconnect per SDD §6.4, and
  the claim-victory flow.
- Client: minimal functional screens (DOM buttons + a bare canvas grid, no
  art): lobby with working share link (`/#CODE`), placement with shuffle,
  aim-by-tapping, textual resolve.

**Gate:** on `localhost:3000` — create/share/join via link; full Blitz game;
mid-battle refresh of either tab resumes correctly from `snapshot`; killing a
tab lets the opponent claim after grace; `npm run check` green.

## M3 — Real client: screens, boards, juice

**Goal:** it looks and feels like the SDD §3.7/§8 game.

- Canvas board renderer (layers, DPR-aware, idle-when-static rAF loop).
- Placement drag/rotate/shuffle with mobile touch handling.
- The resolve choreography from the single `resolve` message: staggered shell
  arcs, splashes, plumes, shake, sink slow-mo + banners, streak fire.
- Screens/transitions, portrait & landscape layouts, victory screen with
  stats + reveal + giant Rematch button, series scoring, emotes, sfx + mute,
  reduced-motion support, avatars/nicknames.

**Gate:** playtest on a phone (portrait) and a desktop: 60fps resolves,
placement pleasant with fingers, every SDD §4 flow (host, guest, reconnect,
expired room) reachable and humane. `npm run check` + jsdom smoke green.

## M4 — Hardening & tuning playtests

**Goal:** boringly robust; fun confirmed by humans.

- Abuse pass: per-IP join limiter, per-conn message limits, origin check,
  nickname sanitizing — plus tests for each.
- Soak: scripted 200-room churn (create/play/abandon) for an hour under
  `node --inspect`; zero leaked rooms/timers/sockets (GC sweep proves empty).
- Kill -9 the dev server mid-game; client reconnect UX must fail gracefully
  into "room gone" (process restart drops rooms by design — the message must
  be kind).
- **Fun tuning:** at least 3 human best-of-3 series. Tune aim timer, energy
  costs, comeback bonus (SDD §13 constants). Record decisions in the SDD
  changelog. This gate is subjective and mandatory: *the loser asked for the
  rematch*.

**Gate:** all above + `npm run check` green. Tag `v1.0.0`.

## M5 — Staging deploy, then production *(the only milestone that touches the live box)*

Staging first, on a disposable wildcard subdomain (house rule for risky
changes — `*.darksgames.app` DNS already resolves here):

1. `rsync -a --exclude .git --exclude node_modules /root/Battleships/ /srv/darksgames/games/battleships-staging/`
2. `cd /srv/darksgames/games/battleships-staging && npm install --omit=dev && npm install --no-save jsdom && npm run check`
3. `chown -R darks:darks /srv/darksgames/games/battleships-staging`
4. `add-game battleships-staging.darksgames.app battleships-staging`
   (allocates the next free port — expect ~3019 — writes vhost + cert, starts
   `darksgame@battleships-staging`).
5. Playtest a full cross-network game (phone on cellular vs. desktop):
   TLS, the WS upgrade through nginx, reconnect over a real network drop,
   `journalctl -u darksgame@battleships-staging` clean.
6. Promote: repeat 1–3 into `/srv/darksgames/games/battleships`, then
   `add-game battleships.darksgames.app battleships`. Verify with a real game.
7. Tear staging down: `remove-site battleships-staging.darksgames.app` (check
   `remove-site` usage first), `systemctl disable --now darksgame@battleships-staging`,
   delete the staging tree, confirm the registry line is gone.

**Redeploys later:** always `diff -r` live tree vs. repo before overwrite-style
deploys (live hotfixes have drifted before on this box); never delete the live
`.env` (it carries the allocated PORT; add-game merges, never truncates —
follow suit).

**Gate:** `https://battleships.darksgames.app` playable end-to-end from two
outside networks; staging fully removed; unit enabled for boot.

## M6 — Catalog listing & wrap-up

1. Add Battleships to the DarksGamesSite Apps catalog. **Known trap:** fresh
   worktrees of DarksGamesSite branch from a stale `origin/main` that lacks
   the Apps section — branch from the *local* `main`, and diff the live site
   tree against the repo before deploying (repo↔production were reconciled
   2026-08-19; verify that still holds).
2. Final push to GitHub; confirm `main` is green (`npm run check`) at HEAD.
3. Write a short `OPERATIONS.md`: restart command, log command, health check,
   redeploy checklist (the M5 rules), room-cap knob.

**Gate:** the game is discoverable from darksgames.app, the repo matches
production, and a cold operator could redeploy from OPERATIONS.md alone.

---

## Milestone → effort sketch

| Milestone | Rough size | Risk |
|---|---|---|
| M0 scaffold | S | trivial |
| M1 game core | L | logic bugs → mitigated test-first |
| M2 transport | M | reconnect edge cases |
| M3 client/juice | L | mobile input + perf |
| M4 hardening | M | subjective fun gate |
| M5 deploy | S | production discipline (checklists above) |
| M6 catalog | S | site-repo drift traps (documented) |
