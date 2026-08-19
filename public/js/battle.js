// Battle screen: aim input, ability targeting, and the resolve choreography
// that turns one server `resolve` message into a synchronized barrage.

import { sfx } from './sfx.js';

const ABILITY_DEFS = [
  { kind: 'recon', ship: 'carrier', icon: '🛩️', name: 'RECON', cost: 5, targets: 'theirs', hint: 'Tap enemy waters to overfly a 3×3 area' },
  { kind: 'bigguns', ship: 'battleship', icon: '💥', name: 'BIG GUNS', cost: 4, targets: null, hint: '' },
  { kind: 'decoy', ship: 'cruiser', icon: '🛟', name: 'DECOY', cost: 3, targets: 'mine', hint: 'Tap open water in your fleet for the buoy' },
  { kind: 'sonar', ship: 'submarine', icon: '📡', name: 'SONAR', cost: 3, targets: 'theirs', hint: 'Tap enemy waters to ping for distance' },
  { kind: 'fullsteam', ship: 'destroyer', icon: '💨', name: 'FULL STEAM', cost: 4, targets: 'mine', hint: 'Tap the new bow cell for your destroyer' },
];

function sunkToShips(sunk) {
  return (sunk ?? []).map((s) => {
    const xs = s.cells.map((c) => c.x);
    const ys = s.cells.map((c) => c.y);
    return {
      id: s.id, size: s.size, sunk: true,
      x: Math.min(...xs), y: Math.min(...ys),
      dir: xs[0] === xs[xs.length - 1] ? 'v' : 'h',
    };
  });
}

export function createBattle({ boards, els, send, showBanner }) {
  // boards: { theirs, mine }; els: head, status, clock, aimCount, fleetNote,
  // abilityBar, fireBtn, claimBtn, targetHint
  let st = null; // latest applied server state
  let aim = [];
  let targeting = null; // ability def awaiting a board tap
  let aimDebounce = 0;
  let animating = false;

  const key = (c) => `${c.x},${c.y}`;

  // ---- rendering ----------------------------------------------------------

  function theirModel() {
    const you = st.view.you;
    return {
      grid: st.view.settings.grid,
      revealed: st.view.foe.revealed,
      ships: sunkToShips(st.view.foe.sunk),
      aim: st.view.phase === 'AIM' ? aim : null,
      bigguns: you.bigguns,
      reconMarks: (you.intel ?? []).filter((i) => i.kind === 'recon').flatMap((i) => i.cells),
    };
  }

  function mineModel() {
    const you = st.view.you;
    return {
      grid: st.view.settings.grid,
      revealed: you.revealed,
      ships: you.ships,
      decoy: you.decoy,
    };
  }

  function header() {
    const v = st.view;
    const me = v.seats[v.seat];
    const foe = v.seats[1 - v.seat];
    const blitz = v.settings.mode === 'blitz';
    els.head.innerHTML = `
      <div class="pilot">
        <span class="face">${me?.avatar ?? '⚓'}</span>
        <div><div class="pname">${esc(me?.name ?? 'You')}</div>
        <div class="sub">${blitz ? `<span class="energy">⚡${v.you.energy}</span> ` : ''}${v.you.streak >= 3 ? `<span class="streak">🔥${v.you.streak}</span>` : ''}&nbsp;</div></div>
      </div>
      <div class="vs">R${v.round}${v.series.target > 1 ? ` · ${v.series.wins[v.seat]}–${v.series.wins[1 - v.seat]}` : ''}</div>
      <div class="pilot" style="flex-direction:row-reverse;text-align:right">
        <span class="face">${foe?.avatar ?? '❓'}</span>
        <div><div class="pname">${esc(foe?.name ?? '…')}</div>
        <div class="sub">${blitz ? `<span class="energy">⚡${v.foe.energy}</span> ` : ''}${st.presence[1 - v.seat] === 'off' ? '📵' : ''}&nbsp;</div></div>
      </div>`;
  }

  function status() {
    const v = st.view;
    if (st.paused) return 'Opponent reconnecting — clocks frozen…';
    if (v.phase !== 'AIM') return '';
    if (v.settings.mode === 'classic') {
      return v.turn === v.seat ? 'YOUR SHOT — pick a square' : `${esc(v.seats[1 - v.seat]?.name ?? 'Enemy')} is aiming…`;
    }
    if (v.you.aimLocked) return v.foe.aimLocked ? 'Firing…' : 'Volley locked — enemy still aiming…';
    return `TAKE AIM — ${v.you.maxShots} shells this round`;
  }

  function abilityBar() {
    const v = st.view;
    if (v.settings.mode !== 'blitz') { els.abilityBar.innerHTML = ''; return; }
    els.abilityBar.innerHTML = '';
    for (const def of ABILITY_DEFS) {
      const ship = v.you.ships.find((s) => s.id === def.ship);
      const alive = ship && !ship.sunk;
      const usedFS = def.kind === 'fullsteam' && v.you.fullsteamUsed;
      const decoyOut = def.kind === 'decoy' && v.you.decoy;
      const can = alive && !usedFS && !decoyOut && v.you.energy >= def.cost
        && !v.you.abilityUsed && !v.you.aimLocked && v.phase === 'AIM' && !animating && !st.paused;
      const btn = document.createElement('button');
      btn.className = 'ability'
        + (def.kind === 'bigguns' && v.you.bigguns ? ' armed' : '')
        + (targeting?.kind === def.kind ? ' targeting' : '');
      btn.disabled = !can;
      btn.title = alive ? def.name : `${def.name} — lost with your ${def.ship}`;
      btn.innerHTML = `<span class="ic">${def.icon}</span><span class="nm">${def.name}</span><span class="cost">⚡${def.cost}</span>`;
      btn.addEventListener('click', () => onAbilityBtn(def));
      els.abilityBar.appendChild(btn);
    }
  }

  function fire() {
    const v = st.view;
    const classicWait = v.settings.mode === 'classic' && v.turn !== v.seat;
    els.fireBtn.disabled = v.you.aimLocked || classicWait || animating || st.paused;
    els.fireBtn.textContent = v.you.aimLocked ? 'LOCKED' : aim.length === 0 ? 'FIRE (scatter)' : 'FIRE!';
    els.claimBtn.classList.toggle('hidden', !st.claimable?.[1 - v.seat]);
    const armed = aim.length;
    els.aimCount.textContent = v.phase === 'AIM' && v.settings.mode === 'blitz'
      ? `· ${armed}/${v.you.maxShots} armed` : '';
    els.fleetNote.textContent = `· ${v.you.shipsAlive} afloat`;
    const foeAim = v.foe.aimCount;
    if (v.settings.mode === 'blitz' && v.phase === 'AIM' && foeAim > 0 && !v.foe.aimLocked) {
      els.status.textContent = `${status()} — enemy has armed ${foeAim}`;
    }
  }

  function update(state) {
    st = state;
    const v = st.view;
    // Reconcile local aim with authoritative aim (e.g. after reconnect).
    if (v.phase === 'AIM' && !animating) {
      if (v.you.aim.length && !aim.length) aim = v.you.aim.map((c) => ({ ...c }));
      if (v.you.aimLocked) aim = v.you.aim.map((c) => ({ ...c }));
    } else if (v.phase !== 'AIM') {
      aim = [];
      targeting = null;
      els.targetHint.classList.add('hidden');
    }
    if (!animating) {
      boards.theirs.setModel(theirModel());
      boards.mine.setModel(mineModel());
    }
    header();
    els.status.textContent = status();
    abilityBar();
    fire();
  }

  // ---- aim input ----------------------------------------------------------

  function syncAim() {
    clearTimeout(aimDebounce);
    aimDebounce = setTimeout(() => send({ t: 'aim', cells: aim }), 120);
  }

  function onTheirsTap(cell) {
    if (!st || st.view.phase !== 'AIM' || animating || st.paused) return;
    const v = st.view;
    if (targeting) { onTargetPick(cell, 'theirs'); return; }
    if (v.you.aimLocked) return;
    if (v.settings.mode === 'classic' && v.turn !== v.seat) return;
    if (v.foe.revealed.some(([k]) => k === key(cell))) return;
    const i = aim.findIndex((c) => c.x === cell.x && c.y === cell.y);
    if (i >= 0) {
      aim.splice(i, 1);
      sfx.disarm();
    } else {
      const cap = v.settings.mode === 'classic' ? 1 : v.you.maxShots;
      if (aim.length >= cap) {
        if (cap === 1) aim = []; // classic: retarget with a single tap
        else { sfx.disarm(); return; }
      }
      aim.push({ ...cell });
      sfx.arm();
    }
    syncAim();
    boards.theirs.setModel(theirModel());
    fire();
  }

  function onMineTap(cell) {
    if (targeting) onTargetPick(cell, 'mine');
  }

  // ---- abilities ----------------------------------------------------------

  function onAbilityBtn(def) {
    sfx.click();
    if (targeting?.kind === def.kind) {
      targeting = null;
      els.targetHint.classList.add('hidden');
      abilityBar();
      return;
    }
    if (!def.targets) { // big guns: no target
      send({ t: 'ability', kind: def.kind, target: {} });
      return;
    }
    targeting = def;
    els.targetHint.textContent = def.hint;
    els.targetHint.classList.remove('hidden');
    abilityBar();
  }

  function onTargetPick(cell, which) {
    if (!targeting || targeting.targets !== which) return;
    const def = targeting;
    targeting = null;
    els.targetHint.classList.add('hidden');
    const target = { x: cell.x, y: cell.y };
    if (def.kind === 'fullsteam') {
      const d = st.view.you.ships.find((s) => s.id === 'destroyer');
      target.dir = d?.dir ?? 'h';
    }
    send({ t: 'ability', kind: def.kind, target });
    abilityBar();
  }

  function onIntel(intel) {
    if (intel.kind === 'sonar') {
      boards.theirs.sonar({ x: intel.x, y: intel.y }, intel.distance);
      sfx.ping();
    } else if (intel.kind === 'recon') {
      const cx = Math.round(intel.cells.reduce((a, c) => a + c.x, 0) / intel.cells.length);
      const cy = Math.round(intel.cells.reduce((a, c) => a + c.y, 0) / intel.cells.length);
      boards.theirs.reconSweep(cx, cy);
      sfx.recon();
    }
  }

  // ---- resolve choreography ----------------------------------------------

  // Animate a resolve on the two boards. Returns a promise that settles when
  // the barrage is done; app.js holds the next state until then.
  function choreograph(resolve) {
    if (!st) return Promise.resolve();
    animating = true;
    els.fireBtn.disabled = true;
    const mySeat = st.view.seat;
    const jobs = [];

    for (const volley of resolve.volleys) {
      const isMine = volley.seat === mySeat;
      const board = isMine ? boards.theirs : boards.mine;
      const model = isMine ? theirModel() : mineModel();
      model.aim = null;
      board.setModel(model);
      volley.shots.forEach((shot, i) => {
        jobs.push({ board, model, shot, at: i * 95 + (isMine ? 0 : 45), isMine });
      });
      const sinkDelay = volley.shots.length * 95 + 550;
      volley.sinks.forEach((sink, i) => {
        jobs.push({ board, model, sink, at: sinkDelay + i * 420, isMine });
      });
    }

    let done = 0;
    const total = jobs.length;
    return new Promise((finish) => {
      const complete = () => { if (++done === total) { animating = false; finish(); } };
      if (!total) { animating = false; finish(); return; }
      for (const job of jobs) {
        setTimeout(() => {
          if (job.shot) {
            const { board, model, shot } = job;
            sfx.whistle();
            board.shell(shot, {
              onImpact: () => {
                model.revealed.push([`${shot.x},${shot.y}`, shot.result === 'miss' ? 'miss' : 'hit']);
                if (shot.result === 'miss') { board.splash(shot); sfx.splash(); }
                else {
                  board.plume(shot); board.shake(160); sfx.boom();
                  if (!job.isMine) navigator.vibrate?.(35); // your hull took one
                }
                complete();
              },
            });
          } else {
            const { board, model, sink } = job;
            board.sinkFlash(sink.cells);
            for (const c of sink.cells) {
              const k = `${c.x},${c.y}`;
              const e = model.revealed.find(([kk]) => kk === k);
              if (e) e[1] = 'sink'; else model.revealed.push([k, 'sink']);
            }
            board.shake(320);
            sfx.sink();
            const label = sink.id.toUpperCase();
            showBanner(
              job.isMine ? `ENEMY ${label} DESTROYED!` : `YOUR ${label} IS DOWN!`,
              sink.ability ? (job.isMine ? `They lost: ${sink.ability}` : `You lost: ${sink.ability} · +2⚡`) : '',
            );
            setTimeout(complete, 500);
          }
        }, job.at);
      }
    });
  }

  return { update, onTheirsTap, onMineTap, onIntel, choreograph, get animating() { return animating; } };
}

function esc(s) {
  const d = document.createElement('span');
  d.textContent = String(s);
  return d.innerHTML;
}
