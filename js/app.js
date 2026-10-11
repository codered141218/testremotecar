import { createTransport } from './transport.js';
import { Tracker } from './tracker.js';

const $ = (id) => document.getElementById(id);
const els = {
  transportSelect: $('transportSelect'), wsUrl: $('wsUrl'), bleService: $('bleService'), serialBaud: $('serialBaud'),
  connectBtn: $('connectBtn'), statusText: $('statusText'), statusDot: $('statusDot'),
  dpad: $('dpad'), joystick: $('joystick'), joyKnob: $('joyKnob'), joyX: $('joyX'), joyY: $('joyY'),
  speed: $('speed'), speedVal: $('speedVal'),
  hornBtn: $('hornBtn'), lightsBtn: $('lightsBtn'), estopBtn: $('estopBtn'),
  trackCanvas: $('trackCanvas'), trackSource: $('trackSource'),
  stHeading: $('stHeading'), stSpeed: $('stSpeed'), stDist: $('stDist'), stPos: $('stPos'), stBatt: $('stBatt'), stLat: $('stLat'),
  resetTrackBtn: $('resetTrackBtn'), followBtn: $('followBtn'),
  log: $('log'), clearLogBtn: $('clearLogBtn'),
};

/* ---------------- state ---------------- */
let transport = null;
let seq = 0;
let lightsOn = false;
let battery = null, latency = null;
const input = { keys: new Set(), pad: null, joy: { x: 0, y: 0, active: false } };
const tracker = new Tracker(els.trackCanvas);

/* ---------------- logging ---------------- */
function log(line, kind = '') {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  const span = document.createElement('span');
  span.className = kind;
  span.textContent = `[${ts}] ${line}\n`;
  els.log.appendChild(span);
  while (els.log.childNodes.length > 300) els.log.removeChild(els.log.firstChild);
  els.log.scrollTop = els.log.scrollHeight;
}

/* ---------------- connection ---------------- */
function showTransportFields() {
  const kind = els.transportSelect.value;
  document.querySelectorAll('.field[data-for]').forEach((f) => f.classList.toggle('show', f.dataset.for === kind));
}
els.transportSelect.addEventListener('change', showTransportFields);
showTransportFields();

function setStatus(state, detail) {
  els.statusDot.className = 'brand-dot ' + state;
  els.statusText.textContent = state[0].toUpperCase() + state.slice(1) + (detail ? ` · ${detail}` : '');
  els.connectBtn.textContent = state === 'disconnected' ? 'Connect' : 'Disconnect';
  if (state === 'disconnected') { latency = null; battery = null; }
}

async function toggleConnection() {
  if (transport && transport.connected) { await transport.disconnect(); transport = null; return; }
  const kind = els.transportSelect.value;
  transport = createTransport(kind, {
    wsUrl: els.wsUrl.value.trim(),
    bleService: els.bleService.value.trim(),
    serialBaud: Number(els.serialBaud.value) || 115200,
  });
  transport.onStatus = (s, d) => { setStatus(s, d); log(`link: ${s} ${d}`); };
  transport.onLog = log;
  transport.onMessage = handleMessage;
  els.connectBtn.disabled = true;
  try { await transport.connect(); tracker.reset(); }
  catch (e) { log(`connect failed: ${e.message}`, 'err'); setStatus('disconnected', 'failed'); transport = null; }
  finally { els.connectBtn.disabled = false; }
}
els.connectBtn.addEventListener('click', toggleConnection);

function handleMessage(msg) {
  switch (msg.t) {
    case 'tel':
      tracker.applyTelemetry(msg);
      if (typeof msg.batt === 'number') battery = msg.batt;
      break;
    case 'pong':
      latency = Math.round(performance.now() - msg.ts);
      break;
    default:
      log(`rx ${JSON.stringify(msg)}`, 'rx');
  }
}

function send(obj, { quiet = false } = {}) {
  if (!transport?.connected) return;
  transport.send(obj);
  if (!quiet) log(`tx ${JSON.stringify(obj)}`, 'tx');
}

/* ---------------- input: keyboard ---------------- */
const KEYMAP = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (KEYMAP[k]) { input.keys.add(KEYMAP[k]); e.preventDefault(); }
  else if (k === ' ') { estop(); e.preventDefault(); }
  else if (k === 'h' && !e.repeat) horn();
  else if (k === 'l' && !e.repeat) toggleLights();
});
window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); if (KEYMAP[k]) input.keys.delete(KEYMAP[k]); });
window.addEventListener('blur', () => { input.keys.clear(); input.pad = null; });

/* ---------------- input: d-pad ---------------- */
els.dpad.querySelectorAll('.pad').forEach((btn) => {
  const dir = btn.dataset.dir;
  const down = (e) => { e.preventDefault(); if (dir === 'stop') return estop(); input.pad = dir; btn.classList.add('active'); };
  const up = () => { if (input.pad === dir) input.pad = null; btn.classList.remove('active'); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
});

/* ---------------- input: joystick ---------------- */
(() => {
  const el = els.joystick, knob = els.joyKnob;
  let pointerId = null;
  const radius = () => el.clientWidth / 2 - 32;
  const update = (clientX, clientY) => {
    const r = el.getBoundingClientRect();
    let dx = clientX - (r.left + r.width / 2), dy = clientY - (r.top + r.height / 2);
    const R = radius(), d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    input.joy = { x: +(dx / R).toFixed(2), y: +(-dy / R).toFixed(2), active: true };
  };
  const release = () => {
    pointerId = null; knob.style.transform = '';
    input.joy = { x: 0, y: 0, active: false };
  };
  el.addEventListener('pointerdown', (e) => { pointerId = e.pointerId; el.setPointerCapture(e.pointerId); update(e.clientX, e.clientY); });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === pointerId) update(e.clientX, e.clientY); });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
})();

/* ---------------- actions ---------------- */
els.speed.addEventListener('input', () => { els.speedVal.textContent = els.speed.value; });
function horn() { send({ t: 'horn' }); }
function toggleLights() { lightsOn = !lightsOn; els.lightsBtn.setAttribute('aria-pressed', String(lightsOn)); send({ t: 'lights', on: lightsOn }); }
function estop() {
  input.keys.clear(); input.pad = null; input.joy = { x: 0, y: 0, active: false };
  els.joyKnob.style.transform = '';
  send({ t: 'stop' });
}
els.hornBtn.addEventListener('click', horn);
els.lightsBtn.addEventListener('click', toggleLights);
els.estopBtn.addEventListener('click', estop);
els.resetTrackBtn.addEventListener('click', () => tracker.reset());
els.followBtn.addEventListener('click', () => {
  tracker.follow = !tracker.follow;
  els.followBtn.setAttribute('aria-pressed', String(tracker.follow));
});
els.clearLogBtn.addEventListener('click', () => { els.log.textContent = ''; });

/* ---------------- control loop: merge inputs, send at 20 Hz ---------------- */
function currentCommand() {
  let x = 0, y = 0;
  if (input.joy.active) { x = input.joy.x; y = input.joy.y; }
  else {
    const dirs = new Set(input.keys); if (input.pad) dirs.add(input.pad);
    if (dirs.has('up')) y += 1; if (dirs.has('down')) y -= 1;
    if (dirs.has('right')) x += 1; if (dirs.has('left')) x -= 1;
  }
  return { x, y, s: Number(els.speed.value) };
}

let lastSent = { x: 0, y: 0, s: 0 }, lastSendAt = 0, lastPing = 0;
setInterval(() => {
  const cmd = currentCommand();
  tracker.setCommand(cmd);
  els.joyX.textContent = cmd.x.toFixed(2); els.joyY.textContent = cmd.y.toFixed(2);
  if (!transport?.connected) return;
  const now = performance.now();
  const changed = cmd.x !== lastSent.x || cmd.y !== lastSent.y || cmd.s !== lastSent.s;
  const moving = cmd.x !== 0 || cmd.y !== 0;
  // Send on change, and keep-alive every 250 ms while moving so the car can fail-safe stop on silence.
  if (changed || (moving && now - lastSendAt > 250)) {
    send({ t: 'drive', ...cmd, seq: ++seq }, { quiet: !changed });
    lastSent = cmd; lastSendAt = now;
  }
  if (now - lastPing > 1000) { send({ t: 'ping', ts: now }, { quiet: true }); lastPing = now; }
}, 50);

/* ---------------- render loop ---------------- */
function render() {
  tracker.tick();
  tracker.draw();
  els.trackSource.textContent = tracker.source === 'telemetry' ? 'Live from car telemetry' : 'Estimated from commands';
  els.stHeading.textContent = Math.round(tracker.heading);
  els.stSpeed.textContent = Math.abs(tracker.speed).toFixed(2);
  els.stDist.textContent = tracker.distance.toFixed(1);
  els.stPos.textContent = `${tracker.pos.x.toFixed(1)}, ${tracker.pos.y.toFixed(1)}`;
  els.stBatt.textContent = battery == null ? '—' : `${Math.round(battery)}%`;
  els.stLat.textContent = latency == null ? '—' : `${latency} ms`;
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

log('Ready. Pick a link type and press Connect. Simulation works without any hardware.');
