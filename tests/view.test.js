import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from '../game/state.js';
import { project } from '../game/view.js';
import { key } from '../game/const.js';
import { must, battleRoom, playRound, waterCells, ROWS_CELLS } from './helpers.js';

test('projection never leaks foe ship positions before game over', () => {
  const state = battleRoom();
  playRound(state, ROWS_CELLS.slice(0, 5), waterCells(5, 0));
  const view = project(state, 1); // the player being hunted looks at the hunter
  assert.equal(view.foe.ships, undefined, 'no foe ships field mid-game');
  assert.equal(view.reveal, undefined, 'no reveal mid-game');
  const asText = JSON.stringify(view.foe);
  assert.ok(!asText.includes('"dir"'), 'no orientation data about foe fleet');
  // Own ships fully visible to their owner.
  assert.equal(project(state, 0).you.ships.length, 5);
});

test('sunk foe ships appear as silhouettes with the lost ability named', () => {
  const state = battleRoom();
  playRound(state, ROWS_CELLS.slice(0, 5), waterCells(5, 0)); // carrier down
  const view = project(state, 0);
  assert.equal(view.foe.sunk.length, 1);
  assert.equal(view.foe.sunk[0].id, 'carrier');
  assert.equal(view.foe.sunk[0].ability, 'Recon Flight');
  assert.equal(view.foe.sunk[0].cells.length, 5);
});

test('decoy dupes are masked for the attacker, visible to the defender', () => {
  const state = battleRoom();
  playRound(state, waterCells(5, 0), waterCells(5, 1));
  playRound(state, waterCells(5, 2), waterCells(5, 3)); // round 3: energy 3
  must(act(state, 1, { t: 'ability', kind: 'decoy', target: { x: 9, y: 9 } }));
  playRound(state, [{ x: 9, y: 9 }], [{ x: 5, y: 5 }]); // seat 0 shoots the buoy

  const attacker = project(state, 0);
  const defender = project(state, 1);
  const k = key(9, 9);
  assert.equal(Object.fromEntries(attacker.foe.revealed)[k], 'hit', 'attacker sees a hit');
  assert.equal(Object.fromEntries(defender.you.revealed)[k], 'decoy', 'defender sees the dupe');
});

test('game over adds the full reveal, including the foe decoy truth', () => {
  const state = battleRoom();
  playRound(state, ROWS_CELLS.slice(0, 5), waterCells(5, 0));
  playRound(state, ROWS_CELLS.slice(5, 10), waterCells(4, 1));
  playRound(state, ROWS_CELLS.slice(10, 15), waterCells(3, 2));
  playRound(state, ROWS_CELLS.slice(15, 17), waterCells(2, 3));
  assert.equal(state.phase, 'GAMEOVER');
  const view = project(state, 1);
  assert.equal(view.reveal.foe.ships.length, 5);
  assert.equal(view.reveal.foe.stats.shots >= 17, true);
  assert.ok(view.you.stats);
});

test('projections are plain JSON — snapshot round-trips exactly', () => {
  const state = battleRoom();
  playRound(state, ROWS_CELLS.slice(0, 5), waterCells(5, 0));
  for (const seat of [0, 1]) {
    const view = project(state, seat);
    assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  }
});

test('aim counts are visible but aim cells are not', () => {
  const state = battleRoom();
  must(act(state, 1, { t: 'aim', cells: waterCells(3, 0) }));
  const view = project(state, 0);
  assert.equal(view.foe.aimCount, 3, 'the tension meter');
  assert.ok(!JSON.stringify(view.foe).includes('"aim":'), 'never the actual cells');
});
