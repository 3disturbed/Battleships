// Boot + screen routing + message dispatch. Every screen renders from the
// latest server state; a refresh at any moment lands you where you were.

import { createNet } from './net.js?v=2';
import { sfx } from './sfx.js?v=2';
import { Board } from './board.js?v=2';
import { createPlacement } from './place.js?v=2';
import { createBattle } from './battle.js?v=2';
import { createLobby } from './lobby.js?v=2';

const $ = (id) => document.getElementById(id);

const AVATARS = ['🦈', '🐙', '🐳', '⚓', '🏴‍☠️', '🦑', '🐊', '🚢', '🧜', '🦞'];
const EMOTES = ['GG', 'lucky!', 'nooo!', '😱', '🔥', '🍀', '😤', '🫡'];
const SCREENS = ['home', 'lobby', 'place', 'battle', 'over'];

// ---- state -----------------------------------------------------------------

let state = null; // latest applied server 'state' message
let pendingState = null; // held back while a barrage animates
let seat = -1;
let joinTarget = null; // room code from the invite link
let clockTimer = 0;
let lastTickSecond = -1;

// ---- identity ----------------------------------------------------------------

let name = localStorage.getItem('bs_name') || '';
let avatar = localStorage.getItem('bs_avatar') || AVATARS[0];

// ---- boards ------------------------------------------------------------------

const boards = {
  place: new Board($('board-place')),
  theirs: new Board($('board-theirs'), { onCell: (c) => battle.onTheirsTap(c) }),
  mine: new Board($('board-mine'), { onCell: (c) => battle.onMineTap(c) }),
  revealTheirs: new Board($('board-reveal-theirs'), { labels: false }),
  revealMine: new Board($('board-reveal-mine'), { labels: false }),
};

// ---- helpers -----------------------------------------------------------------

function show(screenName) {
  for (const s of SCREENS) $(`screen-${s}`).classList.toggle('hidden', s !== screenName);
  $('emote-bar').classList.toggle('hidden', !['battle', 'over', 'place'].includes(screenName));
  boards.theirs.setActive(screenName === 'battle');
  boards.mine.setActive(screenName === 'battle');
  boards.place.setActive(screenName === 'place');
}

let toastTimer = 0;
function toast(text, isErr = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function showBanner(title, sub = '') {
  const stage = $('banner-stage');
  const wrap = document.createElement('div');
  wrap.className = 'round-banner';
  wrap.innerHTML = `<div>${title}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  stage.appendChild(wrap);
  setTimeout(() => wrap.remove(), 2100);
}

const send = (obj) => net.send(obj);

// ---- modules -----------------------------------------------------------------

const lobby = createLobby({
  els: {
    shareLink: $('share-link'), shareBtn: $('btn-share'), seats: $('lobby-seats'),
    settings: $('lobby-settings'), settingsHint: $('settings-hint'), readyBtn: $('btn-ready'),
  },
  send, toast,
});

const placement = createPlacement({
  board: boards.place,
  statusEl: $('place-status'),
  lockBtn: $('btn-lock-fleet'),
  shuffleBtn: $('btn-shuffle'),
  send,
});

const battle = createBattle({
  boards,
  els: {
    head: $('battle-head'), status: $('battle-status'), clock: $('battle-clock'),
    aimCount: $('aim-count'), fleetNote: $('fleet-note'), abilityBar: $('ability-bar'),
    fireBtn: $('btn-fire'), claimBtn: $('btn-claim'), targetHint: $('target-hint'),
    tabTheirs: $('tab-theirs'), tabMine: $('tab-mine'),
    tabTheirsSub: $('tab-theirs-sub'), tabMineSub: $('tab-mine-sub'),
    blockTheirs: $('block-theirs'), blockMine: $('block-mine'),
  },
  send, showBanner,
});

// ---- server messages -----------------------------------------------------------

const net = createNet({
  onMessage(msg) {
    switch (msg.t) {
      case 'welcome': {
        seat = msg.seat ?? -1;
        if (msg.reconnectToken) localStorage.setItem('bs_token', msg.reconnectToken);
        if (msg.roomCode) {
          history.replaceState(null, '', `#${msg.roomCode}`);
        } else if (!msg.resumed && localStorage.getItem('bs_token')) {
          // Dead token (room expired). Forget it; stay wherever we are.
          localStorage.removeItem('bs_token');
          if (state) { // we were mid-game: the room is gone
            state = null;
            show('home');
            toast('That game has ended — start a new one!', true);
          }
        }
        if (msg.resumed) toast('Back aboard ⚓');
        render();
        return;
      }
      case 'state': applyState(msg); return;
      case 'resolve': onResolve(msg); return;
      case 'intel': battle.onIntel(msg.intel); return;
      case 'emote': onEmote(msg); return;
      case 'error': onServerError(msg); return;
      case 'left': state = null; localStorage.removeItem('bs_token'); show('home'); return;
    }
  },
  onStatus(s) {
    $('conn-status').classList.toggle('hidden', s === 'online' || s === 'connecting');
  },
});

function applyState(msg) {
  if (battle.animating) { pendingState = msg; return; }
  const prev = state;
  state = msg;
  seat = msg.view.seat;
  // Fresh placement (new game/rematch) needs a fleet reset.
  if (msg.view.phase === 'PLACEMENT' && prev?.view?.phase !== 'PLACEMENT') {
    placement.start(msg.view.settings.grid, msg.view.you.layoutLocked);
    sfx.arm();
    showBanner(`GAME ${msg.view.series.game}`, 'Position your fleet');
  }
  if (msg.view.phase === 'AIM' && prev?.view?.phase === 'PLACEMENT') {
    sfx.fanfare();
    showBanner('BATTLE STATIONS!', msg.view.settings.mode === 'blitz' ? 'Both fleets fire at once' : 'Classic rules');
  }
  render();
}

function onResolve(msg) {
  // Choreograph on the *current* boards; the post-round state waits.
  battle.choreograph(msg).then(() => {
    if (pendingState) {
      const s = pendingState;
      pendingState = null;
      applyState(s);
    } else {
      render();
    }
  });
}

function onServerError(msg) {
  if (msg.code === 'version') {
    toast('Game updated — refreshing…', true);
    setTimeout(() => location.reload(), 1200);
    return;
  }
  if (msg.code === 'gone') {
    show('home');
    $('home-error').textContent = msg.message;
    $('home-error').classList.remove('hidden');
    return;
  }
  toast(msg.message, true);
}

function onEmote({ seat: from, id }) {
  sfx.emote();
  const el = document.createElement('div');
  el.className = 'emote-bubble' + (from === seat ? ' mine' : '');
  el.textContent = EMOTES[id] ?? '…';
  const mine = from === seat;
  el.style.left = mine ? '12%' : '62%';
  el.style.top = `${18 + Math.random() * 8}%`;
  $('emote-stage').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ---- render ---------------------------------------------------------------------

function render() {
  if (!state) {
    renderHome();
    show('home');
    return;
  }
  const v = state.view;
  switch (v.phase) {
    case 'LOBBY':
      lobby.update(state);
      show('lobby');
      break;
    case 'PLACEMENT':
      placement.setStatus(state.paused ? 'Opponent reconnecting…'
        : v.you.layoutLocked ? (v.foe.layoutLocked ? 'Starting…' : 'Waiting for the enemy fleet…')
          : 'Position your fleet');
      show('place');
      break;
    case 'AIM':
      battle.update(state);
      show('battle');
      break;
    case 'GAMEOVER':
      battle.update(state);
      renderOver();
      show('over');
      break;
  }
  startClock();
}

function renderHome() {
  $('name-input').value = name;
  const row = $('avatar-row');
  if (!row.childElementCount) {
    for (const a of AVATARS) {
      const b = document.createElement('button');
      b.textContent = a;
      b.addEventListener('click', () => {
        avatar = a;
        localStorage.setItem('bs_avatar', a);
        for (const x of row.children) x.classList.toggle('sel', x === b);
        sfx.click();
      });
      row.appendChild(b);
    }
  }
  for (const x of row.children) x.classList.toggle('sel', x.textContent === avatar);
  const invited = !!joinTarget;
  $('invite-banner').classList.toggle('hidden', !invited);
  $('invite-code').textContent = joinTarget ?? '';
  $('btn-join').classList.toggle('hidden', !invited);
  $('btn-create').classList.toggle('hidden', invited);
}

function renderOver() {
  const v = state.view;
  const won = v.winner === seat;
  const draw = v.winner === null;
  const banner = $('over-banner');
  banner.className = `over-banner ${draw ? 'draw' : won ? 'win' : 'loss'}`;
  banner.textContent = draw ? '☠ MUTUAL DESTRUCTION ☠' : won ? '⚓ VICTORY!' : '💀 DEFEAT';
  if (draw) sfx.sink(); else if (won) sfx.fanfare(); else sfx.dirge();

  const reasons = {
    sunk: won ? 'Enemy fleet destroyed.' : 'Your fleet was destroyed.',
    mutual: draw ? 'Both fleets went down in the same barrage.' : 'Both fleets sank — efficiency decided it.',
    forfeit: won ? 'The enemy went dark.' : 'You went dark too long.',
    claim: won ? 'The enemy abandoned ship.' : 'Victory was claimed while you were away.',
    left: won ? 'The enemy fled the battle.' : 'You fled the battle.',
    abandoned: 'Both fleets went dark.',
  };
  $('over-reason').textContent = reasons[v.reason] ?? '';

  const target = v.series.target;
  $('series-pips').innerHTML = target > 1
    ? `<span>${escText(v.seats[seat]?.name ?? 'You')} ${v.series.wins[seat]}</span><span>·</span>
       <span>${v.series.wins[1 - seat]} ${escText(v.seats[1 - seat]?.name ?? 'Them')}</span>
       ${v.series.champion !== null ? `<span class="champ">🏆 ${escText(v.seats[v.series.champion]?.name ?? '')} takes the series!</span>` : ''}`
    : '';

  const my = v.you.stats;
  const their = v.reveal?.foe?.stats ?? {};
  const acc = (s) => (s.shots ? `${Math.round((s.hits / s.shots) * 100)}%` : '—');
  $('over-stats').innerHTML = `<div class="stat-grid">
    <span class="h"></span><span class="h">YOU</span><span class="h">THEM</span>
    <span>Accuracy</span><span class="me">${acc(my)}</span><span class="them">${acc(their)}</span>
    <span>Shells fired</span><span class="me">${my.shots}</span><span class="them">${their.shots ?? '—'}</span>
    <span>Best streak</span><span class="me">${v.you.bestStreak}</span><span class="them">${v.reveal?.foe?.bestStreak ?? '—'}</span>
    <span>Biggest volley</span><span class="me">${my.biggestVolley}</span><span class="them">${their.biggestVolley ?? '—'}</span>
    <span>Decoy dupes</span><span class="me">${my.decoyFools}</span><span class="them">${their.decoyFools ?? '—'}</span>
  </div>`;

  const grid = v.settings.grid;
  boards.revealTheirs.setModel({
    grid,
    ships: (v.reveal?.foe?.ships ?? []).map((s) => ({ ...s })),
    revealed: v.foe.revealed,
    decoy: v.reveal?.foe?.decoy,
  });
  boards.revealMine.setModel({
    grid,
    ships: v.you.ships,
    revealed: v.you.revealed,
    decoy: v.you.decoy,
  });

  const bothIn = state.presence.every((p) => p === 'on');
  const btn = $('btn-rematch');
  btn.disabled = !bothIn;
  const myVote = v.rematch[seat];
  const theirVote = v.rematch[1 - seat];
  btn.textContent = myVote ? 'Waiting for opponent…'
    : theirVote ? '⚔ They want a rematch — GO?' : bothIn ? '⚔ Rematch' : 'Opponent left';
}

// ---- clock ----------------------------------------------------------------------

function startClock() {
  cancelAnimationFrame(clockTimer);
  const step = () => {
    if (!state) return;
    const v = state.view;
    const fills = { PLACEMENT: $('place-clock'), AIM: $('battle-clock') };
    const fill = fills[v.phase];
    if (fill && state.deadlineAt) {
      const total = v.phase === 'PLACEMENT' ? 60_000 : v.settings.aimTimer * 1000;
      const skew = Date.now() - state.serverNow; // rough, refreshed every state
      const left = Math.max(0, state.deadlineAt - (Date.now() - skew));
      const frac = Math.min(1, left / total);
      fill.style.width = `${frac * 100}%`;
      fill.classList.toggle('hot', frac < 0.3);
      const sec = Math.ceil(left / 1000);
      if (frac < 0.3 && sec !== lastTickSecond && v.phase === 'AIM' && sec > 0) {
        lastTickSecond = sec;
        sfx.tick();
      }
    } else if (fill) {
      fill.style.width = '100%';
      fill.classList.remove('hot');
    }
    clockTimer = requestAnimationFrame(step);
  };
  clockTimer = requestAnimationFrame(step);
}

// ---- wiring -----------------------------------------------------------------------

function saveIdentity() {
  const raw = $('name-input').value.trim();
  name = raw || name || 'Sailor';
  localStorage.setItem('bs_name', name);
  net.setIdentity({ name, avatar });
  net.rehello();
}

$('btn-create').addEventListener('click', () => {
  sfx.unlock(); sfx.arm();
  saveIdentity();
  localStorage.removeItem('bs_token');
  send({ t: 'create', settings: {} });
});

$('btn-join').addEventListener('click', () => {
  sfx.unlock(); sfx.arm();
  saveIdentity();
  localStorage.removeItem('bs_token');
  send({ t: 'join', roomCode: joinTarget });
});

$('btn-leave-lobby').addEventListener('click', () => { send({ t: 'leave' }); });
$('btn-new-game').addEventListener('click', () => { send({ t: 'leave' }); joinTarget = null; history.replaceState(null, '', '/'); });
$('btn-rematch').addEventListener('click', () => { sfx.arm(); send({ t: 'rematch' }); });
$('btn-fire').addEventListener('click', () => { sfx.unlock(); send({ t: 'lock' }); });
$('btn-claim').addEventListener('click', () => send({ t: 'claim' }));

$('btn-mute').addEventListener('click', () => {
  $('btn-mute').textContent = sfx.toggleMute() ? '🔇' : '🔊';
});
$('btn-mute').textContent = sfx.muted ? '🔇' : '🔊';

{
  const bar = $('emote-bar');
  EMOTES.forEach((label, id) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => send({ t: 'emote', id }));
    bar.appendChild(b);
  });
}

// Invite links: battleships.example/#QK7F3M
{
  const hash = location.hash.replace('#', '').toUpperCase();
  if (/^[A-HJ-NP-Z2-9]{6}$/.test(hash)) joinTarget = hash;
}

window.addEventListener('hashchange', () => {
  const hash = location.hash.replace('#', '').toUpperCase();
  if (/^[A-HJ-NP-Z2-9]{6}$/.test(hash) && !state) {
    joinTarget = hash;
    renderHome();
  }
});

function escText(s) {
  const d = document.createElement('span');
  d.textContent = String(s);
  return d.innerHTML;
}

renderHome();
show('home');
net.start({ name: name || 'Sailor', avatar });
