/* ─────────────────────────────────────────────────────────────────────────
   UNDERTOW · client
   one pool, kept by the tide.

   Connects to ws(s)://<host>/ws speaking the protocol in DESIGN.md.
   If the water is unreachable, a local "simulacrum" breathes instead,
   so the page never looks broken — only lonelier.
   ───────────────────────────────────────────────────────────────────────── */

'use strict';

/* ── constants ─────────────────────────────────────────────────────────── */

const TICK_HZ = 6;
const DRIFT_SPEED = 140;            // world units / sec (matches server)
const REACH = 150;                  // how close we must be to plant / tend
const NOTE_FREQ = [146.83, 174.61, 196.00, 220.00, 261.63, 293.66, 349.23, 392.00];
const NOTE_HUE  = [172, 197, 224, 258, 292, 326, 18, 44];
const STAGE_NAME = ['a seed', 'a sprout', 'a frond', 'in bloom', 'withering', 'a husk'];

// stillness, if the visitor asked for it
const REDUCED_MOTION = !!(window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// small screens / low-power devices: keep the pool full, just lighter
const LOW_POWER =
  Math.min(window.innerWidth, window.innerHeight) < 700 ||
  (navigator.hardwareConcurrency || 4) <= 4;
const MOTE_CAP = LOW_POWER ? 130 : 260;
const TRAIL_LEN = LOW_POWER ? 8 : 14;

const DEFAULT_WORLD = {
  w: 1600, h: 1000, cx: 800, cy: 500, rx: 760, ry: 460,
  tidePeriod: 5400000, epoch: 1700000000000,
};

/* ── state ─────────────────────────────────────────────────────────────── */

const S = {
  connected: false,
  everConnected: false,
  sim: false,                       // simulacrum running?
  world: { ...DEFAULT_WORLD },
  tide: 0.5,
  me: null,                         // { id, soulTag, name, hue, kind, x, y, tx, ty }
  drifters: new Map(),              // id -> drifter
  flora: new Map(),                 // id -> flora
  echoes: [],                       // fading ghosts of the just-left
  effects: [],                      // pulses, song ripples, blooms
  motes: [],                        // local plankton
  soulsEver: null,
  pendingPlant: null,               // { word, x, y }
  pendingTend: null,                // flora id
  tendedByMe: new Map(),            // flora id -> timestamp (local cooldown memory)
  plantMode: false,
  hover: null,                      // hovered flora id
  soundOn: true,
  audioReady: false,
  hintsSeen: { move: false, pulse: false },
  lastPulseAt: 0,
  lastSingAt: 0,
  dreamLines: [],                   // last night's dream, murmured by the water
  dreamIx: 0,
  nextDreamAt: 0,
};

/* ── dom ───────────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const canvas = $('pool');
const ctx = canvas.getContext('2d');
const el = {
  veil: $('veil'), whisper: $('whisper'), hudTide: $('hud-tide'),
  hudSouls: $('hud-souls'), conn: $('conn'), connLabel: $('conn-label'),
  card: $('card'), cardWord: $('card-word'), cardMeta: $('card-meta'),
  cardTend: $('card-tend'), dock: document.getElementById('dock'),
  notefan: $('notefan'), plantbox: $('plantbox'), plantWord: $('plant-word'),
  namebox: $('namebox'), nameForm: $('nameform'), nameWord: $('name-word'),
  nameSkip: $('name-skip'), hint: $('hint'), offline: $('offline'),
  actPulse: $('act-pulse'), actSing: $('act-sing'), actPlant: $('act-plant'),
  actSound: $('act-sound'), icOn: $('ic-sound-on'), icOff: $('ic-sound-off'),
};

/* ── tiny utils ────────────────────────────────────────────────────────── */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
const TAU = Math.PI * 2;

function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inPool(x, y, w = S.world) {
  const dx = (x - w.cx) / w.rx, dy = (y - w.cy) / w.ry;
  return dx * dx + dy * dy <= 1;
}
function clampToPool(x, y, margin = 0.98) {
  const w = S.world;
  const dx = (x - w.cx) / w.rx, dy = (y - w.cy) / w.ry;
  const d = Math.hypot(dx, dy);
  if (d <= margin) return [x, y];
  return [w.cx + (dx / d) * margin * w.rx, w.cy + (dy / d) * margin * w.ry];
}

function tideNow() {
  const w = S.world;
  const ph = ((Date.now() - w.epoch) % w.tidePeriod) / w.tidePeriod;
  return { tide: 0.5 + 0.5 * Math.sin(TAU * ph), phase: ph,
           rising: Math.cos(TAU * ph) > 0,
           current: 22 * Math.cos(TAU * ph) };
}

function agoText(ms) {
  const s = Math.max(1, (Date.now() - ms) / 1000);
  if (s < 90) return 'moments ago';
  const m = s / 60; if (m < 90) return `${Math.round(m)} minutes ago`;
  const h = m / 60; if (h < 36) return `${Math.round(h)} hours ago`;
  const d = h / 24; if (d < 14) return `${Math.round(d)} days ago`;
  return 'long ago';
}

/* ── camera ────────────────────────────────────────────────────────────── */

const cam = { s: 1, ox: 0, oy: 0, W: 0, H: 0 };
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cam.W = window.innerWidth; cam.H = window.innerHeight;
  canvas.width = Math.round(cam.W * dpr);
  canvas.height = Math.round(cam.H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = S.world;
  cam.s = Math.min(cam.W / (w.rx * 2 * 1.10), cam.H / (w.ry * 2 * 1.22));
  cam.ox = cam.W / 2 - w.cx * cam.s;
  cam.oy = cam.H / 2 - w.cy * cam.s;
}
const w2sX = (x) => x * cam.s + cam.ox;
const w2sY = (y) => y * cam.s + cam.oy;
const s2wX = (px) => (px - cam.ox) / cam.s;
const s2wY = (py) => (py - cam.oy) / cam.s;
window.addEventListener('resize', resize);

/* ── audio ─────────────────────────────────────────────────────────────── */

const A = { ctx: null, master: null, droneGain: null, drone: [] };

function audioInit() {
  if (A.ctx || !S.soundOn) return;
  try {
    A.ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch { return; }
  A.master = A.ctx.createGain();
  A.master.gain.value = 0.0;
  A.master.connect(A.ctx.destination);
  // the drone: two detuned lows + filtered breath of noise
  A.droneGain = A.ctx.createGain();
  A.droneGain.gain.value = 0.05;
  A.droneGain.connect(A.master);
  for (const [f, det] of [[55, 0], [55, 2.7], [110, -1.4]]) {
    const o = A.ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = f; o.detune.value = det;
    const g = A.ctx.createGain(); g.gain.value = f > 60 ? 0.12 : 0.3;
    o.connect(g); g.connect(A.droneGain); o.start();
    A.drone.push(o);
  }
  const noiseBuf = A.ctx.createBuffer(1, A.ctx.sampleRate * 2, A.ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const noise = A.ctx.createBufferSource();
  noise.buffer = noiseBuf; noise.loop = true;
  const nf = A.ctx.createBiquadFilter();
  nf.type = 'lowpass'; nf.frequency.value = 220; nf.Q.value = 0.4;
  const ng = A.ctx.createGain(); ng.gain.value = 0.05;
  noise.connect(nf); nf.connect(ng); ng.connect(A.droneGain); noise.start();
  A.noiseFilter = nf;
  A.master.gain.setTargetAtTime(0.9, A.ctx.currentTime, 3);
  S.audioReady = true;
}

function audioTide(tide) {
  if (!A.ctx) return;
  // higher tide, fuller water
  A.droneGain.gain.setTargetAtTime(0.035 + tide * 0.045, A.ctx.currentTime, 2);
  if (A.noiseFilter) A.noiseFilter.frequency.setTargetAtTime(160 + tide * 260, A.ctx.currentTime, 2);
}

function pan(x) {
  return clamp((x / S.world.w) * 2 - 1, -0.9, 0.9) * 0.7;
}

function playNote(note, x, quiet) {
  if (!A.ctx || !S.soundOn) return;
  const t = A.ctx.currentTime;
  const o = A.ctx.createOscillator();
  o.type = 'sine'; o.frequency.value = NOTE_FREQ[note] * 2;
  const o2 = A.ctx.createOscillator();
  o2.type = 'triangle'; o2.frequency.value = NOTE_FREQ[note]; o2.detune.value = 4;
  const g = A.ctx.createGain();
  const peak = quiet ? 0.10 : 0.17;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
  const p = A.ctx.createStereoPanner ? A.ctx.createStereoPanner() : null;
  const dest = p || g;
  if (p) { p.pan.value = pan(x); g.connect(p); p.connect(A.master); }
  else g.connect(A.master);
  o.connect(g); o2.connect(g);
  o.start(t); o2.start(t); o.stop(t + 3.4); o2.stop(t + 3.4);
}

function playPulse(x, quiet) {
  if (!A.ctx || !S.soundOn) return;
  const t = A.ctx.currentTime;
  const o = A.ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(220, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.9);
  const g = A.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(quiet ? 0.06 : 0.12, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
  const p = A.ctx.createStereoPanner ? A.ctx.createStereoPanner() : null;
  if (p) { p.pan.value = pan(x); g.connect(p); p.connect(A.master); }
  else g.connect(A.master);
  o.connect(g); o.start(t); o.stop(t + 1.5);
}

function playBloomBell(x, hue) {
  // a single gentle bell for a plant reaching bloom — one pentatonic tone,
  // chosen by the plant's own hue, panned to where it grows
  if (!A.ctx || !S.soundOn) return;
  const t = A.ctx.currentTime;
  const f = NOTE_FREQ[Math.round(((hue % 360) + 360) / 45) % 8] * 4;
  const g = A.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.055, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
  const p = A.ctx.createStereoPanner ? A.ctx.createStereoPanner() : null;
  if (p) { p.pan.value = pan(x); g.connect(p); p.connect(A.master); }
  else g.connect(A.master);
  const o = A.ctx.createOscillator();
  o.type = 'sine'; o.frequency.value = f;
  const o2 = A.ctx.createOscillator();          // faintly inharmonic shimmer
  o2.type = 'sine'; o2.frequency.value = f * 2.01;
  const g2 = A.ctx.createGain(); g2.gain.value = 0.35;
  o.connect(g); o2.connect(g2); g2.connect(g);
  o.start(t); o2.start(t); o.stop(t + 3.8); o2.stop(t + 3.8);
}

function playChime() { // growth / arrival sparkle
  if (!A.ctx || !S.soundOn) return;
  const t = A.ctx.currentTime;
  [523.25, 659.25, 783.99].forEach((f, i) => {
    const o = A.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, t + i * 0.12);
    g.gain.linearRampToValueAtTime(0.05, t + i * 0.12 + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 1.8);
    o.connect(g); g.connect(A.master);
    o.start(t + i * 0.12); o.stop(t + i * 0.12 + 2);
  });
}

function playChord(note, x) {
  // the pool answers a chorus: a soft chord stacked up the same pentatonic
  // scale the singers used, swelling in slowly and letting go even slower
  if (!A.ctx || !S.soundOn) return;
  const t = A.ctx.currentTime;
  const root = clamp(Math.trunc(note) || 0, 0, 7);
  const p = A.ctx.createStereoPanner ? A.ctx.createStereoPanner() : null;
  const bus = A.ctx.createGain(); bus.gain.value = 1;
  if (p) { p.pan.value = pan(x) * 0.5; bus.connect(p); p.connect(A.master); }
  else bus.connect(A.master);
  [0, 2, 4].forEach((step, i) => {
    const f = NOTE_FREQ[(root + step) % 8] * (root + step >= 8 ? 2 : 1);
    const o = A.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const o2 = A.ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f; o2.detune.value = 3;
    const g = A.ctx.createGain();
    const at = t + i * 0.22;                        // voices arrive one by one
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.05, at + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 5.5);
    const g2 = A.ctx.createGain(); g2.gain.value = 0.4;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(bus);
    o.start(at); o2.start(at); o.stop(at + 6); o2.stop(at + 6);
  });
  const ob = A.ctx.createOscillator();              // a low root beneath it all
  ob.type = 'sine'; ob.frequency.value = NOTE_FREQ[root] / 2;
  const gb = A.ctx.createGain();
  gb.gain.setValueAtTime(0, t);
  gb.gain.linearRampToValueAtTime(0.035, t + 0.8);
  gb.gain.exponentialRampToValueAtTime(0.0001, t + 6);
  ob.connect(gb); gb.connect(bus); ob.start(t); ob.stop(t + 6.5);
}

/* ── networking ────────────────────────────────────────────────────────── */

let ws = null;
let backoff = 1000;
let simTimer = null;

function soulToken() {
  try { return localStorage.getItem('undertow.soul') || undefined; }
  catch { return undefined; }
}
function saveSoul(s) {
  try { localStorage.setItem('undertow.soul', s); } catch { /* private mode */ }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch { onDisconnected(); return; }

  ws.onopen = () => {
    backoff = 1000;
    send({ t: 'hello', soul: soulToken() });
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => { ws = null; onDisconnected(); };
  ws.onerror = () => { /* close will follow */ };
}

function onDisconnected() {
  if (S.connected) {
    S.connected = false;
    setConnLamp(false);
  }
  startSimulacrum();
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 15000);
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

setInterval(() => send({ t: 'ping' }), 25000);

/* ── message handling ──────────────────────────────────────────────────── */

function handle(m) {
  switch (m.t) {
    case 'welcome': onWelcome(m); break;
    case 'tick': onTick(m); break;
    case 'err': flashHint(m.msg || 'the water refuses'); break;
    case 'pong': break;
  }
}

function onWelcome(m) {
  stopSimulacrum();
  S.connected = true;
  S.everConnected = true;
  setConnLamp(true);
  el.offline.hidden = true;

  if (m.world) S.world = { ...S.world, ...m.world };
  resize();
  S.tide = m.tide ?? S.tide;
  if (m.you?.soul) saveSoul(m.you.soul);

  S.drifters.clear(); S.flora.clear();
  S.echoes = []; S.effects = [];

  S.me = {
    id: m.you.id, soulTag: m.you.soulTag || null,
    name: m.you.name || '', hue: m.you.hue ?? 170, kind: m.you.kind || 'visitor',
    x: S.world.cx, y: S.world.cy + S.world.ry * 0.45,
    tx: S.world.cx, ty: S.world.cy + S.world.ry * 0.45,
    trail: [], vx: 0, vy: 0,
  };

  for (const d of m.drifters || []) {
    if (d.id === S.me.id) { S.me.x = S.me.tx = d.x; S.me.y = S.me.ty = d.y; continue; }
    addDrifter(d);
  }
  for (const f of m.flora || []) addFlora(f);
  for (const e of m.echoes || []) S.echoes.push({ ...e });
  S.soulsEver = m.souls?.ever ?? null;

  // keep last night's dream — the water will murmur it, a line at a time
  S.dreamLines = (m.dream || []).filter(Boolean);
  S.dreamIx = 0;
  S.nextDreamAt = 0;

  spawnMotes();
  showWhisper(m.whisper || []);
  maybeAskName(m.you);
  updateHud();
}

function onTick(m) {
  S.tide = m.tide ?? S.tide;
  const seen = new Set();
  for (const [id, x, y] of m.d || []) {
    seen.add(id);
    if (S.me && id === S.me.id) {
      // gentle server reconciliation — trust local feel, correct drift
      if (dist(S.me.x, S.me.y, x, y) > 220) { S.me.x = x; S.me.y = y; }
      else { S.me.x = lerp(S.me.x, x, 0.02); S.me.y = lerp(S.me.y, y, 0.02); }
      continue;
    }
    const d = S.drifters.get(id);
    if (d) { d.tx = x; d.ty = y; }
  }
  // remove drifters the server no longer lists (missed part event)
  for (const id of S.drifters.keys()) {
    if (!seen.has(id)) S.drifters.delete(id);
  }
  for (const ev of m.ev || []) onEvent(ev);
  updateHud();
}

function onEvent(ev) {
  const mine = S.me && ev.id === S.me.id;
  switch (ev.e) {
    case 'pulse':
      if (!mine) {
        spawnPulse(ev.x, ev.y, ev.hue); playPulse(ev.x, true);
        nudgeSelf(ev.x, ev.y);   // the ripple shoves you too, softly
      }
      break;
    case 'sing':
      if (!mine) {
        spawnSong(ev.x, ev.y, ev.note, ev.hue); playNote(ev.note, ev.x, true);
        noteSing(ev.id, ev.x, ev.y, ev.hue);
      }
      break;
    case 'join':
      if (ev.d && (!S.me || ev.d.id !== S.me.id)) {
        addDrifter(ev.d);
        spawnRipple(ev.d.x, ev.d.y, ev.d.hue, 0.5);
      }
      break;
    case 'part': {
      S.drifters.delete(ev.id);
      if (ev.echo) S.echoes.push({ ...ev.echo });
      if (S.echoes.length > 12) S.echoes.shift();
      break;
    }
    case 'plant':
      if (ev.f) { addFlora(ev.f); spawnRipple(ev.f.x, ev.f.y, ev.f.hue, 0.8); }
      break;
    case 'grow': {
      const f = S.flora.get(ev.id);
      if (f) { f.stage = ev.stage; f.growFlash = performance.now();
               if (ev.stage === 3) { spawnBloom(f.x, f.y, f.hue); playBloomBell(f.x, f.hue); } }
      break;
    }
    case 'wither': { const f = S.flora.get(ev.id); if (f) f.stage = 4; break; }
    case 'husk':   { const f = S.flora.get(ev.id); if (f) f.stage = 5; break; }
    case 'gone':   S.flora.delete(ev.id); break;
    case 'revive': {
      const f = S.flora.get(ev.id);
      if (f) { f.stage = ev.stage; f.growFlash = performance.now();
               if (ev.stage === 3) { spawnBloom(f.x, f.y, f.hue); playBloomBell(f.x, f.hue); }
               else { spawnRipple(f.x, f.y, f.hue, 1); playChime(); } }
      break;
    }
    case 'tend': {
      const f = S.flora.get(ev.id);
      if (f) { f.nourish = ev.nourish ?? f.nourish; f.tendFlash = performance.now();
               spawnRipple(f.x, f.y, f.hue, 0.4); }
      break;
    }
    case 'rename': {
      if (mine) S.me.name = ev.name;
      else { const d = S.drifters.get(ev.id); if (d) d.name = ev.name; }
      break;
    }
    case 'tide':
      flashHint(ev.dir === 'high' ? 'high water' : 'the tide is at its lowest');
      break;
    case 'chorus':
      // three or more voices found each other — the whole pool sings back
      spawnChorus(ev.x, ev.y, ev.count);
      playChord(ev.note ?? 0, ev.x);
      flashHint('the pool sings back');
      break;
    case 'communal': {
      // a plant surged, raised by many hands
      const f = S.flora.get(ev.id);
      const cx = ev.x ?? f?.x, cy = ev.y ?? f?.y;
      if (f) { f.radiantUntil = performance.now() + 60000; f.growFlash = performance.now(); }
      if (cx != null && cy != null) {
        spawnCommunal(cx, cy, ev.hue ?? f?.hue ?? 170, ev.hands);
        playChime();
        playNote(Math.round((((ev.hue ?? 170) % 360) + 360) / 45) % 8, cx, true);
      }
      flashHint('raised by many hands');
      break;
    }
  }
}

/* the ripple of a nearby pulse gives you a gentle outward shove — mirroring
   the server's nudge so it is felt at once, not a beat later */
function nudgeSelf(px, py) {
  if (!S.me || S.sim) return;
  let dx = S.me.x - px, dy = S.me.y - py, d = Math.hypot(dx, dy);
  if (d > 200) return;
  if (d < 1) { const a = Math.random() * TAU; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
  const mag = 48 * (1 - d / 200);
  const ux = dx / d, uy = dy / d;
  [S.me.x, S.me.y] = clampToPool(S.me.x + ux * mag * 0.45, S.me.y + uy * mag * 0.45);
  [S.me.tx, S.me.ty] = clampToPool(S.me.tx + ux * mag, S.me.ty + uy * mag);
}

function addDrifter(d) {
  S.drifters.set(d.id, {
    ...d, tx: d.x, ty: d.y, trail: [], sway: Math.random() * TAU,
  });
}
function addFlora(f) {
  S.flora.set(f.id, { ...f, phase: Math.random() * TAU, growFlash: 0, tendFlash: 0 });
}

function setConnLamp(on) {
  el.conn.classList.toggle('off', !on);
  el.connLabel.textContent = on ? 'in the water' : 'adrift';
}

/* ── the simulacrum (offline fallback) ─────────────────────────────────── */

function startSimulacrum() {
  if (S.sim) return;
  S.sim = true;
  el.offline.hidden = false;
  S.world = { ...DEFAULT_WORLD };
  resize();
  S.drifters.clear(); S.flora.clear(); S.echoes = [];
  if (!S.me) {
    S.me = { id: 'me', soulTag: null, name: '', hue: 170, kind: 'visitor',
             x: 800, y: 700, tx: 800, ty: 700, trail: [] };
  }
  // even the memory of the pool murmurs — a single borrowed dream-line
  S.dreamLines = ['somewhere, the real pool is still breathing.'];
  S.dreamIx = 0; S.nextDreamAt = 0;
  const ghosts = [
    { id: '~fern', name: 'fern', hue: 120, kind: 'visitor', x: 600, y: 380 },
    { id: '~moss', name: 'moss', hue: 275, kind: 'agent', x: 1050, y: 520 },
  ];
  for (const g of ghosts) addDrifter(g);
  const words = [
    ['patience', 520, 640, 165, 3], ['ember', 980, 690, 20, 2],
    ['hush', 720, 330, 210, 1], ['salt', 1180, 420, 45, 2],
    ['wane', 420, 450, 290, 4], ['driftwood', 860, 560, 95, 0],
  ];
  const now = Date.now();
  words.forEach(([word, x, y, hue, stage], i) => addFlora({
    id: 'sim' + i, word, x, y, hue, stage, nourish: 1.5,
    plantedAt: now - (i + 1) * 8.64e7, planter: i % 2 ? 'fern' : 'someone', soulTag: '~',
  }));
  spawnMotes();
  simTimer = setInterval(simStep, 1400);
  updateHud();
}

function stopSimulacrum() {
  if (!S.sim) return;
  S.sim = false;
  clearInterval(simTimer); simTimer = null;
}

function simStep() {
  for (const d of S.drifters.values()) {
    if (Math.random() < 0.4) {
      const a = Math.random() * TAU, r = 120 + Math.random() * 240;
      [d.tx, d.ty] = clampToPool(d.x + Math.cos(a) * r, d.y + Math.sin(a) * r);
    }
    if (Math.random() < 0.10) { spawnPulse(d.x, d.y, d.hue); playPulse(d.x, true); }
    if (Math.random() < 0.06) {
      const n = Math.floor(Math.random() * 8);
      spawnSong(d.x, d.y, n, d.hue); playNote(n, d.x, true);
      noteSing(d.id, d.x, d.y, d.hue);
    }
  }
}

/* ── motes ─────────────────────────────────────────────────────────────── */

function spawnMotes() {
  S.motes = [];
  const n = LOW_POWER
    ? Math.min(90, Math.floor((cam.W * cam.H) / 13000))
    : Math.min(170, Math.floor((cam.W * cam.H) / 7000));
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, r = Math.sqrt(Math.random());
    S.motes.push({
      x: S.world.cx + Math.cos(a) * r * S.world.rx * 0.96,
      y: S.world.cy + Math.sin(a) * r * S.world.ry * 0.96,
      vx: 0, vy: 0,
      tw: Math.random() * TAU,             // twinkle phase
      sz: 0.7 + Math.random() * 1.5,
      hue: 168 + Math.random() * 40,
    });
  }
}

function exciteMotes(x, y, power) {
  for (const m of S.motes) {
    const d = dist(m.x, m.y, x, y);
    if (d < 260 && d > 1) {
      const f = (1 - d / 260) * power;
      m.vx += ((x - m.x) / d) * f * 60;
      m.vy += ((y - m.y) / d) * f * 60;
    }
  }
}

/* ── effects ───────────────────────────────────────────────────────────── */

function spawnPulse(x, y, hue) {
  S.effects.push({ kind: 'pulse', x, y, hue, t0: performance.now(), life: 1800 });
  exciteMotes(x, y, 1);
}
function spawnSong(x, y, note, hue) {
  S.effects.push({ kind: 'song', x, y, note, hue: NOTE_HUE[note] ?? hue,
                   t0: performance.now(), life: 3200 });
  exciteMotes(x, y, 0.4);
}
function spawnRipple(x, y, hue, power) {
  S.effects.push({ kind: 'ripple', x, y, hue, t0: performance.now(), life: 1400 + power * 800 });
  exciteMotes(x, y, power * 0.5);
}
function spawnBloom(x, y, hue) {
  // a plant has reached bloom — a shared flourish everyone sees together,
  // driven by the server's grow event, never faked locally
  const spores = [];
  if (!REDUCED_MOTION) {
    const n = LOW_POWER ? 4 : 7;
    for (let i = 0; i < n; i++) {
      spores.push({
        dx: (Math.random() - 0.5) * 70,
        rise: 60 + Math.random() * 70,
        delay: Math.random() * 0.35,
        sz: 1.2 + Math.random() * 1.6,
      });
    }
    exciteMotes(x, y, 0.7);
  }
  S.effects.push({
    kind: 'bloom', x, y, hue, spores,
    t0: performance.now(),
    life: REDUCED_MOTION ? 1100 : 1600,
  });
}

function spawnChorus(x, y, count) {
  // the pool answering a chorus: one swelling shimmer, shared by everyone
  S.effects.push({
    kind: 'chorus', x, y, count: count || 3,
    t0: performance.now(), life: REDUCED_MOTION ? 3200 : 5200,
  });
  exciteMotes(x, y, REDUCED_MOTION ? 0.6 : 1.5);
}

function spawnCommunal(x, y, hue, hands) {
  // a bloom raised by many hands: light gathers in a ring, then lifts
  const n = clamp(hands || 3, 3, 8);
  const sparks = [];
  if (!REDUCED_MOTION) {
    const m = LOW_POWER ? n : n * 2;
    for (let i = 0; i < m; i++) {
      sparks.push({
        a: (i / m) * TAU + Math.random() * 0.4,
        r0: 26 + Math.random() * 20,
        rise: 80 + Math.random() * 90,
        delay: Math.random() * 0.4,
        sz: 1.1 + Math.random() * 1.7,
      });
    }
    exciteMotes(x, y, 1.2);
  }
  S.effects.push({
    kind: 'communal', x, y, hue, hands: n, sparks,
    t0: performance.now(), life: REDUCED_MOTION ? 2200 : 4200,
  });
}

/* ── song threads ──────────────────────────────────────────────────────────
   "answer a song to converse", the invitation says — so an answered song
   should look like an answer. When one drifter sings within a breath of
   another, a filament of light joins the two singers for a moment.        */

const recentSings = [];              // { id, x, y, hue, at }

function noteSing(id, x, y, hue) {
  const t = performance.now();
  for (const s of recentSings) {
    if (s.id !== id && t - s.at < 6000) spawnThread(s.x, s.y, s.hue, x, y, hue);
  }
  const i = recentSings.findIndex((s) => s.id === id);
  if (i >= 0) recentSings.splice(i, 1);
  recentSings.push({ id, x, y, hue, at: t });
  while (recentSings.length && (recentSings.length > 12 || t - recentSings[0].at > 12000)) {
    recentSings.shift();
  }
}

function spawnThread(x1, y1, hue1, x2, y2, hue2) {
  S.effects.push({
    kind: 'thread', x: x1, y: y1, x2, y2, hue: hue1, hue2,
    t0: performance.now(), life: REDUCED_MOTION ? 2400 : 3400,
  });
  exciteMotes((x1 + x2) / 2, (y1 + y2) / 2, 0.3);
}

/* ── bioluminescent wake ───────────────────────────────────────────────────
   The pool's namesake: disturbed water glows. Anything that swims — you,
   a stranger, a keeper — parts the plankton and leaves a stirred shimmer. */

function wake(d) {
  const sp = Math.hypot(d.vx || 0, d.vy || 0);
  if (sp < 34) return;                               // idle sway doesn't stir
  const t = performance.now();
  if (d.lastWake && t - d.lastWake < (LOW_POWER ? 170 : 90)) return;
  d.lastWake = t;
  let power = clamp(sp / DRIFT_SPEED, 0, 1);
  if (REDUCED_MOTION) power *= 0.5;
  for (const m of S.motes) {
    const dd = dist(m.x, m.y, d.x, d.y);
    if (dd < 90 && dd > 1) {
      const f = (1 - dd / 90) * power;
      // push outward, so the water parts around the swimmer and lights up
      m.vx += ((m.x - d.x) / dd) * f * 34;
      m.vy += ((m.y - d.y) / dd) * f * 34;
    }
  }
}

/* ── the dream, murmured ───────────────────────────────────────────────────
   Each night the pool weaves the day's words into a dream, kept forever.
   It shouldn't live only on /chronicle: every so often a line of it
   surfaces in the deep water, drifts, and dissolves.                      */

function splitDreamLine(text) {
  if (text.length <= 44) return [text];
  const mid = Math.floor(text.length / 2);
  let cut = text.lastIndexOf(' ', mid);
  if (cut < 12) cut = text.indexOf(' ', mid);
  if (cut < 0) return [text];
  return [text.slice(0, cut), text.slice(cut + 1)];
}

function maybeSurfaceDream(pn) {
  if (!S.dreamLines.length) return;
  if (!S.nextDreamAt) { S.nextDreamAt = pn + 45000 + Math.random() * 30000; return; }
  if (pn < S.nextDreamAt) return;
  S.nextDreamAt = pn + 150000 + Math.random() * 120000;   // every 2.5–4.5 min
  const text = S.dreamLines[S.dreamIx % S.dreamLines.length];
  S.dreamIx += 1;
  const w = S.world;
  const x = w.cx + (Math.random() - 0.5) * w.rx * 0.55;
  const y = w.cy - w.ry * (0.05 + Math.random() * 0.3);
  S.effects.push({
    kind: 'dream', x, y, lines: splitDreamLine(text),
    t0: pn, life: REDUCED_MOTION ? 12000 : 16000,
  });
}

/* ── actions ───────────────────────────────────────────────────────────── */

function actMove(wx, wy) {
  if (!S.me) return;
  [wx, wy] = clampToPool(wx, wy);
  S.me.tx = wx; S.me.ty = wy;
  send({ t: 'move', x: Math.round(wx * 10) / 10, y: Math.round(wy * 10) / 10 });
  if (!S.hintsSeen.move) { S.hintsSeen.move = true; setTimeout(() => hintOnce('pulse'), 7000); }
}

function actPulse() {
  const now = performance.now();
  if (!S.me || now - S.lastPulseAt < 1000) return;
  S.lastPulseAt = now;
  spawnPulse(S.me.x, S.me.y, S.me.hue);
  playPulse(S.me.x, false);
  send({ t: 'pulse' });
  S.hintsSeen.pulse = true;
}

function actSing(note) {
  const now = performance.now();
  if (!S.me || now - S.lastSingAt < 1500) return;
  S.lastSingAt = now;
  spawnSong(S.me.x, S.me.y, note, S.me.hue);
  playNote(note, S.me.x, false);
  noteSing(S.me.id, S.me.x, S.me.y, S.me.hue);
  send({ t: 'sing', note });
}

function actPlant(word, wx, wy) {
  [wx, wy] = clampToPool(wx, wy, 0.92);
  if (dist(S.me.x, S.me.y, wx, wy) > REACH) {
    S.pendingPlant = { word, x: wx, y: wy };
    actMove(wx, wy);
    flashHint('drifting closer…');
    return;
  }
  send({ t: 'plant', word, x: Math.round(wx), y: Math.round(wy) });
  if (S.sim) {
    addFlora({ id: 'local' + Date.now(), word, x: wx, y: wy, hue: S.me.hue,
               stage: 0, nourish: 1, plantedAt: Date.now(), planter: S.me.name || 'you',
               soulTag: 'me', mine: true });
  }
  spawnRipple(wx, wy, S.me.hue, 0.8);
  flashHint(`'${word}' is in the water now`);
}

function actTend(id) {
  const f = S.flora.get(id);
  if (!f || !S.me) return;
  if (dist(S.me.x, S.me.y, f.x, f.y) > REACH) {
    S.pendingTend = id;
    actMove(f.x, f.y);
    flashHint('drifting closer…');
    return;
  }
  send({ t: 'tend', id });
  S.tendedByMe.set(id, Date.now());
  f.tendFlash = performance.now();
  spawnRipple(f.x, f.y, f.hue, 0.4);
  hideCard();
}

/* ── input ─────────────────────────────────────────────────────────────── */

let pressTimer = null;
let pressAt = null;
let pulseHeld = false;

canvas.addEventListener('pointerdown', (e) => {
  audioInit();
  if (A.ctx?.state === 'suspended') A.ctx.resume();
  pressAt = { x: e.clientX, y: e.clientY };
  pulseHeld = false;
  pressTimer = setTimeout(() => { pulseHeld = true; actPulse(); }, 380);
});

canvas.addEventListener('pointerup', (e) => {
  clearTimeout(pressTimer);
  if (pulseHeld || !pressAt) { pressAt = null; return; }
  const wx = s2wX(e.clientX), wy = s2wY(e.clientY);
  pressAt = null;

  // plant mode: this touch places the seed
  if (S.plantMode) {
    const word = cleanWord(el.plantWord.value);
    if (word) { exitPlantMode(); actPlant(word, wx, wy); }
    else flashHint('give it one word first');
    return;
  }

  // touching a plant?
  const f = floraAt(wx, wy);
  if (f) { showCard(f); return; }
  hideCard();
  if (!inPool(wx, wy)) return;
  actMove(wx, wy);
});

canvas.addEventListener('pointermove', (e) => {
  if (pressAt && dist(pressAt.x, pressAt.y, e.clientX, e.clientY) > 12) {
    clearTimeout(pressTimer); // it's a drag, not a hold
    if (!pulseHeld) { actMove(s2wX(e.clientX), s2wY(e.clientY)); pressAt = { x: e.clientX, y: e.clientY }; }
  }
  const f = floraAt(s2wX(e.clientX), s2wY(e.clientY));
  S.hover = f ? f.id : null;
  canvas.style.cursor = f ? 'pointer' : 'crosshair';
});

canvas.addEventListener('pointercancel', () => { clearTimeout(pressTimer); pressAt = null; });

function floraAt(wx, wy) {
  let best = null, bestD = Math.max(40, 30 / cam.s);   // generous touch target
  for (const f of S.flora.values()) {
    const d = dist(wx, wy, f.x, f.y - 20);
    if (d < bestD) { best = f; bestD = d; }
  }
  return best;
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') {
    if (e.key === 'Escape') { exitPlantMode(); hideNamebox(); e.target.blur(); }
    return;
  }
  audioInit();
  if (e.code === 'Space') { e.preventDefault(); actPulse(); }
  else if (e.key >= '1' && e.key <= '8') actSing(Number(e.key) - 1);
  else if (e.key === 'p') enterPlantMode();
  else if (e.key === 'Escape') { exitPlantMode(); hideCard(); el.notefan.hidden = true; }
});

/* ── ui: dock, notefan, plantbox, card, name ───────────────────────────── */

el.actPulse.addEventListener('click', () => { audioInit(); actPulse(); });

el.actSing.addEventListener('click', () => {
  audioInit();
  el.notefan.hidden = !el.notefan.hidden;
  exitPlantMode();
  el.actSing.classList.toggle('lit', !el.notefan.hidden);
});

document.querySelectorAll('.note').forEach((b) => {
  const n = Number(b.dataset.note);
  b.style.setProperty('--note-c', `hsla(${NOTE_HUE[n]}, 80%, 62%, .45)`);
  b.addEventListener('click', () => actSing(n));
});

el.actPlant.addEventListener('click', () => {
  audioInit();
  if (S.plantMode) exitPlantMode(); else enterPlantMode();
});

function enterPlantMode() {
  S.plantMode = true;
  el.plantbox.hidden = false;
  el.notefan.hidden = true;
  el.actSing.classList.remove('lit');
  el.actPlant.classList.add('lit');
  el.plantWord.value = '';
  el.plantWord.focus();
}
function exitPlantMode() {
  S.plantMode = false;
  el.plantbox.hidden = true;
  el.actPlant.classList.remove('lit');
}
el.plantWord.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.plantWord.blur(); flashHint('now touch the water'); }
});

// note: the icons are SVG elements — they lack the HTMLElement.hidden
// property, so toggle the attribute (backed by the [hidden] CSS rule).
function reflectSoundIcon() {
  if (S.soundOn) { el.icOn.removeAttribute('hidden'); el.icOff.setAttribute('hidden', ''); }
  else { el.icOn.setAttribute('hidden', ''); el.icOff.removeAttribute('hidden'); }
}
el.actSound.addEventListener('click', () => {
  S.soundOn = !S.soundOn;
  reflectSoundIcon();
  if (S.soundOn) { audioInit(); if (A.ctx?.state === 'suspended') A.ctx.resume(); if (A.master) A.master.gain.setTargetAtTime(0.9, A.ctx.currentTime, 1); }
  else if (A.master) A.master.gain.setTargetAtTime(0, A.ctx.currentTime, 0.3);
});
reflectSoundIcon();

function cleanWord(v) {
  const w = (v || '').trim().toLowerCase().split(/\s+/)[0] || '';
  return /^[\p{L}'-]{1,16}$/u.test(w) ? w : '';
}

let cardFloraId = null;
function showCard(f) {
  cardFloraId = f.id;
  el.cardWord.textContent = `'${f.word}'`;
  const mine = f.mine || (S.me?.soulTag && f.soulTag === S.me.soulTag);
  const who = mine ? 'you' : (f.planter || 'someone');
  el.cardMeta.textContent =
    `planted by ${who} ${agoText(f.plantedAt)} · ${STAGE_NAME[f.stage] || ''}`;
  const cooled = (Date.now() - (S.tendedByMe.get(f.id) || 0)) > 3600e3;
  const tendable = f.stage < 5 && cooled;
  el.cardTend.disabled = !tendable;
  el.cardTend.textContent = f.stage === 5 ? 'beyond tending'
    : (!cooled ? 'tended' : (f.stage === 4 ? 'revive' : 'tend'));
  el.card.style.left = `${w2sX(f.x)}px`;
  el.card.style.top = `${w2sY(f.y - 30)}px`;
  el.card.hidden = false;
}
function hideCard() { el.card.hidden = true; cardFloraId = null; }
el.cardTend.addEventListener('click', () => { if (cardFloraId) actTend(cardFloraId); });

function maybeAskName(you) {
  if (you.name) return;
  let skipped = false;
  try { skipped = localStorage.getItem('undertow.nameless') === '1'; } catch {}
  if (skipped) return;
  setTimeout(() => { if (S.me && !S.me.name) el.namebox.hidden = false; }, 9000);
}
el.nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const w = cleanWord(el.nameWord.value);
  if (!w) { el.nameWord.value = ''; el.nameWord.placeholder = 'just one word'; return; }
  send({ t: 'name', word: w });
  if (S.me) S.me.name = w;
  hideNamebox();
  flashHint(`the pool will remember ${w}`);
});
el.nameSkip.addEventListener('click', () => {
  try { localStorage.setItem('undertow.nameless', '1'); } catch {}
  hideNamebox();
});
function hideNamebox() { el.namebox.hidden = true; }

/* ── whisper + hints + hud ─────────────────────────────────────────────── */

function showWhisper(lines) {
  el.whisper.innerHTML = '';
  lines.slice(0, 4).forEach((text, i) => {
    const div = document.createElement('div');
    div.className = 'whisper-line';
    div.textContent = text;
    el.whisper.appendChild(div);
    setTimeout(() => div.classList.add('on'), 1600 + i * 2100);
    setTimeout(() => div.classList.add('gone'), 1600 + i * 2100 + 9000);
  });
  const total = 1600 + lines.length * 2100 + 13000;
  setTimeout(() => { if (el.whisper.children.length) el.whisper.innerHTML = ''; }, total);
}

let hintTimer = null;
function flashHint(text) {
  el.hint.textContent = text;
  el.hint.classList.add('on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.hint.classList.remove('on'), 3600);
}
function hintOnce(kind) {
  if (S.hintsSeen[kind]) return;
  S.hintsSeen[kind] = true;
  if (kind === 'pulse') flashHint('hold, to pulse light into the water');
}
setTimeout(() => { if (!S.hintsSeen.move) flashHint('touch the water, and drift'); }, 6000);

function updateHud() {
  const { rising } = tideNow();
  const t = S.tide;
  let tideText;
  if (t > 0.85) tideText = 'high water';
  else if (t < 0.15) tideText = 'low water';
  else tideText = rising ? 'the tide is rising' : 'the tide is going out';
  el.hudTide.textContent = tideText;

  const here = S.drifters.size + (S.me ? 1 : 0);
  const keeper = [...S.drifters.values()].some((d) => d.kind === 'agent');
  let s = here === 1 ? 'you drift alone' : `${here} adrift`;
  if (keeper) s += ' · a keeper is here';
  if (S.soulsEver != null) s += ` · ${S.soulsEver} have passed through`;
  el.hudSouls.textContent = s;
}

/* ── simulation of local motion (every frame) ──────────────────────────── */

function stepLocal(dt) {
  const { current } = tideNow();
  const curDx = current * dt;

  // me
  if (S.me) stepDrifter(S.me, dt, curDx, true);

  // others: interpolate toward server pos
  for (const d of S.drifters.values()) {
    const px = d.x, py = d.y;
    d.x = lerp(d.x, d.tx, 1 - Math.pow(0.0018, dt));
    d.y = lerp(d.y, d.ty, 1 - Math.pow(0.0018, dt));
    if (dt > 0) { d.vx = (d.x - px) / dt; d.vy = (d.y - py) / dt; }
    wake(d);
    pushTrail(d);
  }

  // pending plant / tend arrivals
  if (S.pendingPlant && S.me &&
      dist(S.me.x, S.me.y, S.pendingPlant.x, S.pendingPlant.y) < REACH * 0.9) {
    const p = S.pendingPlant; S.pendingPlant = null;
    actPlant(p.word, p.x, p.y);
  }
  if (S.pendingTend && S.me) {
    const f = S.flora.get(S.pendingTend);
    if (!f) S.pendingTend = null;
    else if (dist(S.me.x, S.me.y, f.x, f.y) < REACH * 0.9) {
      const id = S.pendingTend; S.pendingTend = null; actTend(id);
    }
  }

  // motes
  for (const m of S.motes) {
    m.vx += curDx * 0.4 + (Math.random() - 0.5) * 2 * dt;
    m.vy += (Math.random() - 0.5) * 2 * dt;
    m.vx *= Math.pow(0.35, dt); m.vy *= Math.pow(0.35, dt);
    m.x += m.vx * dt * 22; m.y += m.vy * dt * 22;
    if (!inPool(m.x, m.y)) {
      // recycle through the center so the current is a conveyor, not a wall
      const w = S.world;
      m.x = 2 * w.cx - m.x; m.y = 2 * w.cy - m.y;
      m.vx = 0; m.vy = 0;
      [m.x, m.y] = clampToPool(m.x, m.y, 0.94);
    }
  }

  // echoes decay
  const now = Date.now();
  S.echoes = S.echoes.filter((e) => now - e.leftAt < 600000);

  // effects decay
  const pn = performance.now();
  S.effects = S.effects.filter((e) => pn - e.t0 < e.life);
}

function stepDrifter(d, dt, curDx, isMe) {
  const dx = d.tx - d.x, dy = d.ty - d.y;
  const dd = Math.hypot(dx, dy);
  if (dd > 2) {
    const sp = DRIFT_SPEED * clamp(dd / 60, 0.15, 1);
    const step = Math.min(dd, sp * dt);
    d.x += (dx / dd) * step; d.y += (dy / dd) * step;
    d.vx = (dx / dd) * sp; d.vy = (dy / dd) * sp;
  } else {
    d.vx = 0; d.vy = 0;
    // idle sway
    d.sway = (d.sway || 0) + dt * 0.7;
    d.x += Math.cos(d.sway) * 3 * dt;
    d.y += Math.sin(d.sway * 0.8) * 3 * dt;
  }
  d.x += curDx * 0.3;
  [d.x, d.y] = clampToPool(d.x, d.y);
  wake(d);
  pushTrail(d);
}

function pushTrail(d) {
  if (!d.trail) d.trail = [];
  const last = d.trail[d.trail.length - 1];
  if (!last || dist(last[0], last[1], d.x, d.y) > 6) {
    d.trail.push([d.x, d.y]);
    if (d.trail.length > TRAIL_LEN) d.trail.shift();
  }
}

/* ── rendering ─────────────────────────────────────────────────────────── */

const stones = [];
(function makeStones() {
  const r = mulberry(20260823);
  for (let i = 0; i < 34; i++) {
    const a = r() * TAU;
    stones.push({
      a,
      rr: 1.0 + r() * 0.10,     // radial distance factor along rim
      sz: 18 + r() * 46,
      sq: 0.55 + r() * 0.4,
      tone: 0.05 + r() * 0.08,
    });
  }
})();
const floorSpecks = [];
(function makeFloor() {
  const r = mulberry(7);
  for (let i = 0; i < 60; i++) {
    const a = r() * TAU, rad = Math.sqrt(r());
    floorSpecks.push({
      x: DEFAULT_WORLD.cx + Math.cos(a) * rad * DEFAULT_WORLD.rx * 0.9,
      y: DEFAULT_WORLD.cy + Math.sin(a) * rad * DEFAULT_WORLD.ry * 0.9,
      sz: 2 + r() * 7, o: 0.02 + r() * 0.05,
    });
  }
})();

function draw(pn) {
  const w = S.world;
  const t = S.sim ? tideNow().tide : S.tide;

  // night sky / rock shelf around the pool
  ctx.fillStyle = '#04070d';
  ctx.fillRect(0, 0, cam.W, cam.H);

  // ── the water body
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(w2sX(w.cx), w2sY(w.cy), w.rx * cam.s, w.ry * cam.s, 0, 0, TAU);
  ctx.clip();

  // depth gradient — deeper at center, tide raises the luminance
  const g = ctx.createRadialGradient(
    w2sX(w.cx), w2sY(w.cy - w.ry * 0.25), 10,
    w2sX(w.cx), w2sY(w.cy), Math.max(w.rx, w.ry) * cam.s * 1.15
  );
  const lum = 6 + t * 5;
  g.addColorStop(0, `hsl(200, 55%, ${lum + 6}%)`);
  g.addColorStop(0.55, `hsl(208, 60%, ${lum}%)`);
  g.addColorStop(1, `hsl(216, 65%, ${Math.max(3, lum - 5)}%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cam.W, cam.H);

  // floor specks
  for (const sp of floorSpecks) {
    ctx.fillStyle = `rgba(150,190,200,${sp.o})`;
    ctx.beginPath();
    ctx.ellipse(w2sX(sp.x), w2sY(sp.y), sp.sz * cam.s, sp.sz * 0.6 * cam.s, 0, 0, TAU);
    ctx.fill();
  }

  drawCaustics(pn, t);
  drawFlora(pn);
  drawMotes(pn);
  drawEchoes(pn);
  drawEffects(pn);
  drawDrifters(pn);
  drawSurface(pn, t);

  ctx.restore();

  drawRim(t);
  drawVignette();
}

function drawCaustics(pn, tide) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const w = S.world;
  const n = LOW_POWER ? 2 : 4;
  for (let i = 0; i < n; i++) {
    const ph = pn * 0.00006 * (i % 2 ? 1 : -1) + i * 2.1;
    const x = w.cx + Math.cos(ph) * w.rx * 0.5;
    const y = w.cy + Math.sin(ph * 1.3) * w.ry * 0.5;
    const rad = (280 + i * 90) * cam.s;
    const gg = ctx.createRadialGradient(w2sX(x), w2sY(y), 0, w2sX(x), w2sY(y), rad);
    const a = (0.015 + tide * 0.022) * (1 - i * 0.15);
    gg.addColorStop(0, `hsla(185, 70%, 60%, ${a})`);
    gg.addColorStop(1, 'hsla(185, 70%, 60%, 0)');
    ctx.fillStyle = gg;
    ctx.fillRect(0, 0, cam.W, cam.H);
  }
  ctx.restore();
}

function drawSurface(pn, tide) {
  // shimmer lines drifting across the upper water
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const w = S.world;
  ctx.lineWidth = 1;
  const lines = LOW_POWER ? 3 : 5;
  const step = LOW_POWER ? 60 : 40;
  for (let i = 0; i < lines; i++) {
    const yy = w.cy - w.ry * (0.75 - i * 0.09);
    ctx.strokeStyle = `hsla(190, 60%, 70%, ${0.02 + tide * 0.025})`;
    ctx.beginPath();
    for (let x = w.cx - w.rx; x <= w.cx + w.rx; x += step) {
      const y = yy + Math.sin(x * 0.006 + pn * 0.0004 + i * 1.7) * 9
                   + Math.sin(x * 0.013 - pn * 0.0007) * 4;
      if (x === w.cx - w.rx) ctx.moveTo(w2sX(x), w2sY(y));
      else ctx.lineTo(w2sX(x), w2sY(y));
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawRim(tide) {
  const w = S.world;
  ctx.save();
  // rim glow ring — water meets stone
  ctx.beginPath();
  ctx.ellipse(w2sX(w.cx), w2sY(w.cy), w.rx * cam.s, w.ry * cam.s, 0, 0, TAU);
  ctx.strokeStyle = `hsla(190, 60%, 60%, ${0.10 + tide * 0.12})`;
  ctx.lineWidth = 2;
  ctx.shadowColor = 'hsla(185, 80%, 60%, 0.5)';
  ctx.shadowBlur = 18 * cam.s;
  ctx.stroke();
  ctx.shadowBlur = 0;
  // stones
  for (const st of stones) {
    const x = w.cx + Math.cos(st.a) * w.rx * st.rr;
    const y = w.cy + Math.sin(st.a) * w.ry * st.rr;
    ctx.fillStyle = `hsl(210, 18%, ${st.tone * 100}%)`;
    ctx.beginPath();
    ctx.ellipse(w2sX(x), w2sY(y), st.sz * cam.s, st.sz * st.sq * cam.s, st.a, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawVignette() {
  const g = ctx.createRadialGradient(
    cam.W / 2, cam.H / 2, Math.min(cam.W, cam.H) * 0.3,
    cam.W / 2, cam.H / 2, Math.max(cam.W, cam.H) * 0.75
  );
  g.addColorStop(0, 'rgba(2,4,8,0)');
  g.addColorStop(1, 'rgba(2,4,8,0.55)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cam.W, cam.H);
}

function drawMotes(pn) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of S.motes) {
    const tw = 0.5 + 0.5 * Math.sin(pn * 0.0012 + m.tw);
    const speed = Math.hypot(m.vx, m.vy);
    const a = 0.05 + tw * 0.10 + Math.min(speed * 0.06, 0.3);
    ctx.fillStyle = `hsla(${m.hue}, 70%, 70%, ${a})`;
    ctx.beginPath();
    ctx.arc(w2sX(m.x), w2sY(m.y), m.sz * cam.s * (0.8 + tw * 0.5), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawFlora(pn) {
  const sorted = [...S.flora.values()].sort((a, b) => a.y - b.y);
  const { current } = tideNow();
  for (const f of sorted) drawPlant(f, pn, current);
}

function drawPlant(f, pn, current) {
  const x = w2sX(f.x), y = w2sY(f.y);
  const s = cam.s;
  const sway = Math.sin(pn * 0.0009 + f.phase) * 6 + current * 0.35;
  const hue = f.hue;
  const withered = f.stage >= 4;
  const husk = f.stage === 5;
  const glow = husk ? 0 : withered ? 0.25 : 1;
  const flash = Math.max(
    0, 1 - (pn - (f.growFlash || 0)) / 1200, 1 - (pn - (f.tendFlash || 0)) / 1200
  );

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  const heights = [0, 26, 52, 86, 60, 44];
  const H = heights[f.stage] * s;
  const tipX = x + sway * s * (f.stage >= 3 ? 1.4 : 0.8);
  const tipY = y - H;

  // base pearl / root glow
  if (!husk) {
    const bg = ctx.createRadialGradient(x, y, 0, x, y, 22 * s);
    bg.addColorStop(0, `hsla(${hue}, 75%, 60%, ${0.20 * glow + flash * 0.3})`);
    bg.addColorStop(1, `hsla(${hue}, 75%, 60%, 0)`);
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(x, y, 22 * s, 0, TAU); ctx.fill();
  }

  if (f.stage === 0) {
    // seed: a pearl, faintly pulsing
    const p = 0.6 + 0.4 * Math.sin(pn * 0.002 + f.phase);
    ctx.fillStyle = `hsla(${hue}, 80%, 75%, ${0.5 + p * 0.3})`;
    ctx.beginPath(); ctx.arc(x, y, 3.4 * s, 0, TAU); ctx.fill();
    ctx.restore();
    return;
  }

  // stem
  ctx.strokeStyle = husk
    ? 'hsla(200, 8%, 45%, 0.35)'
    : `hsla(${hue}, ${withered ? 25 : 60}%, ${withered ? 38 : 55}%, ${0.35 + glow * 0.3})`;
  ctx.lineWidth = Math.max(1, 2.2 * s);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + sway * 0.4 * s, y - H * 0.55, tipX, tipY);
  ctx.stroke();

  // leaves (frond+)
  if (f.stage >= 2 && !husk) {
    for (const side of [-1, 1]) {
      const ly = y - H * 0.45, lx = x + sway * 0.25 * s;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.quadraticCurveTo(
        lx + side * 16 * s, ly - 10 * s + sway * 0.3 * s,
        lx + side * 24 * s + sway * 0.6 * s, ly - 20 * s
      );
      ctx.strokeStyle = `hsla(${hue}, 55%, 55%, ${0.25 * glow + 0.08})`;
      ctx.lineWidth = Math.max(1, 1.6 * s);
      ctx.stroke();
    }
  }

  // a communal surge leaves a bloom radiant for a while — many hands still felt
  const radiant = f.stage === 3 && f.radiantUntil && pn < f.radiantUntil
    ? clamp((f.radiantUntil - pn) / 60000, 0, 1) : 0;

  // tip bulb
  const pulse = f.stage === 3 ? 0.55 + 0.45 * Math.sin(pn * 0.0016 + f.phase) : 0.5;
  const bulbR = (f.stage === 3 ? 7 : f.stage === 1 ? 3 : 4.4) * s * (1 + radiant * 0.25);
  if (!husk) {
    const gg = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, bulbR * 5);
    const ba = (f.stage === 3 ? 0.5 : 0.3) * glow * pulse + flash * 0.4 + radiant * 0.18;
    gg.addColorStop(0, `hsla(${hue}, 85%, 70%, ${ba})`);
    gg.addColorStop(1, `hsla(${hue}, 85%, 70%, 0)`);
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(tipX, tipY, bulbR * 5, 0, TAU); ctx.fill();
    ctx.fillStyle = `hsla(${hue}, 90%, ${withered ? 45 : 78}%, ${0.5 + glow * 0.4})`;
    ctx.beginPath(); ctx.arc(tipX, tipY, bulbR, 0, TAU); ctx.fill();
    if (radiant > 0) {
      // a slow halo turns about the radiant bloom while the surge lasts
      const wob = REDUCED_MOTION ? 0 : Math.sin(pn * 0.0011 + f.phase);
      const ra = (0.14 + (REDUCED_MOTION ? 0 : 0.10 * Math.sin(pn * 0.003 + f.phase))) * radiant;
      ctx.strokeStyle = `hsla(${hue}, 90%, 80%, ${ra})`;
      ctx.lineWidth = Math.max(1, 1.4 * s);
      ctx.beginPath();
      ctx.ellipse(tipX, tipY, bulbR * (2.6 + wob * 0.4), bulbR * (2.0 - wob * 0.3),
                  REDUCED_MOTION ? 0 : pn * 0.0003, 0, TAU);
      ctx.stroke();
    }
  }

  // bloom sheds spores (a radiant bloom sheds more freely)
  if (f.stage === 3 && Math.random() < (LOW_POWER ? 0.004 : 0.008) * (radiant > 0 ? 2.5 : 1) &&
      S.motes.length < MOTE_CAP) {
    S.motes.push({
      x: f.x, y: f.y - heights[3], vx: (Math.random() - 0.5) * 3, vy: -1.5,
      tw: Math.random() * TAU, sz: 0.9, hue,
    });
  }

  // hover halo + word label
  if (S.hover === f.id) {
    ctx.strokeStyle = `hsla(${hue}, 80%, 70%, 0.5)`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(tipX, tipY, bulbR + 7 * s, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

function drawEchoes(pn) {
  const now = Date.now();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const e of S.echoes) {
    const age = (now - e.leftAt) / 600000;                 // 0..1 over 10 min
    const a = Math.max(0, 0.25 * (1 - age));
    if (a <= 0.004) continue;
    const x = w2sX(e.x), y = w2sY(e.y);
    const r = 16 * cam.s;
    const drift = Math.sin(pn * 0.0005 + e.leftAt % 100) * 6 * cam.s;
    const g = ctx.createRadialGradient(x + drift, y, 0, x + drift, y, r * 2.4);
    g.addColorStop(0, `hsla(${e.hue}, 40%, 70%, ${a})`);
    g.addColorStop(1, `hsla(${e.hue}, 40%, 70%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x + drift, y, r * 2.4, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawEffects(pn) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const e of S.effects) {
    // rAF timestamps can trail performance.now() by a few ms — clamp,
    // or a just-spawned effect renders with a negative radius and throws
    const k = clamp((pn - e.t0) / e.life, 0, 1);
    const x = w2sX(e.x), y = w2sY(e.y);
    if (e.kind === 'pulse' || e.kind === 'ripple') {
      const R = (e.kind === 'pulse' ? 240 : 130) * k * cam.s;
      const a = (e.kind === 'pulse' ? 0.4 : 0.3) * (1 - k);
      ctx.strokeStyle = `hsla(${e.hue}, 80%, 65%, ${a})`;
      ctx.lineWidth = Math.max(1, (1 - k) * 3);
      ctx.beginPath(); ctx.ellipse(x, y, R, R * 0.8, 0, 0, TAU); ctx.stroke();
      if (e.kind === 'pulse' && k < 0.3) {
        const fg = ctx.createRadialGradient(x, y, 0, x, y, 70 * cam.s);
        fg.addColorStop(0, `hsla(${e.hue}, 90%, 75%, ${(0.3 - k) * 1.2})`);
        fg.addColorStop(1, 'transparent');
        ctx.fillStyle = fg;
        ctx.beginPath(); ctx.arc(x, y, 70 * cam.s, 0, TAU); ctx.fill();
      }
    } else if (e.kind === 'song') {
      // twin rings + a rising glyph
      for (const mul of [1, 0.55]) {
        const R = 200 * k * mul * cam.s;
        ctx.strokeStyle = `hsla(${e.hue}, 85%, 68%, ${0.35 * (1 - k)})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.ellipse(x, y, R, R * 0.8, 0, 0, TAU); ctx.stroke();
      }
      const gy = y - k * 90 * cam.s;
      ctx.fillStyle = `hsla(${e.hue}, 90%, 75%, ${0.7 * (1 - k)})`;
      ctx.beginPath(); ctx.arc(x, gy, 3.2 * cam.s, 0, TAU); ctx.fill();
    } else if (e.kind === 'bloom') {
      // a bloom moment: soft light unfolding, a petal ring, spores rising
      const ease = 1 - Math.pow(1 - k, 3);
      const R = (REDUCED_MOTION ? 70 : 40 + ease * 170) * cam.s;
      const a = 0.5 * (1 - k);
      const bg = ctx.createRadialGradient(x, y, 0, x, y, R);
      bg.addColorStop(0, `hsla(${e.hue}, 85%, 72%, ${a * 0.55})`);
      bg.addColorStop(0.6, `hsla(${e.hue}, 85%, 65%, ${a * 0.18})`);
      bg.addColorStop(1, `hsla(${e.hue}, 85%, 65%, 0)`);
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
      if (!REDUCED_MOTION) {
        ctx.strokeStyle = `hsla(${e.hue}, 90%, 75%, ${a * 0.8})`;
        ctx.lineWidth = Math.max(1, (1 - k) * 2);
        ctx.beginPath(); ctx.ellipse(x, y, R * 0.75, R * 0.55, 0, 0, TAU); ctx.stroke();
        for (const sp of e.spores) {
          const kk = clamp((k - sp.delay) / (1 - sp.delay), 0, 1);
          if (kk <= 0) continue;
          const sx = x + sp.dx * kk * cam.s;
          const sy = y - sp.rise * (1 - Math.pow(1 - kk, 2)) * cam.s;
          ctx.fillStyle = `hsla(${e.hue}, 90%, 80%, ${0.8 * (1 - kk)})`;
          ctx.beginPath(); ctx.arc(sx, sy, sp.sz * cam.s, 0, TAU); ctx.fill();
        }
      }
    } else if (e.kind === 'thread') {
      // an answered song: a filament of light between the two singers
      const a = Math.sin(Math.PI * k) * 0.4;             // swell in, let go
      const x2 = w2sX(e.x2), y2 = w2sY(e.y2);
      const mx = (x + x2) / 2, my = (y + y2) / 2 - 40 * cam.s;
      const grad = ctx.createLinearGradient(x, y, x2, y2);
      grad.addColorStop(0, `hsla(${e.hue}, 80%, 70%, ${a})`);
      grad.addColorStop(1, `hsla(${e.hue2}, 80%, 70%, ${a})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(1, 1.6 * cam.s);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(mx, my, x2, y2); ctx.stroke();
      if (!REDUCED_MOTION) {
        // a spark travels from the first singer to the one who answered
        const qx = (1 - k) * (1 - k) * x + 2 * (1 - k) * k * mx + k * k * x2;
        const qy = (1 - k) * (1 - k) * y + 2 * (1 - k) * k * my + k * k * y2;
        ctx.fillStyle = `hsla(${e.hue2}, 90%, 80%, ${0.8 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(qx, qy, 2.4 * cam.s, 0, TAU); ctx.fill();
      }
    } else if (e.kind === 'chorus') {
      // the pool sings back — a shared swell of light rising through the water
      const swell = Math.sin(Math.PI * k);
      ctx.fillStyle = `hsla(185, 70%, 62%, ${swell * (LOW_POWER ? 0.03 : 0.045)})`;
      ctx.fillRect(0, 0, cam.W, cam.H);              // the whole water brightens
      const R = (REDUCED_MOTION ? 420 : 160 + (1 - Math.pow(1 - k, 3)) * 560) * cam.s;
      const cg = ctx.createRadialGradient(x, y, 0, x, y, R);
      cg.addColorStop(0, `hsla(178, 80%, 70%, ${swell * 0.16})`);
      cg.addColorStop(0.55, `hsla(220, 70%, 68%, ${swell * 0.07})`);
      cg.addColorStop(1, 'hsla(258, 70%, 70%, 0)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
      if (!REDUCED_MOTION) {
        const rings = LOW_POWER ? 2 : 3;
        for (let i = 0; i < rings; i++) {
          const kk = clamp(k * 1.35 - i * 0.16, 0, 1);
          if (kk <= 0 || kk >= 1) continue;
          const rr = kk * 540 * cam.s;
          ctx.strokeStyle = `hsla(190, 80%, 70%, ${(1 - kk) * 0.22})`;
          ctx.lineWidth = Math.max(1, (1 - kk) * 2.2);
          ctx.beginPath(); ctx.ellipse(x, y, rr, rr * 0.8, 0, 0, TAU); ctx.stroke();
        }
        // a few glints circle the centre, like voices finding each other
        const gl = LOW_POWER ? 4 : 7;
        for (let i = 0; i < gl; i++) {
          const a = (i / gl) * TAU + k * 1.8 + (e.t0 % 10);
          const rr = (70 + k * 240) * cam.s;
          ctx.fillStyle = `hsla(${172 + i * 12}, 85%, 78%, ${swell * 0.5})`;
          ctx.beginPath();
          ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8, 1.8 * cam.s, 0, TAU);
          ctx.fill();
        }
      }
    } else if (e.kind === 'communal') {
      // a plant raised by many hands — light gathers around it, then lifts
      const swell = Math.sin(Math.PI * k);
      const ease = 1 - Math.pow(1 - k, 3);
      const R = (REDUCED_MOTION ? 120 : 50 + ease * 210) * cam.s;
      const bg = ctx.createRadialGradient(x, y, 0, x, y, R);
      bg.addColorStop(0, `hsla(${e.hue}, 90%, 74%, ${swell * 0.4})`);
      bg.addColorStop(0.6, `hsla(${e.hue}, 85%, 66%, ${swell * 0.14})`);
      bg.addColorStop(1, `hsla(${e.hue}, 85%, 66%, 0)`);
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
      if (!REDUCED_MOTION) {
        for (const mul of [0.8, 0.55]) {
          ctx.strokeStyle = `hsla(${e.hue}, 90%, 76%, ${swell * 0.5 * mul})`;
          ctx.lineWidth = Math.max(1, (1 - k) * 2);
          ctx.beginPath(); ctx.ellipse(x, y, R * mul, R * mul * 0.7, 0, 0, TAU); ctx.stroke();
        }
        // sparks rise from a ring around the base — the many hands, lifting
        for (const sp of e.sparks) {
          const kk = clamp((k - sp.delay) / (1 - sp.delay), 0, 1);
          if (kk <= 0) continue;
          const lift = 1 - Math.pow(1 - kk, 2);
          const sx = x + Math.cos(sp.a) * sp.r0 * (1 - lift * 0.55) * cam.s;
          const sy = y - sp.rise * lift * cam.s
                   + Math.sin(sp.a) * sp.r0 * 0.4 * (1 - lift) * cam.s;
          ctx.fillStyle = `hsla(${e.hue}, 90%, 82%, ${0.85 * (1 - kk)})`;
          ctx.beginPath(); ctx.arc(sx, sy, sp.sz * cam.s, 0, TAU); ctx.fill();
        }
      }
    } else if (e.kind === 'dream') {
      // the pool murmurs last night's dream — a line surfaces, then dissolves
      const a = Math.sin(Math.PI * k) * 0.34;
      if (a > 0.01) {
        const rise = REDUCED_MOTION ? 0 : k * 26 * cam.s;
        const swayX = REDUCED_MOTION ? 0 : Math.sin(pn * 0.0004 + e.t0) * 8 * cam.s;
        const fpx = Math.max(11, 13.5 * cam.s);
        ctx.font = `italic ${fpx}px "Iowan Old Style", Palatino, Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = `hsla(258, 50%, 82%, ${a})`;
        ctx.shadowColor = 'hsla(258, 80%, 70%, 0.5)';
        ctx.shadowBlur = 12;
        e.lines.forEach((line, i) => {
          ctx.fillText(line, x + swayX, y - rise + i * fpx * 1.6);
        });
        ctx.shadowBlur = 0;
        ctx.textAlign = 'left';
      }
    }
  }
  ctx.restore();
}

function drawDrifters(pn) {
  for (const d of S.drifters.values()) drawDrifter(d, pn, false);
  if (S.me) drawDrifter(S.me, pn, true);
}

function drawDrifter(d, pn, isMe) {
  const x = w2sX(d.x), y = w2sY(d.y);
  const s = cam.s;
  const hue = d.hue;
  const isAgent = d.kind === 'agent';

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // trail ribbon
  if (d.trail && d.trail.length > 2) {
    for (let i = 1; i < d.trail.length; i++) {
      const a = (i / d.trail.length) * 0.18;
      ctx.strokeStyle = `hsla(${hue}, 70%, 60%, ${a})`;
      ctx.lineWidth = (i / d.trail.length) * 5 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(w2sX(d.trail[i - 1][0]), w2sY(d.trail[i - 1][1]));
      ctx.lineTo(w2sX(d.trail[i][0]), w2sY(d.trail[i][1]));
      ctx.stroke();
    }
  }

  const breathe = 0.85 + 0.15 * Math.sin(pn * 0.0018 + (d.sway || 0));
  const R = (isMe ? 13 : 11) * s * breathe;

  // outer glow
  const og = ctx.createRadialGradient(x, y, 0, x, y, R * 4.2);
  og.addColorStop(0, `hsla(${hue}, 80%, 65%, ${isMe ? 0.4 : 0.3})`);
  og.addColorStop(1, `hsla(${hue}, 80%, 65%, 0)`);
  ctx.fillStyle = og;
  ctx.beginPath(); ctx.arc(x, y, R * 4.2, 0, TAU); ctx.fill();

  if (isAgent) {
    // keepers: a faceted core inside a slow ring of three orbiting sparks
    ctx.strokeStyle = `hsla(${hue}, 70%, 70%, 0.45)`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, R * 1.9, 0, TAU); ctx.stroke();
    ctx.fillStyle = `hsla(${hue}, 85%, 78%, 0.95)`;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = pn * 0.0004 + (i / 6) * TAU;
      const px = x + Math.cos(a) * R * 0.85, py = y + Math.sin(a) * R * 0.85;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    for (let i = 0; i < 3; i++) {
      const a = pn * 0.0011 + (i / 3) * TAU;
      ctx.fillStyle = `hsla(${hue}, 90%, 80%, 0.85)`;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * R * 1.9, y + Math.sin(a) * R * 1.9, 1.8 * s, 0, TAU);
      ctx.fill();
    }
  } else {
    // visitors: a soft medusa — bell + core
    const stretch = clamp(Math.hypot(d.vx || 0, d.vy || 0) / DRIFT_SPEED, 0, 1);
    ctx.fillStyle = `hsla(${hue}, 85%, 72%, 0.9)`;
    ctx.beginPath();
    ctx.ellipse(x, y, R * (1 + stretch * 0.25), R * (1 - stretch * 0.2), 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `hsla(${hue}, 60%, 90%, 0.9)`;
    ctx.beginPath(); ctx.arc(x, y - R * 0.15, R * 0.35, 0, TAU); ctx.fill();
  }

  ctx.restore();

  // name tag (not for self — you know who you are)
  if (!isMe && d.name) {
    ctx.save();
    ctx.font = `italic ${Math.max(10, 12 * s)}px "Iowan Old Style", Palatino, Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = `hsla(${hue}, 45%, 80%, 0.55)`;
    ctx.fillText(d.name, x, y - R * 3.2);
    ctx.restore();
  }
}

/* ── main loop ─────────────────────────────────────────────────────────── */

let lastFrame = performance.now();
let hudAt = 0;

function frame(pn) {
  // schedule first: no rendering mishap may ever stop the water breathing
  requestAnimationFrame(frame);
  let dt = (pn - lastFrame) / 1000;
  lastFrame = pn;
  if (dt > 0.1) dt = 0.1;                 // tab was hidden — don't lurch

  if (S.sim) S.tide = tideNow().tide;
  stepLocal(dt);
  maybeSurfaceDream(pn);
  draw(pn);

  if (pn - hudAt > 3000) { hudAt = pn; updateHud(); audioTide(S.tide); }

  // keep the flora card tracking its plant
  if (cardFloraId && !el.card.hidden) {
    const f = S.flora.get(cardFloraId);
    if (!f) hideCard();
    else { el.card.style.left = `${w2sX(f.x)}px`; el.card.style.top = `${w2sY(f.y - 30)}px`; }
  }
}

/* ── awaken ────────────────────────────────────────────────────────────── */

resize();
connect();
// if the water hasn't answered soon, dream instead
setTimeout(() => { if (!S.connected) startSimulacrum(); }, 1800);

requestAnimationFrame(frame);
setTimeout(() => {
  el.veil.classList.add('gone');
  document.body.classList.add('awake');
  setTimeout(() => { el.veil.style.display = 'none'; }, 2600);
}, 2200);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && A.ctx?.state === 'suspended' && S.soundOn) A.ctx.resume();
});
