// Movement tracker: keeps a path of where the car has been and draws it on a canvas.
// Source of truth is car telemetry when available; otherwise it dead-reckons from
// the drive commands using the same kinematic model as the simulator.

export class Tracker {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.follow = true;
    this.maxSpeed = 1.5;   // m/s, used only for dead reckoning
    this.turnRate = 150;   // deg/s
    this.reset();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
  }

  reset() {
    this.pos = { x: 0, y: 0 };
    this.heading = 0;        // degrees, 0 = up/north, clockwise
    this.speed = 0;
    this.distance = 0;
    this.path = [{ x: 0, y: 0 }];
    this.source = 'estimated';
    this._lastTel = 0;
    this._lastCmd = { x: 0, y: 0, s: 0 };
    this._lastTick = performance.now();
  }

  // Called ~20x/s with the latest command; used only when no telemetry is arriving.
  setCommand(cmd) { this._lastCmd = cmd; }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.2, (now - this._lastTick) / 1000);
    this._lastTick = now;
    if (now - this._lastTel < 1000) return;  // telemetry is live; don't integrate commands
    this.source = 'estimated';
    const c = this._lastCmd;
    const target = c.y * (c.s / 100) * this.maxSpeed;
    this.speed += (target - this.speed) * Math.min(1, dt * 6);
    const dir = Math.abs(this.speed) < 0.02 ? 1 : Math.sign(this.speed);
    const pivot = Math.abs(c.y) < 0.05 ? 0.6 : 1;
    this.heading = (this.heading + c.x * this.turnRate * dir * pivot * dt + 360) % 360;
    const rad = this.heading * Math.PI / 180;
    this._move(this.pos.x + Math.sin(rad) * this.speed * dt, this.pos.y + Math.cos(rad) * this.speed * dt);
  }

  // Telemetry from the car: {x,y} metres, h degrees, v m/s.
  applyTelemetry(t) {
    this._lastTel = performance.now();
    this.source = 'telemetry';
    if (typeof t.h === 'number') this.heading = (t.h + 360) % 360;
    if (typeof t.v === 'number') this.speed = t.v;
    if (typeof t.x === 'number' && typeof t.y === 'number') this._move(t.x, t.y);
  }

  _move(nx, ny) {
    const dx = nx - this.pos.x, dy = ny - this.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;
    this.distance += d;
    this.pos = { x: nx, y: ny };
    const last = this.path[this.path.length - 1];
    if (Math.hypot(nx - last.x, ny - last.y) > 0.02) {
      this.path.push({ x: nx, y: ny });
      if (this.path.length > 4000) this.path.splice(0, this.path.length - 4000);
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const size = this.canvas.clientWidth || 360;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._size = size;
  }

  draw() {
    const ctx = this.ctx, S = this._size;
    ctx.clearRect(0, 0, S, S);

    // Choose scale: fit the whole path (min 4 m across) when not following; else fixed 6 m window.
    let cx, cy, scale;
    if (this.follow) {
      scale = S / 6; cx = this.pos.x; cy = this.pos.y;
    } else {
      let minX = 0, maxX = 0, minY = 0, maxY = 0;
      for (const p of this.path) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      const span = Math.max(4, maxX - minX, maxY - minY) * 1.2;
      scale = S / span; cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
    }
    const toPx = (x, y) => [S / 2 + (x - cx) * scale, S / 2 - (y - cy) * scale];

    // Grid (1 m)
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    const startX = Math.floor(cx - S / scale / 2), endX = Math.ceil(cx + S / scale / 2);
    const startY = Math.floor(cy - S / scale / 2), endY = Math.ceil(cy + S / scale / 2);
    ctx.beginPath();
    for (let gx = startX; gx <= endX; gx++) { const [px] = toPx(gx, 0); ctx.moveTo(px, 0); ctx.lineTo(px, S); }
    for (let gy = startY; gy <= endY; gy++) { const [, py] = toPx(0, gy); ctx.moveTo(0, py); ctx.lineTo(S, py); }
    ctx.stroke();

    // Origin marker
    const [ox, oy] = toPx(0, 0);
    ctx.strokeStyle = 'rgba(139,149,165,0.6)';
    ctx.beginPath(); ctx.moveTo(ox - 6, oy); ctx.lineTo(ox + 6, oy); ctx.moveTo(ox, oy - 6); ctx.lineTo(ox, oy + 6); ctx.stroke();

    // Path
    if (this.path.length > 1) {
      ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = this.source === 'telemetry' ? 'rgba(34,197,94,0.9)' : 'rgba(56,189,248,0.9)';
      ctx.beginPath();
      this.path.forEach((p, i) => { const [px, py] = toPx(p.x, p.y); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.lineTo(...toPx(this.pos.x, this.pos.y));
      ctx.stroke();
    }

    // Car
    const [carX, carY] = toPx(this.pos.x, this.pos.y);
    ctx.save();
    ctx.translate(carX, carY);
    ctx.rotate(this.heading * Math.PI / 180);
    ctx.fillStyle = '#e6e9ee';
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(8, 10); ctx.lineTo(0, 6); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
    ctx.restore();

    // Scale bar (1 m)
    ctx.strokeStyle = 'rgba(230,233,238,0.8)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(12, S - 12); ctx.lineTo(12 + scale, S - 12); ctx.stroke();
    ctx.fillStyle = 'rgba(139,149,165,0.9)'; ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('1 m', 12, S - 18);
  }
}
