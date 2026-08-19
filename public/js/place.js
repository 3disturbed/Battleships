// Placement screen: drag ships, tap to rotate, shuffle, lock. Keeps a local
// mirror of the fleet rules (bounds/overlap) — the server revalidates anyway.

import { sfx } from './sfx.js?v=4';

export const SHIPS = [
  { id: 'carrier', size: 5 },
  { id: 'battleship', size: 4 },
  { id: 'cruiser', size: 3 },
  { id: 'submarine', size: 3 },
  { id: 'destroyer', size: 2 },
];

const cellsOf = (s) => Array.from({ length: s.size }, (_, i) =>
  s.dir === 'h' ? { x: s.x + i, y: s.y } : { x: s.x, y: s.y + i });

function legal(ship, grid, others) {
  const used = new Set(others.flatMap((o) => cellsOf(o).map((c) => `${c.x},${c.y}`)));
  return cellsOf(ship).every((c) =>
    c.x >= 0 && c.y >= 0 && c.x < grid && c.y < grid && !used.has(`${c.x},${c.y}`));
}

export function randomFleet(grid) {
  for (let tries = 0; tries < 60; tries++) {
    const placed = [];
    let ok = true;
    for (const def of SHIPS) {
      let done = false;
      for (let a = 0; a < 300 && !done; a++) {
        const ship = {
          ...def,
          dir: Math.random() < 0.5 ? 'h' : 'v',
          x: Math.floor(Math.random() * grid),
          y: Math.floor(Math.random() * grid),
        };
        if (legal(ship, grid, placed)) { placed.push(ship); done = true; }
      }
      if (!done) { ok = false; break; }
    }
    if (ok) return placed;
  }
  return null; // practically unreachable
}

export function createPlacement({ board, statusEl, lockBtn, shuffleBtn, send }) {
  let fleet = [];
  let grid = 10;
  let locked = false;
  let drag = null; // { ship, offset, moved }

  function model(extra = {}) {
    return {
      grid,
      ships: fleet.map((s) => ({
        ...s,
        invalid: !legal(s, grid, fleet.filter((o) => o !== s)),
        selected: drag?.ship === s,
      })),
      revealed: [],
      ...extra,
    };
  }

  function paint() {
    board.setModel(model());
    const allLegal = fleet.length === SHIPS.length
      && fleet.every((s) => legal(s, grid, fleet.filter((o) => o !== s)));
    lockBtn.disabled = locked || !allLegal;
    lockBtn.textContent = locked ? 'Waiting for opponent…' : 'Fleet ready';
  }

  function shipAtCell(cell) {
    return fleet.find((s) => cellsOf(s).some((c) => c.x === cell.x && c.y === cell.y));
  }

  function start(newGrid, alreadyLocked) {
    grid = newGrid;
    locked = alreadyLocked;
    if (!fleet.length || fleet.some((s) => !legal(s, grid, []))) {
      fleet = randomFleet(grid) ?? [];
    }
    paint();
  }

  function lockIn() {
    if (locked) return;
    locked = true;
    send({ t: 'layout', ships: fleet.map(({ id, x, y, dir }) => ({ id, x, y, dir })) });
    sfx.arm();
    paint();
  }

  shuffleBtn.addEventListener('click', () => {
    if (locked) return;
    fleet = randomFleet(grid) ?? fleet;
    sfx.click();
    paint();
  });
  lockBtn.addEventListener('click', lockIn);

  const canvas = board.canvas;
  canvas.addEventListener('pointerdown', (ev) => {
    if (locked) return;
    const cell = board.cellFromEvent(ev);
    if (!cell) return;
    const ship = shipAtCell(cell);
    if (!ship) return;
    canvas.setPointerCapture(ev.pointerId);
    drag = { ship, grab: { dx: cell.x - ship.x, dy: cell.y - ship.y }, moved: false, from: { x: ship.x, y: ship.y } };
    paint();
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag || locked) return;
    const cell = board.cellFromEvent(ev);
    if (!cell) return;
    const nx = cell.x - drag.grab.dx;
    const ny = cell.y - drag.grab.dy;
    if (nx !== drag.ship.x || ny !== drag.ship.y) {
      drag.ship.x = nx;
      drag.ship.y = ny;
      drag.moved = true;
      paint();
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (!drag || locked) { drag = null; return; }
    const s = drag.ship;
    if (!drag.moved) {
      // A tap: rotate around the grabbed end, clamped into the grid.
      s.dir = s.dir === 'h' ? 'v' : 'h';
      s.x = Math.min(s.x, grid - (s.dir === 'h' ? s.size : 1));
      s.y = Math.min(s.y, grid - (s.dir === 'v' ? s.size : 1));
      if (!legal(s, grid, fleet.filter((o) => o !== s))) {
        s.dir = s.dir === 'h' ? 'v' : 'h'; // no room — undo
        Object.assign(s, { x: drag.from.x, y: drag.from.y });
      }
      sfx.click();
    } else {
      // Clamp the drop into the grid; revert if it lands on another ship.
      s.x = Math.max(0, Math.min(s.x, grid - (s.dir === 'h' ? s.size : 1)));
      s.y = Math.max(0, Math.min(s.y, grid - (s.dir === 'v' ? s.size : 1)));
      if (!legal(s, grid, fleet.filter((o) => o !== s))) {
        Object.assign(s, drag.from);
        sfx.disarm();
      } else {
        sfx.arm();
      }
    }
    drag = null;
    paint();
  });

  return {
    start,
    setStatus(text) { statusEl.textContent = text; },
    get locked() { return locked; },
  };
}
