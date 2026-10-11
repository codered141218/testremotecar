#!/usr/bin/env node
// Mock car: a tiny WebSocket server (no dependencies) that behaves like the ESP32
// firmware. Lets you test the real Wi-Fi link end to end without any hardware.
//
//   node tools/mock-car.js            # listens on ws://127.0.0.1:81
//   node tools/mock-car.js 8081       # custom port
//
// Then in the app pick "Wi-Fi · WebSocket", enter ws://127.0.0.1:81 and Connect.
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 81;
const MAX_SPEED = 1.5, TURN_RATE = 150, FAILSAFE_MS = 500;
const clients = new Set();

// --- car model (same kinematics as the firmware) ---
const car = { x: 0, y: 0, h: 0, v: 0, batt: 100 };
const cmd = { x: 0, y: 0, s: 60 };
let lastCmd = 0, lastTick = Date.now();

setInterval(() => {
  const now = Date.now(), dt = (now - lastTick) / 1000; lastTick = now;
  if ((cmd.x || cmd.y) && now - lastCmd > FAILSAFE_MS) { cmd.x = cmd.y = 0; console.log('failsafe stop'); }
  const target = cmd.y * (cmd.s / 100) * MAX_SPEED;
  car.v += (target - car.v) * Math.min(1, dt * 6);
  const dir = Math.abs(car.v) < 0.02 ? 1 : Math.sign(car.v);
  const pivot = Math.abs(cmd.y) < 0.05 ? 0.6 : 1;
  car.h = (car.h + cmd.x * TURN_RATE * dir * pivot * dt + 360) % 360;
  const rad = car.h * Math.PI / 180;
  car.x += Math.sin(rad) * car.v * dt; car.y += Math.cos(rad) * car.v * dt;
  car.batt = Math.max(0, car.batt - Math.abs(car.v) * dt * 0.05);
}, 50);

setInterval(() => {
  const tel = JSON.stringify({ t: 'tel', x: +car.x.toFixed(3), y: +car.y.toFixed(3), h: +car.h.toFixed(1), v: +car.v.toFixed(3), batt: +car.batt.toFixed(1) }) + '\n';
  for (const c of clients) c.write(frame(tel));
}, 100);

function handle(sock, text) {
  let msg; try { msg = JSON.parse(text); } catch { return; }
  switch (msg.t) {
    case 'drive': Object.assign(cmd, { x: +msg.x || 0, y: +msg.y || 0, s: +msg.s || 60 }); lastCmd = Date.now();
      process.stdout.write(`drive x=${cmd.x.toFixed(2)} y=${cmd.y.toFixed(2)} s=${cmd.s}\r`); break;
    case 'stop': cmd.x = cmd.y = 0; console.log('\nstop'); break;
    case 'horn': console.log('\nBEEP'); break;
    case 'lights': console.log(`\nlights ${msg.on ? 'ON' : 'OFF'}`); break;
    case 'ping': sock.write(frame(JSON.stringify({ t: 'pong', ts: msg.ts }) + '\n')); break;
    default: console.log('\nunknown message', text);
  }
}

// --- minimal RFC 6455 server ---
function frame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function parseFrames(sock, state) {
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (masked) off += 4;
    if (b.length < off + len) return;
    let data = b.slice(off, off + len);
    if (masked) { const m = b.slice(off - 4, off); data = Buffer.from(data.map((v, i) => v ^ m[i % 4])); }
    state.buf = b.slice(off + len);
    if (op === 0x8) { sock.end(Buffer.from([0x88, 0])); return; }
    if (op === 0x9) { sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
    if (op === 0x1 || op === 0x0) {
      state.text += data.toString();
      if (!fin) continue;
      let nl; while ((nl = state.text.indexOf('\n')) >= 0) { const line = state.text.slice(0, nl).trim(); state.text = state.text.slice(nl + 1); if (line) handle(sock, line); }
      if (state.text.trim() && !state.text.includes('\n')) { handle(sock, state.text.trim()); state.text = ''; }
    }
  }
}

net.createServer((sock) => {
  let pending = Buffer.alloc(0), upgraded = false;
  const state = { buf: Buffer.alloc(0), text: '' };
  sock.on('data', (chunk) => {
    if (upgraded) { state.buf = Buffer.concat([state.buf, chunk]); return parseFrames(sock, state); }
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf('\r\n\r\n'); if (end < 0) return;
    const head = pending.slice(0, end).toString();
    const key = /sec-websocket-key:\s*(.+)/i.exec(head)?.[1]?.trim();
    if (!key) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    upgraded = true; clients.add(sock); console.log(`client connected (${clients.size})`);
    state.buf = pending.slice(end + 4); parseFrames(sock, state);
  });
  const bye = () => { if (clients.delete(sock)) { console.log(`\nclient disconnected (${clients.size})`); if (!clients.size) { cmd.x = cmd.y = 0; } } };
  sock.on('close', bye); sock.on('error', bye);
}).listen(PORT, () => console.log(`mock car listening on ws://127.0.0.1:${PORT}  (Ctrl+C to stop)`));
