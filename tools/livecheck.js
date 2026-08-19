// Play one real scripted game against a running server — local or deployed.
//   node tools/livecheck.js                      (ws://127.0.0.1:3000/ws)
//   node tools/livecheck.js wss://battleships.example/ws
// Exercises: create/join by code, lobby settings, placement, sonar, a full
// blitz hunt, victory, reveal. Exits 0 on PASS.

import { TestClient } from '../tests/wsclient.js';
import { ROWS_LAYOUT, ROWS_CELLS, waterCells } from '../tests/helpers.js';

const url = process.argv[2] || 'ws://127.0.0.1:3000/ws';

async function untilPhase(client, phase, timeout = 8000) {
  let s;
  do { s = await client.take('state', timeout); } while (s.view.phase !== phase);
  return s;
}

export async function runGame(wsUrl, tag = '') {
  const t0 = Date.now();
  const a = new TestClient(wsUrl);
  await a.open;
  a.send({ t: 'hello', v: 1, name: `Check${tag}A`, avatar: '🤖' });
  await a.take('welcome');
  a.send({ t: 'create', settings: { mode: 'blitz', grid: 10, aimTimer: 15, series: 1 } });
  const wa = await a.take('welcome');
  if (wa.seat !== 0) throw new Error('host seat != 0');

  const b = new TestClient(wsUrl);
  await b.open;
  b.send({ t: 'hello', v: 1, name: `Check${tag}B`, avatar: '🤖' });
  await b.take('welcome');
  b.send({ t: 'join', roomCode: wa.roomCode });
  const wb = await b.take('welcome');
  if (wb.seat !== 1) throw new Error('guest seat != 1');

  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });
  await untilPhase(a, 'PLACEMENT');
  await untilPhase(b, 'PLACEMENT');
  a.send({ t: 'layout', ships: ROWS_LAYOUT });
  b.send({ t: 'layout', ships: ROWS_LAYOUT });
  await untilPhase(a, 'AIM');
  await untilPhase(b, 'AIM');

  const hunts = [ROWS_CELLS.slice(0, 5), ROWS_CELLS.slice(5, 10), ROWS_CELLS.slice(10, 15), ROWS_CELLS.slice(15, 17)];
  const waters = [5, 4, 3, 2];
  for (let r = 0; r < 4; r++) {
    if (r === 2) { // by round 3 there is energy for a sonar ping
      b.send({ t: 'ability', kind: 'sonar', target: { x: 9, y: 9 } });
      const intel = await b.take('intel');
      if (typeof intel.intel.distance !== 'number') throw new Error('sonar returned no distance');
    }
    a.send({ t: 'aim', cells: hunts[r] });
    b.send({ t: 'aim', cells: waterCells(waters[r], r) });
    a.send({ t: 'lock' });
    b.send({ t: 'lock' });
    const rs = await a.take('resolve');
    if (rs.round !== r + 1) throw new Error(`resolve round ${rs.round} != ${r + 1}`);
    await b.take('resolve');
  }

  const endA = await untilPhase(a, 'GAMEOVER');
  if (endA.view.winner !== 0 || endA.view.reason !== 'sunk') {
    throw new Error(`unexpected result ${endA.view.winner}/${endA.view.reason}`);
  }
  if (!endA.view.reveal?.foe?.ships?.length) throw new Error('no reveal at game over');
  const endB = await untilPhase(b, 'GAMEOVER');
  if (endB.view.winner !== 0) throw new Error('loser saw a different winner');

  await a.close();
  await b.close();
  return { ms: Date.now() - t0, room: wa.roomCode };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  try {
    const { ms, room } = await runGame(url);
    console.log(`PASS — full blitz game in ${ms}ms (room ${room}) against ${url}`);
    process.exit(0);
  } catch (err) {
    console.error(`FAIL — ${err.message}`);
    process.exit(1);
  }
}
