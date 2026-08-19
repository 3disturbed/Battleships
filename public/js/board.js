// Canvas board renderer + timed effects (shell arcs, splashes, plumes, sonar
// rings, shakes). One Board per canvas; render loop runs only while the board
// is active or effects are in flight.

const COLS = 'ABCDEFGHJK';

export class Board {
  constructor(canvas, { labels = true, onCell = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.labels = labels;
    this.model = null;
    this.effects = [];
    this.active = false;
    this.raf = 0;
    this.shakeUntil = 0;
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.onCell = onCell;
    this.hover = null;

    if (onCell) {
      canvas.addEventListener('pointerdown', (ev) => {
        const cell = this.cellFromEvent(ev);
        if (cell) onCell(cell, ev);
      });
    }
    this.ro = new ResizeObserver(() => { this.resize(); this.draw(performance.now()); });
    this.ro.observe(canvas);
  }

  resize() {
    const w = this.canvas.clientWidth || 300;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(w * this.dpr);
    this.canvas.style.height = `${w}px`;
    const grid = this.model?.grid ?? 10;
    this.margin = this.labels ? w * 0.055 : w * 0.012;
    this.pad = w * 0.012;
    this.cell = (w - this.margin - this.pad * 2) / grid;
    this.origin = this.margin + this.pad;
  }

  setModel(model) {
    const gridChanged = this.model?.grid !== model.grid;
    this.model = model;
    if (gridChanged) this.resize();
    this.requestDraw();
  }

  setActive(on) {
    this.active = on;
    if (on) this.loop();
  }

  cellRect(x, y) {
    return [this.origin + x * this.cell, this.origin + y * this.cell, this.cell, this.cell];
  }
  cellCenter(x, y) {
    return [this.origin + (x + 0.5) * this.cell, this.origin + (y + 0.5) * this.cell];
  }
  cellFromEvent(ev) {
    const r = this.canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    const grid = this.model?.grid ?? 10;
    const x = Math.floor((px - this.origin) / this.cell);
    const y = Math.floor((py - this.origin) / this.cell);
    return x >= 0 && y >= 0 && x < grid && y < grid ? { x, y } : null;
  }

  // ---- effects ------------------------------------------------------------

  addFx(fx) {
    this.effects.push({ t0: performance.now() + (fx.delay ?? 0), fired: false, ...fx });
    this.loop();
  }
  shell(cell, { onImpact, from = 'bottom' } = {}) {
    this.addFx({ type: 'shell', cell, dur: 430, from, onImpact });
  }
  splash(cell) { this.addFx({ type: 'splash', cell, dur: 550 }); }
  plume(cell) { this.addFx({ type: 'plume', cell, dur: 750 }); }
  sinkFlash(cells) { this.addFx({ type: 'sinkflash', cells, dur: 650 }); }
  sonar(cell, distance) { this.addFx({ type: 'sonar', cell, distance, dur: 2000 }); }
  reconSweep(cx, cy) { this.addFx({ type: 'recon', cell: { x: cx, y: cy }, dur: 900 }); }
  shake(ms = 220) { this.shakeUntil = performance.now() + ms; this.loop(); }
  clearFx() { this.effects = []; }

  get busy() { return this.effects.length > 0; }

  // ---- render -------------------------------------------------------------

  requestDraw() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => { this.raf = 0; this.draw(t); });
  }
  loop() {
    if (this.raf) return;
    const step = (t) => {
      this.raf = 0;
      this.draw(t);
      if (this.active || this.effects.length || t < this.shakeUntil) {
        this.raf = requestAnimationFrame(step);
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  draw(now) {
    const m = this.model;
    const ctx = this.ctx;
    if (!m || !this.cell) return;
    const grid = m.grid;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (now < this.shakeUntil) {
      const k = (this.shakeUntil - now) / 220;
      ctx.translate((Math.random() - 0.5) * 8 * k, (Math.random() - 0.5) * 8 * k);
    }

    const size = grid * this.cell;
    const o = this.origin;

    // Water
    const sea = ctx.createLinearGradient(0, o, 0, o + size);
    sea.addColorStop(0, '#0d2748');
    sea.addColorStop(1, '#081c36');
    ctx.fillStyle = sea;
    ctx.fillRect(o, o, size, size);
    // Shimmer: sparse moving glints
    ctx.fillStyle = 'rgba(96, 165, 250, 0.05)';
    const t = now / 1400;
    for (let i = 0; i < 14; i++) {
      const gx = o + ((i * 0.37 + Math.sin(t + i * 1.7) * 0.06 + 1) % 1) * size;
      const gy = o + ((i * 0.61 + Math.cos(t * 0.8 + i) * 0.05 + 1) % 1) * size;
      ctx.fillRect(gx, gy, this.cell * 0.5, 1.5);
    }

    // Grid
    ctx.strokeStyle = 'rgba(56, 122, 189, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= grid; i++) {
      ctx.moveTo(o + i * this.cell, o); ctx.lineTo(o + i * this.cell, o + size);
      ctx.moveTo(o, o + i * this.cell); ctx.lineTo(o + size, o + i * this.cell);
    }
    ctx.stroke();

    // Labels
    if (this.labels) {
      ctx.fillStyle = 'rgba(125, 151, 184, 0.7)';
      ctx.font = `${Math.max(8, this.cell * 0.34)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < grid; i++) {
        ctx.fillText(COLS[i], o + (i + 0.5) * this.cell, this.margin * 0.45);
        ctx.fillText(String(i + 1), this.margin * 0.45, o + (i + 0.5) * this.cell);
      }
    }

    // Recon intel marks (before ships so own-board never uses them)
    for (const mark of m.reconMarks ?? []) {
      const [x, y, w, h] = this.cellRect(mark.x, mark.y);
      ctx.fillStyle = mark.ship ? 'rgba(248, 113, 113, 0.28)' : 'rgba(74, 222, 128, 0.16)';
      ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
      ctx.strokeStyle = mark.ship ? 'rgba(248, 113, 113, 0.8)' : 'rgba(74, 222, 128, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
    }

    // Ships
    for (const ship of m.ships ?? []) this.drawShip(ship, m);

    // Decoy buoy (own board)
    if (m.decoy) {
      const [cx, cy] = this.cellCenter(m.decoy.x, m.decoy.y);
      ctx.fillStyle = m.decoy.hit ? '#fbbf24' : '#eab308';
      ctx.beginPath();
      ctx.arc(cx, cy, this.cell * 0.22, 0, 7);
      ctx.fill();
      ctx.fillStyle = '#0b1524';
      ctx.font = `${this.cell * 0.3}px system-ui`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('◈', cx, cy);
      if (m.decoy.hit) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, this.cell * 0.34 + Math.sin(now / 200) * 2, 0, 7);
        ctx.stroke();
      }
    }

    // Shot markers
    for (const [k, v] of m.revealed ?? []) {
      const [xs, ys] = k.split(',');
      this.drawMarker(+xs, +ys, v, now);
    }

    // Aim reticles
    if (m.aim) {
      for (const c of m.aim) {
        const [cx, cy] = this.cellCenter(c.x, c.y);
        const r = this.cell * (0.3 + Math.sin(now / 260) * 0.03);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 7);
        ctx.stroke();
        ctx.beginPath();
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          ctx.moveTo(cx + dx * r * 0.55, cy + dy * r * 0.55);
          ctx.lineTo(cx + dx * r * 1.35, cy + dy * r * 1.35);
        }
        ctx.stroke();
      }
      if (m.bigguns && m.aim[0]) {
        // show the cross blast preview on the first armed cell
        const c = m.aim[0];
        ctx.fillStyle = 'rgba(251, 191, 36, 0.22)';
        for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x = c.x + dx, y = c.y + dy;
          if (x < 0 || y < 0 || x >= grid || y >= grid) continue;
          const [rx, ry, rw, rh] = this.cellRect(x, y);
          ctx.fillRect(rx + 1, ry + 1, rw - 2, rh - 2);
        }
      }
    }

    // Hover ghost (targeting)
    if (this.hover) {
      const [x, y, w, h] = this.cellRect(this.hover.x, this.hover.y);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    }

    // Effects on top
    const keep = [];
    for (const fx of this.effects) {
      const p = (now - fx.t0) / fx.dur;
      if (p < 0) { keep.push(fx); continue; }
      this.drawFx(fx, Math.min(1, p), now);
      if (p < 1) keep.push(fx);
      else if (fx.onDone) fx.onDone();
    }
    this.effects = keep;
  }

  drawShip(ship, m) {
    const ctx = this.ctx;
    const horiz = ship.dir === 'h';
    const [x, y] = [ship.x, ship.y];
    const [rx, ry] = this.cellRect(x, y);
    const len = ship.size * this.cell;
    const inset = this.cell * 0.12;
    const w = horiz ? len - inset * 2 : this.cell - inset * 2;
    const h = horiz ? this.cell - inset * 2 : len - inset * 2;
    const r = Math.min(w, h) * 0.4;

    ctx.save();
    ctx.translate(rx + inset, ry + inset);
    const isGhost = ship.ghost;
    const isSunk = ship.sunk;
    ctx.globalAlpha = isGhost ? 0.55 : 1;
    const hull = ctx.createLinearGradient(0, 0, horiz ? 0 : w, horiz ? h : 0);
    if (isSunk) { hull.addColorStop(0, '#3f1d1d'); hull.addColorStop(1, '#2a1215'); }
    else if (ship.invalid) { hull.addColorStop(0, '#7f1d1d'); hull.addColorStop(1, '#5f1616'); }
    else { hull.addColorStop(0, '#64748b'); hull.addColorStop(1, '#3b4a5f'); }
    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, r);
    ctx.fill();
    ctx.strokeStyle = isSunk ? '#7f1d1d' : ship.selected ? '#38bdf8' : '#1e293b';
    ctx.lineWidth = ship.selected ? 2.5 : 1.5;
    ctx.stroke();

    // Deck detail: one hatch per cell
    ctx.fillStyle = isSunk ? 'rgba(127, 29, 29, .5)' : 'rgba(15, 23, 42, 0.45)';
    for (let i = 0; i < ship.size; i++) {
      const cx = horiz ? (i + 0.5) * this.cell - inset : w / 2;
      const cy = horiz ? h / 2 : (i + 0.5) * this.cell - inset;
      ctx.beginPath();
      ctx.arc(cx, cy, this.cell * 0.13, 0, 7);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawMarker(x, y, kind, now) {
    const ctx = this.ctx;
    const [cx, cy] = this.cellCenter(x, y);
    if (kind === 'miss') {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(cx, cy, this.cell * 0.16, 0, 7);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.beginPath();
      ctx.arc(cx, cy, this.cell * 0.05, 0, 7);
      ctx.fill();
    } else { // hit / sink / decoy(own board)
      const flick = 0.85 + Math.sin(now / 90 + x * 7 + y * 3) * 0.15;
      const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, this.cell * 0.34);
      grad.addColorStop(0, `rgba(254, 240, 138, ${0.95 * flick})`);
      grad.addColorStop(0.45, `rgba(251, 146, 60, ${0.9 * flick})`);
      grad.addColorStop(1, 'rgba(194, 65, 12, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, this.cell * 0.34, 0, 7);
      ctx.fill();
      if (kind === 'sink') {
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.lineWidth = 2;
        const d = this.cell * 0.16;
        ctx.beginPath();
        ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
        ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
        ctx.stroke();
      }
    }
  }

  drawFx(fx, p, now) {
    const ctx = this.ctx;
    switch (fx.type) {
      case 'shell': {
        const [tx, ty] = this.cellCenter(fx.cell.x, fx.cell.y);
        const size = (this.model.grid) * this.cell;
        const sx = this.origin + size * (fx.cell.x / this.model.grid);
        const sy = this.origin + size + this.cell * 2;
        const apex = -this.cell * 3;
        const e = p * p * (3 - 2 * p); // smoothstep
        const x = sx + (tx - sx) * e;
        const y = sy + (ty - sy) * e + apex * Math.sin(Math.PI * e);
        ctx.fillStyle = '#fde68a';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, this.cell * 0.09), 0, 7);
        ctx.fill();
        ctx.strokeStyle = 'rgba(253, 230, 138, 0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        const eb = Math.max(0, e - 0.12);
        const xb = sx + (tx - sx) * eb;
        const yb = sy + (ty - sy) * eb + apex * Math.sin(Math.PI * eb);
        ctx.lineTo(xb, yb);
        ctx.stroke();
        if (p >= 1 && !fx.fired) { fx.fired = true; fx.onImpact?.(); }
        break;
      }
      case 'splash': {
        const [cx, cy] = this.cellCenter(fx.cell.x, fx.cell.y);
        ctx.strokeStyle = `rgba(147, 197, 253, ${0.7 * (1 - p)})`;
        ctx.lineWidth = 2.5 * (1 - p) + 0.5;
        ctx.beginPath();
        ctx.arc(cx, cy, this.cell * (0.1 + p * 0.55), 0, 7);
        ctx.stroke();
        ctx.fillStyle = `rgba(191, 219, 254, ${0.5 * (1 - p)})`;
        for (let i = 0; i < 5; i++) {
          const a = i * 1.256 + fx.t0;
          const rr = this.cell * p * 0.5;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr - p * this.cell * 0.35, 1.8 * (1 - p) + 0.4, 0, 7);
          ctx.fill();
        }
        break;
      }
      case 'plume': {
        const [cx, cy] = this.cellCenter(fx.cell.x, fx.cell.y);
        if (p < 0.25) {
          ctx.fillStyle = `rgba(254, 249, 195, ${1 - p * 4})`;
          ctx.beginPath();
          ctx.arc(cx, cy, this.cell * (0.2 + p * 2.2), 0, 7);
          ctx.fill();
        }
        for (let i = 0; i < 7; i++) {
          const a = i * 0.9 + (fx.t0 % 6);
          const lift = p * this.cell * (0.5 + (i % 3) * 0.28);
          const alpha = Math.max(0, 0.55 - p * 0.6);
          ctx.fillStyle = i % 2 ? `rgba(251, 146, 60, ${alpha})` : `rgba(71, 85, 105, ${alpha + 0.1})`;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * this.cell * 0.18 * (1 + p), cy - lift + Math.sin(a) * 3,
            this.cell * (0.1 + p * 0.16) * (1 + (i % 3) * 0.3), 0, 7);
          ctx.fill();
        }
        break;
      }
      case 'sinkflash': {
        for (const c of fx.cells) {
          const [x, y, w, h] = this.cellRect(c.x, c.y);
          const a = p < 0.3 ? p / 0.3 : 1 - (p - 0.3) / 0.7;
          ctx.fillStyle = `rgba(248, 113, 113, ${a * 0.55})`;
          ctx.fillRect(x, y, w, h);
        }
        break;
      }
      case 'sonar': {
        const [cx, cy] = this.cellCenter(fx.cell.x, fx.cell.y);
        const ringP = Math.min(1, p * 2.2);
        ctx.strokeStyle = `rgba(74, 222, 128, ${0.8 * (1 - ringP)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, this.cell * (0.2 + ringP * (fx.distance ?? 2) * 0.9), 0, 7);
        ctx.stroke();
        ctx.fillStyle = `rgba(74, 222, 128, ${p > 0.85 ? (1 - p) / 0.15 : 1})`;
        ctx.font = `800 ${this.cell * 0.5}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(fx.distance === null ? '∅' : String(fx.distance), cx, cy - this.cell * 0.05);
        break;
      }
      case 'recon': {
        const { x, y } = fx.cell;
        const [rx, ry] = this.cellRect(x - 1, y - 1);
        const w = this.cell * 3;
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, ry, w, w);
        ctx.clip();
        const sweepY = ry + w * p;
        const grad = ctx.createLinearGradient(0, sweepY - this.cell, 0, sweepY);
        grad.addColorStop(0, 'rgba(74, 222, 128, 0)');
        grad.addColorStop(1, 'rgba(74, 222, 128, 0.5)');
        ctx.fillStyle = grad;
        ctx.fillRect(rx, ry, w, w);
        ctx.restore();
        break;
      }
    }
  }
}
