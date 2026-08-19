// All audio is synthesized — zero asset bytes. Every effect is a short
// envelope on oscillators/noise through a master gain.

let ctx = null;
let master = null;
let muted = localStorage.getItem('bs_muted') === '1';

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return true;
}

function noiseBuffer(seconds) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function env(node, t0, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  node.connect(g);
  g.connect(master);
  return g;
}

function tone(type, f0, f1, t0, dur, peak = 0.3) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  env(o, t0, peak, 0.01, dur);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

function noise(t0, dur, peak = 0.3, filterFreq = null, q = 1) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(Math.min(dur + 0.1, 1.5));
  let node = src;
  if (filterFreq) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = filterFreq;
    f.Q.value = q;
    src.connect(f);
    node = f;
  }
  env(node, t0, peak, 0.015, dur);
  src.start(t0);
  src.stop(t0 + dur + 0.1);
}

function play(fn) {
  if (muted || !ensure()) return;
  try { fn(ctx.currentTime); } catch { /* audio must never break the game */ }
}

export const sfx = {
  get muted() { return muted; },
  toggleMute() {
    muted = !muted;
    localStorage.setItem('bs_muted', muted ? '1' : '0');
    return muted;
  },
  unlock() { if (!muted) ensure(); }, // call on first user gesture

  click: () => play((t) => tone('square', 660, 520, t, 0.06, 0.08)),
  arm: () => play((t) => tone('sine', 380, 520, t, 0.07, 0.12)),
  disarm: () => play((t) => tone('sine', 520, 340, t, 0.07, 0.1)),
  whistle: () => play((t) => tone('sine', 1400, 300, t, 0.42, 0.12)),
  splash: () => play((t) => { noise(t, 0.35, 0.25, 900, 0.8); tone('sine', 220, 90, t, 0.2, 0.1); }),
  boom: () => play((t) => {
    tone('sine', 120, 36, t, 0.45, 0.55);
    noise(t, 0.3, 0.35, 1800, 0.6);
    noise(t + 0.03, 0.5, 0.2, 400, 0.8);
  }),
  sink: () => play((t) => {
    tone('sine', 90, 28, t, 1.1, 0.6);
    noise(t + 0.1, 0.9, 0.22, 500, 0.7);
    for (let i = 0; i < 6; i++) tone('sine', 300 + i * 60, 200, t + 0.25 + i * 0.09, 0.07, 0.05);
  }),
  ping: () => play((t) => { tone('sine', 1150, 1120, t, 0.5, 0.16); tone('sine', 1150, 1120, t + 0.55, 0.35, 0.07); }),
  recon: () => play((t) => { for (let i = 0; i < 3; i++) tone('triangle', 700 + i * 180, 900 + i * 180, t + i * 0.09, 0.1, 0.08); }),
  tick: () => play((t) => tone('square', 900, 880, t, 0.03, 0.05)),
  fanfare: () => play((t) => {
    [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, t + i * 0.13, 0.32, 0.2));
    noise(t + 0.5, 0.6, 0.1, 3000, 0.5);
  }),
  dirge: () => play((t) => {
    [392, 370, 349, 330].forEach((f, i) => tone('triangle', f, f * 0.99, t + i * 0.22, 0.4, 0.16));
  }),
  emote: () => play((t) => tone('sine', 880, 1100, t, 0.09, 0.1)),
};
