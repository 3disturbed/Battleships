// Soak: churn many concurrent games through an in-process server, then prove
// the registry drains to zero after GC and memory stays sane.
//   node tools/soak.js [waves] [gamesPerWave]

import { createServer } from '../server.js';
import { runGame } from './livecheck.js';

const waves = Number(process.argv[2]) || 4;
const perWave = Number(process.argv[3]) || 12;

const srv = createServer({ port: 0, roomOpsPerMin: 100_000, maxRooms: 1000 });
await new Promise((res) => srv.server.on('listening', res));
const url = `ws://127.0.0.1:${srv.server.address().port}/ws`;

let played = 0;
let failed = 0;
const t0 = Date.now();

for (let w = 0; w < waves; w++) {
  const results = await Promise.allSettled(
    Array.from({ length: perWave }, (_, i) => runGame(url, `${w}-${i}`)),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') played++;
    else { failed++; console.error('  game failed:', r.reason?.message); }
  }
  const rss = Math.round(process.memoryUsage().rss / 1e6);
  console.log(`wave ${w + 1}/${waves}: ${played} played, ${failed} failed, rooms=${srv.registry.size}, rss=${rss}MB`);
}

// Every game ended (GAMEOVER) — age every room past its TTL and sweep:
// the registry must drain to zero.
const roomsBefore = srv.registry.size;
for (const room of srv.registry.rooms.values()) room.lastActivity -= 31 * 60_000;
srv.registry.sweep(() => {});
const roomsAfter = srv.registry.size;

const rss = Math.round(process.memoryUsage().rss / 1e6);
srv.close();

console.log(`soak: ${played} games in ${Math.round((Date.now() - t0) / 1000)}s, rooms ${roomsBefore} → ${roomsAfter}, rss ${rss}MB`);
if (failed > 0) { console.error(`FAIL: ${failed} games failed`); process.exit(1); }
if (roomsAfter !== 0) { console.error('FAIL: registry did not drain after GC'); process.exit(1); }
if (rss > 300) { console.error('FAIL: rss suspiciously high'); process.exit(1); }
console.log('PASS');
process.exit(0);
