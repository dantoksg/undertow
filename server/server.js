// Undertow — one pool, kept by the tide.
// Authoritative world server: HTTP static + /health + WebSocket /ws.
// Node 22, ws, better-sqlite3. See ../DESIGN.md for the contract.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';

/* ───────────────────────── constants ───────────────────────── */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.UNDERTOW_DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT) || 3000;

const WORLD = { w: 1600, h: 1000, cx: 800, cy: 500, rx: 760, ry: 460 };
const TIDE_PERIOD_MS = 5_400_000;         // 90 minutes
const TICK_MS = 1000 / 6;                  // 6 Hz
const MOVE_SPEED = 140;                     // world units / sec
const ARRIVE_R = 60;
const CURRENT_MAX = 22;                     // units/sec at extreme
const MAX_FLORA = 400;
const PLANT_REACH = 160;
const TEND_REACH = 160;
const PULSE_FEED_R = 120;
const ECHO_TTL_MS = 10 * 60_000;
const ECHO_CAP = 12;
const WORD_RE = /^[\p{L}'-]{1,16}$/u;

const STAGE = { SEED: 0, SPROUT: 1, FROND: 2, BLOOM: 3, WITHER: 4, HUSK: 5 };

/* ───────────────────────── database ───────────────────────── */

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'undertow.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS souls (
  id TEXT PRIMARY KEY, tag TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  hue INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'visitor',
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, visits INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS flora (
  id TEXT PRIMARY KEY, soul_id TEXT NOT NULL,
  word TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, hue INTEGER NOT NULL,
  stage INTEGER NOT NULL DEFAULT 0, nourish REAL NOT NULL DEFAULT 1.0,
  planted_at INTEGER NOT NULL, last_tended INTEGER, withered_at INTEGER, prev_stage INTEGER
);
CREATE TABLE IF NOT EXISTS tendings (
  flora_id TEXT NOT NULL, soul_id TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tend ON tendings(flora_id, soul_id, at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL,
  soul_id TEXT, subject TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE TABLE IF NOT EXISTS world (k TEXT PRIMARY KEY, v TEXT);
`);

// Prune ancient events on boot.
db.prepare(`DELETE FROM events WHERE at < ?`).run(Date.now() - 30 * 86_400_000);

// Tide epoch: written once, sacred forever.
const getWorld = db.prepare(`SELECT v FROM world WHERE k = ?`);
const setWorld = db.prepare(`INSERT INTO world(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
let epoch = Number(getWorld.get('epoch')?.v);
if (!epoch) { epoch = Date.now(); setWorld.run('epoch', String(epoch)); }

const Q = {
  soulById: db.prepare(`SELECT * FROM souls WHERE id = ?`),
  insSoul: db.prepare(`INSERT INTO souls(id,tag,name,hue,kind,first_seen,last_seen,visits) VALUES(@id,@tag,@name,@hue,@kind,@first_seen,@last_seen,1)`),
  touchSoul: db.prepare(`UPDATE souls SET last_seen=@last_seen, visits=visits+1, name=@name, hue=@hue, kind=@kind WHERE id=@id`),
  setSeen: db.prepare(`UPDATE souls SET last_seen=? WHERE id=?`),
  setSoulName: db.prepare(`UPDATE souls SET name=? WHERE id=?`),
  everCount: db.prepare(`SELECT COUNT(*) n FROM souls`),
  allFlora: db.prepare(`SELECT * FROM flora`),
  insFlora: db.prepare(`INSERT INTO flora(id,soul_id,word,x,y,hue,stage,nourish,planted_at) VALUES(@id,@soul_id,@word,@x,@y,@hue,0,1.0,@planted_at)`),
  floraById: db.prepare(`SELECT * FROM flora WHERE id = ?`),
  updNourish: db.prepare(`UPDATE flora SET nourish=?, last_tended=? WHERE id=?`),
  updStage: db.prepare(`UPDATE flora SET stage=?, withered_at=?, prev_stage=? WHERE id=?`),
  updNourishOnly: db.prepare(`UPDATE flora SET nourish=? WHERE id=?`),
  delFlora: db.prepare(`DELETE FROM flora WHERE id = ?`),
  livingCount: db.prepare(`SELECT COUNT(*) n FROM flora WHERE stage < 5`),
  lastPlant: db.prepare(`SELECT MAX(planted_at) t FROM flora WHERE soul_id = ?`),
  lastTend: db.prepare(`SELECT MAX(at) t FROM tendings WHERE flora_id=? AND soul_id=?`),
  insTend: db.prepare(`INSERT INTO tendings(flora_id,soul_id,at) VALUES(?,?,?)`),
  insEvent: db.prepare(`INSERT INTO events(at,type,soul_id,subject,data) VALUES(@at,@type,@soul_id,@subject,@data)`),
  eventsSince: db.prepare(`SELECT * FROM events WHERE at > ? ORDER BY at ASC`),
  recentEvents: db.prepare(`SELECT * FROM events WHERE type IN ('tide','plant','grow','revive','wither') ORDER BY at DESC LIMIT ?`),
  lastSing: db.prepare(`SELECT MAX(at) t FROM events WHERE type='sing' AND soul_id=?`),
};

const logEvent = (type, soul_id, subject, data) =>
  Q.insEvent.run({ at: Date.now(), type, soul_id: soul_id || null, subject: subject || null, data: data ? JSON.stringify(data) : null });

/* ───────────────────────── helpers ───────────────────────── */

const now = () => Date.now();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const tagOf = (soul) => crypto.createHash('sha256').update(soul).digest('hex').slice(0, 8);
const mintSoul = () => crypto.randomBytes(16).toString('hex'); // 32 hex

function tidePhase(t = now()) { return (((t - epoch) % TIDE_PERIOD_MS) + TIDE_PERIOD_MS) % TIDE_PERIOD_MS / TIDE_PERIOD_MS; }
function tideValue(t = now()) { return 0.5 + 0.5 * Math.sin(2 * Math.PI * tidePhase(t)); }
function tideRising(t = now()) { const p = tidePhase(t); return p >= 0.75 || p < 0.25; }
function currentX(t = now()) { return CURRENT_MAX * Math.cos(2 * Math.PI * tidePhase(t)); }

function clampEllipse(x, y) {
  let nx = (x - WORLD.cx) / WORLD.rx, ny = (y - WORLD.cy) / WORLD.ry;
  const r = Math.hypot(nx, ny);
  if (r > 0.98) { const s = 0.98 / r; nx *= s; ny *= s; }
  return [WORLD.cx + nx * WORLD.rx, WORLD.cy + ny * WORLD.ry];
}
function randInEllipse() {
  const a = Math.random() * 2 * Math.PI, rr = Math.sqrt(Math.random()) * 0.9;
  return [WORLD.cx + Math.cos(a) * rr * WORLD.rx, WORLD.cy + Math.sin(a) * rr * WORLD.ry];
}
function cleanWord(raw) {
  if (typeof raw !== 'string') return null;
  const tok = raw.trim().split(/\s+/)[0] || '';
  const w = tok.toLowerCase();
  return WORD_RE.test(w) ? w : null;
}

/* ───────────────────────── live state ───────────────────────── */

const drifters = new Map();   // ws -> drifter
const byId = new Map();       // id -> drifter
let echoes = [];              // recently departed
const pending = [];           // event objects queued for next tick broadcast

function makeId() { let id; do { id = crypto.randomBytes(3).toString('hex'); } while (byId.has(id)); return id; }

function floraPublic(f, forSoul) {
  const o = {
    id: f.id, word: f.word, x: Math.round(f.x), y: Math.round(f.y), hue: f.hue,
    stage: f.stage, nourish: Math.round(f.nourish * 100) / 100,
    plantedAt: f.planted_at, planter: f.planterName ?? '', soulTag: f.soulTag,
  };
  if (forSoul) o.mine = f.soul_id === forSoul;
  return o;
}

// Decorate a raw flora row with planter name + tag (cached on the row object).
const soulMetaCache = new Map();
function decorate(f) {
  let meta = soulMetaCache.get(f.soul_id);
  if (!meta) { const s = Q.soulById.get(f.soul_id); meta = { name: s?.name || '', tag: s?.tag || tagOf(f.soul_id) }; soulMetaCache.set(f.soul_id, meta); }
  f.planterName = meta.name; f.soulTag = meta.tag;
  return f;
}

/* ───────────────────────── whisper ───────────────────────── */

function buildWhisper(soul) {
  const since = soul.last_seen;
  const rows = Q.eventsSince.all(since);
  const mine = new Set(Q.allFlora.all().filter(f => f.soul_id === soul.id).map(f => f.id));
  const lines = [];

  // 1. personal flora news
  for (const r of rows) {
    if (lines.length >= 2) break;
    if (!['tend', 'revive', 'grow', 'wither'].includes(r.type)) continue;
    const d = r.data ? JSON.parse(r.data) : {};
    if (d.owner !== soul.id && !mine.has(r.subject)) continue;
    const who = d.byKind === 'agent' ? 'a keeper' : (d.byName || 'someone');
    if (r.type === 'tend') lines.push(`${who} tended your '${d.word}'.`);
    else if (r.type === 'revive') lines.push(`Your '${d.word}' was almost lost. ${who} brought it back.`);
    else if (r.type === 'grow' && d.stage >= STAGE.BLOOM) lines.push(`Your '${d.word}' has bloomed.`);
    else if (r.type === 'wither') lines.push(`Your '${d.word}' withered while you were gone. The pool remembers it.`);
  }

  // 2. tides
  const tides = rows.filter(r => r.type === 'tide').length;
  lines.push(tides > 0 ? `While you were away, the tide turned ${tides} times.` : `The tide has barely moved since you left.`);

  // 3. visitors
  const visits = rows.filter(r => r.type === 'visit' && r.soul_id !== soul.id);
  if (visits.length && lines.length < 4) {
    let line = `${visits.length} ${visits.length === 1 ? 'soul' : 'souls'} passed through.`;
    if (visits.some(v => { try { return JSON.parse(v.data || '{}').kind === 'agent'; } catch { return false; } })) line += ' One of them was not human.';
    lines.push(line);
  }

  // 4. new flora by others
  if (lines.length < 4) {
    const plant = [...rows].reverse().find(r => r.type === 'plant' && r.soul_id !== soul.id);
    if (plant) { try { lines.push(`Something new is growing: '${JSON.parse(plant.data).word}'.`); } catch {} }
  }

  const out = lines.slice(0, 4);
  if (out.length === 0) out.push('Nothing has forgotten you. The pool kept your place.');
  return out;
}

function firstWhisper() {
  const days = Math.max(1, Math.floor((now() - epoch) / 86_400_000));
  return [
    `This pool was here before you. It has been breathing for ${days} ${days === 1 ? 'day' : 'days'}.`,
    'Others pass through — not all of them human.',
    'Leave one small thing, and the water will speak of you.',
  ];
}

function buildChronicle() {
  const rows = Q.recentEvents.all(6);
  const out = [];
  for (const r of rows) {
    let d = {}; try { d = r.data ? JSON.parse(r.data) : {}; } catch {}
    if (r.type === 'tide') out.push(d.dir === 'high' ? 'the tide rose to its full' : 'the tide drew down');
    else if (r.type === 'plant') out.push(`${d.name || 'someone'} planted '${d.word}'`);
    else if (r.type === 'grow' && d.stage >= STAGE.BLOOM) out.push(`'${d.word}' came into bloom`);
    else if (r.type === 'revive') out.push(`'${d.word}' was brought back from the edge`);
    else if (r.type === 'wither') out.push(`'${d.word}' began to wither`);
  }
  return out.slice(0, 5);
}

/* ───────────────────────── connection / hello ───────────────────────── */

function send(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }
function err(ws, msg) { send(ws, { t: 'err', msg }); }

function handleHello(ws, m) {
  if (drifters.has(ws)) return; // already joined
  // A valid 32-hex soul may be presented as a bearer identity. If known, it's a
  // return; if well-formed but unknown, honor it as a seed (lets agents keep a
  // fixed identity across restarts via UNDERTOW_SOUL). Otherwise mint fresh.
  const seed = typeof m.soul === 'string' && /^[0-9a-f]{32}$/.test(m.soul) ? m.soul : null;
  let soul = seed ? Q.soulById.get(seed) : null;

  const hue = Number.isInteger(m.hue) ? ((m.hue % 360) + 360) % 360 : Math.floor(Math.random() * 360);
  const kind = m.kind === 'agent' ? 'agent' : 'visitor';
  const name = cleanWord(m.name) || (soul ? soul.name : '');

  let whisper;
  if (soul) {
    whisper = buildWhisper(soul);
    Q.touchSoul.run({ id: soul.id, last_seen: now(), name, hue: soul.hue, kind });
    soul = Q.soulById.get(soul.id);
    soulMetaCache.delete(soul.id);
  } else {
    const id = seed || mintSoul();   // honor a valid client seed as the identity
    const rec = { id, tag: tagOf(id), name, hue, kind, first_seen: now(), last_seen: now() };
    Q.insSoul.run(rec);
    soul = Q.soulById.get(id);
    whisper = firstWhisper();
  }
  logEvent('visit', soul.id, null, { name: soul.name, kind: soul.kind });

  const [sx, sy] = randInEllipse();
  const d = {
    ws, id: makeId(), soul: soul.id, soulTag: soul.tag, name: soul.name, hue: soul.hue, kind: soul.kind,
    x: sx, y: sy, tx: sx, ty: sy,
    rl: { move: 0, pulse: 0, sing: 0, name: 0 }, sway: Math.random() * Math.PI * 2, alive: true,
  };
  drifters.set(ws, d); byId.set(d.id, d); ws._d = d;

  const flora = Q.allFlora.all().map(decorate);
  send(ws, {
    t: 'welcome',
    you: { id: d.id, soul: soul.id, soulTag: soul.tag, name: soul.name, hue: soul.hue, kind: soul.kind },
    world: { ...WORLD, tidePeriod: TIDE_PERIOD_MS, epoch },
    tide: Math.round(tideValue() * 1000) / 1000, rising: tideRising(),
    drifters: [...drifters.values()].filter(o => o !== d).map(o => ({ id: o.id, name: o.name, hue: o.hue, kind: o.kind, x: Math.round(o.x), y: Math.round(o.y) })),
    flora: flora.map(f => floraPublic(f, soul.id)),
    echoes: echoes.map(e => ({ name: e.name, hue: e.hue, kind: e.kind, x: Math.round(e.x), y: Math.round(e.y), leftAt: e.leftAt })),
    whisper, chronicle: buildChronicle(),
    souls: { here: drifters.size, ever: Q.everCount.get().n },
  });

  // Announce to everyone else after their snapshot exists.
  pending.push({ e: 'join', d: { id: d.id, name: d.name, hue: d.hue, kind: d.kind, x: Math.round(d.x), y: Math.round(d.y) }, _skip: d.id });
}

/* ───────────────────────── verbs ───────────────────────── */

function handle(ws, m) {
  const d = drifters.get(ws);
  if (m.t === 'hello') return handleHello(ws, m);
  if (!d) return; // ignore everything before hello
  const t = now();
  switch (m.t) {
    case 'ping': return send(ws, { t: 'pong', now: t });

    case 'move': {
      if (t - d.rl.move < 100) return; d.rl.move = t; // 10/sec
      if (typeof m.x !== 'number' || typeof m.y !== 'number' || !isFinite(m.x) || !isFinite(m.y)) return;
      const [cx, cy] = clampEllipse(m.x, m.y); d.tx = cx; d.ty = cy; return;
    }

    case 'pulse': {
      if (t - d.rl.pulse < 1000) return err(ws, 'the water is still ringing');
      d.rl.pulse = t;
      pending.push({ e: 'pulse', id: d.id, x: Math.round(d.x), y: Math.round(d.y), hue: d.hue });
      // feed nearby flora
      for (const f of Q.allFlora.all()) {
        if (f.stage >= STAGE.HUSK) continue;
        if (Math.hypot(f.x - d.x, f.y - d.y) <= PULSE_FEED_R) {
          const nv = Math.min(6, f.nourish + 0.15); Q.updNourishOnly.run(nv, f.id);
        }
      }
      return;
    }

    case 'sing': {
      if (t - d.rl.sing < 1500) return err(ws, 'let the last note fade');
      const note = clamp(Math.trunc(m.note), 0, 7); if (!Number.isFinite(note)) return;
      d.rl.sing = t;
      pending.push({ e: 'sing', id: d.id, note, x: Math.round(d.x), y: Math.round(d.y), hue: d.hue });
      const last = Q.lastSing.get(d.soul).t || 0;
      if (t - last > 600_000) logEvent('sing', d.soul, null, { name: d.name }); // throttled 10min
      return;
    }

    case 'name': {
      if (t - d.rl.name < 30_000) return err(ws, 'a name needs time to settle');
      const w = cleanWord(m.word); if (!w) return err(ws, 'that name will not hold');
      d.rl.name = t; d.name = w;
      Q.setSoulName.run(w, d.soul); soulMetaCache.delete(d.soul);
      pending.push({ e: 'rename', id: d.id, name: w });
      return;
    }

    case 'plant': {
      const w = cleanWord(m.word); if (!w) return err(ws, 'the word will not take root');
      if (Q.livingCount.get().n >= MAX_FLORA) return err(ws, 'the pool is full');
      const lp = Q.lastPlant.get(d.soul).t || 0;
      if (t - lp < 600_000) return err(ws, 'too soon to plant again');
      let px = typeof m.x === 'number' ? m.x : d.x, py = typeof m.y === 'number' ? m.y : d.y;
      if (Math.hypot(px - d.x, py - d.y) > PLANT_REACH) return err(ws, 'reach where you can touch the floor');
      [px, py] = clampEllipse(px, py);
      const id = 'f_' + Math.random().toString(36).slice(2, 8);
      Q.insFlora.run({ id, soul_id: d.soul, word: w, x: px, y: py, hue: d.hue, planted_at: t });
      logEvent('plant', d.soul, id, { word: w, name: d.name, owner: d.soul });
      const f = decorate(Q.floraById.get(id));
      pending.push({ e: 'plant', f: floraPublic(f) });
      return;
    }

    case 'tend': {
      const f = Q.floraById.get(m.id); if (!f) return err(ws, 'nothing there to tend');
      if (Math.hypot(f.x - d.x, f.y - d.y) > TEND_REACH) return err(ws, 'draw closer to tend it');
      if (f.stage >= STAGE.HUSK) return err(ws, 'only a husk remains');
      const lt = Q.lastTend.get(f.id, d.soul).t || 0;
      if (t - lt < 3_600_000) return err(ws, 'you have tended this recently');
      Q.insTend.run(f.id, d.soul, t);
      const owner = Q.soulById.get(f.soul_id);
      // Revive a freshly-withering plant back to its previous stage.
      if (f.stage === STAGE.WITHER && f.withered_at && (t - f.withered_at) < 6 * 3_600_000) {
        const back = f.prev_stage ?? STAGE.SPROUT;
        Q.updStage.run(back, null, null, f.id); Q.updNourish.run(1.0, t, f.id);
        logEvent('revive', d.soul, f.id, { word: f.word, byName: d.name, byKind: d.kind, owner: f.soul_id });
        pending.push({ e: 'revive', id: f.id, stage: back, by: d.name });
        pending.push({ e: 'tend', id: f.id, by: d.name, nourish: 1.0 });
      } else {
        const nv = Math.min(6, f.nourish + 1.0); Q.updNourish.run(nv, t, f.id);
        logEvent('tend', d.soul, f.id, { word: f.word, byName: d.name, byKind: d.kind, owner: f.soul_id });
        pending.push({ e: 'tend', id: f.id, by: d.name, nourish: Math.round(nv * 100) / 100 });
      }
      return;
    }
  }
}

/* ───────────────────────── tick loop (6 Hz) ───────────────────────── */

let lastPhase = tidePhase();
function crossed(a, b, mark) { return a < mark && b >= mark || (b < a && (a < mark || b >= mark)); }

function tick() {
  const t = now();
  const dt = TICK_MS / 1000;
  const cur = currentX(t) * dt;

  // tide crossings → events
  const p = tidePhase(t);
  const wrapped = p < lastPhase; // phase wrapped 1→0
  const crossHigh = (lastPhase < 0.25 && p >= 0.25) || (wrapped && p >= 0.25 && lastPhase < 0.25);
  const crossLow = (lastPhase < 0.75 && p >= 0.75);
  if (crossHigh) { logEvent('tide', null, null, { dir: 'high' }); pending.push({ e: 'tide', dir: 'high' }); }
  if (crossLow) { logEvent('tide', null, null, { dir: 'low' }); pending.push({ e: 'tide', dir: 'low' }); }
  lastPhase = p;

  // integrate drifters
  for (const d of drifters.values()) {
    const dx = d.tx - d.x, dy = d.ty - d.y; const dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      const step = Math.min(dist, MOVE_SPEED * dt * (dist < ARRIVE_R ? dist / ARRIVE_R : 1));
      d.x += (dx / dist) * step; d.y += (dy / dist) * step;
    } else { d.sway += dt; d.x += Math.cos(d.sway) * 4 * dt; d.y += Math.sin(d.sway * 0.7) * 4 * dt; }
    d.x += cur;
    [d.x, d.y] = clampEllipse(d.x, d.y);
  }

  // broadcast
  const dArr = [...drifters.values()].map(d => [d.id, Math.round(d.x), Math.round(d.y)]);
  const base = { t: 'tick', now: t, tide: Math.round(tideValue(t) * 1000) / 1000, d: dArr };
  for (const [ws, d] of drifters) {
    if (ws.bufferedAmount > 65536) continue;
    const ev = pending.filter(e => e._skip !== d.id).map(({ _skip, ...rest }) => rest);
    send(ws, ev.length ? { ...base, ev } : base);
  }
  pending.length = 0;
}

/* ───────────────────────── slow loop (60 s): growth ───────────────────────── */

const GROW = [
  { to: STAGE.SPROUT, age: 3_600_000, nour: 0.5 },
  { to: STAGE.FROND, age: 6 * 3_600_000, nour: 1.0 },
  { to: STAGE.BLOOM, age: 20 * 3_600_000, nour: 2.0 },
];
let lastGrow = now();

function growth() {
  const t = now();
  const hrs = (t - lastGrow) / 3_600_000; lastGrow = t;
  for (const f of Q.allFlora.all()) {
    // cull husks 48h after withering
    if (f.stage === STAGE.HUSK) {
      if (f.withered_at && t - f.withered_at > 48 * 3_600_000) { Q.delFlora.run(f.id); pending.push({ e: 'gone', id: f.id }); }
      continue;
    }
    // husk transition
    if (f.stage === STAGE.WITHER) {
      if (f.withered_at && t - f.withered_at > 12 * 3_600_000) { Q.updStage.run(STAGE.HUSK, f.withered_at, f.prev_stage, f.id); pending.push({ e: 'husk', id: f.id }); logEvent('husk', f.soul_id, f.id, { word: f.word, owner: f.soul_id }); }
      continue;
    }
    // decay
    let nour = Math.max(0, f.nourish - 0.04 * hrs);
    if (nour <= 0 && f.stage >= STAGE.SPROUT) {
      Q.updStage.run(STAGE.WITHER, t, f.stage, f.id); Q.updNourishOnly.run(0, f.id);
      pending.push({ e: 'wither', id: f.id }); logEvent('wither', f.soul_id, f.id, { word: f.word, owner: f.soul_id });
      continue;
    }
    if (nour !== f.nourish) Q.updNourishOnly.run(nour, f.id);
    // advance
    const age = t - f.planted_at;
    for (const g of GROW) {
      if (f.stage === g.to - 1 && age >= g.age && nour >= g.nour) {
        Q.updStage.run(g.to, null, null, f.id);
        pending.push({ e: 'grow', id: f.id, stage: g.to });
        logEvent('grow', f.soul_id, f.id, { word: f.word, stage: g.to, owner: f.soul_id });
        break;
      }
    }
  }
}

/* ───────────────────────── echoes & disconnect ───────────────────────── */

function drop(ws, code) {
  const d = drifters.get(ws); if (!d) return;
  drifters.delete(ws); byId.delete(d.id);
  Q.setSeen.run(now(), d.soul);
  const echo = { name: d.name, hue: d.hue, kind: d.kind, x: Math.round(d.x), y: Math.round(d.y), leftAt: now() };
  echoes.push(echo); if (echoes.length > ECHO_CAP) echoes.shift();
  pending.push({ e: 'part', id: d.id, echo });
}
setInterval(() => { const cut = now() - ECHO_TTL_MS; echoes = echoes.filter(e => e.leftAt > cut); }, 30_000);

/* ───────────────────────── http + ws ───────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, drifters: drifters.size, flora: Q.livingCount.get().n, tide: Math.round(tideValue() * 100) / 100 }));
  }
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    if (raw.length > 512) return ws.close(1009);
    let m; try { m = JSON.parse(raw); } catch { return ws.close(1008); }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { /* fail soft */ }
  });
  ws.on('close', (c) => drop(ws, c));
  ws.on('error', () => drop(ws));
});

// heartbeat: terminate dead sockets (fires normal part path via close)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 30_000);

setInterval(tick, TICK_MS);
setInterval(growth, 60_000);

server.listen(PORT, () => {
  const days = Math.floor((now() - epoch) / 86_400_000);
  console.log(`Undertow listening on :${PORT} — the pool has been breathing for ${days} day(s).`);
});
