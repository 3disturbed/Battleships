# Battleships — Operations

Production: **https://battleships.darksgames.app** · unit `darksgame@battleships`
· port **3022** (from `/srv/darksgames/games/battleships/.env`) · runs as `darks`.

## Daily driving

```bash
systemctl status darksgame@battleships          # is it up
journalctl -u darksgame@battleships -f          # live logs (JSON lines)
curl -s https://battleships.darksgames.app/healthz   # {ok, rooms, uptime}
sudo darksgame-ctl restart battleships          # restart (as darks; root: systemctl)
```

## Verify after any change

```bash
cd /srv/darksgames/games/battleships && npm run check   # syntax + 70 unit/integration tests
node /root/Battleships/tools/livecheck.js wss://battleships.darksgames.app/ws
```

`livecheck` plays a real scripted game (create → join → place → 4 volley
rounds with a sonar ping → victory + reveal) and exits 0 on PASS.

## Redeploy checklist

0. **Client-file changes need a cache-bust**: nginx caches game js/css for 7
   days. Bump the `?v=N` stamp everywhere it appears — the `<link>`/`<script>`
   tags in `public/index.html` AND every module import in `public/js/*.js`:
   `sed -i 's/?v=OLD/?v=NEW/g' public/index.html public/js/*.js` (index.html
   itself is no-cache, so the new stamps are picked up immediately).
1. Work and commit in `/root/Battleships`; get `npm run check` green there.
2. `diff -r --exclude node_modules --exclude .git /root/Battleships /srv/darksgames/games/battleships`
   — the live tree must not contain hotfixes the repo lacks (this box has a
   history of live-ahead drift on other apps).
3. `rsync -a --exclude .git --exclude node_modules /root/Battleships/ /srv/darksgames/games/battleships/`
   — **never delete the live `.env`** (it carries the allocated PORT; add-game
   merges rather than truncates, follow suit).
4. `cd /srv/darksgames/games/battleships && npm install --omit=dev && npm run check`
5. `chown -R darks:darks /srv/darksgames/games/battleships`
6. `systemctl restart darksgame@battleships` (drops live rooms — games last
   minutes, restart in a quiet moment; `/healthz` shows current room count)
7. `node tools/livecheck.js wss://battleships.darksgames.app/ws`
8. Risky changes: stage first on a disposable wildcard subdomain
   (`add-game battleships-staging.darksgames.app battleships-staging`), verify,
   then promote and tear staging down (unit, vhost, registry line, cert, tree).

## Knobs

- `PORT` — in `.env`, owned by add-game/registry.tsv. Don't move it by hand.
- `MAX_ROOMS` (default 500) — `createServer` option; wire through `.env` +
  `server.js` if it's ever needed.
- `RECONNECT_GRACE_MS` env — shrinks the reconnect grace (tests use 200ms).
- Gameplay tuning constants (energy, timers, salvo floor) — `game/const.js`.

## Facts worth knowing

- A process restart drops all live rooms by design (in-memory state, no DB);
  clients fail into a kind "game has ended" message and a fresh-start button.
- Rooms GC: empty lobby 10 min, finished 5 min, abandoned mid-game 5 min.
- Rate limits: 10 room create/join per IP per minute; 20 msg/s per socket.
- The catalog card lives in DarksGamesSite `site/games.js` (slug
  `battleships`); a site deploy needs the `?v=` and `sw.js` `dg-vNN` bump
  (live site was at dg-v24 when this shipped).
