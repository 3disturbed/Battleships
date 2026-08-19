import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, act, maxShots } from '../game/state.js';
import { validateLayout } from '../game/placement.js';
import {
  mulberry32, must, joinedRoom, battleRoom, playRound,
  ROWS_LAYOUT, ROWS_CELLS, waterCells,
} from './helpers.js';

// --- lobby -----------------------------------------------------------------

test('lobby: join, settings, ready-up flow', () => {
  const state = createRoom({}, mulberry32(1));
  must(act(state, 0, { t: 'join', name: 'Ash', avatar: '🦈' }));
  assert.ok(act(state, 0, { t: 'join', name: 'X', avatar: 'y' }).error, 'seat taken');
  must(act(state, 1, { t: 'join', name: 'Bo', avatar: '🐙' }));
  assert.ok(act(state, 1, { t: 'settings', patch: { grid: 8 } }).error, 'guest cannot set');
  must(act(state, 0, { t: 'settings', patch: { grid: 8, aimTimer: 10, junk: 'ignored', series: 99 } }));
  assert.equal(state.settings.grid, 8);
  assert.equal(state.settings.aimTimer, 10);
  assert.equal(state.settings.series, 3, 'invalid series value ignored');
  must(act(state, 0, { t: 'ready', ready: true }));
  assert.equal(state.phase, 'LOBBY');
  const res = must(act(state, 1, { t: 'ready', ready: true }));
  assert.equal(state.phase, 'PLACEMENT');
  assert.ok(res.events.some((e) => e.t === 'phase' && e.phase === 'PLACEMENT'));
});

// --- action × phase legality ----------------------------------------------

test('actions are rejected outside their phase, state untouched', () => {
  const lobby = joinedRoom();
  for (const action of [
    { t: 'layout', ships: ROWS_LAYOUT },
    { t: 'aim', cells: [{ x: 0, y: 0 }] },
    { t: 'ability', kind: 'sonar', target: { x: 0, y: 0 } },
    { t: 'lock' },
    { t: 'rematch' },
    { t: 'forfeit', loser: 0 },
    { t: 'nonsense' },
  ]) {
    const res = act(lobby, 0, action);
    assert.ok(res.error, `${action.t} must fail in LOBBY`);
    assert.equal(lobby.phase, 'LOBBY');
  }

  const battle = battleRoom();
  for (const action of [
    { t: 'ready', ready: true },
    { t: 'settings', patch: { grid: 8 } },
    { t: 'layout', ships: ROWS_LAYOUT },
  ]) {
    assert.ok(act(battle, 0, action).error, `${action.t} must fail in AIM`);
    assert.equal(battle.phase, 'AIM');
  }

  // A stale deadline after game end is harmless.
  const res = act(battle, null, { t: 'deadline' });
  assert.ok(res.ok);
});

// --- placement -------------------------------------------------------------

test('placement: bad layout rejected, deadline auto-places stragglers', () => {
  const state = joinedRoom();
  must(act(state, 0, { t: 'ready', ready: true }));
  must(act(state, 1, { t: 'ready', ready: true }));
  assert.ok(act(state, 0, { t: 'layout', ships: 'garbage' }).error);
  must(act(state, 0, { t: 'layout', ships: ROWS_LAYOUT }));
  assert.ok(act(state, 0, { t: 'layout', ships: ROWS_LAYOUT }).error, 'double lock');
  assert.equal(state.phase, 'PLACEMENT');
  const res = must(act(state, null, { t: 'deadline' }));
  assert.equal(state.phase, 'AIM');
  assert.ok(res.events.some((e) => e.t === 'placed' && e.seat === 1));
  assert.ok(validateLayout(state.players[1].ships.map(({ id, x, y, dir }) => ({ id, x, y, dir })), 10));
});

// --- blitz: full game to a sunk win ---------------------------------------

test('blitz: methodical hunt wins in 4 rounds with correct energy accounting', () => {
  const state = battleRoom();
  assert.equal(state.round, 1);
  assert.equal(maxShots(state, 0), 5);

  playRound(state, ROWS_CELLS.slice(0, 5), waterCells(5, 0)); // carrier down
  assert.equal(state.players[1].ships.find((s) => s.id === 'carrier').sunk, true);
  assert.equal(state.round, 2);
  assert.equal(maxShots(state, 1), 4, 'salvo shrinks with the fleet');
  assert.equal(state.players[1].energy, 1 + 2 + 1, 'round + ship-lost bonus + round 2');
  assert.equal(state.players[0].energy, 2);

  playRound(state, ROWS_CELLS.slice(5, 10), waterCells(4, 1)); // battleship + cruiser nick
  playRound(state, ROWS_CELLS.slice(10, 15), waterCells(3, 2)); // cruiser + submarine
  assert.equal(state.players[1].energy, 8, 'comeback energy caps at 8');

  const events = playRound(state, ROWS_CELLS.slice(15, 17), waterCells(2, 3));
  assert.equal(state.phase, 'GAMEOVER');
  assert.equal(state.winner, 0);
  assert.equal(state.reason, 'sunk');
  assert.deepEqual(state.series.wins, [1, 0]);
  assert.equal(state.series.champion, null, 'best-of-3 needs 2 wins');

  const over = events.find((e) => e.t === 'over');
  assert.ok(over);
  const resolve = events.find((e) => e.t === 'resolve');
  const mySinks = resolve.volleys.find((v) => v.seat === 0).sinks;
  assert.equal(mySinks[0].id, 'destroyer');
  assert.equal(mySinks[0].ability, 'Full Steam', 'sink banner names the lost ability');
});

test('blitz: aim validation — bounds, repeats, over-count, revealed cells', () => {
  const state = battleRoom();
  assert.ok(act(state, 0, { t: 'aim', cells: [{ x: 10, y: 0 }] }).error);
  assert.ok(act(state, 0, { t: 'aim', cells: [{ x: 1, y: 1 }, { x: 1, y: 1 }] }).error);
  assert.ok(act(state, 0, { t: 'aim', cells: waterCells(6, 0).concat(waterCells(1, 1)) }).error);
  playRound(state, [{ x: 9, y: 9 }], waterCells(2, 0));
  assert.ok(act(state, 0, { t: 'aim', cells: [{ x: 9, y: 9 }] }).error, 'already revealed');
});

test('blitz: abilities through the state machine, intel event routing', () => {
  const state = battleRoom();
  playRound(state, waterCells(5, 0), waterCells(5, 1)); // round 2: energy 2 each
  playRound(state, waterCells(5, 2), waterCells(5, 3)); // round 3: energy 3 each
  const res = must(act(state, 0, { t: 'ability', kind: 'sonar', target: { x: 9, y: 9 } }));
  const intel = res.events.find((e) => e.t === 'intel');
  assert.equal(intel.seat, 0);
  assert.equal(intel.intel.distance, 7);
  assert.ok(act(state, 0, { t: 'ability', kind: 'sonar', target: { x: 0, y: 0 } }).error, 'once per round');
  assert.ok(act(state, 1, { t: 'ability', kind: 'recon', target: { x: 1, y: 1 } }).error, 'energy too low');
});

// --- AFK & forfeit ---------------------------------------------------------

test('blitz: a fully absent player forfeits after 3 rounds', () => {
  const state = battleRoom();
  for (let r = 0; r < 3; r++) {
    must(act(state, 0, { t: 'aim', cells: waterCells(5, r) }));
    must(act(state, null, { t: 'deadline' })); // seat 1 said nothing all round
  }
  assert.equal(state.phase, 'GAMEOVER');
  assert.equal(state.winner, 0);
  assert.equal(state.reason, 'forfeit');
});

test('blitz: both absent = abandoned draw; scatter still fires shells', () => {
  const state = battleRoom();
  for (let r = 0; r < 3; r++) must(act(state, null, { t: 'deadline' }));
  assert.equal(state.phase, 'GAMEOVER');
  assert.equal(state.winner, null);
  assert.equal(state.reason, 'abandoned');
  // Scatter may randomly sink attacker ships and shrink later volleys, so
  // assert the floor, not an exact count: ≥ MIN_SHOTS per round.
  assert.ok(state.players[0].stats.shots >= 6, 'auto-scatter fired every round');
});

test('forfeit action ends a live game for the leaver', () => {
  const state = battleRoom();
  must(act(state, null, { t: 'forfeit', loser: 1, reason: 'left' }));
  assert.equal(state.phase, 'GAMEOVER');
  assert.equal(state.winner, 0);
  assert.equal(state.reason, 'left');
});

// --- mutual destruction ----------------------------------------------------

function playMirrorGame(state) {
  let idx = 0;
  let guard = 0;
  while (state.phase === 'AIM' && guard++ < 20) {
    const k = maxShots(state, 0); // symmetric — same for both
    const cells = ROWS_CELLS.slice(idx, Math.min(idx + k, ROWS_CELLS.length));
    idx += cells.length;
    playRound(state, cells, cells.map((c) => ({ ...c })));
  }
}

test('blitz: perfectly mirrored destruction is a true draw', () => {
  const state = battleRoom();
  playMirrorGame(state);
  assert.equal(state.phase, 'GAMEOVER');
  assert.equal(state.winner, null);
  assert.equal(state.reason, 'mutual');
  assert.deepEqual(state.series.wins, [0, 0]);
});

test('blitz: mutual destruction tiebreak goes to the more efficient fleet', () => {
  const state = battleRoom();
  state.players[1].stats.shots += 3; // seat 1 wasted shells earlier (simulated)
  playMirrorGame(state);
  assert.equal(state.phase, 'GAMEOVER');
  assert.equal(state.winner, 0);
  assert.equal(state.reason, 'mutual');
});

// --- rematch & series ------------------------------------------------------

test('rematch resets boards, advances the series, crowns a champion', () => {
  const state = battleRoom();
  playRound(state, ROWS_CELLS.slice(0, 5), waterCells(5, 0));
  playRound(state, ROWS_CELLS.slice(5, 10), waterCells(4, 1));
  playRound(state, ROWS_CELLS.slice(10, 15), waterCells(3, 2));
  playRound(state, ROWS_CELLS.slice(15, 17), waterCells(2, 3));
  assert.equal(state.phase, 'GAMEOVER');

  must(act(state, 0, { t: 'rematch' }));
  assert.equal(state.phase, 'GAMEOVER', 'one vote is not enough');
  must(act(state, 1, { t: 'rematch' }));
  assert.equal(state.phase, 'PLACEMENT');
  assert.equal(state.series.game, 2);
  assert.deepEqual(state.series.wins, [1, 0]);
  assert.equal(state.players[0].ships, null, 'fresh boards');
  assert.equal(state.players[0].energy, 0);

  // Win game 2 → 2-0 in a best-of-3 → champion.
  must(act(state, 0, { t: 'layout', ships: ROWS_LAYOUT }));
  must(act(state, 1, { t: 'layout', ships: ROWS_LAYOUT }));
  playRound(state, ROWS_CELLS.slice(0, 5), waterCells(5, 0));
  playRound(state, ROWS_CELLS.slice(5, 10), waterCells(4, 1));
  playRound(state, ROWS_CELLS.slice(10, 15), waterCells(3, 2));
  playRound(state, ROWS_CELLS.slice(15, 17), waterCells(2, 3));
  assert.equal(state.series.champion, 0);

  // Rematch after a crowned series starts a fresh series.
  must(act(state, 0, { t: 'rematch' }));
  must(act(state, 1, { t: 'rematch' }));
  assert.deepEqual(state.series.wins, [0, 0]);
  assert.equal(state.series.game, 1);
  assert.equal(state.series.champion, null);
});

// --- classic mode ----------------------------------------------------------

test('classic: alternating single shots to a win; no abilities', () => {
  const state = battleRoom({ mode: 'classic' });
  assert.equal(state.phase, 'AIM');
  const first = state.turn;
  const hunter = first; // whoever starts hunts; the other shoots water
  assert.ok(act(state, 1 - first, { t: 'aim', cells: [{ x: 9, y: 9 }] }).error, 'not your turn');
  assert.ok(act(state, first, { t: 'ability', kind: 'sonar', target: { x: 0, y: 0 } }).error, 'no abilities');

  let shipIdx = 0;
  let waterIdx = 0;
  let guard = 0;
  while (state.phase === 'AIM' && guard++ < 80) {
    const seat = state.turn;
    const cell = seat === hunter
      ? ROWS_CELLS[shipIdx++]
      : { x: waterIdx % 10, y: 8 + Math.floor((waterIdx++ % 20) / 10) };
    must(act(state, seat, { t: 'aim', cells: [cell] }));
    must(act(state, seat, { t: 'lock' }));
  }
  assert.equal(state.phase, 'GAMEOVER');
  assert.equal(state.winner, hunter);
  assert.equal(state.reason, 'sunk');
  assert.equal(state.players[hunter].stats.hits, 17);
  assert.equal(state.players[hunter].stats.shots, 17, 'perfect classic game');
});

test('classic: timeout auto-fires for the absent active player and turn passes', () => {
  const state = battleRoom({ mode: 'classic' });
  const active = state.turn;
  must(act(state, null, { t: 'deadline' }));
  assert.equal(state.players[active].stats.shots, 1, 'scattered a shell');
  assert.equal(state.turn, 1 - active);
  assert.equal(state.round, 2);
});
