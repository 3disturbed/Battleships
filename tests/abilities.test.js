import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useAbility } from '../game/abilities.js';
import { validateLayout } from '../game/placement.js';
import { ABILITIES } from '../game/const.js';
import { ROWS_LAYOUT } from './helpers.js';

function player(energy = 8) {
  return {
    ships: validateLayout(ROWS_LAYOUT, 10),
    revealed: new Map(),
    decoy: null,
    bigguns: false,
    fullsteamUsed: false,
    energy,
    abilityUsedThisRound: null,
    intel: [],
  };
}

test('abilities cost energy and are once per round', () => {
  const me = player(8);
  const foe = player();
  const res = useAbility(me, foe, 'sonar', { x: 5, y: 5 }, 10);
  assert.ok(!res.error);
  assert.equal(me.energy, 8 - ABILITIES.sonar.cost);
  assert.equal(me.abilityUsedThisRound, 'sonar');
  const second = useAbility(me, foe, 'bigguns', {}, 10);
  assert.match(second.error, /One ability per round/);
});

test('not enough energy is rejected', () => {
  const me = player(2);
  const res = useAbility(me, player(), 'sonar', { x: 0, y: 0 }, 10);
  assert.match(res.error, /Energy/);
  assert.equal(me.energy, 2);
  assert.equal(me.abilityUsedThisRound, null);
});

test('a sunk ship takes its ability down with it', () => {
  const me = player(8);
  me.ships.find((s) => s.id === 'submarine').sunk = true;
  const res = useAbility(me, player(), 'sonar', { x: 0, y: 0 }, 10);
  assert.match(res.error, /sunk/);
});

test('unknown ability and junk targets are rejected', () => {
  const me = player(8);
  assert.ok(useAbility(me, player(), 'nuke', {}, 10).error);
  assert.ok(useAbility(me, player(), 'sonar', { x: 99, y: 0 }, 10).error);
  assert.ok(useAbility(me, player(), 'sonar', null, 10).error);
  assert.ok(useAbility(me, player(), 'recon', { x: 'a', y: 0 }, 10).error);
  assert.equal(me.energy, 8);
});

test('sonar returns intel with the distance', () => {
  const me = player(8);
  const res = useAbility(me, player(), 'sonar', { x: 9, y: 9 }, 10);
  assert.equal(res.intel.kind, 'sonar');
  assert.equal(res.intel.distance, 7);
  assert.equal(me.intel.length, 1);
});

test('recon returns the 3x3 presence grid', () => {
  const me = player(8);
  const res = useAbility(me, player(), 'recon', { x: 1, y: 1 }, 10);
  assert.equal(res.intel.kind, 'recon');
  assert.equal(res.intel.cells.length, 9);
  assert.ok(res.intel.cells.every((c) => c.ship)); // rows 0-2 x 0-2 all ship
});

test('big guns arms the flag', () => {
  const me = player(8);
  const res = useAbility(me, player(), 'bigguns', {}, 10);
  assert.ok(!res.error);
  assert.equal(me.bigguns, true);
});

test('decoy: open water only, one per game', () => {
  const me = player(8);
  assert.match(useAbility(me, player(), 'decoy', { x: 0, y: 0 }, 10).error, /open water/);
  const res = useAbility(me, player(), 'decoy', { x: 9, y: 9 }, 10);
  assert.ok(!res.error);
  assert.deepEqual(me.decoy, { x: 9, y: 9, hit: false });
  me.abilityUsedThisRound = null; // next round
  me.energy = 8;
  assert.match(useAbility(me, player(), 'decoy', { x: 8, y: 8 }, 10).error, /already deployed/);
});

test('full steam: relocates an undamaged destroyer once, legally', () => {
  const me = player(8);
  const foe = player();
  // Illegal: collides with own submarine row
  assert.ok(useAbility(me, foe, 'fullsteam', { x: 0, y: 3, dir: 'h' }, 10).error);
  // Illegal: runs aground
  assert.ok(useAbility(me, foe, 'fullsteam', { x: 9, y: 9, dir: 'h' }, 10).error);
  // Legal
  const res = useAbility(me, foe, 'fullsteam', { x: 5, y: 8, dir: 'v' }, 10);
  assert.ok(!res.error);
  const d = me.ships.find((s) => s.id === 'destroyer');
  assert.deepEqual([d.x, d.y, d.dir], [5, 8, 'v']);
  assert.equal(me.fullsteamUsed, true);
  // Once per game
  me.abilityUsedThisRound = null;
  me.energy = 8;
  assert.match(useAbility(me, foe, 'fullsteam', { x: 0, y: 9, dir: 'h' }, 10).error, /once per game/);
});

test('full steam: refused when the destroyer is damaged', () => {
  const me = player(8);
  me.ships.find((s) => s.id === 'destroyer').hits[0] = true;
  assert.match(useAbility(me, player(), 'fullsteam', { x: 5, y: 8, dir: 'h' }, 10).error, /damaged/);
});

test('a failed ability neither spends energy nor burns the round slot', () => {
  const me = player(8);
  useAbility(me, player(), 'decoy', { x: 0, y: 0 }, 10); // fails: on own ship
  assert.equal(me.energy, 8);
  assert.equal(me.abilityUsedThisRound, null);
  const ok = useAbility(me, player(), 'sonar', { x: 4, y: 4 }, 10);
  assert.ok(!ok.error);
});
