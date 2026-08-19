import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistry, makeCode, CODE_ALPHABET,
  scheduleDeadline, freezeDeadline, resumeDeadline, cancelDeadline,
} from '../lib/rooms.js';
import { mulberry32 } from './helpers.js';

test('room codes: 6 chars, unambiguous alphabet only', () => {
  assert.ok(!CODE_ALPHABET.includes('I'));
  assert.ok(!CODE_ALPHABET.includes('O'));
  assert.ok(!CODE_ALPHABET.includes('0'));
  assert.ok(!CODE_ALPHABET.includes('1'));
  assert.equal(CODE_ALPHABET.length, 32);
  for (let s = 0; s < 50; s++) {
    const code = makeCode(mulberry32(s));
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  }
});

test('registry: create, cap, tokens, destroy', () => {
  const reg = createRegistry({ maxRooms: 2 });
  const r1 = reg.create({}, mulberry32(1));
  const r2 = reg.create({}, mulberry32(2));
  assert.ok(r1 && r2);
  assert.equal(reg.create({}, mulberry32(3)), null, 'cap reached');
  assert.equal(reg.get(r1.code), r1);

  const tok = reg.issueToken(r1, 0);
  assert.deepEqual(reg.byToken(tok).seat, 0);
  assert.equal(reg.byToken('nope'), null);

  reg.destroy(r1);
  assert.equal(reg.get(r1.code), null);
  assert.equal(reg.byToken(tok), null, 'destroy clears tokens');
  assert.equal(reg.size, 1);
});

test('sweep: empty lobbies, finished games, abandoned battles', () => {
  let t = 1_000_000;
  const reg = createRegistry({ now: () => t });

  const lobby = reg.create({}, mulberry32(1));
  const finished = reg.create({}, mulberry32(2));
  finished.state.phase = 'GAMEOVER';
  const abandoned = reg.create({}, mulberry32(3));
  abandoned.state.phase = 'AIM';
  const occupied = reg.create({}, mulberry32(4));
  occupied.seats[0].conn = { fake: true };

  t += 6 * 60_000; // +6 min
  reg.sweep(() => {});
  assert.equal(reg.get(lobby.code), lobby, 'empty lobby lives 10 min');
  assert.equal(reg.get(finished.code), null, 'finished room GCed at 5 min');
  assert.equal(reg.get(abandoned.code), null, 'abandoned battle GCed at 5 min');
  assert.equal(reg.get(occupied.code), occupied);

  t += 5 * 60_000; // +11 min total
  reg.sweep(() => {});
  assert.equal(reg.get(lobby.code), null, 'empty lobby GCed at 10 min');
  assert.equal(reg.get(occupied.code), occupied, 'occupied lobby never GCed');

  occupied.state.phase = 'GAMEOVER'; // someone camping the victory screen
  t += 11 * 60_000;
  let closed = 0;
  reg.sweep(() => closed++);
  assert.equal(reg.get(occupied.code), null);
  assert.equal(closed, 1, 'camper socket got the close callback');
});

test('deadline freeze/resume preserves remaining time', async () => {
  const room = { deadline: null };
  let fired = 0;
  scheduleDeadline(room, 60, () => fired++);
  freezeDeadline(room);
  const frozen = room.deadline.remainingMs;
  assert.ok(frozen >= 1000, 'freeze floors remaining at 1s');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, 0, 'frozen clock does not fire');
  resumeDeadline(room, () => fired++);
  assert.ok(room.deadline.at > Date.now());
  cancelDeadline(room);
  assert.equal(room.deadline, null);
});
