// Room state machine: LOBBY → PLACEMENT → AIM (round loop) → GAMEOVER, with
// rematch looping back to PLACEMENT. Pure — no timers, no sockets, no clocks.
// The shell drives deadlines by sending {t:'deadline'} when its timer fires,
// and schedules the next one from the phase events this module emits.

import {
  MIN_SHOTS, ENERGY_CAP, ENERGY_PER_ROUND, ENERGY_ON_SHIP_LOST,
  PLACEMENT_MS, RESOLVE_DELAY_MS, AFK_FORFEIT_ROUNDS,
  normalizeSettings, key,
} from './const.js';
import { validateLayout, autoComplete, randomLayout } from './placement.js';
import { buildVolley, applyVolley, fleetDead, aliveShips } from './battle.js';
import { useAbility } from './abilities.js';

export const LOST_ABILITY = {
  carrier: 'Recon Flight',
  battleship: 'Big Guns',
  cruiser: 'Decoy Buoy',
  submarine: 'Sonar Ping',
  destroyer: 'Full Steam',
};

function makePlayer() {
  return {
    ships: null,
    layoutLocked: false,
    revealed: new Map(),
    decoy: null,
    bigguns: false,
    fullsteamUsed: false,
    energy: 0,
    streak: 0,
    bestStreak: 0,
    stats: { shots: 0, hits: 0, sinks: 0, decoyFools: 0, biggestVolley: 0 },
    aim: [],
    aimLocked: false,
    abilityUsedThisRound: null,
    inputThisRound: false,
    afkRounds: 0,
    intel: [],
  };
}

export function createRoom(settings, rng) {
  return {
    settings: normalizeSettings(settings),
    rng,
    phase: 'LOBBY',
    round: 0,
    turn: 0, // classic mode: whose shot it is
    seats: [null, null],
    players: [makePlayer(), makePlayer()],
    series: { target: 0, wins: [0, 0], game: 1, champion: null },
    winner: null,
    reason: null,
    rematch: [false, false],
  };
}

const err = (message) => ({ ok: false, error: message, events: [] });
const ok = (events = []) => ({ ok: true, events });

export function maxShots(state, seat) {
  if (state.settings.mode === 'classic') return 1;
  return Math.max(MIN_SHOTS, aliveShips(state.players[seat]).length);
}

function grantRoundEnergy(state) {
  if (state.settings.mode !== 'blitz') return;
  for (const p of state.players) p.energy = Math.min(ENERGY_CAP, p.energy + ENERGY_PER_ROUND);
}

function startPlacement(state, events) {
  state.phase = 'PLACEMENT';
  state.round = 0;
  state.winner = null;
  state.reason = null;
  state.rematch = [false, false];
  state.players = [makePlayer(), makePlayer()];
  events.push({ t: 'phase', phase: 'PLACEMENT', durationMs: PLACEMENT_MS, delayMs: 0 });
}

function startBattle(state, events) {
  state.phase = 'AIM';
  state.round = 1;
  state.turn = state.rng() < 0.5 ? 0 : 1;
  grantRoundEnergy(state);
  events.push({
    t: 'phase', phase: 'AIM', round: 1, turn: state.turn,
    durationMs: state.settings.aimTimer * 1000, delayMs: 0,
  });
}

function nextRound(state, events) {
  state.round++;
  if (state.settings.mode === 'classic') state.turn = 1 - state.turn;
  for (const p of state.players) {
    p.aim = [];
    p.aimLocked = false;
    p.abilityUsedThisRound = null;
    p.inputThisRound = false;
  }
  grantRoundEnergy(state);
  const delayMs = state.settings.mode === 'blitz' ? RESOLVE_DELAY_MS : 1500;
  events.push({
    t: 'phase', phase: 'AIM', round: state.round, turn: state.turn,
    durationMs: state.settings.aimTimer * 1000, delayMs,
  });
}

function seriesNeeded(target) {
  return Math.ceil((target + 1) / 2);
}

function gameOver(state, events, winner, reason) {
  state.phase = 'GAMEOVER';
  state.winner = winner; // null on a draw
  state.reason = reason;
  state.rematch = [false, false];
  if (winner !== null) {
    state.series.wins[winner]++;
    if (state.series.wins[winner] >= seriesNeeded(state.series.target)) {
      state.series.champion = winner;
    }
  }
  events.push({ t: 'over', winner, reason });
}

function validateAim(state, seat, cells) {
  const count = maxShots(state, seat);
  if (!Array.isArray(cells) || cells.length > count) return null;
  const grid = state.settings.grid;
  const foe = state.players[1 - seat];
  const seen = new Set();
  const out = [];
  for (const c of cells) {
    if (!c || !Number.isInteger(c.x) || !Number.isInteger(c.y)) return null;
    if (c.x < 0 || c.y < 0 || c.x >= grid || c.y >= grid) return null;
    const k = key(c.x, c.y);
    if (seen.has(k) || foe.revealed.has(k)) return null;
    seen.add(k);
    out.push({ x: c.x, y: c.y });
  }
  return out;
}

function resolveBlitz(state, events) {
  const grid = state.settings.grid;
  const [a, b] = state.players;
  const volleyA = buildVolley(a.aim, maxShots(state, 0), b, grid, a.bigguns, state.rng);
  const volleyB = buildVolley(b.aim, maxShots(state, 1), a, grid, b.bigguns, state.rng);
  a.bigguns = false;
  b.bigguns = false;
  const resA = applyVolley(a, b, volleyA);
  const resB = applyVolley(b, a, volleyB);
  for (const p of state.players) {
    if (p.inputThisRound) p.afkRounds = 0;
    else p.afkRounds++;
  }
  // Comeback Energy: losing a ship pays out.
  a.energy = Math.min(ENERGY_CAP, a.energy + resB.sinks.length * ENERGY_ON_SHIP_LOST);
  b.energy = Math.min(ENERGY_CAP, b.energy + resA.sinks.length * ENERGY_ON_SHIP_LOST);

  const tagSinks = (r) => r.sinks.map((s) => ({ ...s, ability: LOST_ABILITY[s.id] }));
  events.push({
    t: 'resolve',
    round: state.round,
    volleys: [
      { seat: 0, shots: resA.shots, sinks: tagSinks(resA) },
      { seat: 1, shots: resB.shots, sinks: tagSinks(resB) },
    ],
  });

  const deadA = fleetDead(a);
  const deadB = fleetDead(b);
  if (deadA && deadB) {
    // Both fleets always take exactly 17 hits to die, so raw hit totals can
    // never differ here — the tiebreak is efficiency: fewer shells fired wins.
    if (a.stats.shots !== b.stats.shots) {
      gameOver(state, events, a.stats.shots < b.stats.shots ? 0 : 1, 'mutual');
    } else {
      gameOver(state, events, null, 'mutual'); // true draw — MUTUAL DESTRUCTION
    }
  } else if (deadA || deadB) {
    gameOver(state, events, deadA ? 1 : 0, 'sunk');
  } else if (state.players.some((p) => p.afkRounds >= AFK_FORFEIT_ROUNDS)) {
    const afkA = a.afkRounds >= AFK_FORFEIT_ROUNDS;
    const afkB = b.afkRounds >= AFK_FORFEIT_ROUNDS;
    if (afkA && afkB) gameOver(state, events, null, 'abandoned');
    else gameOver(state, events, afkA ? 1 : 0, 'forfeit');
  } else {
    nextRound(state, events);
  }
}

function resolveClassic(state, events) {
  const shooter = state.turn;
  const grid = state.settings.grid;
  const me = state.players[shooter];
  const foe = state.players[1 - shooter];
  const volley = buildVolley(me.aim, 1, foe, grid, false, state.rng);
  const res = applyVolley(me, foe, volley);
  if (me.inputThisRound) me.afkRounds = 0;
  else me.afkRounds++;
  events.push({
    t: 'resolve',
    round: state.round,
    volleys: [{ seat: shooter, shots: res.shots, sinks: res.sinks.map((s) => ({ ...s, ability: null })) }],
  });
  if (fleetDead(foe)) {
    gameOver(state, events, shooter, 'sunk');
  } else if (me.afkRounds >= AFK_FORFEIT_ROUNDS) {
    gameOver(state, events, 1 - shooter, 'forfeit');
  } else {
    nextRound(state, events);
  }
}

// ---------------------------------------------------------------------------

export function act(state, seat, action) {
  switch (action.t) {
    case 'join': {
      if (state.seats[seat]) return err('Seat taken.');
      state.seats[seat] = { name: action.name, avatar: action.avatar, ready: false };
      return ok([{ t: 'update' }]);
    }

    case 'settings': {
      if (state.phase !== 'LOBBY') return err('Settings are locked once the game starts.');
      if (seat !== 0) return err('Only the host can change settings.');
      state.settings = normalizeSettings(action.patch, state.settings);
      return ok([{ t: 'update' }]);
    }

    case 'ready': {
      if (state.phase !== 'LOBBY') return err('Not in the lobby.');
      if (!state.seats[seat]) return err('No seat.');
      state.seats[seat].ready = !!action.ready;
      const events = [{ t: 'update' }];
      if (state.seats[0]?.ready && state.seats[1]?.ready) {
        state.series = { target: state.settings.series, wins: [0, 0], game: 1, champion: null };
        startPlacement(state, events);
      }
      return ok(events);
    }

    case 'layout': {
      if (state.phase !== 'PLACEMENT') return err('Not placing now.');
      const me = state.players[seat];
      if (me.layoutLocked) return err('Your fleet is already locked.');
      const ships = validateLayout(action.ships, state.settings.grid);
      if (!ships) return err('That layout is not legal.');
      me.ships = ships;
      me.layoutLocked = true;
      const events = [{ t: 'placed', seat }, { t: 'update' }];
      if (state.players.every((p) => p.layoutLocked)) startBattle(state, events);
      return ok(events);
    }

    case 'aim': {
      if (state.phase !== 'AIM') return err('Not aiming now.');
      if (state.settings.mode === 'classic' && seat !== state.turn) return err('Not your turn.');
      const me = state.players[seat];
      if (me.aimLocked) return err('Volley already locked.');
      const cells = validateAim(state, seat, action.cells);
      if (!cells) return err('Invalid target set.');
      me.aim = cells;
      me.inputThisRound = true;
      return ok([{ t: 'update' }]);
    }

    case 'ability': {
      if (state.phase !== 'AIM') return err('Not now.');
      if (state.settings.mode !== 'blitz') return err('No abilities in Classic.');
      const me = state.players[seat];
      if (me.aimLocked) return err('Volley already locked.');
      const res = useAbility(me, state.players[1 - seat], action.kind, action.target, state.settings.grid);
      if (res.error) return err(res.error);
      me.inputThisRound = true;
      const events = [{ t: 'update' }];
      if (res.intel) events.push({ t: 'intel', seat, intel: res.intel });
      return ok(events);
    }

    case 'lock': {
      if (state.phase !== 'AIM') return err('Not aiming now.');
      if (state.settings.mode === 'classic' && seat !== state.turn) return err('Not your turn.');
      const me = state.players[seat];
      if (me.aimLocked) return err('Already locked.');
      me.aimLocked = true;
      me.inputThisRound = true;
      const events = [{ t: 'update' }];
      if (state.settings.mode === 'classic') resolveClassic(state, events);
      else if (state.players.every((p) => p.aimLocked)) resolveBlitz(state, events);
      return ok(events);
    }

    case 'rematch': {
      if (state.phase !== 'GAMEOVER') return err('No game to rematch.');
      state.rematch[seat] = true;
      const events = [{ t: 'update' }];
      if (state.rematch[0] && state.rematch[1]) {
        if (state.series.champion !== null) {
          state.series = { target: state.settings.series, wins: [0, 0], game: 1, champion: null };
        } else {
          state.series.game++;
        }
        startPlacement(state, events);
      }
      return ok(events);
    }

    case 'forfeit': {
      // Shell-initiated: leave mid-battle, or claim-victory after grace.
      if (state.phase !== 'PLACEMENT' && state.phase !== 'AIM') return err('No live game.');
      const events = [];
      gameOver(state, events, 1 - action.loser, action.reason || 'forfeit');
      return ok(events);
    }

    case 'deadline': {
      const events = [];
      if (state.phase === 'PLACEMENT') {
        for (let s = 0; s < 2; s++) {
          const p = state.players[s];
          if (!p.layoutLocked) {
            p.ships = validateLayout(autoComplete(null, state.settings.grid, state.rng), state.settings.grid)
              ?? validateLayout(randomLayout(state.settings.grid, state.rng), state.settings.grid);
            p.layoutLocked = true;
            events.push({ t: 'placed', seat: s });
          }
        }
        startBattle(state, events);
      } else if (state.phase === 'AIM') {
        if (state.settings.mode === 'classic') resolveClassic(state, events);
        else resolveBlitz(state, events);
      }
      return ok(events);
    }

    default:
      return err('Unknown action.');
  }
}
