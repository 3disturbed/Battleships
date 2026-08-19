// Battleships server: static files + /healthz over HTTP, game protocol over
// WebSocket at /ws. In production nginx serves public/ and proxies the rest
// here; standalone it self-hosts everything.

import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { parse } from './lib/protocol.js';
import {
  createRegistry, scheduleDeadline, cancelDeadline, freezeDeadline, resumeDeadline,
  LOBBY_SEAT_TTL_MS,
} from './lib/rooms.js';
import { startHeartbeat, makeBucket, makeIpLimiter } from './lib/hub.js';
import { act } from './game/state.js';
import { project } from './game/view.js';
import { RECONNECT_GRACE_MS } from './game/const.js';
import { randomLayout } from './game/placement.js';
import { BOT_PROFILES, decideTurn, clampLevel } from './lib/bot.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const EMOTE_THROTTLE_MS = 4_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const log = (event, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));

export function createServer({ port = 3000, host = '127.0.0.1', maxRooms = 500, roomOpsPerMin = 10 } = {}) {
  // Read at construction (not module load) so tests can shrink the grace.
  const GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || RECONNECT_GRACE_MS;
  const registry = createRegistry({ maxRooms });
  const allowRoomOp = makeIpLimiter(roomOpsPerMin / 60, Math.max(10, roomOpsPerMin / 6));

  // ---- HTTP ----------------------------------------------------------------

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: registry.size, uptime: Math.round(process.uptime()) }));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = normalize(join(PUBLIC_DIR, rel));
    if (!path.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end(); return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, {
        'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': path.endsWith('.html') ? 'no-cache' : 'max-age=300',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  // ---- WS ------------------------------------------------------------------

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const heartbeat = startHeartbeat(wss);

  const send = (conn, obj) => {
    if (conn && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(obj));
  };
  const sendErr = (conn, message, code = 'error') => send(conn, { t: 'error', code, message });

  function stateFor(room, seatIdx) {
    const claimable = room.seats.map(
      (s, i) => !s.bot && !s.conn && !!s.disconnectedAt && Date.now() - s.disconnectedAt >= GRACE_MS
        && !!room.state.seats[i],
    );
    return {
      t: 'state',
      roomCode: room.code,
      deadlineAt: room.deadline && room.deadline.remainingMs === null ? room.deadline.at : null,
      paused: room.paused,
      presence: room.seats.map((s, i) => (room.state.seats[i] ? (s.bot || s.conn ? 'on' : 'off') : 'none')),
      claimable,
      serverNow: Date.now(),
      view: project(room.state, seatIdx),
    };
  }

  function broadcastState(room) {
    room.seats.forEach((seat, i) => { if (seat.conn) send(seat.conn, stateFor(room, i)); });
    scheduleBot(room); // any state change may hand the bot its next move
  }

  // ---- bot driver ------------------------------------------------------------
  // The bot plays through the same act()/handleEvents path as a socket would,
  // deciding from project(state, seat) — the fair, masked view.

  const BOT_FAST = process.env.BOT_FAST === '1'; // tests shrink the thinking time
  const wait = (base, spread) => (BOT_FAST ? 15 : base + Math.random() * spread);

  function scheduleBot(room) {
    const bot = room.bot;
    if (!bot || room.paused) return;
    const st = room.state;
    const phase = st.phase;
    let stage = null;
    let delay = 0;

    if (phase === 'PLACEMENT' && !st.players[bot.seat].layoutLocked) {
      stage = 'place';
      delay = wait(900, 700);
    } else if (phase === 'AIM' && !st.players[bot.seat].aimLocked
      && (st.settings.mode !== 'classic' || st.turn === bot.seat)) {
      stage = 'aim';
      delay = wait(1000 + (5 - bot.level) * 350, 900);
    } else if (phase === 'GAMEOVER' && !st.rematch[bot.seat] && st.seats[bot.seat]) {
      stage = 'rematch';
      delay = wait(1200, 600);
    }

    const stageKey = stage && `${stage}:${phase}:${st.round}:${st.series.game}:${st.turn}`;
    if (!stage || bot.key === stageKey) return;
    bot.key = stageKey;
    clearTimeout(bot.timer);
    bot.timer = setTimeout(() => runBot(room, stage, stageKey), delay);
  }

  function runBot(room, stage, stageKey) {
    const bot = room.bot;
    if (!bot || bot.key !== stageKey || registry.get(room.code) !== room) return;
    if (room.paused) { bot.key = ''; return; } // rescheduled on resume
    const st = room.state;
    try {
      if (stage === 'place' && st.phase === 'PLACEMENT') {
        const res = act(st, bot.seat, { t: 'layout', ships: randomLayout(st.settings.grid, Math.random) });
        if (res.ok) handleEvents(room, res.events);
      } else if (stage === 'aim' && st.phase === 'AIM') {
        const { ability, cells } = decideTurn(bot.level, project(st, bot.seat), Math.random);
        if (ability) {
          const r = act(st, bot.seat, { t: 'ability', kind: ability.kind, target: ability.target });
          if (r.ok) handleEvents(room, r.events); // host sees energy move
        }
        const aimRes = act(st, bot.seat, { t: 'aim', cells });
        if (aimRes.ok) handleEvents(room, aimRes.events); // host sees the armed count climb
        bot.timer = setTimeout(() => {
          if (registry.get(room.code) !== room || room.state.phase !== 'AIM') return;
          if (room.paused) { bot.key = ''; return; } // re-aim after resume
          const lockRes = act(room.state, bot.seat, { t: 'lock' });
          if (lockRes.ok) handleEvents(room, lockRes.events);
        }, wait(800, 600));
      } else if (stage === 'rematch' && st.phase === 'GAMEOVER') {
        const res = act(st, bot.seat, { t: 'rematch' });
        if (res.ok) handleEvents(room, res.events);
      }
    } catch (err) {
      log('bot_error', { room: room.code, error: String(err?.stack || err) });
    }
  }

  function onDeadline(room) {
    if (room.paused) return; // frozen rooms wait for reconnect/claim
    const res = act(room.state, null, { t: 'deadline' });
    room.lastActivity = Date.now();
    if (res.ok) handleEvents(room, res.events);
  }

  function handleEvents(room, events) {
    for (const e of events) {
      if (e.t === 'phase') {
        scheduleDeadline(room, e.delayMs + e.durationMs, () => onDeadline(room));
        if (room.paused) freezeDeadline(room); // opponent still gone (e.g. deadline fired then paused)
      } else if (e.t === 'resolve') {
        room.seats.forEach((seat) => send(seat.conn, { t: 'resolve', round: e.round, volleys: e.volleys }));
      } else if (e.t === 'intel') {
        send(room.seats[e.seat].conn, { t: 'intel', intel: e.intel });
      } else if (e.t === 'over') {
        cancelDeadline(room);
        log('game_over', { room: room.code, winner: e.winner, reason: e.reason });
      }
    }
    broadcastState(room);
  }

  function detach(conn) {
    if (!conn.room) return;
    const room = conn.room;
    const seat = room.seats[conn.seat];
    if (seat.conn === conn) seat.conn = null;
    conn.room = null;
    conn.seat = -1;
  }

  function vacateSeat(room, seatIdx) {
    const seat = room.seats[seatIdx];
    if (seat.token) { registry.tokens.delete(seat.token); seat.token = null; }
    if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
    seat.disconnectedAt = null;
    act(room.state, seatIdx, { t: 'vacate' });
    if (!room.state.seats[0] && !room.state.seats[1]) {
      registry.destroy(room, (s) => s.conn?.ws.close(4000, 'room closed'));
    } else {
      broadcastState(room);
    }
  }

  function attachToRoom(conn, room, seatIdx) {
    const seat = room.seats[seatIdx];
    if (seat.conn && seat.conn !== conn) seat.conn.ws.close(4001, 'replaced'); // new tab wins
    seat.conn = conn;
    seat.disconnectedAt = null;
    if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
    conn.room = room;
    conn.seat = seatIdx;
    room.lastActivity = Date.now();
    if (room.paused && room.seats.every((s, i) => !room.state.seats[i] || s.conn || s.bot)) {
      room.paused = false;
      resumeDeadline(room, () => onDeadline(room));
    }
  }

  function handleMessage(conn, msg) {
    const room = conn.room;

    switch (msg.t) {
      case 'hello': {
        conn.identity = { name: msg.name, avatar: msg.avatar };
        if (msg.reconnectToken) {
          const found = registry.byToken(msg.reconnectToken);
          if (found) {
            attachToRoom(conn, found.room, found.seat);
            send(conn, {
              t: 'welcome', seat: found.seat, reconnectToken: msg.reconnectToken,
              roomCode: found.room.code, resumed: true,
            });
            broadcastState(found.room);
            log('reconnected', { room: found.room.code, seat: found.seat });
            return;
          }
        }
        send(conn, { t: 'welcome', resumed: false });
        return;
      }

      case 'create': {
        if (!conn.identity) return sendErr(conn, 'Say hello first.');
        if (room) return sendErr(conn, 'Already in a room.');
        if (!allowRoomOp(conn.ip)) return sendErr(conn, 'Slow down a little.', 'rate');
        const created = registry.create(msg.settings, Math.random);
        if (!created) return sendErr(conn, 'The server is packed right now — try again in a few minutes.', 'full');
        act(created.state, 0, { t: 'join', ...conn.identity });
        const token = registry.issueToken(created, 0);
        attachToRoom(conn, created, 0);
        send(conn, { t: 'welcome', seat: 0, reconnectToken: token, roomCode: created.code, resumed: false });
        broadcastState(created);
        log('room_created', { room: created.code, rooms: registry.size });
        return;
      }

      case 'join': {
        if (!conn.identity) return sendErr(conn, 'Say hello first.');
        if (room) return sendErr(conn, 'Already in a room.');
        if (!allowRoomOp(conn.ip)) return sendErr(conn, 'Slow down a little.', 'rate');
        const target = registry.get(msg.roomCode);
        if (!target) {
          return sendErr(conn, `Room ${msg.roomCode} has expired — start a new game and send a fresh link.`, 'gone');
        }
        const free = target.state.seats.findIndex((s, i) => !s && !target.seats[i].conn);
        if (free === -1) return sendErr(conn, 'That room is already full.', 'full');
        const res = act(target.state, free, { t: 'join', ...conn.identity });
        if (!res.ok) return sendErr(conn, res.error);
        const token = registry.issueToken(target, free);
        attachToRoom(conn, target, free);
        send(conn, { t: 'welcome', seat: free, reconnectToken: token, roomCode: target.code, resumed: false });
        handleEvents(target, res.events);
        log('joined', { room: target.code });
        return;
      }

      case 'addBot': {
        if (!room) return sendErr(conn, 'No room.');
        if (conn.seat !== 0) return sendErr(conn, 'Only the host can add a bot.');
        if (room.state.phase !== 'LOBBY') return sendErr(conn, 'Bots join in the lobby.');
        if (room.state.seats[1]) return sendErr(conn, 'That seat is taken.');
        const level = clampLevel(msg.level);
        const profile = BOT_PROFILES[level];
        const res = act(room.state, 1, { t: 'join', name: profile.name, avatar: profile.avatar, bot: true });
        if (!res.ok) return sendErr(conn, res.error);
        room.seats[1].bot = true;
        room.bot = { seat: 1, level, timer: null, key: '' };
        const ready = act(room.state, 1, { t: 'ready', ready: true }); // bots are always keen
        handleEvents(room, [...res.events, ...(ready.ok ? ready.events : [])]);
        log('bot_added', { room: room.code, level });
        return;
      }

      case 'removeBot': {
        if (!room) return sendErr(conn, 'No room.');
        if (conn.seat !== 0) return sendErr(conn, 'Only the host can dismiss the bot.');
        if (!room.bot) return sendErr(conn, 'No bot aboard.');
        const phase = room.state.phase;
        if (phase !== 'LOBBY' && phase !== 'GAMEOVER') return sendErr(conn, 'Finish the game first.');
        clearTimeout(room.bot.timer);
        room.bot = null;
        room.seats[1].bot = false;
        const res = act(room.state, 1, { t: 'vacate' });
        if (res.ok) handleEvents(room, res.events);
        log('bot_removed', { room: room.code });
        return;
      }

      case 'leave': {
        if (!room) return;
        const phase = room.state.phase;
        if (phase === 'PLACEMENT' || phase === 'AIM') {
          const res = act(room.state, null, { t: 'forfeit', loser: conn.seat, reason: 'left' });
          if (res.ok) handleEvents(room, res.events);
          detach(conn);
          broadcastState(room);
        } else {
          const seatIdx = conn.seat;
          detach(conn);
          vacateSeat(room, seatIdx);
        }
        send(conn, { t: 'left' });
        return;
      }

      case 'claim': {
        if (!room) return sendErr(conn, 'No room.');
        const other = 1 - conn.seat;
        const otherSeat = room.seats[other];
        const gone = !otherSeat.conn && otherSeat.disconnectedAt
          && Date.now() - otherSeat.disconnectedAt >= GRACE_MS;
        if (!gone) return sendErr(conn, 'Your opponent has not been gone long enough.');
        const res = act(room.state, null, { t: 'forfeit', loser: other, reason: 'claim' });
        if (!res.ok) return sendErr(conn, res.error);
        room.paused = false;
        handleEvents(room, res.events);
        return;
      }

      case 'emote': {
        if (!room) return;
        const seat = room.seats[conn.seat];
        const now = Date.now();
        if (now - seat.emoteAt < EMOTE_THROTTLE_MS) return;
        seat.emoteAt = now;
        room.seats.forEach((s) => send(s.conn, { t: 'emote', seat: conn.seat, id: msg.id }));
        return;
      }

      default: {
        // Core game actions: settings, ready, layout, aim, ability, lock, rematch.
        if (!room) return sendErr(conn, 'Not in a room.');
        const action = msg.t === 'ability'
          ? { t: 'ability', kind: msg.kind, target: msg.target }
          : msg;
        const res = act(room.state, conn.seat, action);
        room.lastActivity = Date.now();
        if (!res.ok) return sendErr(conn, res.error);
        handleEvents(room, res.events);
      }
    }
  }

  wss.on('connection', (ws, req) => {
    // Same-host origin check; absent origin (tests, non-browser) is allowed.
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* malformed */ }
      const ok = host && (host === req.headers.host || host.startsWith('localhost') || host.startsWith('127.0.0.1'));
      if (!ok) { ws.close(4403, 'origin'); return; }
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const conn = {
      ws,
      ip: req.headers['x-real-ip'] || req.socket.remoteAddress || '?',
      identity: null,
      room: null,
      seat: -1,
      bucket: makeBucket(20, 40),
    };

    ws.on('message', (raw) => {
      if (!conn.bucket.take()) {
        if (conn.bucket.level < -20) ws.close(4429, 'rate');
        return; // soft-drop
      }
      const parsed = parse(raw);
      if (!parsed.ok) {
        if (parsed.error === 'version') {
          send(conn, { t: 'error', code: 'version', message: 'This game updated — refresh the page to keep playing.' });
          ws.close(4426, 'version');
          return;
        }
        return sendErr(conn, parsed.error, 'bad');
      }
      try {
        handleMessage(conn, parsed.msg);
      } catch (err) {
        // A bug must never take the process down with it.
        log('handler_error', { error: String(err?.stack || err) });
        sendErr(conn, 'Something went wrong on our end.');
      }
    });

    ws.on('close', () => {
      const room = conn.room;
      if (!room) return;
      const seat = room.seats[conn.seat];
      if (seat.conn !== conn) return; // superseded by a reconnect
      seat.conn = null;
      seat.disconnectedAt = Date.now();
      room.lastActivity = Date.now();
      const phase = room.state.phase;
      if (phase === 'PLACEMENT' || phase === 'AIM') {
        room.paused = true;
        freezeDeadline(room);
        seat.graceTimer = setTimeout(() => broadcastState(room), GRACE_MS + 50);
        seat.graceTimer.unref?.();
      } else if (phase === 'LOBBY') {
        const seatIdx = conn.seat;
        seat.graceTimer = setTimeout(() => { if (!seat.conn) vacateSeat(room, seatIdx); }, LOBBY_SEAT_TTL_MS);
        seat.graceTimer.unref?.();
      }
      broadcastState(room);
    });
  });

  const sweeper = setInterval(
    () => registry.sweep((s) => s.conn?.ws.close(4000, 'room expired')),
    60_000,
  );
  sweeper.unref?.();

  server.listen(port, host, () => {
    log('listening', { port: server.address().port, host });
  });

  return {
    server,
    registry,
    close() {
      clearInterval(sweeper);
      clearInterval(heartbeat);
      for (const room of [...registry.rooms.values()]) {
        registry.destroy(room, (s) => s.conn?.ws.close(4000, 'shutdown'));
      }
      wss.close();
      server.close();
      for (const ws of wss.clients) ws.terminate();
    },
  };
}

// Started directly (systemd runs `npm start`): boot from .env-provided PORT.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer({ port: Number(process.env.PORT) || 3000 });
}
