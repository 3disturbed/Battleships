// Shared test utilities: deterministic rng and canned layouts/actions.

import { createRoom, act } from '../game/state.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Row-per-ship layout: 17 cells in rows 0-4, all horizontal from x=0.
export const ROWS_LAYOUT = [
  { id: 'carrier', x: 0, y: 0, dir: 'h' },
  { id: 'battleship', x: 0, y: 1, dir: 'h' },
  { id: 'cruiser', x: 0, y: 2, dir: 'h' },
  { id: 'submarine', x: 0, y: 3, dir: 'h' },
  { id: 'destroyer', x: 0, y: 4, dir: 'h' },
];

// All 17 occupied cells of ROWS_LAYOUT, in reading order.
export const ROWS_CELLS = [
  ...[0, 1, 2, 3, 4].map((x) => ({ x, y: 0 })),
  ...[0, 1, 2, 3].map((x) => ({ x, y: 1 })),
  ...[0, 1, 2].map((x) => ({ x, y: 2 })),
  ...[0, 1, 2].map((x) => ({ x, y: 3 })),
  ...[0, 1].map((x) => ({ x, y: 4 })),
];

export function must(res) {
  if (!res.ok) throw new Error(`action failed: ${res.error}`);
  return res;
}

// A room with both seats joined. Returns state.
export function joinedRoom(settings = {}, seed = 42) {
  const state = createRoom(settings, mulberry32(seed));
  must(act(state, 0, { t: 'join', name: 'Ash', avatar: '🦈' }));
  must(act(state, 1, { t: 'join', name: 'Bo', avatar: '🐙' }));
  return state;
}

// Through the lobby and placement with ROWS_LAYOUT on both sides → AIM r1.
export function battleRoom(settings = {}, seed = 42) {
  const state = joinedRoom(settings, seed);
  must(act(state, 0, { t: 'ready', ready: true }));
  must(act(state, 1, { t: 'ready', ready: true }));
  must(act(state, 0, { t: 'layout', ships: ROWS_LAYOUT }));
  must(act(state, 1, { t: 'layout', ships: ROWS_LAYOUT }));
  return state;
}

// One blitz round: both players aim the given cells and lock. Returns events.
export function playRound(state, aim0, aim1) {
  must(act(state, 0, { t: 'aim', cells: aim0 }));
  must(act(state, 1, { t: 'aim', cells: aim1 }));
  must(act(state, 0, { t: 'lock' }));
  return must(act(state, 1, { t: 'lock' })).events;
}

// Cells guaranteed empty under ROWS_LAYOUT: rows 8-9 hold 20 cells, carved
// into disjoint 5-cell blocks by salt (0-3) so successive volleys never
// re-target an already-revealed cell.
export function waterCells(n, salt = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = salt * 5 + i;
    out.push({ x: idx % 10, y: 8 + Math.floor(idx / 10) });
  }
  return out;
}
