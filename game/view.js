// Per-player projection: exactly what each seat is entitled to see, and
// nothing more. This is the anti-cheat boundary — foe ships appear only as
// revealed cells and sunk silhouettes until GAMEOVER, and a decoy dupe is
// indistinguishable from a hit in the attacker's view.

import { shipCells } from './placement.js';
import { LOST_ABILITY, maxShots } from './state.js';

function mapToEntries(revealed, mask) {
  const out = [];
  for (const [k, v] of revealed) out.push([k, mask && v === 'decoy' ? 'hit' : v]);
  return out;
}

function shipsFull(ships) {
  return (ships ?? []).map((s) => ({
    id: s.id, size: s.size, x: s.x, y: s.y, dir: s.dir,
    hits: [...s.hits], sunk: s.sunk,
  }));
}

export function project(state, seat) {
  const me = state.players[seat];
  const foe = state.players[1 - seat];
  const over = state.phase === 'GAMEOVER';

  const view = {
    seat,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    settings: state.settings,
    series: state.series,
    seats: state.seats.map((s) => (s ? { name: s.name, avatar: s.avatar, ready: s.ready } : null)),
    winner: state.winner,
    reason: state.reason,
    rematch: [...state.rematch],
    you: {
      ships: shipsFull(me.ships),
      layoutLocked: me.layoutLocked,
      revealed: mapToEntries(me.revealed, false), // own board: decoy dupes visible
      decoy: me.decoy ? { ...me.decoy } : null,
      energy: me.energy,
      streak: me.streak,
      bestStreak: me.bestStreak,
      stats: { ...me.stats },
      aim: me.aim.map((c) => ({ ...c })),
      aimLocked: me.aimLocked,
      abilityUsed: me.abilityUsedThisRound,
      bigguns: me.bigguns,
      fullsteamUsed: me.fullsteamUsed,
      maxShots: state.phase === 'AIM' || state.phase === 'GAMEOVER' ? maxShots(state, seat) : 0,
      intel: me.intel.map((i) => ({ ...i })),
      shipsAlive: (me.ships ?? []).filter((s) => !s.sunk).length,
    },
    foe: {
      layoutLocked: foe.layoutLocked,
      revealed: mapToEntries(foe.revealed, !over), // my shots at them; dupes masked until reveal
      energy: foe.energy,
      streak: foe.streak,
      aimCount: foe.aim.length,
      aimLocked: foe.aimLocked,
      shipsAlive: (foe.ships ?? []).filter((s) => !s.sunk).length,
      sunk: (foe.ships ?? [])
        .filter((s) => s.sunk)
        .map((s) => ({ id: s.id, size: s.size, cells: shipCells(s), ability: LOST_ABILITY[s.id] })),
    },
  };

  if (over) {
    view.reveal = {
      you: { ships: shipsFull(me.ships), decoy: me.decoy ? { ...me.decoy } : null },
      foe: {
        ships: shipsFull(foe.ships),
        decoy: foe.decoy ? { ...foe.decoy } : null,
        stats: { ...foe.stats },
        bestStreak: foe.bestStreak,
      },
    };
  }
  return view;
}
