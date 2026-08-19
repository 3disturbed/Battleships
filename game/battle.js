// Volley construction and resolution. Pure functions over player state.
//
// Per-player battle state (created by state.js):
//   ships     — normalized ships with hits[]/sunk
//   revealed  — Map cellKey -> 'miss'|'hit'|'sink'|'decoy'  (shots MY board has taken;
//               'decoy' renders as a hit to the attacker until the reveal)
//   decoy     — null | {x, y, hit}
//   energy, streak, bestStreak, stats {shots, hits, sinks, decoyFools, biggestVolley}

import { key } from './const.js';
import { shipCells } from './placement.js';

export function aliveShips(player) {
  return player.ships.filter((s) => !s.sunk);
}

export function shipAt(player, x, y) {
  for (const ship of player.ships) {
    const cells = shipCells(ship);
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].x === x && cells[i].y === y) return { ship, index: i };
    }
  }
  return null;
}

// Expand a Big Guns cross around (x,y): center + 4 orthogonal, in bounds.
export function crossCells(x, y, grid) {
  return [
    { x, y }, { x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 },
  ].filter((c) => c.x >= 0 && c.y >= 0 && c.x < grid && c.y < grid);
}

// Build the final list of target cells for one attacker: expand Big Guns on
// the first aimed cell, dedupe, drop already-revealed, then scatter-fill up
// to `count` from the defender's unrevealed cells.
export function buildVolley(aim, count, defender, grid, bigguns, rng) {
  const chosen = [];
  const used = new Set();
  const push = (c) => {
    const k = key(c.x, c.y);
    if (!used.has(k) && !defender.revealed.has(k)) {
      used.add(k);
      chosen.push(c);
    }
  };
  const aimed = Array.isArray(aim) ? aim.slice(0, count) : [];
  aimed.forEach((c, i) => {
    if (i === 0 && bigguns) crossCells(c.x, c.y, grid).forEach(push);
    else push(c);
  });
  // Scatter-fill missing shots (AFK players still fire; SDD §3.3) — based on
  // accepted cells, so dropped dupes/revealed still get replaced. Big Guns can
  // legitimately exceed count; never scatter negative.
  const deficit = Math.max(0, count - chosen.length);
  if (deficit > 0) {
    const open = [];
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        if (!used.has(key(x, y)) && !defender.revealed.has(key(x, y))) open.push({ x, y });
      }
    }
    for (let i = open.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [open[i], open[j]] = [open[j], open[i]];
    }
    for (let i = 0; i < deficit && i < open.length; i++) push(open[i]);
  }
  return chosen;
}

// Apply one attacker's volley to the defender. Mutates both players' state.
// Returns per-shot results in firing order plus sink details — exactly what
// the client needs to choreograph the barrage.
export function applyVolley(attacker, defender, cells) {
  const shots = [];
  const hitShips = new Set();
  for (const { x, y } of cells) {
    const k = key(x, y);
    attacker.stats.shots++;
    const found = shipAt(defender, x, y);
    if (found) {
      found.ship.hits[found.index] = true;
      hitShips.add(found.ship);
      defender.revealed.set(k, 'hit');
      attacker.stats.hits++;
      attacker.streak++;
      shots.push({ x, y, result: 'hit' });
    } else if (defender.decoy && !defender.decoy.hit && defender.decoy.x === x && defender.decoy.y === y) {
      defender.decoy.hit = true;
      defender.revealed.set(k, 'decoy'); // attacker is shown a hit
      defender.stats.decoyFools++;
      attacker.streak++; // the dupe feels like a streak too
      shots.push({ x, y, result: 'hit', decoy: true });
    } else {
      defender.revealed.set(k, 'miss');
      attacker.streak = 0;
      shots.push({ x, y, result: 'miss' });
    }
    attacker.bestStreak = Math.max(attacker.bestStreak, attacker.streak);
  }
  const sinks = [];
  for (const ship of hitShips) {
    if (!ship.sunk && ship.hits.every(Boolean)) {
      ship.sunk = true;
      attacker.stats.sinks++;
      const cells = shipCells(ship);
      for (const c of cells) defender.revealed.set(key(c.x, c.y), 'sink');
      sinks.push({ id: ship.id, size: ship.size, cells });
    }
  }
  const volleyHits = shots.filter((s) => s.result === 'hit').length;
  attacker.stats.biggestVolley = Math.max(attacker.stats.biggestVolley, volleyHits);
  return { shots, sinks };
}

export function fleetDead(player) {
  return player.ships.every((s) => s.sunk);
}

// Chebyshev distance from (x,y) to the nearest cell of a surviving ship.
export function sonarDistance(defender, x, y) {
  let best = Infinity;
  for (const ship of aliveShips(defender)) {
    for (const c of shipCells(ship)) {
      best = Math.min(best, Math.max(Math.abs(c.x - x), Math.abs(c.y - y)));
    }
  }
  return best === Infinity ? null : best;
}

// Truthful ship-presence for each cell of the 3x3 centered on (cx,cy).
export function reconScan(defender, cx, cy, grid) {
  const cells = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= grid || y >= grid) continue;
      cells.push({ x, y, ship: !!shipAt(defender, x, y) });
    }
  }
  return cells;
}
