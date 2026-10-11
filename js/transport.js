// Transport layer: one small interface, four implementations.
// Every transport exposes: connect(), disconnect(), send(obj), and the
// callbacks onMessage(obj), onStatus(state, detail), onLog(line, kind).
//
// Wire protocol (newline-delimited JSON, both directions):
//   -> {"t":"drive","x":-1..1,"y":-1..1,"s":0..100,"seq":n}   steer / throttle / speed limit
//   -> {"t":"stop"}                                             immediate stop
//   -> {"t":"horn"} | {"t":"lights","on":true|false}
//   -> {"t":"ping","ts":ms}                                     latency probe
//   <- {"t":"pong","ts":ms}
//   <- {"t":"tel","x":m,"y":m,"h":deg,"v":m/s,"batt":%}        optional telemetry from the car

export class BaseTransport {
  constructor() {
    this.onMessage = () => {};
    this.onStatus = () => {};
    this.onLog = () => {};
    this.connected = false;
    this._rxBuf = '';
  }
  async connect() {}
  async disconnect() {}
  send(_obj) {}
  _setStatus(state, detail = '') {
    this.connected = state === 'connected';
    this.onStatus(state, detail);
  }
  // Feed raw text chunks; emits one parsed object per newline-terminated line.
  _ingest(text) {
    this._rxBuf += text;
    let nl;
    while ((nl = this._rxBuf.indexOf('\n')) >= 0) {
      const line = this._rxBuf.slice(0, nl).trim();
      this._rxBuf = this._rxBuf.slice(nl + 1);
      if (!line) continue;
      try { this.onMessage(JSON.parse(line)); }
      catch { this.onLog(`rx (raw) ${line}`, 'rx'); }
    }
  }
}

/* ---------------- WebSocket (Wi-Fi: ESP32 / Raspberry Pi) ---------------- */
export class WebSocketTransport extends BaseTransport {
  constructor(url) { super(); this.url = url; this.ws = null; }
  async connect() {
    this._setStatus('connecting', this.url);
    await new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); }
      catch (e) { this._setStatus('disconnected', e.message); return reject(e); }
      this.ws = ws;
      ws.onopen = () => { this._setStatus('connected', this.url); resolve(); };
      ws.onerror = () => { const e = new Error('WebSocket error'); this._setStatus('disconnected', 'error'); reject(e); };
      ws.onclose = (ev) => this._setStatus('disconnected', `closed (${ev.code})`);
      ws.onmessage = (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : '';
        this._ingest(text.endsWith('\n') ? text : text + '\n');
      };
    });
  }
  async disconnect() { this.ws?.close(); this.ws = null; }
  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj) + '\n');
  }
}

/* ---------------- Web Bluetooth (BLE, Nordic UART Service by default) ---------------- */
export class BluetoothTransport extends BaseTransport {
  constructor(serviceUuid) {
    super();
    this.serviceUuid = serviceUuid.toLowerCase();
    // Nordic UART convention: RX = write to device, TX = notifications from device.
    this.rxUuid = this.serviceUuid.replace(/^(\w{4})(\w{4})/, (m, a, b) => a + (parseInt(b, 16) + 1).toString(16).padStart(4, '0'));
    this.txUuid = this.serviceUuid.replace(/^(\w{4})(\w{4})/, (m, a, b) => a + (parseInt(b, 16) + 2).toString(16).padStart(4, '0'));
    this.device = null; this.rxChar = null; this.txChar = null;
    this._enc = new TextEncoder(); this._dec = new TextDecoder();
    this._queue = Promise.resolve();
  }
  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported in this browser (use Chrome/Edge over https or localhost).');
    this._setStatus('connecting', 'choose device…');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [this.serviceUuid] }],
      optionalServices: [this.serviceUuid],
    });
    this.device.addEventListener('gattserverdisconnected', () => this._setStatus('disconnected', 'GATT disconnected'));
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(this.serviceUuid);
    this.rxChar = await service.getCharacteristic(this.rxUuid);
    this.txChar = await service.getCharacteristic(this.txUuid);
    await this.txChar.startNotifications();
    this.txChar.addEventListener('characteristicvaluechanged', (ev) => this._ingest(this._dec.decode(ev.target.value)));
    this._setStatus('connected', this.device.name || 'BLE device');
  }
  async disconnect() { this.device?.gatt?.connected && this.device.gatt.disconnect(); }
  send(obj) {
    if (!this.rxChar) return;
    const bytes = this._enc.encode(JSON.stringify(obj) + '\n');
    // BLE writes must be serialized and kept under the (typically 20-byte) MTU.
    this._queue = this._queue.then(async () => {
      for (let i = 0; i < bytes.length; i += 20) {
        const chunk = bytes.slice(i, i + 20);
        if (this.rxChar.writeValueWithoutResponse) await this.rxChar.writeValueWithoutResponse(chunk);
        else await this.rxChar.writeValue(chunk);
      }
    }).catch((e) => this.onLog(`ble write failed: ${e.message}`, 'err'));
  }
}

/* ---------------- Web Serial (USB cable to Arduino / ESP32) ---------------- */
export class SerialTransport extends BaseTransport {
  constructor(baud) { super(); this.baud = baud; this.port = null; this.writer = null; this._reading = false; }
  async connect() {
    if (!navigator.serial) throw new Error('Web Serial not supported in this browser (use Chrome/Edge over https or localhost).');
    this._setStatus('connecting', 'choose port…');
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.baud });
    this.writer = this.port.writable.getWriter();
    this._setStatus('connected', `serial @ ${this.baud}`);
    this._readLoop();
  }
  async _readLoop() {
    this._reading = true;
    const dec = new TextDecoder();
    while (this._reading && this.port?.readable) {
      const reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this._ingest(dec.decode(value, { stream: true }));
        }
      } catch (e) { this.onLog(`serial read error: ${e.message}`, 'err'); }
      finally { reader.releaseLock(); }
    }
  }
  async disconnect() {
    this._reading = false;
    try { await this.writer?.close(); } catch {}
    try { await this.port?.close(); } catch {}
    this.writer = null; this.port = null;
    this._setStatus('disconnected', 'serial closed');
  }
  send(obj) {
    this.writer?.write(new TextEncoder().encode(JSON.stringify(obj) + '\n')).catch(() => {});
  }
}

/* ---------------- Simulation (no hardware) ---------------- */
// A small kinematic car model so the UI and tracker can be exercised without a vehicle.
export class SimTransport extends BaseTransport {
  constructor() {
    super();
    this.state = { x: 0, y: 0, h: 0, v: 0, batt: 100 };
    this.cmd = { x: 0, y: 0, s: 60 };
    this._timer = null; this._last = 0;
    this.maxSpeed = 1.5;   // m/s at 100% throttle, 100% limit
    this.turnRate = 150;   // deg/s at full steer
  }
  async connect() {
    this._setStatus('connecting', 'starting sim');
    await new Promise((r) => setTimeout(r, 300));
    this._last = performance.now();
    this._timer = setInterval(() => this._tick(), 50);
    this._setStatus('connected', 'simulated car');
  }
  async disconnect() { clearInterval(this._timer); this._timer = null; this._setStatus('disconnected', 'sim stopped'); }
  send(obj) {
    if (obj.t === 'drive') this.cmd = { x: obj.x, y: obj.y, s: obj.s };
    else if (obj.t === 'stop') this.cmd = { ...this.cmd, x: 0, y: 0 };
    else if (obj.t === 'ping') setTimeout(() => this.onMessage({ t: 'pong', ts: obj.ts }), 8 + Math.random() * 12);
    else if (obj.t === 'horn') this.onLog('sim: beep!', 'rx');
    else if (obj.t === 'lights') this.onLog(`sim: lights ${obj.on ? 'on' : 'off'}`, 'rx');
  }
  _tick() {
    const now = performance.now(); const dt = (now - this._last) / 1000; this._last = now;
    const s = this.state, c = this.cmd;
    const target = c.y * (c.s / 100) * this.maxSpeed;
    s.v += (target - s.v) * Math.min(1, dt * 6);              // simple motor lag
    const dir = Math.abs(s.v) < 0.02 ? 1 : Math.sign(s.v);    // car-like: steering flips in reverse
    const pivot = Math.abs(c.y) < 0.05 ? 0.6 : 1;             // slower pivot when stationary
    s.h = (s.h + c.x * this.turnRate * dir * pivot * dt + 360) % 360;
    const rad = s.h * Math.PI / 180;
    s.x += Math.sin(rad) * s.v * dt;
    s.y += Math.cos(rad) * s.v * dt;
    s.batt = Math.max(0, s.batt - Math.abs(s.v) * dt * 0.02);
    this.onMessage({ t: 'tel', x: +s.x.toFixed(3), y: +s.y.toFixed(3), h: +s.h.toFixed(1), v: +s.v.toFixed(3), batt: +s.batt.toFixed(1) });
  }
}

export function createTransport(kind, opts) {
  switch (kind) {
    case 'ws': return new WebSocketTransport(opts.wsUrl);
    case 'ble': return new BluetoothTransport(opts.bleService);
    case 'serial': return new SerialTransport(opts.serialBaud);
    default: return new SimTransport();
  }
}
