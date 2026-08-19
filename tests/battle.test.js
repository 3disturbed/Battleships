import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVolley, applyVolley, crossCells, sonarDistance, reconScan, fleetDead, aliveShips,
} from '../game/battle.js';
import { validateLayout } from '../game/placement.js';
import { key } from '../game/const.js';
import { mulberry32, ROWS_LAYOUT } from './helpers.js';

function freshPlayer(layout = ROWS_LAYOUT) {
  return {
    ships: validateLayout(layout, 10),
    revealed: new Map(),
    decoy: null,
    streak: 0,
    bestStreak: 0,
    stats: { shots: 0, hits: 0, sinks: 0, decoyFools: 0, biggestVolley: 0 },
  };
}

test('applyVolley: miss, hit, sink bookkeeping', () => {
  const att = freshPlayer();
  const def = freshPlayer();
  const { shots, sinks } = applyVolley(att, def, [
    { x: 9, y: 9 },            // miss
    { x: 0, y: 4 }, { x: 1, y: 4 }, // destroyer, both cells → sink
  ]);
  assert.deepEqual(shots.map((s) => s.result), ['miss', 'hit', 'hit']);
  assert.equal(sinks.length, 1);
  assert.equal(sinks[0].id, 'destroyer');
  assert.equal(att.stats.shots, 3);
  assert.equal(att.stats.hits, 2);
  assert.equal(att.stats.sinks, 1);
  assert.equal(att.streak, 2);
  assert.equal(def.revealed.get(key(9, 9)), 'miss');
  assert.equal(def.revealed.get(key(0, 4)), 'sink'); // upgraded from hit on sink
  assert.ok(fleetDead(def) === false);
  assert.equal(aliveShips(def).length, 4);
});

test('applyVolley: streak resets on miss, best streak persists', () => {
  const att = freshPlayer();
  const def = freshPlayer();
  applyVolley(att, def, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 9, y: 9 }, { x: 2, y: 0 }]);
  assert.equal(att.streak, 1);
  assert.equal(att.bestStreak, 2);
});

test('applyVolley: decoy reports a hit, counts the dupe, sinks nothing', () => {
  const att = freshPlayer();
  const def = freshPlayer();
  def.decoy = { x: 9, y: 9, hit: false };
  const { shots, sinks } = applyVolley(att, def, [{ x: 9, y: 9 }]);
  assert.equal(shots[0].result, 'hit');
  assert.equal(shots[0].decoy, true);
  assert.equal(sinks.length, 0);
  assert.equal(att.stats.hits, 0); // fake hit is not a real hit
  assert.equal(att.streak, 1); // but it feels like one
  assert.equal(def.stats.decoyFools, 1);
  assert.equal(def.revealed.get(key(9, 9)), 'decoy');
});

test('crossCells clips at edges', () => {
  assert.equal(crossCells(5, 5, 10).length, 5);
  assert.equal(crossCells(0, 0, 10).length, 3);
  assert.equal(crossCells(9, 0, 10).length, 3);
});

test('buildVolley: dedupes, drops revealed, scatter-fills to count', () => {
  const def = freshPlayer();
  def.revealed.set(key(3, 3), 'miss');
  const rng = mulberry32(1);
  const volley = buildVolley(
    [{ x: 3, y: 3 }, { x: 4, y: 4 }, { x: 4, y: 4 }], // revealed + dup
    5, def, 10, false, rng,
  );
  assert.equal(volley.length, 5); // 1 kept + 4 scattered... (3,3) dropped, dup dropped
  const keys = new Set(volley.map((c) => key(c.x, c.y)));
  assert.equal(keys.size, 5);
  assert.ok(!keys.has(key(3, 3)));
});

test('buildVolley: big guns expands the first cell into a cross', () => {
  const def = freshPlayer();
  const volley = buildVolley([{ x: 5, y: 5 }, { x: 0, y: 9 }], 2, def, 10, true, mulberry32(1));
  const keys = new Set(volley.map((c) => key(c.x, c.y)));
  for (const c of crossCells(5, 5, 10)) assert.ok(keys.has(key(c.x, c.y)));
  assert.ok(keys.has(key(0, 9)));
  assert.equal(volley.length, 6); // 5 cross + 1 normal, no scatter (aimed 2 of 2)
});

test('buildVolley: AFK scatter never repeats revealed cells and stays in bounds', () => {
  const def = freshPlayer();
  for (let x = 0; x < 10; x++) for (let y = 0; y < 5; y++) def.revealed.set(key(x, y), 'miss');
  for (let seed = 0; seed < 30; seed++) {
    const volley = buildVolley([], 5, def, 10, false, mulberry32(seed));
    assert.equal(volley.length, 5);
    for (const c of volley) {
      assert.ok(c.y >= 5, 'scatter must avoid revealed half');
      assert.ok(c.x >= 0 && c.x < 10 && c.y < 10);
    }
  }
});

test('buildVolley: scatter caps at available open water', () => {
  const def = freshPlayer();
  for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) {
    if (!(x === 0 && y === 0)) def.revealed.set(key(x, y), 'miss');
  }
  const volley = buildVolley([], 5, def, 10, false, mulberry32(3));
  assert.equal(volley.length, 1);
});

test('sonarDistance: Chebyshev to nearest surviving ship', () => {
  const def = freshPlayer();
  assert.equal(sonarDistance(def, 0, 0), 0); // on the carrier
  assert.equal(sonarDistance(def, 9, 9), 7); // nearest: cruiser/sub at x=2 → max(7,7)
  assert.equal(sonarDistance(def, 0, 6), 2);
  for (const s of def.ships) s.sunk = true;
  assert.equal(sonarDistance(def, 0, 0), null);
});

test('sonarDistance ignores sunk ships', () => {
  const def = freshPlayer();
  def.ships.find((s) => s.id === 'destroyer').sunk = true; // row 4 gone
  assert.equal(sonarDistance(def, 0, 6), 3); // nearest now submarine row 3
});

test('reconScan reports truthful presence, clipped at edges', () => {
  const def = freshPlayer();
  const cells = reconScan(def, 0, 0, 10);
  assert.equal(cells.length, 4); // corner 3x3 → 2x2
  assert.ok(cells.find((c) => c.x === 0 && c.y === 0).ship);
  const open = reconScan(def, 8, 8, 10);
  assert.equal(open.length, 9);
  assert.ok(open.every((c) => !c.ship));
});
