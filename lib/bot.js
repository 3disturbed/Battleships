// Bot opponents. Decisions are computed from the SAME per-player view a human
// client renders from (game/view.js) — the bot cannot see hidden ships, and a
// decoy's fake 'hit' fools it exactly like it fools a person. Five levels:
//
//   1 Deckhand   — random fire, no follow-up
//   2 Ensign     — chases hits with adjacent shots
//   3 Captain    — parity hunting + line-following target mode, dabbles in sonar
//   4 Commodore  — probability-density hunting, purposeful abilities
//   5 Admiral    — exact density, recon-led targeting, full ability book
//
// All functions are pure; randomness comes in via rng().

import { SHIPS, key } from '../game/const.js';

export const BOT_PROFILES = {
  1: { name: 'Deckhand Bot', avatar: '🐣', blurb: 'fires wild' },
  2: { name: 'Ensign Bot', avatar: '🪝', blurb: 'chases hits' },
  3: { name: 'Captain Bot', avatar: '🧭', blurb: 'hunts in patterns' },
  4: { name: 'Commodore Bot', avatar: '🎖️', blurb: 'reads the board' },
  5: { name: 'Admiral Bot', avatar: '👑', blurb: 'shows no mercy' },
};

export function clampLevel(level) {
  return Math.min(5, Math.max(1, Number.isInteger(level) ? level : 3));
}

const parseKey = (k) => { const [x, y] = k.split(','); return { x: +x, y: +y }; };

function shuffled(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- board knowledge (all from the masked view) ------------------------------

function knowledge(view) {
  const grid = view.settings.grid;
  const revealed = new Map(view.foe.revealed); // 'miss' | 'hit' | 'sink' — decoys masked as 'hit'
  const open = [];
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      if (!revealed.has(key(x, y))) open.push({ x, y });
    }
  }
  // Hits that belong to no sunk ship: something is wounded out there (or it's
  // a decoy and we're being played — the bot can't tell, which is the point).
  const activeHits = [...revealed].filter(([, v]) => v === 'hit').map(([k]) => parseKey(k));
  const sunkSizes = view.foe.sunk.map((s) => s.size);
  const remaining = [...SHIPS.map((s) => s.size)];
  for (const size of sunkSizes) {
    const i = remaining.indexOf(size);
    if (i >= 0) remaining.splice(i, 1);
  }
  // Recon intel: confirmed ship cells we haven't shot yet.
  const reconTargets = (view.you.intel ?? [])
    .filter((i) => i.kind === 'recon')
    .flatMap((i) => i.cells)
    .filter((c) => c.ship && !revealed.has(key(c.x, c.y)));
  return { grid, revealed, open, activeHits, remaining, reconTargets };
}

const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function adjacentOpen(cells, k) {
  const out = [];
  const seen = new Set();
  for (const h of cells) {
    for (const [dx, dy] of NEIGHBORS) {
      const x = h.x + dx, y = h.y + dy;
      const kk = key(x, y);
      if (x < 0 || y < 0 || x >= k.grid || y >= k.grid) continue;
      if (k.revealed.has(kk) || seen.has(kk)) continue;
      seen.add(kk);
      out.push({ x, y });
    }
  }
  return out;
}

// Extend collinear runs of active hits past both ends — the classic kill move.
function lineExtensions(k) {
  const hitSet = new Set(k.activeHits.map((c) => key(c.x, c.y)));
  const out = [];
  for (const h of k.activeHits) {
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      if (!hitSet.has(key(h.x + dx, h.y + dy))) continue;
      // walk to both ends of this run
      let a = h;
      while (hitSet.has(key(a.x - dx, a.y - dy))) a = { x: a.x - dx, y: a.y - dy };
      let b = h;
      while (hitSet.has(key(b.x + dx, b.y + dy))) b = { x: b.x + dx, y: b.y + dy };
      for (const c of [{ x: a.x - dx, y: a.y - dy }, { x: b.x + dx, y: b.y + dy }]) {
        if (c.x >= 0 && c.y >= 0 && c.x < k.grid && c.y < k.grid && !k.revealed.has(key(c.x, c.y))) {
          out.push(c);
        }
      }
    }
  }
  return out;
}

// Probability density: for every remaining ship, count legal placements over
// each open cell. Placements covering active hits dominate when any exist.
function densityScores(k) {
  const scores = new Map();
  const blocked = (x, y) => {
    const v = k.revealed.get(key(x, y));
    return v === 'miss' || v === 'sink';
  };
  const targetMode = k.activeHits.length > 0;
  const hitSet = new Set(k.activeHits.map((c) => key(c.x, c.y)));
  for (const size of k.remaining) {
    for (let y = 0; y < k.grid; y++) {
      for (let x = 0; x < k.grid; x++) {
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const ex = x + dx * (size - 1), ey = y + dy * (size - 1);
          if (ex >= k.grid || ey >= k.grid) continue;
          let fits = true;
          let coversHit = false;
          for (let i = 0; i < size; i++) {
            const cx = x + dx * i, cy = y + dy * i;
            if (blocked(cx, cy)) { fits = false; break; }
            if (hitSet.has(key(cx, cy))) coversHit = true;
          }
          if (!fits || (targetMode && !coversHit)) continue;
          for (let i = 0; i < size; i++) {
            const cx = x + dx * i, cy = y + dy * i;
            const kk = key(cx, cy);
            if (k.revealed.has(kk)) continue; // never re-shoot
            scores.set(kk, (scores.get(kk) ?? 0) + 1);
          }
        }
      }
    }
  }
  return scores;
}

function topByScore(scores, n, rng, noise = 0) {
  const max = Math.max(1, ...scores.values());
  return [...scores.entries()]
    .map(([k, s]) => ({ cell: parseKey(k), s: s + (noise ? rng() * max * noise : 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((e) => e.cell);
}

function fill(cells, n, pool, rng) {
  const used = new Set(cells.map((c) => key(c.x, c.y)));
  for (const c of shuffled(pool, rng)) {
    if (cells.length >= n) break;
    if (!used.has(key(c.x, c.y))) { used.add(key(c.x, c.y)); cells.push(c); }
  }
  return cells.slice(0, n);
}

// --- ability choice -----------------------------------------------------------

function chooseAbility(level, view, k, plannedFirst, rng) {
  if (view.settings.mode !== 'blitz' || view.you.abilityUsed) return null;
  const you = view.you;
  const alive = (id) => you.ships.some((s) => s.id === id && !s.sunk);
  const can = (id, cost) => alive(id) && you.energy >= cost;

  if (level <= 2) return null;

  if (level === 3) {
    if (can('submarine', 3) && rng() < 0.35 && k.open.length) {
      const c = k.open[Math.floor(rng() * k.open.length)];
      return { kind: 'sonar', target: { x: c.x, y: c.y } };
    }
    return null;
  }

  // Commodore / Admiral: purposeful priorities.
  // Big Guns turns the first planned shot into a cross — best with a wounded
  // ship on the hook or a strong density peak.
  if (can('battleship', 4) && plannedFirst && (k.activeHits.length || view.round >= 3)) {
    return { kind: 'bigguns', target: {} };
  }
  if (can('carrier', 5) && !k.activeHits.length && plannedFirst) {
    const cx = Math.min(k.grid - 2, Math.max(1, plannedFirst.x));
    const cy = Math.min(k.grid - 2, Math.max(1, plannedFirst.y));
    return { kind: 'recon', target: { x: cx, y: cy } };
  }
  if (can('cruiser', 3) && !you.decoy) {
    const shipCells = new Set(you.ships.flatMap((s) => cellsOfShip(s).map((c) => key(c.x, c.y))));
    const spots = [];
    for (let y = 0; y < k.grid; y++) {
      for (let x = 0; x < k.grid; x++) {
        if (!shipCells.has(key(x, y))) spots.push({ x, y });
      }
    }
    if (spots.length) {
      const c = spots[Math.floor(rng() * spots.length)];
      return { kind: 'decoy', target: { x: c.x, y: c.y } };
    }
  }
  if (level === 5 && can('destroyer', 4) && !you.fullsteamUsed) {
    const destroyer = you.ships.find((s) => s.id === 'destroyer');
    if (destroyer && !destroyer.hits.some(Boolean) && underThreat(destroyer, view)) {
      const move = relocationFor(destroyer, view, k.grid, rng);
      if (move) return { kind: 'fullsteam', target: move };
    }
  }
  if (level === 5 && can('submarine', 3) && !k.activeHits.length && rng() < 0.4 && k.open.length) {
    const c = k.open[Math.floor(rng() * k.open.length)];
    return { kind: 'sonar', target: { x: c.x, y: c.y } };
  }
  return null;
}

function cellsOfShip(s) {
  return Array.from({ length: s.size }, (_, i) =>
    s.dir === 'h' ? { x: s.x + i, y: s.y } : { x: s.x, y: s.y + i });
}

// Enemy shells landing next to the (unhit) destroyer? Time to run.
function underThreat(destroyer, view) {
  const mine = new Map(view.you.revealed);
  return cellsOfShip(destroyer).some((c) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (mine.has(key(c.x + dx, c.y + dy))) return true;
      }
    }
    return false;
  });
}

function relocationFor(destroyer, view, grid, rng) {
  const others = new Set(view.you.ships
    .filter((s) => s.id !== 'destroyer')
    .flatMap((s) => cellsOfShip(s).map((c) => key(c.x, c.y))));
  for (let tries = 0; tries < 80; tries++) {
    const dir = rng() < 0.5 ? 'h' : 'v';
    const x = Math.floor(rng() * (grid - (dir === 'h' ? 1 : 0)));
    const y = Math.floor(rng() * (grid - (dir === 'v' ? 1 : 0)));
    const cells = cellsOfShip({ x, y, dir, size: 2 });
    if (cells.every((c) => c.x < grid && c.y < grid && !others.has(key(c.x, c.y)))) {
      return { x, y, dir };
    }
  }
  return null;
}

// --- the public brain -----------------------------------------------------------

// decideTurn(level, view, rng) -> { ability: {kind, target}|null, cells: [...] }
// `cells` are always distinct, unrevealed, in-bounds, and ≤ view.you.maxShots.
export function decideTurn(level, view, rng) {
  level = clampLevel(level);
  const k = knowledge(view);
  const n = Math.max(1, view.you.maxShots || 1);
  let cells;

  if (level === 1) {
    cells = fill([], n, k.open, rng);
  } else if (level === 2) {
    cells = fill(shuffled(adjacentOpen(k.activeHits, k), rng).slice(0, n), n, k.open, rng);
  } else if (level === 3) {
    const priority = [...lineExtensions(k), ...shuffled(adjacentOpen(k.activeHits, k), rng), ...k.reconTargets];
    const parity = k.open.filter((c) => (c.x + c.y) % 2 === 0);
    cells = fill(dedupe(priority).slice(0, n), n, parity.length ? parity : k.open, rng);
  } else {
    const priority = level === 5 ? [...k.reconTargets, ...lineExtensions(k)] : lineExtensions(k);
    const scores = densityScores(k);
    const picked = topByScore(scores, n * 2, rng, level === 4 ? 0.35 : 0);
    cells = fill(dedupe([...priority, ...picked]).slice(0, n), n, k.open, rng);
  }

  const ability = chooseAbility(level, view, k, cells[0] ?? null, rng);
  return { ability, cells };
}

function dedupe(cells) {
  const seen = new Set();
  return cells.filter((c) => {
    const kk = key(c.x, c.y);
    if (seen.has(kk)) return false;
    seen.add(kk);
    return true;
  });
}
