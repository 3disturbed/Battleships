// Lobby screen: share link, seats, host settings, ready-up.

import { sfx } from './sfx.js?v=2';

export function createLobby({ els, send, toast }) {
  // els: shareLink, shareBtn, seats, settings, settingsHint, readyBtn
  let st = null;

  function link() {
    return `${location.origin}/#${st?.roomCode ?? ''}`;
  }

  async function share() {
    sfx.click();
    const url = link();
    const payload = {
      title: 'Battleships',
      text: '⚓ You\'ve been challenged to Battleships! Game takes 5 minutes:',
      url,
    };
    if (navigator.share) {
      try { await navigator.share(payload); return; } catch { /* cancelled */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied — paste it to your friend!');
    } catch {
      toast('Copy this link: ' + url, true);
    }
  }

  function renderSeats() {
    const v = st.view;
    els.seats.innerHTML = '';
    v.seats.forEach((seat, i) => {
      const row = document.createElement('div');
      row.className = 'seat' + (seat ? '' : ' empty');
      const on = st.presence[i] === 'on';
      row.innerHTML = seat ? `
        <span class="face">${seat.avatar}</span>
        <span class="who">${escText(seat.name)}${i === v.seat ? ' (you)' : ''}</span>
        <span class="state ${seat.ready ? 'ready' : ''}">${!on ? 'reconnecting…' : seat.ready ? 'READY ⚓' : 'not ready'}</span>`
        : `
        <span class="face">👀</span>
        <span class="who">Waiting for a challenger…</span>
        <span class="state">send the link!</span>`;
      els.seats.appendChild(row);
    });
  }

  function renderSettings() {
    const v = st.view;
    const host = v.seat === 0;
    els.settingsHint.textContent = host
      ? 'You\'re the host — pick the rules.'
      : 'The host picks the rules.';
    for (const row of els.settings.querySelectorAll('.setting-row')) {
      const keyName = row.dataset.key;
      const seg = row.querySelector('.seg');
      if (!seg.dataset.built) {
        seg.dataset.built = '1';
        for (const [value, label] of JSON.parse(seg.dataset.opts)) {
          const b = document.createElement('button');
          b.textContent = label;
          b.dataset.value = JSON.stringify(value);
          b.addEventListener('click', () => {
            if (st.view.seat !== 0) return;
            sfx.click();
            send({ t: 'settings', patch: { [keyName]: value } });
          });
          seg.appendChild(b);
        }
      }
      for (const b of seg.querySelectorAll('button')) {
        b.classList.toggle('sel', JSON.parse(b.dataset.value) === v.settings[keyName]);
        b.disabled = !host;
      }
    }
  }

  function update(state) {
    st = state;
    els.shareLink.textContent = link().replace(/^https?:\/\//, '');
    renderSeats();
    renderSettings();
    const me = st.view.seats[st.view.seat];
    els.readyBtn.textContent = me?.ready ? 'Not ready' : 'Ready up ⚓';
    els.readyBtn.classList.toggle('primary', !me?.ready);
  }

  els.shareBtn.addEventListener('click', share);
  els.shareLink.addEventListener('click', share);
  els.readyBtn.addEventListener('click', () => {
    if (!st) return;
    const me = st.view.seats[st.view.seat];
    sfx.arm();
    send({ t: 'ready', ready: !me?.ready });
  });

  return { update };
}

function escText(s) {
  const d = document.createElement('span');
  d.textContent = String(s);
  return d.innerHTML;
}
