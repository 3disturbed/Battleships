// Layout validation and generation. Pure; randomness comes in via rng().

import { SHIPS, key } from './const.js';

export function shipCells({ x, y, dir, size }) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    cells.push(dir === 'h' ? { x: x + i, y } : { x, y: y + i });
  }
  return cells;
}

const inBounds = (c, n) => c.x >= 0 && c.y >= 0 && c.x < n && c.y < n;

// layout: [{id, x, y, dir}] — must place each fleet ship exactly once, in
// bounds, no overlaps (touching is allowed). Returns normalized ships or null.
export function validateLayout(layout, grid) {
  if (!Array.isArray(layout) || layout.length !== SHIPS.length) return null;
  const seen = new Set();
  const occupied = new Set();
  const ships = [];
  for (const entry of layout) {
    if (!entry || typeof entry !== 'object') return null;
    const def = SHIPS.find((s) => s.id === entry.id);
    if (!def || seen.has(def.id)) return null;
    seen.add(def.id);
    const dir = entry.dir === 'v' ? 'v' : entry.dir === 'h' ? 'h' : null;
    const x = entry.x, y = entry.y;
    if (!dir || !Number.isInteger(x) || !Number.isInteger(y)) return null;
    const ship = { id: def.id, size: def.size, x, y, dir };
    for (const c of shipCells(ship)) {
      if (!inBounds(c, grid) || occupied.has(key(c.x, c.y))) return null;
      occupied.add(key(c.x, c.y));
    }
    ships.push({ ...ship, hits: new Array(def.size).fill(false), sunk: false });
  }
  return ships;
}

function fits(ship, grid, occupied) {
  for (const c of shipCells(ship)) {
    if (!inBounds(c, grid) || occupied.has(key(c.x, c.y))) return false;
  }
  return true;
}

// Random legal position for one ship given already-occupied cells.
function placeOne(def, grid, occupied, rng) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const dir = rng() < 0.5 ? 'h' : 'v';
    const x = Math.floor(rng() * grid);
    const y = Math.floor(rng() * grid);
    const ship = { ...def, x, y, dir };
    if (fits(ship, grid, occupied)) {
      for (const c of shipCells(ship)) occupied.add(key(c.x, c.y));
      return ship;
    }
  }
  return null; // statistically unreachable on 8x8+ with this fleet
}

export function randomLayout(grid, rng) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const occupied = new Set();
    const out = [];
    let ok = true;
    for (const def of SHIPS) {
      const ship = placeOne(def, grid, occupied, rng);
      if (!ship) { ok = false; break; }
      out.push({ id: ship.id, x: ship.x, y: ship.y, dir: ship.dir });
    }
    if (ok) return out;
  }
  throw new Error('randomLayout could not place the fleet');
}

// Fill in whatever a partial (possibly invalid) layout is missing. Entries
// that individually fit and don't collide are kept; the rest are re-rolled.
export function autoComplete(partial, grid, rng) {
  const kept = [];
  const occupied = new Set();
  const seen = new Set();
  if (Array.isArray(partial)) {
    for (const entry of partial) {
      const def = SHIPS.find((s) => entry && s.id === entry.id);
      if (!def || seen.has(def.id)) continue;
      const dir = entry.dir === 'v' ? 'v' : 'h';
      const ship = { ...def, x: entry.x, y: entry.y, dir };
      if (Number.isInteger(ship.x) && Number.isInteger(ship.y) && fits(ship, grid, occupied)) {
        for (const c of shipCells(ship)) occupied.add(key(c.x, c.y));
        seen.add(def.id);
        kept.push({ id: def.id, x: ship.x, y: ship.y, dir });
      }
    }
  }
  for (const def of SHIPS) {
    if (seen.has(def.id)) continue;
    const ship = placeOne(def, grid, occupied, rng);
    if (!ship) return autoComplete(null, grid, rng); // restart clean
    kept.push({ id: ship.id, x: ship.x, y: ship.y, dir: ship.dir });
  }
  return kept;
}
