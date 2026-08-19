// Room registry: code allocation, token → seat lookup for reconnects, and
// garbage collection. Holds runtime (sockets, timers) alongside the pure core
// state — but never reaches into core internals.

import { randomUUID, randomInt } from 'node:crypto';
import { createRoom } from '../game/state.js';

// No I/O/0/1 — codes get read out loud over voice chat.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const EMPTY_ROOM_TTL_MS = 10 * 60_000;
export const FINISHED_ROOM_TTL_MS = 5 * 60_000;
export const ABANDONED_ROOM_TTL_MS = 5 * 60_000;
export const LOBBY_SEAT_TTL_MS = 60_000;

export function makeCode(rng = null) {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[rng ? Math.floor(rng() * 32) : randomInt(32)];
  }
  return code;
}

export function createRegistry({ maxRooms = 500, now = Date.now } = {}) {
  const rooms = new Map(); // code -> room
  const tokens = new Map(); // reconnectToken -> { code, seat }

  function create(settings, rng) {
    if (rooms.size >= maxRooms) return null;
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const room = {
      code,
      state: createRoom(settings, rng),
      seats: [newSeat(), newSeat()],
      deadline: null, // { at, remainingMs (when frozen), timer }
      paused: false,
      createdAt: now(),
      lastActivity: now(),
      emptySince: now(),
    };
    rooms.set(code, room);
    return room;
  }

  function newSeat() {
    return { token: null, conn: null, disconnectedAt: null, graceTimer: null, emoteAt: 0 };
  }

  function issueToken(room, seatIdx) {
    const token = randomUUID();
    room.seats[seatIdx].token = token;
    tokens.set(token, { code: room.code, seat: seatIdx });
    return token;
  }

  function byToken(token) {
    const ref = tokens.get(token);
    if (!ref) return null;
    const room = rooms.get(ref.code);
    if (!room) { tokens.delete(token); return null; }
    return { room, seat: ref.seat };
  }

  function destroy(room, closeSeat) {
    for (const seat of room.seats) {
      if (seat.token) tokens.delete(seat.token);
      if (seat.graceTimer) clearTimeout(seat.graceTimer);
      if (seat.conn && closeSeat) closeSeat(seat);
    }
    if (room.deadline?.timer) clearTimeout(room.deadline.timer);
    if (room.bot?.timer) clearTimeout(room.bot.timer);
    rooms.delete(room.code);
  }

  // Periodic sweep. closeSeat(seat, reason) lets the caller notify sockets.
  function sweep(closeSeat) {
    const t = now();
    for (const room of [...rooms.values()]) {
      const occupied = room.seats.some((s) => s.conn);
      const phase = room.state.phase;
      let dead = false;
      if (!occupied) {
        const idleFor = t - room.lastActivity;
        if (phase === 'LOBBY' && idleFor > EMPTY_ROOM_TTL_MS) dead = true;
        else if (phase === 'GAMEOVER' && idleFor > FINISHED_ROOM_TTL_MS) dead = true;
        else if (idleFor > ABANDONED_ROOM_TTL_MS && phase !== 'LOBBY' && phase !== 'GAMEOVER') dead = true;
      } else if (phase === 'GAMEOVER' && t - room.lastActivity > EMPTY_ROOM_TTL_MS) {
        dead = true; // someone idling on a victory screen forever
      }
      if (dead) destroy(room, closeSeat);
    }
  }

  return {
    rooms,
    tokens,
    create,
    issueToken,
    byToken,
    destroy,
    sweep,
    get(code) { return rooms.get(code) ?? null; },
    get size() { return rooms.size; },
  };
}

// --- room deadline timers ---------------------------------------------------

export function scheduleDeadline(room, ms, cb) {
  cancelDeadline(room);
  room.deadline = { at: Date.now() + ms, remainingMs: null, timer: setTimeout(cb, ms) };
}

export function cancelDeadline(room) {
  if (room.deadline?.timer) clearTimeout(room.deadline.timer);
  room.deadline = null;
}

export function freezeDeadline(room) {
  if (!room.deadline || room.deadline.remainingMs !== null) return;
  clearTimeout(room.deadline.timer);
  room.deadline.timer = null;
  room.deadline.remainingMs = Math.max(1000, room.deadline.at - Date.now());
}

export function resumeDeadline(room, cb) {
  if (!room.deadline || room.deadline.remainingMs === null) return;
  const ms = room.deadline.remainingMs;
  room.deadline = { at: Date.now() + ms, remainingMs: null, timer: setTimeout(cb, ms) };
}
