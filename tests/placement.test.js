import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLayout, randomLayout, autoComplete, shipCells } from '../game/placement.js';
import { SHIPS, key } from '../game/const.js';
import { mulberry32, ROWS_LAYOUT } from './helpers.js';

test('validateLayout accepts a legal layout and normalizes it', () => {
  const ships = validateLayout(ROWS_LAYOUT, 10);
  assert.ok(ships);
  assert.equal(ships.length, 5);
  const carrier = ships.find((s) => s.id === 'carrier');
  assert.equal(carrier.size, 5);
  assert.deepEqual(carrier.hits, [false, false, false, false, false]);
  assert.equal(carrier.sunk, false);
});

test('validateLayout rejects overlap', () => {
  const bad = ROWS_LAYOUT.map((s) => ({ ...s, y: 0 })); // everything on row 0
  assert.equal(validateLayout(bad, 10), null);
});

test('validateLayout rejects out of bounds', () => {
  const bad = ROWS_LAYOUT.map((s) => (s.id === 'carrier' ? { ...s, x: 6 } : s)); // 6+5 > 10
  assert.equal(validateLayout(bad, 10), null);
  const badV = ROWS_LAYOUT.map((s) => (s.id === 'destroyer' ? { ...s, y: 9, dir: 'v' } : s));
  assert.equal(validateLayout(badV, 10), null);
});

test('validateLayout rejects missing / duplicate / unknown ships and junk', () => {
  assert.equal(validateLayout(ROWS_LAYOUT.slice(1), 10), null);
  assert.equal(validateLayout([ROWS_LAYOUT[0], ...ROWS_LAYOUT.slice(0, 4)], 10), null);
  assert.equal(validateLayout(ROWS_LAYOUT.map((s) => ({ ...s, id: s.id === 'cruiser' ? 'canoe' : s.id })), 10), null);
  assert.equal(validateLayout('nope', 10), null);
  assert.equal(validateLayout([null, 1, 2, 3, 4], 10), null);
  assert.equal(validateLayout(ROWS_LAYOUT.map((s) => ({ ...s, dir: 'diagonal' })), 10), null);
  assert.equal(validateLayout(ROWS_LAYOUT.map((s) => ({ ...s, x: 0.5 })), 10), null);
});

test('touching ships are legal', () => {
  assert.ok(validateLayout(ROWS_LAYOUT, 10)); // rows 0-4 all adjacent
});

test('randomLayout is always legal on both grids', () => {
  for (let seed = 0; seed < 200; seed++) {
    for (const grid of [8, 10]) {
      const layout = randomLayout(grid, mulberry32(seed));
      assert.ok(validateLayout(layout, grid), `seed ${seed} grid ${grid}`);
    }
  }
});

test('autoComplete keeps a valid partial and fills the rest', () => {
  const partial = ROWS_LAYOUT.slice(0, 2); // carrier + battleship kept
  const full = autoComplete(partial, 10, mulberry32(7));
  const ships = validateLayout(full, 10);
  assert.ok(ships);
  const carrier = full.find((s) => s.id === 'carrier');
  assert.deepEqual(carrier, ROWS_LAYOUT[0]);
});

test('autoComplete discards colliding/junk entries and still produces legality', () => {
  const junk = [
    { id: 'carrier', x: 9, y: 9, dir: 'h' }, // out of bounds
    { id: 'carrier', x: 0, y: 0, dir: 'h' }, // duplicate id (second ignored)
    { id: 'kayak', x: 0, y: 0, dir: 'h' },
    null,
  ];
  for (let seed = 0; seed < 50; seed++) {
    const full = autoComplete(junk, 8, mulberry32(seed));
    assert.ok(validateLayout(full, 8), `seed ${seed}`);
  }
});

test('shipCells covers exactly size cells with no gaps', () => {
  const cells = shipCells({ x: 2, y: 3, dir: 'v', size: 4 });
  assert.deepEqual(cells, [{ x: 2, y: 3 }, { x: 2, y: 4 }, { x: 2, y: 5 }, { x: 2, y: 6 }]);
});

test('fleet totals 17 cells', () => {
  const total = SHIPS.reduce((n, s) => n + s.size, 0);
  assert.equal(total, 17);
  const ships = validateLayout(ROWS_LAYOUT, 10);
  const cells = new Set(ships.flatMap((s) => shipCells(s).map((c) => key(c.x, c.y))));
  assert.equal(cells.size, 17);
});
