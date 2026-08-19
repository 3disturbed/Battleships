import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, act } from '../game/state.js';
import { project } from '../game/view.js';
import { decideTurn, clampLevel, BOT_PROFILES } from '../lib/bot.js';
import { mulberry32, must, battleRoom, playRound, waterCells } from './helpers.js';

// Drive a full blitz game with both seats played by bot brains, through the
// real core. Every aim MUST validate — that is the legality proof.
function playBotGame(levelA, levelB, seed) {
  const rng = mulberry32(seed);
  const state = createRoom({ mode: 'blitz', grid: 10, series: 1 }, rng);
  must(act(state, 0, { t: 'join', name: 'A', avatar: 'a' }));
  must(act(state, 1, { t: 'join', name: 'B', avatar: 'b' }));
  must(act(state, 0, { t: 'ready', ready: true }));
  must(act(state, 1, { t: 'ready', ready: true }));
  must(act(state, null, { t: 'deadline' })); // random auto-placement for both

  const levels = [levelA, levelB];
  let guard = 0;
  while (state.phase === 'AIM' && guard++ < 300) {
    for (const seat of [0, 1]) {
      if (state.phase !== 'AIM') break;
      const { ability, cells } = decideTurn(levels[seat], project(state, seat), rng);
      if (ability) {
        const r = act(state, seat, { t: 'ability', kind: ability.kind, target: ability.target });
        assert.ok(r.ok, `L${levels[seat]} chose an illegal ability ${ability.kind}: ${r.error}`);
      }
      const aim = act(state, seat, { t: 'aim', cells });
      assert.ok(aim.ok, `L${levels[seat]} produced an illegal aim (seed ${seed}): ${aim.error}`);
      must(act(state, seat, { t: 'lock' }));
    }
  }
  assert.equal(state.phase, 'GAMEOVER', `game must end (seed ${seed})`);
  return state;
}

test('every level plays full games with only legal moves', () => {
  for (let level = 1; level <= 5; level++) {
    for (let seed = 1; seed <= 4; seed++) {
      playBotGame(level, 3, seed * 100 + level);
    }
  }
});

test('the Admiral crushes the Deckhand', () => {
  let admiralWins = 0;
  for (let seed = 1; seed <= 9; seed++) {
    const state = playBotGame(1, 5, seed);
    if (state.winner === 1) admiralWins++;
  }
  assert.ok(admiralWins >= 6, `Admiral won only ${admiralWins}/9 vs Deckhand`);
});

test('level 2+ chases a fresh hit with adjacent shots', () => {
  const state = battleRoom();
  playRound(state, [{ x: 0, y: 0 }], waterCells(5, 0)); // one hit on their carrier
  const view = project(state, 0);
  for (const level of [2, 3, 4, 5]) {
    const { cells } = decideTurn(level, view, mulberry32(level));
    const nearHit = cells.some((c) =>
      (Math.abs(c.x - 0) === 1 && c.y === 0) || (c.x === 0 && Math.abs(c.y - 0) === 1));
    assert.ok(nearHit, `L${level} ignored the wounded ship`);
  }
});

test('a decoy dupes the bot exactly like a human', () => {
  const state = battleRoom();
  playRound(state, waterCells(5, 0), waterCells(5, 1));
  playRound(state, waterCells(5, 2), waterCells(5, 3)); // round 3: energy 3
  must(act(state, 1, { t: 'ability', kind: 'decoy', target: { x: 9, y: 9 } }));
  playRound(state, [{ x: 9, y: 9 }], [{ x: 5, y: 5 }]); // seat 0 "hits" the buoy

  const view = project(state, 0); // masked: the decoy reads as a plain hit
  const { cells } = decideTurn(4, view, mulberry32(7));
  const chasesGhost = cells.some((c) =>
    (Math.abs(c.x - 9) === 1 && c.y === 9) || (c.x === 9 && Math.abs(c.y - 9) === 1));
  assert.ok(chasesGhost, 'Commodore should waste shells hunting the buoy');
});

test('level 1 never uses abilities; level ladder is bounded', () => {
  const state = battleRoom();
  playRound(state, waterCells(5, 0), waterCells(5, 1));
  playRound(state, waterCells(5, 2), waterCells(5, 3));
  const view = project(state, 0);
  for (let seed = 0; seed < 20; seed++) {
    assert.equal(decideTurn(1, view, mulberry32(seed)).ability, null);
    assert.equal(decideTurn(2, view, mulberry32(seed)).ability, null);
  }
  assert.equal(clampLevel(0), 1);
  assert.equal(clampLevel(99), 5);
  assert.equal(clampLevel('x'), 3);
  assert.equal(Object.keys(BOT_PROFILES).length, 5);
});

test('bot respects the shot budget', () => {
  const state = battleRoom();
  const view = project(state, 0);
  for (let level = 1; level <= 5; level++) {
    const { cells } = decideTurn(level, view, mulberry32(level * 7));
    assert.ok(cells.length <= view.you.maxShots);
    assert.ok(cells.length >= 1);
    assert.equal(new Set(cells.map((c) => `${c.x},${c.y}`)).size, cells.length, 'distinct cells');
  }
});
