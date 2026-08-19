// Tuning constants. SDD §13 expects the Energy/timer numbers to move after
// playtests — keep every knob here.

export const SHIPS = [
  { id: 'carrier', size: 5 },
  { id: 'battleship', size: 4 },
  { id: 'cruiser', size: 3 },
  { id: 'submarine', size: 3 },
  { id: 'destroyer', size: 2 },
];

export const ABILITIES = {
  recon: { ship: 'carrier', cost: 5 },
  bigguns: { ship: 'battleship', cost: 4 },
  decoy: { ship: 'cruiser', cost: 3 },
  sonar: { ship: 'submarine', cost: 3 },
  fullsteam: { ship: 'destroyer', cost: 4 },
};

export const ENERGY_CAP = 8;
export const ENERGY_PER_ROUND = 1;
export const ENERGY_ON_SHIP_LOST = 2;
export const MIN_SHOTS = 2;

export const PLACEMENT_MS = 60_000;
export const RESOLVE_DELAY_MS = 3_000; // client barrage animation window
export const REMATCH_MS = 30_000;
export const AFK_FORFEIT_ROUNDS = 3;
export const RECONNECT_GRACE_MS = 90_000;

export const GRIDS = [8, 10];
export const AIM_TIMERS = [10, 15];
export const SERIES = [1, 3, 5];

export const DEFAULT_SETTINGS = {
  mode: 'blitz', // 'blitz' | 'classic'
  grid: 10,
  aimTimer: 15, // seconds
  series: 3, // best of N
};

export function normalizeSettings(partial, base = DEFAULT_SETTINGS) {
  const s = { ...base };
  if (partial && typeof partial === 'object') {
    if (partial.mode === 'blitz' || partial.mode === 'classic') s.mode = partial.mode;
    if (GRIDS.includes(partial.grid)) s.grid = partial.grid;
    if (AIM_TIMERS.includes(partial.aimTimer)) s.aimTimer = partial.aimTimer;
    if (SERIES.includes(partial.series)) s.series = partial.series;
  }
  return s;
}

export const key = (x, y) => `${x},${y}`;
