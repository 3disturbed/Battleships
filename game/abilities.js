// The five ship abilities: validation and effects. One per player per round;
// an ability dies with its ship. Pure; mutates the acting player's state and
// returns either {error} or {intel?} for the actor's eyes only.

import { ABILITIES, key } from './const.js';
import { shipAt, sonarDistance, reconScan } from './battle.js';
import { shipCells } from './placement.js';

const inGrid = (x, y, grid) =>
  Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < grid && y < grid;

export function useAbility(me, foe, kind, target, grid) {
  const def = ABILITIES[kind];
  if (!def) return { error: 'Unknown ability.' };
  if (me.abilityUsedThisRound) return { error: 'One ability per round.' };
  const ship = me.ships.find((s) => s.id === def.ship);
  if (!ship || ship.sunk) return { error: 'That ship has been sunk — its ability is gone.' };
  if (me.energy < def.cost) return { error: 'Not enough Energy.' };
  target = target && typeof target === 'object' ? target : {};

  let intel = null;
  switch (kind) {
    case 'recon': {
      if (!inGrid(target.x, target.y, grid)) return { error: 'Pick a cell to overfly.' };
      intel = { kind: 'recon', cells: reconScan(foe, target.x, target.y, grid) };
      me.intel.push(intel);
      break;
    }
    case 'sonar': {
      if (!inGrid(target.x, target.y, grid)) return { error: 'Pick a cell to ping.' };
      intel = { kind: 'sonar', x: target.x, y: target.y, distance: sonarDistance(foe, target.x, target.y) };
      me.intel.push(intel);
      break;
    }
    case 'bigguns': {
      me.bigguns = true; // consumed by the next volley build
      break;
    }
    case 'decoy': {
      if (me.decoy) return { error: 'Your decoy is already deployed.' };
      if (!inGrid(target.x, target.y, grid)) return { error: 'Pick a cell for the buoy.' };
      if (shipAt(me, target.x, target.y)) return { error: 'The buoy needs open water.' };
      me.decoy = { x: target.x, y: target.y, hit: false };
      break;
    }
    case 'fullsteam': {
      if (me.fullsteamUsed) return { error: 'Full Steam is once per game.' };
      if (ship.hits.some(Boolean)) return { error: 'The destroyer is damaged — too slow to run.' };
      const dir = target.dir === 'v' ? 'v' : 'h';
      if (!inGrid(target.x, target.y, grid)) return { error: 'Pick a new position.' };
      const moved = { ...ship, x: target.x, y: target.y, dir };
      const ownCells = new Set();
      for (const other of me.ships) {
        if (other.id === ship.id) continue;
        for (const c of shipCells(other)) ownCells.add(key(c.x, c.y));
      }
      for (const c of shipCells(moved)) {
        if (!inGrid(c.x, c.y, grid)) return { error: 'That position runs aground.' };
        if (ownCells.has(key(c.x, c.y))) return { error: 'That position collides with your fleet.' };
      }
      ship.x = target.x; ship.y = target.y; ship.dir = dir;
      me.fullsteamUsed = true;
      break;
    }
  }

  me.energy -= def.cost;
  me.abilityUsedThisRound = kind;
  return { intel };
}
