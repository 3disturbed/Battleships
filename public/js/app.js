// Boot + screen routing + message dispatch. Every screen renders from the
// latest server state; a refresh at any moment lands you where you were.

import { createNet } from './net.js?v=5';
import { sfx } from './sfx.js?v=5';
import { Board } from './board.js?v=5';
import { createPlacement } from './place.js?v=5';
import { createBattle } from './battle.js?v=5';
import { createLobby } from './lobby.js?v=5';

const $ = (id) => document.getElementById(id);

const AVATARS = ['🦈', '🐙', '🐳', '⚓', '🏴‍☠️', '🦑', '🐊', '🚢', '🧜', '🦞'];
const EMOTES = ['GG', 'lucky!', 'nooo!', '😱', '🔥', '🍀', '😤', '🫡'];
const SCREENS = ['home', 'lobby', 'place', 'battle', 'over'];

// ---- state -----------------------------------------------------------------

let state = null; // latest applied server 'state' message
let pendingState = null; // held back while a barrage animates
let leaving = false; // ignore room traffic once we've chosen to leave
let seat = -1;
let joinTarget = null; // room code from the invite link
let clockTimer = 0;
let lastTickSecond = -1;
let queuedJoin = null; // social invite that arrived mid-room; fired from resetToHome()
let partyRoomPending = false; // we created a room for a party launch; report it on 'welcome'

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
  $('btn-menu').classList.toggle('hidden', !['lobby', 'place', 'battle'].includes(screenName));
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
    botCard: $('bot-card'),
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
          if (partyRoomPending && window.DGOverlay) { // party host: hand the room to the party
            partyRoomPending = false;
            DGOverlay.party.setRoom({ joinCode: msg.roomCode }).catch((e) => console.warn('[social] setRoom', e));
          }
        } else if (!msg.resumed && localStorage.getItem('bs_token')) {
          // Dead token (room expired). Forget it; stay wherever we are.
          localStorage.removeItem('bs_token');
          if (state) { // we were mid-game: the room is gone
            state = null;
            show('home');
            toast('That game has ended — start a new one!', true);
            publishPresence();
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
      case 'left': resetToHome(); leaving = false; return;
    }
  },
  onStatus(s) {
    $('conn-status').classList.toggle('hidden', s === 'online' || s === 'connecting');
  },
});

function applyState(msg) {
  if (leaving) return; // the forfeit-broadcast must not flash a defeat screen
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
  publishPresence();
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

// Back to the main menu: clear room state, dead token, stale invite hash, and
// any post-barrage state still waiting to render.
// NOTE: deliberately does not clear `leaving` — that guard must outlive the
// reset, until the server's 'left' ack (or a fresh create/join) clears it.
function resetToHome() {
  state = null;
  pendingState = null;
  joinTarget = null;
  localStorage.removeItem('bs_token');
  history.replaceState(null, '', '/');
  $('confirm-leave').classList.add('hidden');
  renderHome();
  show('home');
  publishPresence();
  if (queuedJoin) { // an invite arrived mid-battle: now we're free to follow it
    const code = queuedJoin;
    queuedJoin = null;
    setTimeout(() => socialJoin({ joinCode: code }), 0);
  }
}

function requestLeave() {
  sfx.click();
  const phase = state?.view?.phase;
  if (phase === 'PLACEMENT' || phase === 'AIM') {
    $('confirm-leave').classList.remove('hidden'); // leaving a live game forfeits
    return;
  }
  leaving = true;
  send({ t: 'leave' });
  resetToHome(); // don't wait on the round-trip; a dead socket must not trap us
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
  leaving = false;
  localStorage.removeItem('bs_token');
  send({ t: 'create', settings: {} });
});

$('btn-join').addEventListener('click', () => {
  sfx.unlock(); sfx.arm();
  saveIdentity();
  leaving = false;
  localStorage.removeItem('bs_token');
  send({ t: 'join', roomCode: joinTarget });
});

$('btn-leave-lobby').addEventListener('click', requestLeave);
$('btn-new-game').addEventListener('click', requestLeave);
$('btn-menu').addEventListener('click', requestLeave);
$('btn-confirm-stay').addEventListener('click', () => {
  sfx.click();
  $('confirm-leave').classList.add('hidden');
});
$('btn-confirm-leave').addEventListener('click', () => {
  sfx.disarm();
  leaving = true;
  send({ t: 'leave' });
  resetToHome();
});
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

// ---- Darks Games social layer -------------------------------------------------------
// Friends / party / invites via the DG overlay SDK (index.html loads dg-account +
// dg-overlay before this module). Everything here is a no-op when the SDKs are
// missing, so the game plays exactly as before offline or on a bare checkout.

const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

async function initSocial() {
  if (!window.DGAccount || !window.DGOverlay) return;
  const user = await DGAccount.init({ game: 'battleships' });
  if (user?.name && !localStorage.getItem('bs_name')) {
    name = user.name.slice(0, 16);
    $('name-input').value = name;
  }
  await DGOverlay.init({ game: 'battleships', accent: '#6bd5fa', joinHandler: socialJoin });
  DGOverlay.on('party.arrived', onPartyArrived);
  publishPresence();
}

// Derive presence from the latest server state; called on every transition.
function publishPresence() {
  if (!window.DGOverlay) return;
  const v = state?.view;
  if (!v) { DGOverlay.presence.set({ state: 'menu', detail: '', join: null }); return; }
  const seated = v.seats.filter(Boolean).length; // a bot in seat 1 is a filled seat
  const target = v.series?.target ?? 1;
  DGOverlay.presence.set({
    state: { LOBBY: 'lobby', PLACEMENT: 'placing', AIM: 'battle', GAMEOVER: 'game over' }[v.phase] ?? 'playing',
    detail: `${v.settings.mode === 'blitz' ? 'Blitz' : 'Classic'} · ${v.settings.grid}×${v.settings.grid}${target > 1 ? ` · best of ${target}` : ''}`,
    join: { joinCode: state.roomCode, joinable: v.phase === 'LOBBY' && seated < 2, players: seated, max: 2 },
  });
}

// Overlay "Join" / accepted invite / party room. Join in place and return true;
// return false only when we cannot (the overlay then navigates to the join URL).
function socialJoin(j) {
  const code = (j?.joinCode || location.hash.slice(1) || '').toUpperCase();
  if (!ROOM_CODE_RE.test(code)) return false;
  if (state?.roomCode === code) return true; // already aboard
  if (state) { // in a room (lobby or battle): never yank the player out mid-match
    queuedJoin = code;
    toast('Invite saved — leave this battle to join it');
    return true; // handled: nothing to navigate to
  }
  // Home screen: same path as an invite link. hashchange fires asynchronously,
  // so set joinTarget directly before auto-pressing Join.
  joinTarget = code;
  location.hash = code;
  renderHome();
  if (name) $('btn-join').click(); // identity known → join straight away
  return true;
}

// Party launch: the host creates a room the normal way and reports it on 'welcome'.
function onPartyArrived({ isHost, room, party } = {}) {
  if (!isHost || room) return;
  if ((party?.members?.length ?? 0) > 2) {
    toast('Battleships is two players — the party is too big', true);
    return;
  }
  queuedJoin = null; // the party room supersedes any saved invite
  if (state) { leaving = true; send({ t: 'leave' }); resetToHome(); }
  partyRoomPending = true;
  sfx.unlock(); sfx.arm();
  saveIdentity();
  leaving = false;
  localStorage.removeItem('bs_token');
  send({ t: 'create', settings: {} }); // same as #btn-create
}

{
  const boot = () => initSocial().catch((e) => console.warn('[social]', e));
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
}
