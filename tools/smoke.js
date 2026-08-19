// jsdom smoke test: boot the real client, drive it with mocked server
// messages through home → lobby → placement → battle (with a live barrage)
// → game over. Fails on any uncaught error. Needs the jsdom devDependency:
//   npm install --no-save jsdom   (on a deployed tree)

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('smoke: jsdom is not installed — run `npm install --no-save jsdom` first.');
  process.exit(2);
}

const failures = [];
process.on('uncaughtException', (e) => { failures.push(`uncaught: ${e.stack}`); });
process.on('unhandledRejection', (e) => { failures.push(`unhandled rejection: ${e?.stack ?? e}`); });

const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost:3000/#QK7F3M',
  pretendToBeVisual: true, // requestAnimationFrame + performance
});

const { window } = dom;

// --- browser shims jsdom lacks ------------------------------------------------

window.HTMLCanvasElement.prototype.getContext = function () {
  const noop = () => {};
  const grad = { addColorStop: noop };
  return new Proxy({}, {
    get: (t, prop) => {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
      if (prop === 'measureText') return () => ({ width: 10 });
      return typeof prop === 'string' ? noop : undefined;
    },
    set: () => true,
  });
};
window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300 };
};
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return 300; }, configurable: true });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const sockets = [];
window.WebSocket = class FakeWS {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.OPEN = 1;
    this.sent = [];
    sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5);
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  push(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); } // server → client
};

for (const key of ['window', 'document', 'location', 'history', 'localStorage', 'navigator',
  'HTMLCanvasElement', 'HTMLElement', 'ResizeObserver', 'WebSocket', 'getComputedStyle']) {
  try { Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true }); } catch { /* readonly */ }
}
// Node's native `performance` works fine; jsdom's recurses when re-homed.
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, what) => { if (!cond) failures.push(`ASSERT: ${what}`); };
const visible = (id) => !window.document.getElementById(id).classList.contains('hidden');

// --- canned server states -------------------------------------------------------

const SHIPS_VIEW = [
  { id: 'carrier', size: 5, x: 0, y: 0, dir: 'h', hits: [false, false, false, false, false], sunk: false },
  { id: 'battleship', size: 4, x: 0, y: 1, dir: 'h', hits: [false, false, false, false], sunk: false },
  { id: 'cruiser', size: 3, x: 0, y: 2, dir: 'h', hits: [false, false, false], sunk: false },
  { id: 'submarine', size: 3, x: 0, y: 3, dir: 'h', hits: [false, false, false], sunk: false },
  { id: 'destroyer', size: 2, x: 0, y: 4, dir: 'h', hits: [false, false], sunk: false },
];

function mkView(phase, extra = {}) {
  return {
    seat: 0,
    phase,
    round: 1,
    turn: 0,
    settings: { mode: 'blitz', grid: 10, aimTimer: 15, series: 3 },
    series: { target: 3, wins: [0, 0], game: 1, champion: null },
    seats: [{ name: 'Ash', avatar: '🦈', ready: true }, { name: 'Bo', avatar: '🐙', ready: true }],
    winner: null,
    reason: null,
    rematch: [false, false],
    you: {
      ships: SHIPS_VIEW, layoutLocked: phase !== 'PLACEMENT', revealed: [], decoy: null,
      energy: 5, streak: 0, bestStreak: 0,
      stats: { shots: 0, hits: 0, sinks: 0, decoyFools: 0, biggestVolley: 0 },
      aim: [], aimLocked: false, abilityUsed: null, bigguns: false, fullsteamUsed: false,
      maxShots: 5, intel: [], shipsAlive: 5,
    },
    foe: {
      layoutLocked: true, revealed: [], energy: 5, streak: 0, aimCount: 0,
      aimLocked: false, shipsAlive: 5, sunk: [],
    },
    ...extra,
  };
}

function mkState(phase, extra = {}, viewExtra = {}) {
  return {
    t: 'state', roomCode: 'QK7F3M', deadlineAt: Date.now() + 15_000, paused: false,
    presence: ['on', 'on'], claimable: [false, false], serverNow: Date.now(),
    view: mkView(phase, viewExtra), ...extra,
  };
}

// --- the walkthrough --------------------------------------------------------------

await import(join(root, 'public/js/app.js'));
await sleep(20);

const ws = sockets[0];
assert(ws, 'client opened a websocket');
assert(ws.sent[0]?.t === 'hello' && ws.sent[0].v === 1, 'client says a versioned hello');
assert(visible('screen-home'), 'home visible before welcome');
assert(!window.document.getElementById('invite-banner').classList.contains('hidden'),
  'invite banner shows for a #CODE link');

// join flow → lobby
ws.push({ t: 'welcome', seat: 1, reconnectToken: 'tok-1', roomCode: 'QK7F3M', resumed: false });
ws.push(mkState('LOBBY', {}, { seat: 1, seats: [{ name: 'Ash', avatar: '🦈', ready: false }, { name: 'Bo', avatar: '🐙', ready: false }] }));
await sleep(30);
assert(visible('screen-lobby'), 'lobby renders');
assert(window.document.getElementById('share-link').textContent.includes('QK7F3M'), 'share link shows the room code');

// placement
ws.push(mkState('PLACEMENT', {}, { seat: 1, you: { ...mkView('PLACEMENT').you, layoutLocked: false } }));
await sleep(30);
assert(visible('screen-place'), 'placement renders');
const layoutSent = () => ws.sent.some((m) => m.t === 'layout');
window.document.getElementById('btn-lock-fleet').click();
await sleep(10);
assert(layoutSent(), 'fleet ready sends a layout');

// battle + a real barrage
ws.push(mkState('AIM', {}, { seat: 1 }));
await sleep(50);
assert(visible('screen-battle'), 'battle renders');
const blockMine = window.document.getElementById('block-mine');
const blockTheirs = window.document.getElementById('block-theirs');
assert(blockMine.classList.contains('tab-hidden'), 'AIM auto-selects the My Shots tab');
assert(!blockTheirs.classList.contains('tab-hidden'), 'enemy waters visible during aim');
window.document.getElementById('tab-mine').click();
await sleep(10);
assert(!blockMine.classList.contains('tab-hidden'), 'manual tab switch shows my ships');
window.document.getElementById('tab-theirs').click();
await sleep(10);

// Menu escape hatch: visible in battle, mid-game leave asks for confirmation.
assert(visible('btn-menu'), 'menu button visible in battle');
window.document.getElementById('btn-menu').click();
await sleep(10);
assert(visible('confirm-leave'), 'mid-game leave asks before forfeiting');
window.document.getElementById('btn-confirm-stay').click();
await sleep(10);
assert(!visible('confirm-leave'), 'staying dismisses the confirm');
assert(visible('screen-battle'), 'still in the battle after staying');
ws.push({
  t: 'resolve',
  round: 1,
  volleys: [
    { seat: 1, shots: [{ x: 5, y: 5, result: 'miss' }, { x: 0, y: 0, result: 'hit' }], sinks: [] },
    {
      seat: 0,
      shots: [{ x: 0, y: 4, result: 'hit' }, { x: 1, y: 4, result: 'hit' }],
      sinks: [{ id: 'destroyer', size: 2, cells: [{ x: 0, y: 4 }, { x: 1, y: 4 }], ability: 'Full Steam' }],
    },
  ],
});
// held-back state while the barrage animates
ws.push(mkState('AIM', {}, { seat: 1, round: 2 }));
await sleep(2600);
assert(visible('screen-battle'), 'battle still on screen after barrage');
assert(blockMine.classList.contains('tab-hidden'),
  'auto tab back on My Shots for the new round after the barrage');

// game over
ws.push(mkState('GAMEOVER', {}, {
  seat: 1,
  winner: 1,
  reason: 'sunk',
  you: { ...mkView('GAMEOVER').you, stats: { shots: 20, hits: 17, sinks: 5, decoyFools: 1, biggestVolley: 4 } },
  reveal: {
    you: { ships: SHIPS_VIEW, decoy: null },
    foe: { ships: SHIPS_VIEW, decoy: { x: 9, y: 9, hit: true }, stats: { shots: 25, hits: 9, sinks: 2, decoyFools: 0, biggestVolley: 3 }, bestStreak: 3 },
  },
}));
await sleep(60);
assert(visible('screen-over'), 'game-over renders');
assert(window.document.getElementById('over-banner').textContent.includes('VICTORY'), 'victory banner');
window.document.getElementById('btn-rematch').click();
await sleep(10);
assert(ws.sent.some((m) => m.t === 'rematch'), 'rematch button sends rematch');

// emote round-trip
ws.push({ t: 'emote', seat: 0, id: 3 });
await sleep(30);
assert(window.document.querySelector('.emote-bubble'), 'emote bubble appears');

if (failures.length) {
  console.error(`SMOKE FAILED (${failures.length}):\n` + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('smoke: client boots and plays through home → lobby → placement → battle → over ✔');
process.exit(0);
