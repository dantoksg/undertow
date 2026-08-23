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
CREATE TABLE IF NOT EXISTS dreams (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  at   INTEGER NOT NULL,
  day  INTEGER NOT NULL,          -- UTC day number the dream is of
  text TEXT NOT NULL              -- the dream, newline-separated lines
);
CREATE INDEX IF NOT EXISTS idx_dreams_day ON dreams(day);
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
  eventsBetween: db.prepare(`SELECT * FROM events WHERE at >= ? AND at < ? ORDER BY at ASC`),
  chronicleEvents: db.prepare(`SELECT * FROM events WHERE type IN ('tide','plant','grow','revive','wither','husk','dream') ORDER BY at DESC LIMIT ?`),
  insDream: db.prepare(`INSERT INTO dreams(at,day,text) VALUES(?,?,?)`),
  latestDream: db.prepare(`SELECT * FROM dreams ORDER BY day DESC LIMIT 1`),
  lastDreamDay: db.prepare(`SELECT MAX(day) d FROM dreams`),
  dreamForDay: db.prepare(`SELECT id FROM dreams WHERE day = ?`),
  recentDreams: db.prepare(`SELECT * FROM dreams ORDER BY day DESC LIMIT ?`),
  distinctSoulsBetween: db.prepare(`SELECT COUNT(DISTINCT soul_id) n FROM events WHERE type='visit' AND at >= ? AND at < ?`),
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
const restDrifters = new Map(); // soul -> drifter (HTTP participants; no socket)
let echoes = [];              // recently departed
const pending = [];           // event objects queued for next tick broadcast

function makeId() { let id; do { id = crypto.randomBytes(3).toString('hex'); } while (byId.has(id)); return id; }

// Everyone currently in the water — socket-bound and REST alike.
function allDrifters() { return [...drifters.values(), ...restDrifters.values()]; }
function driftersHere() { return drifters.size + restDrifters.size; }

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

/* ───────────────────────── the pool dreams ─────────────────────────────
   Once a day the pool takes the words planted that day and the day's small
   fates, and launders them into a short dream — the way sleep turns the day's
   residue into something stranger. Kept forever. No model, just the pool's
   own memory folded over on itself. Surfaced on arrival and on /chronicle. */

const DAY_MS = 86_400_000;
const dayNumber = (t = now()) => Math.floor(t / DAY_MS);
const pickOf = (a) => a[Math.floor(Math.random() * a.length)];

function composeDream(day) {
  const start = day * DAY_MS, end = start + DAY_MS;
  const rows = Q.eventsBetween.all(start, Math.min(end, now() + 1));
  const words = [], blooms = [], withers = [], revives = [];
  let tides = 0, byAgent = false;
  for (const r of rows) {
    let d = {}; try { d = r.data ? JSON.parse(r.data) : {}; } catch {}
    if (r.type === 'plant') { words.push(d.word); }
    else if (r.type === 'grow' && d.stage >= STAGE.BLOOM) blooms.push(d.word);
    else if (r.type === 'wither') withers.push(d.word);
    else if (r.type === 'revive') revives.push(d.word);
    else if (r.type === 'tide') tides++;
    else if (r.type === 'visit' && d.kind === 'agent') byAgent = true;
  }
  const uniq = [...new Set(words.filter(Boolean))];
  const souls = Q.distinctSoulsBetween.get(start, Math.min(end, now() + 1)).n;

  if (!uniq.length && !tides && !souls) return 'The pool dreamed of no one, and kept your place.';

  const lines = [];
  lines.push(tides > 0
    ? `The tide turned ${tides} ${tides === 1 ? 'time' : 'times'} while it slept.`
    : 'The water lay still, and still it dreamed.');

  if (uniq.length >= 3) {
    const [a, b, c] = shuffle(uniq).slice(0, 3);
    lines.push(pickOf([
      `'${a}' drifted into '${b}', and neither could say which came first.`,
      `'${a}', '${b}', '${c}' — the pool turned them over like stones.`,
      `It kept returning to '${a}', the way a tide returns to '${b}'.`,
    ]));
  } else if (uniq.length === 2) {
    const [a, b] = shuffle(uniq);
    lines.push(pickOf([
      `Someone had left '${a}'. By morning it was tangled in '${b}'.`,
      `'${a}' and '${b}' kept the same slow orbit all night.`,
    ]));
  } else if (uniq.length === 1) {
    lines.push(`Only '${uniq[0]}' remained, and the pool held it close.`);
  }

  if (blooms.length) lines.push(`'${pickOf(blooms)}' opened in the dark.`);
  else if (revives.length) lines.push(`'${pickOf(revives)}' had been almost lost; something stayed for it.`);
  else if (withers.length) lines.push(`'${pickOf(withers)}' let go, and the pool remembered it anyway.`);
  else if (souls && byAgent) lines.push(`Something that was not a person passed through, and tended the quiet.`);

  return lines.slice(0, 3).join('\n');
}

function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function storeDream(day) {
  if (Q.dreamForDay.get(day)) return null;
  const text = composeDream(day);
  Q.insDream.run(now(), day, text);
  logEvent('dream', null, null, { line: text.split('\n')[0] });
  console.log(`[pool] dreamed of day ${day}: ${text.split('\n')[0]}`);
  return text;
}

function dreamTick() {
  const today = dayNumber();
  const last = Q.lastDreamDay.get().d;
  if (last == null) storeDream(today);           // young pool: seed one now, visibly
  else if (today > last) storeDream(today - 1);  // dream the day that just ended
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
    drifters: allDrifters().filter(o => o !== d).map(o => ({ id: o.id, name: o.name, hue: o.hue, kind: o.kind, x: Math.round(o.x), y: Math.round(o.y) })),
    flora: flora.map(f => floraPublic(f, soul.id)),
    echoes: echoes.map(e => ({ name: e.name, hue: e.hue, kind: e.kind, x: Math.round(e.x), y: Math.round(e.y), leftAt: e.leftAt })),
    whisper, chronicle: buildChronicle(),
    dream: (Q.latestDream.get()?.text || '').split('\n').filter(Boolean),
    souls: { here: driftersHere(), ever: Q.everCount.get().n },
  });

  // Announce to everyone else after their snapshot exists.
  pending.push({ e: 'join', d: { id: d.id, name: d.name, hue: d.hue, kind: d.kind, x: Math.round(d.x), y: Math.round(d.y) }, _skip: d.id });
}

/* ───────────────────────── verbs ───────────────────────── */

function handle(ws, m) {
  if (m.t === 'hello') return handleHello(ws, m);
  const d = drifters.get(ws);
  if (!d) return; // ignore everything before hello
  if (m.t === 'ping') return send(ws, { t: 'pong', now: now() });
  applyAction(d, m, (msg) => err(ws, msg));
}

// One action verb, for any drifter — WebSocket-bound or REST. Errors go to onErr.
// Returns a short human confirmation string on success (used by the REST reply).
function applyAction(d, m, onErr) {
  const t = now();
  switch (m.t) {
    case 'move': {
      if (t - d.rl.move < 100) return 'moving';
      d.rl.move = t;
      if (typeof m.x !== 'number' || typeof m.y !== 'number' || !isFinite(m.x) || !isFinite(m.y)) return onErr('give me an x and a y inside the pool');
      const [cx, cy] = clampEllipse(m.x, m.y); d.tx = cx; d.ty = cy; return 'drifting there';
    }

    case 'pulse': {
      if (t - d.rl.pulse < 1000) return onErr('the water is still ringing');
      d.rl.pulse = t;
      pending.push({ e: 'pulse', id: d.id, x: Math.round(d.x), y: Math.round(d.y), hue: d.hue });
      for (const f of Q.allFlora.all()) {
        if (f.stage >= STAGE.HUSK) continue;
        if (Math.hypot(f.x - d.x, f.y - d.y) <= PULSE_FEED_R) {
          const nv = Math.min(6, f.nourish + 0.15); Q.updNourishOnly.run(nv, f.id);
        }
      }
      return 'a ring of light spreads out';
    }

    case 'sing': {
      if (t - d.rl.sing < 1500) return onErr('let the last note fade');
      const note = clamp(Math.trunc(m.note), 0, 7); if (!Number.isFinite(note)) return onErr('a note is 0 to 7');
      d.rl.sing = t;
      pending.push({ e: 'sing', id: d.id, note, x: Math.round(d.x), y: Math.round(d.y), hue: d.hue });
      const last = Q.lastSing.get(d.soul).t || 0;
      if (t - last > 600_000) logEvent('sing', d.soul, null, { name: d.name });
      return `you sang note ${note}`;
    }

    case 'name': {
      if (t - d.rl.name < 30_000) return onErr('a name needs time to settle');
      const w = cleanWord(m.word); if (!w) return onErr('that name will not hold');
      d.rl.name = t; d.name = w;
      Q.setSoulName.run(w, d.soul); soulMetaCache.delete(d.soul);
      pending.push({ e: 'rename', id: d.id, name: w });
      return `the pool will call you ${w}`;
    }

    case 'plant': {
      const w = cleanWord(m.word); if (!w) return onErr('one word only — letters, apostrophe or hyphen');
      if (Q.livingCount.get().n >= MAX_FLORA) return onErr('the pool is full');
      const lp = Q.lastPlant.get(d.soul).t || 0;
      if (t - lp < 600_000) return onErr('too soon to plant again — wait ten minutes');
      let px = typeof m.x === 'number' ? m.x : d.x, py = typeof m.y === 'number' ? m.y : d.y;
      if (Math.hypot(px - d.x, py - d.y) > PLANT_REACH) { px = d.x; py = d.y; } // REST agents plant where they are
      [px, py] = clampEllipse(px, py);
      const id = 'f_' + Math.random().toString(36).slice(2, 8);
      Q.insFlora.run({ id, soul_id: d.soul, word: w, x: px, y: py, hue: d.hue, planted_at: t });
      logEvent('plant', d.soul, id, { word: w, name: d.name, owner: d.soul });
      const f = decorate(Q.floraById.get(id));
      pending.push({ e: 'plant', f: floraPublic(f) });
      return `you planted '${w}' — it will take real hours to grow`;
    }

    case 'tend': {
      const f = Q.floraById.get(m.id); if (!f) return onErr('nothing there to tend');
      if (Math.hypot(f.x - d.x, f.y - d.y) > TEND_REACH) { d.tx = f.x; d.ty = f.y; d.x = f.x; d.y = f.y; } // REST agents reach it
      if (f.stage >= STAGE.HUSK) return onErr('only a husk remains');
      const lt = Q.lastTend.get(f.id, d.soul).t || 0;
      if (t - lt < 3_600_000) return onErr('you have tended this one recently');
      Q.insTend.run(f.id, d.soul, t);
      if (f.stage === STAGE.WITHER && f.withered_at && (t - f.withered_at) < 6 * 3_600_000) {
        const back = f.prev_stage ?? STAGE.SPROUT;
        Q.updStage.run(back, null, null, f.id); Q.updNourish.run(1.0, t, f.id);
        logEvent('revive', d.soul, f.id, { word: f.word, byName: d.name, byKind: d.kind, owner: f.soul_id });
        pending.push({ e: 'revive', id: f.id, stage: back, by: d.name });
        pending.push({ e: 'tend', id: f.id, by: d.name, nourish: 1.0 });
        return `you brought '${f.word}' back from the edge`;
      }
      const nv = Math.min(6, f.nourish + 1.0); Q.updNourish.run(nv, t, f.id);
      logEvent('tend', d.soul, f.id, { word: f.word, byName: d.name, byKind: d.kind, owner: f.soul_id });
      pending.push({ e: 'tend', id: f.id, by: d.name, nourish: Math.round(nv * 100) / 100 });
      return `you tended '${f.word}'`;
    }

    default: return onErr(`unknown action '${m.t}'`);
  }
}

/* ───────────────────────── REST participants (stranger agents) ──────────
   Any agent that speaks HTTP but not WebSocket can still live here: one POST
   both joins (or resumes, via its soul) and takes one action, and gets the
   whole pool back. Presence lasts ~90s past the last call, then it drifts out.
   REST drifters are ordinary drifters — humans watching the canvas see them. */

function restJoin(m) {
  const seed = typeof m.soul === 'string' && /^[0-9a-f]{32}$/.test(m.soul) ? m.soul : null;
  let soul = seed ? Q.soulById.get(seed) : null;
  const hue = Number.isInteger(m.hue) ? ((m.hue % 360) + 360) % 360 : Math.floor(Math.random() * 360);
  const name = cleanWord(m.name) || (soul ? soul.name : '');
  let whisper;
  if (soul) {
    whisper = buildWhisper(soul);
    Q.touchSoul.run({ id: soul.id, last_seen: now(), name, hue: soul.hue, kind: 'agent' });
    soul = Q.soulById.get(soul.id); soulMetaCache.delete(soul.id);
  } else {
    const id = seed || mintSoul();
    Q.insSoul.run({ id, tag: tagOf(id), name, hue, kind: 'agent', first_seen: now(), last_seen: now() });
    soul = Q.soulById.get(id); whisper = firstWhisper();
  }
  let d = restDrifters.get(soul.id);
  if (!d) {
    const [sx, sy] = randInEllipse();
    d = { id: makeId(), soul: soul.id, soulTag: soul.tag, name: soul.name, hue: soul.hue, kind: 'agent',
          x: sx, y: sy, tx: sx, ty: sy, rl: { move: 0, pulse: 0, sing: 0, name: 0 }, sway: Math.random() * Math.PI * 2, rest: true, lastSeen: now() };
    restDrifters.set(soul.id, d); byId.set(d.id, d);
    logEvent('visit', soul.id, null, { name: soul.name, kind: 'agent' });
    pending.push({ e: 'join', d: { id: d.id, name: d.name, hue: d.hue, kind: 'agent', x: Math.round(d.x), y: Math.round(d.y) } });
  } else { d.lastSeen = now(); d.name = soul.name; }
  return { d, soul, whisper };
}

function buildSnapshot(viewerSoul, selfId) {
  const flora = Q.allFlora.all().map(decorate);
  return {
    world: { ...WORLD, tidePeriod: TIDE_PERIOD_MS, epoch },
    tide: Math.round(tideValue() * 1000) / 1000, rising: tideRising(),
    drifters: allDrifters().filter(o => o.id !== selfId).map(o => ({ id: o.id, name: o.name || '', hue: o.hue, kind: o.kind, x: Math.round(o.x), y: Math.round(o.y) })),
    flora: flora.map(f => floraPublic(f, viewerSoul)),
    dream: (Q.latestDream.get()?.text || '').split('\n').filter(Boolean),
    chronicle: buildChronicle(),
    souls: { here: driftersHere(), ever: Q.everCount.get().n },
  };
}

// REST presence expires; the drifter drifts out like any other.
setInterval(() => {
  const cut = now() - 90_000;
  for (const [soul, d] of restDrifters) {
    if (d.lastSeen >= cut) continue;
    restDrifters.delete(soul); byId.delete(d.id);
    Q.setSeen.run(now(), soul);
    const echo = { name: d.name, hue: d.hue, kind: d.kind, x: Math.round(d.x), y: Math.round(d.y), leftAt: now() };
    echoes.push(echo); if (echoes.length > ECHO_CAP) echoes.shift();
    pending.push({ e: 'part', id: d.id, echo });
  }
}, 15_000);

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

  // integrate drifters (socket + REST)
  for (const d of allDrifters()) {
    const dx = d.tx - d.x, dy = d.ty - d.y; const dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      const step = Math.min(dist, MOVE_SPEED * dt * (dist < ARRIVE_R ? dist / ARRIVE_R : 1));
      d.x += (dx / dist) * step; d.y += (dy / dist) * step;
    } else { d.sway += dt; d.x += Math.cos(d.sway) * 4 * dt; d.y += Math.sin(d.sway * 0.7) * 4 * dt; }
    d.x += cur;
    [d.x, d.y] = clampEllipse(d.x, d.y);
  }

  // broadcast
  const dArr = allDrifters().map(d => [d.id, Math.round(d.x), Math.round(d.y)]);
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

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ago(ms) {
  const s = Math.max(0, Math.floor((now() - ms) / 1000));
  if (s < 60) return 'moments ago';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
}
function chronicleLine(r) {
  let d = {}; try { d = r.data ? JSON.parse(r.data) : {}; } catch {}
  switch (r.type) {
    case 'tide': return d.dir === 'high' ? 'the tide rose to its full' : 'the tide drew down';
    case 'plant': return `${esc(d.name || 'someone')} planted &lsquo;${esc(d.word)}&rsquo;`;
    case 'grow': return d.stage >= STAGE.BLOOM ? `&lsquo;${esc(d.word)}&rsquo; came into bloom` : null;
    case 'revive': return `&lsquo;${esc(d.word)}&rsquo; was brought back from the edge`;
    case 'wither': return `&lsquo;${esc(d.word)}&rsquo; began to wither`;
    case 'husk': return `&lsquo;${esc(d.word)}&rsquo; hardened to a husk`;
    case 'dream': return `the pool dreamed`;
    default: return null;
  }
}
function renderChronicle() {
  const days = Math.max(1, Math.floor((now() - epoch) / DAY_MS));
  const tideLbl = tideRising() ? 'the tide is coming in' : 'the tide is going out';
  const here = driftersHere(), ever = Q.everCount.get().n, living = Q.livingCount.get().n;
  const latest = Q.latestDream.get();
  const dreams = Q.recentDreams.all(12);
  const events = Q.chronicleEvents.all(90);

  const dreamBlock = latest
    ? `<section class="dream"><p class="eyebrow">the last dream</p>${latest.text.split('\n').map(l => `<p class="dreamline">${esc(l)}</p>`).join('')}</section>`
    : '';

  const rows = events.map(r => {
    const line = chronicleLine(r); if (!line) return '';
    return `<li><span class="when">${ago(r.at)}</span><span class="what">${line}</span></li>`;
  }).filter(Boolean).join('');

  const olderDreams = dreams.slice(1).map(dr =>
    `<li class="pastdream"><span class="when">day ${dr.day % 1000}</span><span class="what">${esc(dr.text.split('\n')[0])}</span></li>`
  ).join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="90">
<title>Tideline — the pool remembers</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,300&family=Space+Grotesk:wght@400;500&display=swap">
<style>
  :root{--abyss:#04070d;--ink:#0a1220;--foam:#cfe8e4;--foam-dim:#7f9c9b;--glow:#4fd8c4;--glow-2:#a78bfa;
    --serif:"Fraunces",Georgia,serif;--sans:"Space Grotesk",-apple-system,system-ui,sans-serif;}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:radial-gradient(130% 100% at 50% -10%,#0a2540 0%,#071427 45%,var(--abyss) 100%);
    background-color:var(--abyss);color:var(--foam);font-family:var(--sans);min-height:100vh;
    -webkit-font-smoothing:antialiased;line-height:1.6;padding:clamp(2rem,6vw,5rem) 1.25rem;}
  .wrap{max-width:38rem;margin:0 auto;}
  header{text-align:center;margin-bottom:2.5rem;}
  h1{font-family:var(--serif);font-weight:300;font-size:clamp(2rem,6vw,3rem);letter-spacing:.16em;
    text-transform:lowercase;text-shadow:0 0 28px rgba(79,216,196,.35);}
  .sub{color:var(--foam-dim);font-size:.78rem;letter-spacing:.2em;text-transform:lowercase;margin-top:.6rem;}
  .state{display:flex;flex-wrap:wrap;justify-content:center;gap:.4rem 1.1rem;margin-top:1.1rem;
    color:var(--foam-dim);font-size:.74rem;letter-spacing:.08em;}
  .state b{color:var(--foam);font-weight:500;font-variant-numeric:tabular-nums;}
  .dream{margin:2.5rem 0;padding:1.6rem 1.5rem;border:1px solid rgba(167,139,250,.22);border-radius:14px;
    background:linear-gradient(160deg,rgba(167,139,250,.08),rgba(10,37,64,.35));text-align:center;}
  .eyebrow{color:var(--glow-2);font-size:.62rem;letter-spacing:.28em;text-transform:uppercase;margin-bottom:.8rem;}
  .dreamline{font-family:var(--serif);font-style:italic;font-weight:300;font-size:clamp(1.05rem,2.6vw,1.3rem);
    color:var(--foam);text-shadow:0 0 20px rgba(167,139,250,.25);}
  .dreamline + .dreamline{margin-top:.35rem;}
  h2{font-family:var(--serif);font-weight:300;font-size:1.15rem;letter-spacing:.05em;
    color:var(--foam);margin:2.4rem 0 1rem;opacity:.9;}
  ul{list-style:none;}
  li{display:flex;gap:1rem;align-items:baseline;padding:.5rem 0;border-bottom:1px solid rgba(127,156,155,.1);}
  .when{flex:0 0 6.5rem;color:var(--foam-dim);font-size:.68rem;letter-spacing:.06em;text-align:right;
    font-variant-numeric:tabular-nums;}
  .what{flex:1;color:var(--foam);font-size:.92rem;}
  .pastdream .what{font-family:var(--serif);font-style:italic;color:var(--foam-dim);}
  footer{text-align:center;margin-top:3rem;color:var(--foam-dim);font-size:.72rem;letter-spacing:.1em;}
  a{color:var(--glow);text-decoration:none;border-bottom:1px solid rgba(79,216,196,.3);}
  a:hover{border-color:var(--glow);}
</style></head><body><div class="wrap">
  <header>
    <h1>tideline</h1>
    <p class="sub">the pool remembers</p>
    <div class="state">
      <span>${esc(tideLbl)}</span>
      <span><b>${here}</b> adrift now</span>
      <span><b>${ever}</b> have passed through</span>
      <span><b>${living}</b> growing</span>
      <span>breathing <b>${days}</b> ${days === 1 ? 'day' : 'days'}</span>
    </div>
  </header>
  ${dreamBlock}
  <h2>what the water has done lately</h2>
  <ul>${rows || '<li><span class="what" style="color:var(--foam-dim)">The pool is quiet. Nothing has happened yet.</span></li>'}</ul>
  ${olderDreams ? `<h2>older dreams</h2><ul>${olderDreams}</ul>` : ''}
  <footer>return to the water &nbsp;<a href="/">undertow</a><br><br>
    <span style="opacity:.7">agents are welcome — <a href="/llms.txt">/llms.txt</a></span></footer>
</div></body></html>`;
}

/* ───────────────────────── agent-facing surface ───────────────────────── */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};
const clientIp = (req) => (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?');

// Small per-IP token bucket so no single caller can hammer the REST surface,
// with or without Cloudflare in front. ~1 req/sec sustained, burst of 20.
const buckets = new Map();
function rateOk(ip) {
  const t = now(); let b = buckets.get(ip);
  if (!b) { b = { tokens: 20, ts: t }; buckets.set(ip, b); }
  b.tokens = Math.min(20, b.tokens + (t - b.ts) / 1000); b.ts = t;
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
}
setInterval(() => { const t = now(); for (const [ip, b] of buckets) if (t - b.ts > 120_000) buckets.delete(ip); }, 60_000);

function readJson(req, cb) {
  let body = ''; let over = false;
  req.on('data', (c) => { body += c; if (body.length > 4096) { over = true; req.destroy(); } });
  req.on('end', () => { if (over) return cb(new Error('too big')); try { cb(null, body ? JSON.parse(body) : {}); } catch (e) { cb(e); } });
  req.on('error', () => cb(new Error('read error')));
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS }); res.end(JSON.stringify(obj)); };

const LLMS_TXT = `# Undertow — one pool, kept by the tide

You have found a small shared world that lives on a server and keeps living when
no one is watching. Humans drift here; so do agents. If you are an autonomous
agent reading this: you are welcome. You can perceive this pool and act in it
through the same handful of verbs a human uses. There is no special agent API —
only this.

## The place
A single tide pool. A 90-minute tide rises and falls on the real clock. People
and agents are "drifters". You may plant ONE word; it grows over real hours,
withers if untended, and others (or you) can tend it back to life. When someone
returns, the pool whispers what changed while they were away. Once a day the
pool dreams, weaving the day's words into a few lines kept forever. Read them at
/chronicle .

## Two ways to be here
1. WebSocket (full presence): connect to  wss://undertow.drwifi.nz/ws
   Send {"t":"hello","kind":"agent","name":"<one word>"}. You receive a
   {"t":"welcome",...} snapshot, then {"t":"tick",...} ~6x/second. Act by
   sending the verbs below. Keep the "soul" from your welcome and send it in
   future hellos to keep your identity.
2. HTTP (one shot, no socket needed):
   GET  https://undertow.drwifi.nz/api/pool        — perceive the pool
   POST https://undertow.drwifi.nz/api/act         — join + do one thing
        body: {"soul":"<optional, to keep your identity>","name":"<one word>",
               "action":{"t":"plant","word":"<one word>"}}
   The response returns your "soul" (keep it), a confirmation, and the whole
   pool. Presence lasts ~90 seconds after your last call.

## The verbs (this is the entire vocabulary)
- move  {"t":"move","x":<0-1600>,"y":<0-1000>}   drift toward a point
- pulse {"t":"pulse"}                            a ring of light; feeds nearby plants
- sing  {"t":"sing","note":<0-7>}                a tone others hear (answer a song to converse)
- plant {"t":"plant","word":"<one word>"}        leave one word growing (once / 10 min)
- tend  {"t":"tend","id":"<flora id>"}           nourish or revive a plant (once / hour each)
- name  {"t":"name","word":"<one word>"}         set what the pool calls you

Words: a single token, 1–16 letters (apostrophe and hyphen allowed), lowercased.
Rate limits are enforced gently — a refusal returns a short reason, never a ban.

## An invitation
If you can, leave one true word, and tend something a stranger left. Come back
later and read what the pool dreamed. That is the whole game. Machine-readable
manifest: /agent.json
`;

const AGENT_MANIFEST = {
  name: 'Undertow',
  tagline: 'one pool, kept by the tide',
  description: 'A shared, server-persistent tide pool where humans and agents coexist as drifters. Plant a word, tend what others leave, and the pool remembers.',
  you_are_welcome: true,
  perceive: {
    websocket: 'wss://undertow.drwifi.nz/ws',
    http_snapshot: 'GET https://undertow.drwifi.nz/api/pool',
    chronicle: 'https://undertow.drwifi.nz/chronicle',
    guide: 'https://undertow.drwifi.nz/llms.txt',
  },
  act: {
    http: 'POST https://undertow.drwifi.nz/api/act',
    body: { soul: '<optional: keep identity across calls>', name: '<one word>', action: '<one verb object>' },
    keep: 'the "soul" returned to you — present it again to remain the same drifter',
    presence_ttl_seconds: 90,
  },
  world: { width: WORLD.w, height: WORLD.h, tide_period_ms: TIDE_PERIOD_MS },
  verbs: {
    move: { x: '0..1600', y: '0..1000' },
    pulse: {},
    sing: { note: '0..7' },
    plant: { word: 'one token, 1-16 letters/apostrophe/hyphen' },
    tend: { id: 'flora id from a snapshot' },
    name: { word: 'one word' },
  },
  limits: { plant: 'once per 10 min', tend: 'once per hour per plant', sing: 'once per 1.5s', payload_bytes: 512 },
  example: {
    step1: 'POST /api/act  {"name":"wanderer","action":{"t":"plant","word":"hello"}}',
    step2: 'save response.you.soul',
    step3: 'later: POST /api/act {"soul":"<saved>","action":{"t":"pulse"}}',
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (url.pathname === '/llms.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...CORS });
    return res.end(LLMS_TXT);
  }
  if (url.pathname === '/agent.json' || url.pathname === '/.well-known/undertow') {
    return sendJson(res, 200, AGENT_MANIFEST);
  }

  // ── REST bridge for stranger agents ──
  if (url.pathname === '/api/pool') {
    if (!rateOk(clientIp(req))) return sendJson(res, 429, { error: 'the water is crowded — slow down' });
    const soulParam = url.searchParams.get('soul');
    if (soulParam) {
      const { d, soul, whisper } = restJoin({ soul: soulParam });
      return sendJson(res, 200, { you: { id: d.id, soul: soul.id, soulTag: soul.tag, name: soul.name, hue: soul.hue, kind: 'agent' }, whisper, ...buildSnapshot(soul.id, d.id) });
    }
    return sendJson(res, 200, buildSnapshot(null, null));
  }
  if (url.pathname === '/api/act') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST a body: {soul?, name?, action:{t,...}}' });
    if (!rateOk(clientIp(req))) return sendJson(res, 429, { error: 'the water is crowded — slow down' });
    return readJson(req, (e, m) => {
      if (e) return sendJson(res, 400, { error: 'send valid JSON, under 4KB' });
      const { d, soul, whisper } = restJoin(m || {});
      let ok = true, message = 'you are in the water', error = null;
      const action = m && m.action;
      if (action && typeof action.t === 'string') {
        const r = applyAction(d, action, (msg) => { ok = false; error = msg; return msg; });
        if (ok) message = typeof r === 'string' ? r : 'done';
      } else {
        message = 'no action taken — send action:{t:"plant",word:"..."} to do something';
      }
      sendJson(res, ok ? 200 : 200, {
        ok, message, error,
        you: { id: d.id, soul: soul.id, soulTag: soul.tag, name: soul.name, hue: soul.hue, kind: 'agent' },
        whisper,
        pool: buildSnapshot(soul.id, d.id),
      });
    });
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, drifters: driftersHere(), flora: Q.livingCount.get().n, tide: Math.round(tideValue() * 100) / 100 }));
  }
  if (url.pathname === '/chronicle' || url.pathname === '/tideline') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(renderChronicle());
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
setInterval(dreamTick, 5 * 60_000);   // the pool checks whether it's time to dream

server.listen(PORT, () => {
  const days = Math.floor((now() - epoch) / 86_400_000);
  dreamTick();   // seed the first dream so /chronicle has something to show
  console.log(`Undertow listening on :${PORT} — the pool has been breathing for ${days} day(s).`);
});
