// End-to-end over real websockets: lobby → placement → battle → game over,
// plus reconnect-with-token and claim-after-grace. Deadlines never fire here —
// every step locks explicitly.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { TestClient, lastState } from './wsclient.js';
import { ROWS_LAYOUT, ROWS_CELLS, waterCells } from './helpers.js';
import { shipCells } from '../game/placement.js';

process.env.RECONNECT_GRACE_MS = '200'; // read at createServer() time
process.env.BOT_FAST = '1'; // bots think in ~15ms instead of seconds

let srv;
let url;

before(async () => {
  srv = createServer({ port: 0, roomOpsPerMin: 6000 });
  await new Promise((res) => srv.server.on('listening', res));
  url = `ws://127.0.0.1:${srv.server.address().port}/ws`;
});

after(() => srv.close());

async function freshPair(settings = {}) {
  const a = new TestClient(url);
  await a.open;
  a.send({ t: 'hello', v: 1, name: 'Ash', avatar: '🦈' });
  await a.take('welcome');
  a.send({ t: 'create', settings });
  const wa = await a.take('welcome');
  assert.equal(wa.seat, 0);

  const b = new TestClient(url);
  await b.open;
  b.send({ t: 'hello', v: 1, name: 'Bo', avatar: '🐙' });
  await b.take('welcome');
  b.send({ t: 'join', roomCode: wa.roomCode });
  const wb = await b.take('welcome');
  assert.equal(wb.seat, 1);
  return { a, b, code: wa.roomCode, tokenA: wa.reconnectToken, tokenB: wb.reconnectToken };
}

async function untilPhase(client, phase) {
  let s;
  do { s = await client.take('state'); } while (s.view.phase !== phase);
  return s;
}

async function toBattle(a, b) {
  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });
  // Layouts may not be sent until the server has actually entered PLACEMENT —
  // cross-socket ordering is not guaranteed.
  await untilPhase(a, 'PLACEMENT');
  await untilPhase(b, 'PLACEMENT');
  a.send({ t: 'layout', ships: ROWS_LAYOUT });
  b.send({ t: 'layout', ships: ROWS_LAYOUT });
  await untilPhase(a, 'AIM');
  await untilPhase(b, 'AIM');
}

test('full blitz game over websockets', async () => {
  const { a, b } = await freshPair();
  await toBattle(a, b);

  const hunts = [ROWS_CELLS.slice(0, 5), ROWS_CELLS.slice(5, 10), ROWS_CELLS.slice(10, 15), ROWS_CELLS.slice(15, 17)];
  for (let r = 0; r < 4; r++) {
    a.send({ t: 'aim', cells: hunts[r] });
    b.send({ t: 'aim', cells: waterCells([5, 4, 3, 2][r], r) }); // salvo shrinks with the fleet
    a.send({ t: 'lock' });
    b.send({ t: 'lock' });
    const resolve = await a.take('resolve');
    assert.equal(resolve.round, r + 1);
    await b.take('resolve');
  }

  let s = await lastState(a);
  assert.equal(s.view.phase, 'GAMEOVER');
  assert.equal(s.view.winner, 0);
  assert.equal(s.view.reason, 'sunk');
  assert.ok(s.view.reveal.foe.ships.length === 5, 'reveal reaches the loser too');

  // Rematch → fresh placement.
  a.send({ t: 'rematch' });
  b.send({ t: 'rematch' });
  do { s = await a.take('state'); } while (s.view.phase !== 'PLACEMENT');
  assert.equal(s.view.series.game, 2);

  await a.close();
  await b.close();
});

test('reconnect with token resumes mid-battle and unfreezes the clock', async () => {
  const { a, b, tokenB } = await freshPair();
  await toBattle(a, b);

  a.send({ t: 'aim', cells: [{ x: 9, y: 9 }] });
  await b.terminate(); // network death, no clean close

  let s;
  do { s = await a.take('state'); } while (!s.paused);
  assert.equal(s.presence[1], 'off');
  assert.equal(s.deadlineAt, null, 'clock frozen while paused');

  const b2 = new TestClient(url);
  await b2.open;
  b2.send({ t: 'hello', v: 1, name: 'Bo', avatar: '🐙', reconnectToken: tokenB });
  const w = await b2.take('welcome');
  assert.equal(w.resumed, true);
  assert.equal(w.seat, 1);

  s = await lastState(b2);
  assert.equal(s.view.phase, 'AIM');
  assert.equal(s.paused, false);
  assert.ok(s.deadlineAt > Date.now(), 'clock running again');
  assert.equal(s.view.you.ships.length, 5, 'snapshot restores own fleet');

  do { s = await a.take('state'); } while (s.paused);
  assert.equal(s.presence[1], 'on');

  await a.close();
  await b2.close();
});

test('claim victory after the grace period', async () => {
  const { a, b } = await freshPair();
  await toBattle(a, b);

  await b.terminate();
  let s;
  do { s = await a.take('state'); } while (!s.paused);

  a.send({ t: 'claim' });
  const early = await a.take('error');
  assert.match(early.message, /not been gone long enough/);

  await new Promise((res) => setTimeout(res, 300)); // grace is 200ms in tests
  a.send({ t: 'claim' });
  do { s = await a.take('state'); } while (s.view.phase !== 'GAMEOVER');
  assert.equal(s.view.winner, 0);
  assert.equal(s.view.reason, 'claim');

  await a.close();
});

test('join failures: malformed, expired, full', async () => {
  const c = new TestClient(url);
  await c.open;
  c.send({ t: 'hello', v: 1, name: 'Cee', avatar: '🐳' });
  await c.take('welcome');

  c.send({ t: 'join', roomCode: 'nope' });
  assert.match((await c.take('error')).message, /does not look right/);

  c.send({ t: 'join', roomCode: 'ABCDEF' });
  const gone = await c.take('error');
  assert.equal(gone.code, 'gone');
  assert.match(gone.message, /expired/);

  const { code, a, b } = await freshPair();
  c.send({ t: 'join', roomCode: code });
  assert.equal((await c.take('error')).code, 'full');

  await c.close();
  await a.close();
  await b.close();
});

test('lobby leave frees the seat for someone else', async () => {
  const { a, b, code } = await freshPair();
  b.send({ t: 'leave' });
  await b.take('left');

  let s;
  do { s = await a.take('state'); } while (s.view.seats[1] !== null);
  assert.equal(s.presence[1], 'none');

  const c = new TestClient(url);
  await c.open;
  c.send({ t: 'hello', v: 1, name: 'Cee', avatar: '🐳' });
  await c.take('welcome');
  c.send({ t: 'join', roomCode: code });
  const w = await c.take('welcome');
  assert.equal(w.seat, 1);

  await a.close();
  await b.close();
  await c.close();
});

test('mid-game leave is a forfeit for the leaver', async () => {
  const { a, b } = await freshPair();
  await toBattle(a, b);
  b.send({ t: 'leave' });
  let s;
  do { s = await a.take('state'); } while (s.view.phase !== 'GAMEOVER');
  assert.equal(s.view.winner, 0);
  assert.equal(s.view.reason, 'left');
  await a.close();
  await b.close();
});

test('solo player: add a bot, beat it, rematch, dismiss it', async () => {
  const a = new TestClient(url);
  await a.open;
  a.send({ t: 'hello', v: 1, name: 'Solo', avatar: '🦈' });
  await a.take('welcome');
  a.send({ t: 'create', settings: { mode: 'blitz', grid: 10, series: 3 } });
  const w = await a.take('welcome');

  a.send({ t: 'addBot', level: 1 });
  let s;
  do { s = await a.take('state'); } while (!s.view.seats[1]);
  assert.equal(s.view.seats[1].bot, true);
  assert.equal(s.view.seats[1].ready, true, 'bots ready up instantly');
  assert.equal(s.presence[1], 'on');

  a.send({ t: 'ready', ready: true });
  await untilPhase(a, 'PLACEMENT');
  a.send({ t: 'layout', ships: ROWS_LAYOUT });
  s = await untilPhase(a, 'AIM'); // the bot auto-placed (randomly)

  // The test is omniscient: read the bot's real layout from the registry and
  // hunt exactly those 17 cells. A Deckhand cannot land 17 targeted hits first.
  const room = srv.registry.get(w.roomCode);
  const targets = room.state.players[1].ships.flatMap((ship) => shipCells(ship));
  assert.equal(targets.length, 17);
  let idx = 0;
  let guard = 0;
  let round = s.view.round;
  while (s.view.phase === 'AIM' && guard++ < 40) {
    const n = Math.min(s.view.you.maxShots, targets.length - idx);
    assert.ok(n > 0, 'ran out of targets with the bot fleet still afloat');
    a.send({ t: 'aim', cells: targets.slice(idx, idx + n) });
    a.send({ t: 'lock' });
    await a.take('resolve', 8000); // the bot aims and locks on its own
    idx += n;
    // Skip stale same-round states buffered before the resolve; stop only on
    // a genuinely new round (or the end).
    do { s = await a.take('state'); } while (
      s.view.phase !== 'GAMEOVER' && !(s.view.phase === 'AIM' && s.view.round > round));
    round = s.view.round;
  }
  assert.equal(s.view.phase, 'GAMEOVER');
  assert.equal(s.view.winner, 0);

  // No claiming victory over a bot — it is always "present".
  a.send({ t: 'claim' });
  assert.match((await a.take('error')).message, /not been gone/);

  // Bot votes rematch by itself; one tap from the human starts game 2.
  a.send({ t: 'rematch' });
  s = await untilPhase(a, 'PLACEMENT');
  assert.equal(s.view.series.game, 2);

  await a.close();
});

test('dismissing a bot frees the seat for a human', async () => {
  const a = new TestClient(url);
  await a.open;
  a.send({ t: 'hello', v: 1, name: 'Host', avatar: '🐙' });
  await a.take('welcome');
  a.send({ t: 'create', settings: {} });
  const w = await a.take('welcome');

  a.send({ t: 'addBot', level: 5 });
  let s;
  do { s = await a.take('state'); } while (!s.view.seats[1]);
  a.send({ t: 'addBot', level: 2 });
  assert.match((await a.take('error')).message, /taken/);

  a.send({ t: 'removeBot' });
  do { s = await a.take('state'); } while (s.view.seats[1]);
  assert.equal(s.presence[1], 'none');

  const b = new TestClient(url);
  await b.open;
  b.send({ t: 'hello', v: 1, name: 'Friend', avatar: '🐳' });
  await b.take('welcome');
  b.send({ t: 'join', roomCode: w.roomCode });
  assert.equal((await b.take('welcome')).seat, 1);

  await a.close();
  await b.close();
});

test('wrong-version hello is refused with a refresh hint', async () => {
  const c = new TestClient(url);
  await c.open;
  c.send({ t: 'hello', v: 42, name: 'Old', avatar: '🦕' });
  const e = await c.take('error');
  assert.equal(e.code, 'version');
  await c.closed;
});

test('GET /api/rooms/:code reports occupancy for the social layer, 404 otherwise', async () => {
  const http = `http://127.0.0.1:${srv.server.address().port}`;
  const info = async (code) => {
    const r = await fetch(`${http}/api/rooms/${code}`);
    return { status: r.status, body: await r.json() };
  };

  assert.deepEqual(await info('ZZZZZZ'), { status: 404, body: { error: 'not_found' } });
  assert.equal((await fetch(`${http}/api/rooms/toolongcode`)).status, 404); // shape miss → static 404

  const a = new TestClient(url);
  await a.open;
  a.send({ t: 'hello', v: 1, name: 'Host', avatar: '⚓' });
  await a.take('welcome');
  a.send({ t: 'create', settings: {} });
  const w = await a.take('welcome');

  let r = await info(w.roomCode.toLowerCase()); // case-insensitive lookup
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { code: w.roomCode, players: 1, max: 2, phase: 'LOBBY', joinable: true });

  a.send({ t: 'addBot', level: 1 }); // a bot fills seat 1
  await a.take('state');
  r = await info(w.roomCode);
  assert.deepEqual(r.body, { code: w.roomCode, players: 2, max: 2, phase: 'LOBBY', joinable: false });

  await a.close();
});
