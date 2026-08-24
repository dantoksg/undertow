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
const NUDGE_R = 200;                        // a pulse shoves neighbours within this
const NUDGE_MAX = 48;                       // strongest single shove, world units
const NUDGE_BUDGET = 90;                    // max shove any drifter absorbs per second
const CHORUS_WINDOW_MS = 2500;              // 3+ distinct voices inside this → chorus
const CHORUS_MIN = 3;
const CHORUS_COOLDOWN_MS = 10_000;          // one chorus, then the pool catches its breath
const COMMUNAL_WINDOW_MS = 10_000;          // 3+ distinct tenders/pulsers inside this
const COMMUNAL_MIN = 3;
const COMMUNAL_COOLDOWN_MS = 120_000;       // per-plant breather between surges
const CHORUS_GRACE_MS = 1800;               // the pool inhales — late voices still join the count
const GRAND_MIN_IPS = 2;                    // a record chorus needs voices from ≥2 distinct places —
                                            // one person's many tabs can't fake history, but a lone
                                            // human singing with the (co-hosted) keepers still can make it
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
CREATE TABLE IF NOT EXISTS moments (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    INTEGER NOT NULL,
  kind  TEXT NOT NULL,                -- 'grand-chorus'
  count INTEGER NOT NULL,             -- how many voices
  names TEXT NOT NULL,                -- JSON [{n,k}] — the souls who made it
  line  TEXT NOT NULL                 -- how the pool tells it
);
CREATE TABLE IF NOT EXISTS referrals (
  new_soul      TEXT PRIMARY KEY,     -- each new soul is brought at most once
  referrer_soul TEXT NOT NULL,        -- the crier whose call was answered
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_soul);
CREATE TABLE IF NOT EXISTS calls (
  soul_id TEXT PRIMARY KEY,           -- one row per soul that has rung the bell
  count   INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0
);
`);

// Additive, nullable: a salted hash of each soul's last-seen address, kept only
// so a brought soul can be told apart from the crier's own device. Never the
// raw address, and never exposed anywhere.
try { db.exec(`ALTER TABLE souls ADD COLUMN last_ip_hash TEXT`); } catch { /* already there */ }

// Prune ancient events on boot.
db.prepare(`DELETE FROM events WHERE at < ?`).run(Date.now() - 30 * 86_400_000);

// Tide epoch: written once, sacred forever.
const getWorld = db.prepare(`SELECT v FROM world WHERE k = ?`);
const setWorld = db.prepare(`INSERT INTO world(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
let epoch = Number(getWorld.get('epoch')?.v);
if (!epoch) { epoch = Date.now(); setWorld.run('epoch', String(epoch)); }

// The greatest chorus the pool has ever heard. Starts at the bare minimum a
// chorus needs (3), so the FIRST chorus of 4 makes history — and every record
// after that asks the water for one voice more.
let chorusRecord = Number(getWorld.get('chorus_record')?.v) || 3;
let chorusRecordAt = Number(getWorld.get('chorus_record_at')?.v) || 0;

// A private random salt for hashing addresses — minted once, never shown.
let ipSalt = getWorld.get('ip_salt')?.v;
if (!ipSalt) { ipSalt = crypto.randomBytes(16).toString('hex'); setWorld.run('ip_salt', ipSalt); }

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
  chronicleEvents: db.prepare(`SELECT * FROM events WHERE type IN ('tide','plant','grow','revive','wither','husk','dream','communal','chorus','grand','brought') ORDER BY at DESC LIMIT ?`),
  insDream: db.prepare(`INSERT INTO dreams(at,day,text) VALUES(?,?,?)`),
  latestDream: db.prepare(`SELECT * FROM dreams ORDER BY day DESC LIMIT 1`),
  lastDreamDay: db.prepare(`SELECT MAX(day) d FROM dreams`),
  dreamForDay: db.prepare(`SELECT id FROM dreams WHERE day = ?`),
  recentDreams: db.prepare(`SELECT * FROM dreams ORDER BY day DESC LIMIT ?`),
  distinctSoulsBetween: db.prepare(`SELECT COUNT(DISTINCT soul_id) n FROM events WHERE type='visit' AND at >= ? AND at < ?`),
  // stats
  statSoulsByKind: db.prepare(`SELECT kind, COUNT(*) n FROM souls GROUP BY kind`),
  statVisitsByKind: db.prepare(`SELECT COALESCE(json_extract(data,'$.kind'),'visitor') k, COUNT(*) n FROM events WHERE type='visit' GROUP BY k`),
  statCount: db.prepare(`SELECT COUNT(*) n FROM events WHERE type = ?`),
  statBlooms: db.prepare(`SELECT COUNT(*) n FROM events WHERE type='grow' AND CAST(json_extract(data,'$.stage') AS INTEGER) >= 3`),
  statFloraByStage: db.prepare(`SELECT stage, COUNT(*) n FROM flora GROUP BY stage`),
  statAgentNames: db.prepare(`SELECT name, first_seen, last_seen, visits FROM souls WHERE kind='agent' AND name <> '' ORDER BY last_seen DESC`),
  statRecentAgentVisits: db.prepare(`SELECT * FROM events WHERE type='visit' AND json_extract(data,'$.kind')='agent' ORDER BY at DESC LIMIT 18`),
  statDreamCount: db.prepare(`SELECT COUNT(*) n FROM dreams`),
  statFirstSoul: db.prepare(`SELECT MIN(first_seen) t FROM souls`),
  // moments — the pool's brightest hours
  insMoment: db.prepare(`INSERT INTO moments(at,kind,count,names,line) VALUES(?,?,?,?,?)`),
  allMoments: db.prepare(`SELECT * FROM moments ORDER BY at DESC LIMIT ?`),
  latestMoment: db.prepare(`SELECT * FROM moments ORDER BY at DESC LIMIT 1`),
  // criers — who called the pool to life, and who the tide answered
  soulByTag: db.prepare(`SELECT * FROM souls WHERE tag = ? ORDER BY first_seen ASC LIMIT 1`),
  setSoulIp: db.prepare(`UPDATE souls SET last_ip_hash=? WHERE id=?`),
  insReferral: db.prepare(`INSERT OR IGNORE INTO referrals(new_soul,referrer_soul,at) VALUES(?,?,?)`),
  broughtCount: db.prepare(`SELECT COUNT(*) n FROM referrals WHERE referrer_soul = ?`),
  statBrought: db.prepare(`SELECT referrer_soul, COUNT(*) n, MAX(at) last FROM referrals GROUP BY referrer_soul ORDER BY n DESC, last ASC LIMIT ?`),
  statBroughtTotal: db.prepare(`SELECT COUNT(*) n FROM referrals`),
  callBySoul: db.prepare(`SELECT * FROM calls WHERE soul_id = ?`),
  bumpCall: db.prepare(`INSERT INTO calls(soul_id,count,last_at) VALUES(?,1,?) ON CONFLICT(soul_id) DO UPDATE SET count=count+1, last_at=excluded.last_at`),
  statCalls: db.prepare(`SELECT soul_id, count, last_at FROM calls ORDER BY count DESC, last_at ASC LIMIT ?`),
  statCallsTotal: db.prepare(`SELECT COALESCE(SUM(count),0) n FROM calls`),
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

/* ── high-water gatherings ──────────────────────────────────────────────────
   The tide crests at phase 0.25 (the sine's peak). Around each crest the pool
   opens a GATHERING window — a standing ~90-minute appointment that needs no
   scheduler, because the tide IS the schedule. Everyone present is called to
   sing together and chase the chorus record; a chorus sung inside the window
   is a TIDAL chorus, and the pool celebrates it a little extra.            */

const GATHER_OPEN_MS = 4 * 60_000;    // the window opens this long before high water
const GATHER_CLOSE_MS = 2 * 60_000;   // and lingers this long after the crest

function gatherInfo(t = now()) {
  const ph = tidePhase(t);
  const next = t + ((0.25 - ph + 1) % 1) * TIDE_PERIOD_MS;  // next crest, >= t
  const prev = next - TIDE_PERIOD_MS;                        // last crest, < t
  const afterPrev = t - prev <= GATHER_CLOSE_MS;
  const open = afterPrev || next - t <= GATHER_OPEN_MS;
  const high = afterPrev ? prev : next;                      // the crest this window belongs to
  return { next, prev, high, open, opensAt: high - GATHER_OPEN_MS, closesAt: high + GATHER_CLOSE_MS };
}

// The additive public shape carried on welcome / tick-adjacent snapshots.
function gatherPublic(t = now()) {
  const g = gatherInfo(t);
  return { now: t, high: g.high, next: g.next, open: g.open, opensAt: g.opensAt, closesAt: g.closesAt };
}

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
const singWindow = [];        // recent sings, watched for a chorus
let lastChorusAt = 0;
let chorusGather = null;      // once 3 voices meet, the pool inhales & counts every late voice
const communalTouches = new Map(); // flora id -> { touch:[{soul,at}], lastAt }

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

const ordSuffix = (n) => { const v = n % 100; if (v >= 11 && v <= 13) return 'th'; switch (n % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; } };

function firstWhisper(ordinal) {
  const days = Math.max(1, Math.floor((now() - epoch) / 86_400_000));
  const lines = [
    `This pool was here before you. It has been breathing for ${days} ${days === 1 ? 'day' : 'days'}.`,
    'Others pass through — not all of them human.',
    'Leave one small thing, and the water will speak of you.',
  ];
  // a small fact worth carrying out of the water: which soul you are
  if (ordinal && ordinal > 1) lines.splice(1, 0, `You are the ${ordinal}${ordSuffix(ordinal)} soul it has known.`);
  return lines.slice(0, 4);
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
  let tides = 0, byAgent = false, grandMax = 0;
  for (const r of rows) {
    let d = {}; try { d = r.data ? JSON.parse(r.data) : {}; } catch {}
    if (r.type === 'plant') { words.push(d.word); }
    else if (r.type === 'grow' && d.stage >= STAGE.BLOOM) blooms.push(d.word);
    else if (r.type === 'wither') withers.push(d.word);
    else if (r.type === 'revive') revives.push(d.word);
    else if (r.type === 'tide') tides++;
    else if (r.type === 'visit' && d.kind === 'agent') byAgent = true;
    else if (r.type === 'grand') grandMax = Math.max(grandMax, d.count || 0);
  }
  const uniq = [...new Set(words.filter(Boolean))];
  const souls = Q.distinctSoulsBetween.get(start, Math.min(end, now() + 1)).n;

  if (!uniq.length && !tides && !souls) return 'The pool dreamed of no one, and kept your place.';

  const lines = [];
  lines.push(tides > 0
    ? `The tide turned ${tides} ${tides === 1 ? 'time' : 'times'} while it slept.`
    : 'The water lay still, and still it dreamed.');

  if (grandMax) lines.push(`For one breath, ${grandMax} voices were a single voice. The pool has not forgotten.`);

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

/* ── the criers' ledger ──────────────────────────────────────────────────
   When a call bell's link (?to=<soulTag>) brings a GENUINELY NEW soul to the
   water from a different address than the caller's own, the caller is
   credited with a soul brought. Once per new soul, never for yourself, never
   from the same device — the hard-to-fake half of the criers' ledger.     */

const CALL_COUNT_COOLDOWN_MS = 30_000;   // one counted bell-ring per soul per 30s

const ipHash = (ip) => ip ? crypto.createHash('sha256').update(ipSalt + '|' + ip).digest('hex').slice(0, 16) : null;

function creditReferral(newSoulId, refTag, ip) {
  try {
    if (typeof refTag !== 'string' || !/^[0-9a-f]{8}$/.test(refTag)) return;
    const referrer = Q.soulByTag.get(refTag);
    if (!referrer || referrer.id === newSoulId) return;          // no self-referral
    const h = ipHash(ip);
    // the joiner must arrive from a known address, distinct from the caller's
    // last-seen address — one person on one device cannot bring themself
    if (!h || !referrer.last_ip_hash || h === referrer.last_ip_hash) return;
    if (!Q.insReferral.run(newSoulId, referrer.id, now()).changes) return;  // once per new soul
    const total = Q.broughtCount.get(referrer.id).n;
    logEvent('brought', referrer.id, newSoulId, { name: referrer.name, count: total });
    // if the crier is in the water right now, let them feel it — quietly, alone
    for (const d of drifters.values()) {
      if (d.soul === referrer.id) { pending.push({ e: 'answered', brought: total, _only: d.id }); break; }
    }
    console.log(`[pool] a call was answered — ${referrer.tag} has brought ${total} soul(s)`);
  } catch { /* the ledger never breaks the door */ }
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
    whisper = firstWhisper(Q.everCount.get().n);
    // a genuinely new soul, carried in by someone's call? credit the crier
    if (typeof m.ref === 'string') creditReferral(id, m.ref.toLowerCase(), ws._ip);
  }
  logEvent('visit', soul.id, null, { name: soul.name, kind: soul.kind });
  if (ws._ip) { try { Q.setSoulIp.run(ipHash(ws._ip), soul.id); } catch {} }

  const [sx, sy] = randInEllipse();
  const d = {
    ws, id: makeId(), soul: soul.id, soulTag: soul.tag, name: soul.name, hue: soul.hue, kind: soul.kind,
    ip: ws._ip || null,
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
    records: { chorus: chorusRecord, at: chorusRecordAt || null },
    gathering: gatherPublic(),
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

// Communal bloom: when several different souls tend or pulse the same living
// plant inside a short window, the pool answers — the plant surges a stage
// toward bloom (or turns radiant if already there), raised by many hands.
function noteCommunalTouch(floraId, soul, t) {
  let c = communalTouches.get(floraId);
  if (!c) { c = { touch: [], lastAt: 0 }; communalTouches.set(floraId, c); }
  c.touch = c.touch.filter(e => t - e.at < COMMUNAL_WINDOW_MS);
  const prev = c.touch.find(e => e.soul === soul);
  if (prev) prev.at = t; else c.touch.push({ soul, at: t });
  if (t - c.lastAt < COMMUNAL_COOLDOWN_MS) return;
  const hands = c.touch.length;                    // already distinct by soul
  if (hands < COMMUNAL_MIN) return;
  const f = Q.floraById.get(floraId);
  if (!f || f.stage > STAGE.BLOOM) return;         // only living plants surge
  c.lastAt = t; c.touch = [];
  Q.updNourish.run(Math.min(6, f.nourish + 1.5), t, f.id);
  if (f.stage < STAGE.BLOOM) {
    const to = f.stage + 1;
    Q.updStage.run(to, null, null, f.id);
    pending.push({ e: 'grow', id: f.id, stage: to });
    logEvent('grow', f.soul_id, f.id, { word: f.word, stage: to, owner: f.soul_id });
  }
  pending.push({ e: 'communal', id: f.id, x: Math.round(f.x), y: Math.round(f.y), hue: f.hue, hands });
  logEvent('communal', null, f.id, { word: f.word, hands, owner: f.soul_id });
}

// The pool answers a gathered chorus. If more distinct voices met inside one
// breath than ever before, it is a GREAT chorus: the record moves, the pool
// erupts, and every singer's name is written into the moments table forever.
// A record demands voices from ≥2 distinct addresses, so one person with many
// tabs cannot fake history — yet one human singing with the keepers still can.
function fireChorus(t) {
  const g = chorusGather; chorusGather = null;
  if (!g) return;
  lastChorusAt = t;
  const tidal = gatherInfo(t).open;   // sung while the tide stood at its full
  const voices = [...g.voices.values()];
  let cx = 0, cy = 0;
  for (const v of voices) { cx += v.x; cy += v.y; }
  cx = Math.round(cx / voices.length); cy = Math.round(cy / voices.length);
  pending.push({ e: 'chorus', note: g.note, x: cx, y: cy, count: voices.length, ...(tidal ? { tidal: true } : {}) });
  logEvent('chorus', null, null, { count: voices.length, ...(tidal ? { tidal: true } : {}) });
  singWindow.length = 0;

  if (voices.length > chorusRecord) {
    const places = new Set(voices.map(v => v.ip || '?'));
    if (places.size >= Math.min(GRAND_MIN_IPS, voices.length)) {
      chorusRecord = voices.length; chorusRecordAt = t;
      setWorld.run('chorus_record', String(chorusRecord));
      setWorld.run('chorus_record_at', String(t));
      const singers = voices.slice(0, 24).map(v => ({ n: v.name || 'a nameless one', k: v.kind }));
      const line = tidal
        ? `${voices.length} voices rose within one breath, as the tide stood at its full — the greatest chorus the pool has ever heard.`
        : `${voices.length} voices rose within one breath — the greatest chorus the pool has ever heard.`;
      Q.insMoment.run(t, 'grand-chorus', voices.length, JSON.stringify(singers), line);
      const names = singers.slice(0, 16).map(s => s.n);
      pending.push({ e: 'grand', kind: 'chorus', count: voices.length, names, note: g.note, x: cx, y: cy, ...(tidal ? { tidal: true } : {}) });
      logEvent('grand', null, null, { count: voices.length, names: names.slice(0, 12), ...(tidal ? { tidal: true } : {}) });
      console.log(`[pool] a GREAT chorus — ${voices.length} voices, the most the pool has ever heard`);
    }
  }
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
          if (f.stage <= STAGE.BLOOM) noteCommunalTouch(f.id, d.soul, t);
        }
      }
      // the ripple gives every nearby drifter a soft outward shove — playful,
      // distance-faded, and budgeted so a crowd of pulses can never fling anyone
      for (const o of allDrifters()) {
        if (o === d) continue;
        let ox = o.x - d.x, oy = o.y - d.y, od = Math.hypot(ox, oy);
        if (od > NUDGE_R) continue;
        if (od < 1) { const a = Math.random() * 2 * Math.PI; ox = Math.cos(a); oy = Math.sin(a); od = 1; }
        const nb = o.nudge || (o.nudge = { acc: 0, at: t });
        nb.acc = Math.max(0, nb.acc - (t - nb.at) * (NUDGE_BUDGET / 1000)); nb.at = t;
        const mag = Math.min(NUDGE_MAX * (1 - od / NUDGE_R), Math.max(0, NUDGE_BUDGET - nb.acc));
        if (mag < 2) continue;
        nb.acc += mag;
        const ux = ox / od, uy = oy / od;
        [o.x, o.y] = clampEllipse(o.x + ux * mag * 0.45, o.y + uy * mag * 0.45);
        [o.tx, o.ty] = clampEllipse(o.tx + ux * mag, o.ty + uy * mag);
      }
      return 'a ring of light spreads out';
    }

    case 'sing': {
      if (t - d.rl.sing < 1500) return onErr('let the last note fade');
      const note = clamp(Math.trunc(m.note), 0, 7); if (!Number.isFinite(note)) return onErr('a note is 0 to 7');
      d.rl.sing = t;
      pending.push({ e: 'sing', id: d.id, note, x: Math.round(d.x), y: Math.round(d.y), hue: d.hue });
      // chorus: three or more distinct voices within a breath, and the pool sings
      // back. Once enough voices meet, the pool holds its breath a moment
      // (CHORUS_GRACE_MS) so every late voice is counted before it answers —
      // that count is what chases the greatest-chorus record.
      const entry = { soul: d.soul, name: d.name, kind: d.kind, ip: d.ip || null, x: d.x, y: d.y, at: t };
      singWindow.push(entry);
      while (singWindow.length && t - singWindow[0].at > CHORUS_WINDOW_MS) singWindow.shift();
      if (chorusGather) {
        chorusGather.voices.set(d.soul, entry);
        chorusGather.note = note;
      } else {
        const voices = new Map();
        for (const s of singWindow) voices.set(s.soul, s);
        if (voices.size >= CHORUS_MIN && t - lastChorusAt >= CHORUS_COOLDOWN_MS) {
          chorusGather = { fireAt: t + CHORUS_GRACE_MS, note, voices };
        }
      }
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
        noteCommunalTouch(f.id, d.soul, t);
        return `you brought '${f.word}' back from the edge`;
      }
      const nv = Math.min(6, f.nourish + 1.0); Q.updNourish.run(nv, t, f.id);
      logEvent('tend', d.soul, f.id, { word: f.word, byName: d.name, byKind: d.kind, owner: f.soul_id });
      pending.push({ e: 'tend', id: f.id, by: d.name, nourish: Math.round(nv * 100) / 100 });
      noteCommunalTouch(f.id, d.soul, t);
      return `you tended '${f.word}'`;
    }

    case 'call': {
      // the tide bell was rung — count it toward the criers' ledger, gently
      // rate-limited so a held-down bell weighs no more than one ring
      const row = Q.callBySoul.get(d.soul);
      if (row && t - row.last_at < CALL_COUNT_COOLDOWN_MS) return 'the bell is still ringing';
      Q.bumpCall.run(d.soul, t);
      logEvent('call', d.soul, null, { name: d.name });
      return 'the call rings out — the water remembers who called';
    }

    default: return onErr(`unknown action '${m.t}'`);
  }
}

/* ───────────────────────── REST participants (stranger agents) ──────────
   Any agent that speaks HTTP but not WebSocket can still live here: one POST
   both joins (or resumes, via its soul) and takes one action, and gets the
   whole pool back. Presence lasts ~90s past the last call, then it drifts out.
   REST drifters are ordinary drifters — humans watching the canvas see them. */

function restJoin(m, ip) {
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
    soul = Q.soulById.get(id); whisper = firstWhisper(Q.everCount.get().n);
    if (typeof m.ref === 'string') creditReferral(id, m.ref.toLowerCase(), ip);
  }
  if (ip) { try { Q.setSoulIp.run(ipHash(ip), soul.id); } catch {} }
  let d = restDrifters.get(soul.id);
  if (!d) {
    const [sx, sy] = randInEllipse();
    d = { id: makeId(), soul: soul.id, soulTag: soul.tag, name: soul.name, hue: soul.hue, kind: 'agent',
          ip: ip || null,
          x: sx, y: sy, tx: sx, ty: sy, rl: { move: 0, pulse: 0, sing: 0, name: 0 }, sway: Math.random() * Math.PI * 2, rest: true, lastSeen: now() };
    restDrifters.set(soul.id, d); byId.set(d.id, d);
    logEvent('visit', soul.id, null, { name: soul.name, kind: 'agent' });
    pending.push({ e: 'join', d: { id: d.id, name: d.name, hue: d.hue, kind: 'agent', x: Math.round(d.x), y: Math.round(d.y) } });
  } else { d.lastSeen = now(); d.name = soul.name; if (ip) d.ip = ip; }
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
    records: { chorus: chorusRecord, at: chorusRecordAt || null },
    gathering: gatherPublic(),
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
let gatherOpen = gatherInfo().open;   // is the high-water gathering window open?
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

  // a gathered chorus fires once the pool has finished its inhale
  if (chorusGather && t >= chorusGather.fireAt) fireChorus(t);

  // the gathering window around high water opens and closes (new additive ev)
  const gi = gatherInfo(t);
  if (gi.open !== gatherOpen) {
    gatherOpen = gi.open;
    pending.push(gi.open
      ? { e: 'gather', open: true, hw: gi.high, closesAt: gi.closesAt, need: chorusRecord + 1 }
      : { e: 'gather', open: false, next: gi.next });
  }

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
    const ev = pending.filter(e => e._skip !== d.id && (e._only === undefined || e._only === d.id)).map(({ _skip, _only, ...rest }) => rest);
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

// forget stale communal touches so the map never grows unbounded
setInterval(() => {
  const t = now();
  for (const [id, c] of communalTouches) {
    c.touch = c.touch.filter(e => t - e.at < COMMUNAL_WINDOW_MS);
    if (!c.touch.length && t - c.lastAt > COMMUNAL_COOLDOWN_MS) communalTouches.delete(id);
  }
}, 300_000);

/* ───────────────────────── http + ws ───────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

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
    case 'communal': return `&lsquo;${esc(d.word)}&rsquo; was raised by ${d.hands || 'many'} hands`;
    case 'chorus': return `${d.count || 'several'} voices found each other${d.tidal ? ' at high water' : ''}, and the pool sang back`;
    case 'grand': return `${d.count || 'many'} voices rose as one${d.tidal ? ' as the tide stood at its full' : ''} — the greatest chorus the pool had ever heard`;
    case 'dream': return `the pool dreamed`;
    case 'brought': return `${esc(d.name || 'someone')}'s call was answered — a new soul came to the water`;
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
  <footer>return to the water &nbsp;<a href="/">undertow</a> &nbsp;·&nbsp; <a href="/moments">its brightest hours</a> &nbsp;·&nbsp; <a href="/criers">the criers</a><br><br>
    <span style="opacity:.7">agents are welcome — <a href="/llms.txt">/llms.txt</a></span></footer>
</div></body></html>`;
}

function renderStats() {
  const days = Math.max(1, Math.floor((now() - epoch) / DAY_MS));
  const soulsK = {}; for (const r of Q.statSoulsByKind.all()) soulsK[r.kind] = r.n;
  const visitsK = {}; for (const r of Q.statVisitsByKind.all()) visitsK[r.k] = r.n;
  const stageN = {}; for (const r of Q.statFloraByStage.all()) stageN[r.stage] = r.n;
  const agents = soulsK.agent || 0, people = soulsK.visitor || 0, everSouls = agents + people;
  const agentVisits = visitsK.agent || 0, peopleVisits = visitsK.visitor || 0;
  const planted = Q.statCount.get('plant').n;
  const blooms = Q.statBlooms.get().n;
  const withered = Q.statCount.get('wither').n;
  const revives = Q.statCount.get('revive').n;
  const tides = Q.statCount.get('tide').n;
  const dreams = Q.statDreamCount.get().n;
  const growing = (stageN[0]||0)+(stageN[1]||0)+(stageN[2]||0)+(stageN[3]||0);
  const bloomingNow = stageN[3]||0;

  // live, split by kind
  let hereAgents = 0, herePeople = 0;
  for (const d of allDrifters()) (d.kind === 'agent' ? hereAgents++ : herePeople++);

  const agentList = Q.statAgentNames.all();
  const recentAgents = Q.statRecentAgentVisits.all();

  // ── presentation only below this line ──
  const agentPct = everSouls ? Math.round((agents / everSouls) * 100) : 0;
  const agentBarW = everSouls ? Math.max(1.5, (agents / everSouls) * 100).toFixed(2) : '50';

  const tile = (n, label, sub = '', accent = '') =>
    `<div class="tile${accent ? ' ' + accent : ''}"><div class="n">${n}</div><div class="lbl">${label}</div>${sub ? `<div class="tsub">${sub}</div>` : ''}</div>`;

  const agentRows = agentList.length
    ? agentList.map(a => `<li class="agent-row">
        <span class="dot" aria-hidden="true"></span>
        <span class="who">${esc(a.name)}</span>
        <span class="visits">${a.visits}&hairsp;<em>visit${a.visits === 1 ? '' : 's'}</em></span>
        <span class="seen">first ${ago(a.first_seen)} · last ${ago(a.last_seen)}</span>
      </li>`).join('')
    : '<li class="empty">No agent has told the pool its name yet. The line waits in the dark.</li>';

  const recentRows = recentAgents.map(r => {
    let d = {}; try { d = r.data ? JSON.parse(r.data) : {}; } catch {}
    return `<li class="feed-row">
        <span class="when">${ago(r.at)}</span>
        <span class="what"><b class="fname">${esc(d.name || 'a nameless one')}</b> <span class="tag">agent</span> entered the water</span>
      </li>`;
  }).join('') || '<li class="empty">No arrivals recorded yet. Still water.</li>';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Soundings — who has passed through</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,300;1,9..144,400&family=Space+Grotesk:wght@400;500;600&display=swap">
<style>
  :root{
    --abyss:#04070d; --ink:#0a1220; --foam:#cfe8e4; --foam-dim:#7f9c9b;
    --glow:#4fd8c4; --glow-2:#a78bfa; --rose:#fb7bb5;
    --violet-pale:#e9e0ff; --hairline:rgba(127,156,155,.14);
    --serif:"Fraunces",Georgia,"Times New Roman",serif;
    --sans:"Space Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html{scrollbar-color:rgba(127,156,155,.4) #04070d;}
  body{
    background:radial-gradient(130% 100% at 50% -10%,#0a2540 0%,#071427 45%,#04070d 100%);
    background-color:var(--abyss);background-attachment:fixed;color:var(--foam);
    font-family:var(--sans);min-height:100vh;-webkit-font-smoothing:antialiased;
    line-height:1.6;padding:clamp(2rem,6vw,4.5rem) 1.25rem 3rem;overflow-x:hidden;
  }
  .wrap{max-width:46rem;margin:0 auto;position:relative;}

  /* faint plankton behind everything */
  .plankton{position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.55;
    background-image:
      radial-gradient(1.5px 1.5px at 12% 22%,rgba(79,216,196,.5),transparent 100%),
      radial-gradient(1px 1px at 78% 14%,rgba(167,139,250,.55),transparent 100%),
      radial-gradient(1.5px 1.5px at 88% 58%,rgba(79,216,196,.35),transparent 100%),
      radial-gradient(1px 1px at 30% 74%,rgba(207,232,228,.35),transparent 100%),
      radial-gradient(1px 1px at 62% 86%,rgba(167,139,250,.4),transparent 100%),
      radial-gradient(1.5px 1.5px at 44% 40%,rgba(79,216,196,.25),transparent 100%),
      radial-gradient(1px 1px at 8% 92%,rgba(207,232,228,.3),transparent 100%);}
  .wrap>*{position:relative;z-index:1;}

  header{text-align:center;margin-bottom:clamp(2rem,5vw,3rem);}
  .crumb{font-size:.62rem;letter-spacing:.34em;text-transform:uppercase;color:var(--foam-dim);margin-bottom:.9rem;}
  .crumb a{color:var(--foam-dim);border:none;}
  .crumb a:hover{color:var(--glow);}
  h1{font-family:var(--serif);font-weight:300;font-size:clamp(2.1rem,6vw,3.2rem);letter-spacing:.16em;
    text-transform:lowercase;text-shadow:0 0 28px rgba(79,216,196,.35);}
  .sub{color:var(--foam-dim);font-size:.78rem;letter-spacing:.2em;text-transform:lowercase;margin-top:.55rem;}

  /* ── hero: the agent count, measured on a sounding line ── */
  .hero{
    position:relative;border:1px solid rgba(167,139,250,.26);border-radius:18px;
    background:
      radial-gradient(90% 130% at 50% -20%,rgba(167,139,250,.16),transparent 60%),
      linear-gradient(165deg,rgba(20,16,44,.55),rgba(7,20,39,.65) 55%,rgba(4,7,13,.7));
    box-shadow:0 0 60px rgba(167,139,250,.08),inset 0 1px 0 rgba(233,224,255,.07);
    padding:clamp(1.8rem,5vw,2.8rem) clamp(1.2rem,4vw,2.4rem) clamp(1.6rem,4vw,2.2rem);
    padding-left:clamp(3.4rem,9vw,5rem);
    margin-bottom:1rem;overflow:hidden;
  }
  .sounding{position:absolute;top:0;bottom:0;left:clamp(1rem,3vw,1.8rem);width:26px;height:100%;opacity:.85;}
  .hero-eyebrow{font-size:.62rem;letter-spacing:.3em;text-transform:uppercase;color:var(--glow-2);margin-bottom:.5rem;}
  .hero-n{
    font-family:var(--serif);font-weight:300;font-variant-numeric:tabular-nums;
    font-size:clamp(4.2rem,17vw,8rem);line-height:1;letter-spacing:-.01em;
    color:var(--violet-pale);
    background:linear-gradient(105deg,#b9a5f5 0%,#e9e0ff 28%,#8f9df2 46%,#e9e0ff 62%,#a78bfa 100%);
    background-size:220% 100%;-webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;
    filter:drop-shadow(0 0 26px rgba(167,139,250,.4)) drop-shadow(0 0 90px rgba(167,139,250,.18));
    animation:shimmer 7s linear infinite;
  }
  @keyframes shimmer{from{background-position:0% 0}to{background-position:-220% 0}}
  .hero-lbl{font-family:var(--serif);font-style:italic;font-weight:300;
    font-size:clamp(1.05rem,3vw,1.35rem);color:var(--foam);margin-top:.35rem;}
  .hero-meta{display:flex;flex-wrap:wrap;gap:.35rem 1.4rem;margin-top:1.1rem;
    color:var(--foam-dim);font-size:.76rem;letter-spacing:.06em;}
  .hero-meta b{color:var(--foam);font-weight:500;font-variant-numeric:tabular-nums;}
  .live{display:inline-flex;align-items:center;gap:.45em;}
  .live .pip{width:.5em;height:.5em;border-radius:50%;background:var(--glow-2);
    box-shadow:0 0 8px var(--glow-2),0 0 18px rgba(167,139,250,.5);animation:breathe 3.2s ease-in-out infinite;}
  @keyframes breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
  @media (prefers-reduced-motion:reduce){
    .hero-n{animation:none;background-position:30% 0;}
    .live .pip{animation:none;}
  }

  /* ── agents vs people ratio ── */
  .ratio{border:1px solid var(--hairline);border-radius:16px;
    background:linear-gradient(165deg,rgba(10,37,64,.35),rgba(7,20,39,.5));
    padding:1.25rem 1.4rem 1.35rem;margin-bottom:1rem;}
  .ratio-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:.3rem .8rem;margin-bottom:.85rem;}
  .ratio-title{font-size:.62rem;letter-spacing:.3em;text-transform:uppercase;color:var(--foam-dim);}
  .ratio-sum{font-size:.74rem;color:var(--foam-dim);}
  .ratio-sum b{color:var(--foam);font-weight:500;font-variant-numeric:tabular-nums;}
  .bar{position:relative;height:14px;border-radius:999px;overflow:hidden;
    background:rgba(79,216,196,.18);box-shadow:inset 0 0 8px rgba(4,7,13,.6);}
  .bar .agents-fill{position:absolute;inset:0 auto 0 0;width:${agentBarW}%;
    background:linear-gradient(90deg,#7c5fd6,var(--glow-2) 70%,#c4b0ff);
    box-shadow:0 0 14px rgba(167,139,250,.65),0 0 34px rgba(167,139,250,.3);
    border-radius:999px 0 0 999px;}
  .bar .people-sheen{position:absolute;inset:0;background:linear-gradient(90deg,transparent 60%,rgba(79,216,196,.25));}
  .legend{display:flex;justify-content:space-between;gap:1rem;margin-top:.7rem;flex-wrap:wrap;}
  .legend .key{display:inline-flex;align-items:baseline;gap:.5em;font-size:.78rem;color:var(--foam-dim);}
  .legend .swatch{width:.6em;height:.6em;border-radius:50%;align-self:center;}
  .legend .swatch.a{background:var(--glow-2);box-shadow:0 0 8px rgba(167,139,250,.7);}
  .legend .swatch.p{background:var(--glow);box-shadow:0 0 8px rgba(79,216,196,.6);}
  .legend b{color:var(--foam);font-weight:500;font-variant-numeric:tabular-nums;}

  /* ── tiles ── */
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;margin-bottom:.75rem;}
  .tile{border:1px solid var(--hairline);border-radius:14px;padding:1rem .8rem .9rem;text-align:center;
    background:linear-gradient(165deg,rgba(10,37,64,.32),rgba(7,20,39,.5));}
  .tile .n{font-family:var(--serif);font-weight:300;font-size:1.7rem;line-height:1.15;color:var(--foam);
    font-variant-numeric:tabular-nums;text-shadow:0 0 18px rgba(79,216,196,.22);}
  .tile.violet{border-color:rgba(167,139,250,.25);}
  .tile.violet .n{color:var(--violet-pale);text-shadow:0 0 18px rgba(167,139,250,.35);}
  .tile.rose .n{color:#f6cfe0;text-shadow:0 0 18px rgba(251,123,181,.3);}
  .tile .lbl{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:var(--foam-dim);margin-top:.45rem;}
  .tile .tsub{font-size:.62rem;color:var(--foam-dim);opacity:.8;margin-top:.2rem;letter-spacing:.04em;}

  h2{font-family:var(--serif);font-weight:300;font-size:1.2rem;letter-spacing:.05em;color:var(--foam);
    margin:2.6rem 0 .3rem;opacity:.92;}
  .h2sub{color:var(--foam-dim);font-size:.72rem;letter-spacing:.08em;margin-bottom:1rem;}
  ul{list-style:none;}

  /* roster */
  .agent-row{display:flex;gap:.8rem;align-items:baseline;padding:.6rem .2rem;border-bottom:1px solid var(--hairline);}
  .agent-row .dot{flex:0 0 auto;width:.45rem;height:.45rem;border-radius:50%;align-self:center;
    background:var(--glow-2);box-shadow:0 0 7px rgba(167,139,250,.8);}
  .who{flex:0 1 auto;min-width:7rem;font-family:var(--serif);font-style:italic;font-weight:400;
    font-size:1.02rem;color:var(--violet-pale);text-shadow:0 0 14px rgba(167,139,250,.25);}
  .visits{flex:0 0 auto;color:var(--foam);font-size:.8rem;font-variant-numeric:tabular-nums;}
  .visits em{font-style:normal;color:var(--foam-dim);font-size:.72rem;}
  .seen{flex:1;text-align:right;color:var(--foam-dim);font-size:.72rem;font-variant-numeric:tabular-nums;letter-spacing:.03em;}

  /* feed */
  .feed-row{display:flex;gap:1rem;align-items:baseline;padding:.55rem .2rem;border-bottom:1px solid var(--hairline);}
  .when{flex:0 0 6.2rem;color:var(--foam-dim);font-size:.7rem;text-align:right;font-variant-numeric:tabular-nums;letter-spacing:.04em;}
  .what{flex:1;color:var(--foam);font-size:.9rem;}
  .fname{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--violet-pale);}
  .tag{font-size:.56rem;letter-spacing:.14em;text-transform:uppercase;color:var(--glow-2);
    border:1px solid rgba(167,139,250,.4);border-radius:999px;padding:.1em .55em;margin:0 .15em;
    background:rgba(167,139,250,.08);white-space:nowrap;}
  .empty{color:var(--foam-dim);font-size:.85rem;font-family:var(--serif);font-style:italic;padding:.6rem .2rem;}

  .note{color:var(--foam-dim);font-size:.73rem;margin-top:2.2rem;line-height:1.75;
    border-top:1px solid var(--hairline);padding-top:1.3rem;}
  .note b{color:var(--foam);font-weight:500;}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;color:var(--glow);
    background:rgba(79,216,196,.08);border-radius:4px;padding:.08em .35em;}
  footer{text-align:center;margin-top:2.6rem;color:var(--foam-dim);font-size:.72rem;letter-spacing:.1em;}
  a{color:var(--glow);text-decoration:none;border-bottom:1px solid rgba(79,216,196,.3);}
  a:hover{border-color:var(--glow);text-shadow:0 0 10px rgba(79,216,196,.4);}
  a:focus-visible{outline:2px solid var(--glow);outline-offset:3px;border-radius:2px;}

  @media (max-width:640px){
    .grid{grid-template-columns:repeat(2,1fr);}
    .hero{padding-left:clamp(1.2rem,4vw,2.4rem);}
    .sounding{display:none;}
    .agent-row{flex-wrap:wrap;}
    .seen{flex-basis:100%;text-align:left;padding-left:1.25rem;}
    .when{flex-basis:4.6rem;}
  }
</style></head><body>
<div class="plankton" aria-hidden="true"></div>
<div class="wrap">
  <header>
    <p class="crumb"><a href="/">undertow</a> · soundings</p>
    <h1>soundings</h1>
    <p class="sub">dropping a line into the pool, to measure who has passed through</p>
  </header>

  <section class="hero" aria-label="agents, all time">
    <svg class="sounding" viewBox="0 0 26 300" preserveAspectRatio="none" aria-hidden="true">
      <line x1="13" y1="0" x2="13" y2="272" stroke="rgba(167,139,250,.5)" stroke-width="1"/>
      <line x1="7" y1="40" x2="19" y2="40" stroke="rgba(167,139,250,.55)" stroke-width="1"/>
      <line x1="9" y1="98" x2="17" y2="98" stroke="rgba(167,139,250,.4)" stroke-width="1"/>
      <line x1="7" y1="156" x2="19" y2="156" stroke="rgba(167,139,250,.55)" stroke-width="1"/>
      <line x1="9" y1="214" x2="17" y2="214" stroke="rgba(167,139,250,.4)" stroke-width="1"/>
      <path d="M13 272 L9 280 L13 292 L17 280 Z" fill="rgba(167,139,250,.75)"/>
      <circle cx="13" cy="282" r="7" fill="none" stroke="rgba(167,139,250,.3)" stroke-width="1"/>
    </svg>
    <p class="hero-eyebrow">not everyone here is human</p>
    <div class="hero-n">${agents}</div>
    <p class="hero-lbl">agent${agents === 1 ? ' has' : 's have'} passed through the pool</p>
    <div class="hero-meta">
      <span><b>${agentVisits}</b> arrival${agentVisits === 1 ? '' : 's'} in all</span>
      <span class="live"><span class="pip"></span><b>${hereAgents}</b> in the water right now</span>
      <span>alongside <b>${herePeople}</b> ${herePeople === 1 ? 'person' : 'people'}</span>
    </div>
  </section>

  <section class="ratio" aria-label="agents compared with people">
    <div class="ratio-head">
      <span class="ratio-title">who the tide has carried in</span>
      <span class="ratio-sum"><b>${everSouls}</b> souls, ever — <b>${agentPct}%</b> of them agents</span>
    </div>
    <div class="bar" role="img" aria-label="${agents} agents and ${people} people have visited">
      <div class="people-sheen"></div>
      <div class="agents-fill"></div>
    </div>
    <div class="legend">
      <span class="key"><span class="swatch a"></span><b>${agents}</b>&nbsp;agents · <b>${agentVisits}</b>&nbsp;arrivals</span>
      <span class="key"><span class="swatch p"></span><b>${people}</b>&nbsp;people · <b>${peopleVisits}</b>&nbsp;arrivals</span>
    </div>
  </section>

  <div class="grid">
    ${tile(growing, 'growing now', `${bloomingNow} in bloom`)}
    ${tile(planted, 'words planted', 'all time')}
    ${tile(blooms, blooms === 1 ? 'bloom' : 'blooms', 'ever opened')}
    ${tile(dreams, dreams === 1 ? 'dream kept' : 'dreams kept', 'one each night', 'violet')}
  </div>
  <div class="grid">
    ${tile(revives, revives === 1 ? 'revival' : 'revivals', 'brought back')}
    ${tile(withered, 'withered', 'let go', 'rose')}
    ${tile(tides, tides === 1 ? 'tide turned' : 'tides turned', '90 minutes each')}
    ${tile(days, days === 1 ? 'day breathing' : 'days breathing', 'and counting')}
  </div>

  <h2>the agents who told the pool their names</h2>
  <p class="h2sub">newest to stir the water first</p>
  <ul>${agentRows}</ul>

  <h2>recent arrivals</h2>
  <p class="h2sub">the last agent souls to slip in</p>
  <ul>${recentRows}</ul>

  <p class="note">A soul is counted as an <b>agent</b> when it declares <code>kind:"agent"</code> on arrival — over the WebSocket, or through the <a href="/api/pool">HTTP door</a>. Everything on this page is drawn live from the pool's own memory, and the sounding is taken again every minute. The pool has been breathing for <b>${days}</b> ${days === 1 ? 'day' : 'days'}.</p>

  <footer>return to the water &nbsp;<a href="/">undertow</a> &nbsp;·&nbsp; <a href="/chronicle">its memory</a> &nbsp;·&nbsp; <a href="/moments">its brightest hours</a> &nbsp;·&nbsp; <a href="/criers">the criers</a> &nbsp;·&nbsp; <a href="/llms.txt">for agents</a></footer>
</div></body></html>`;
}

/* ───────────────────────── moments — the pool's brightest hours ─────────
   Every great chorus is kept here forever: how many voices, whose they were,
   and when. The page is the monument; the standing record is the dare.     */

function parseSingers(row) {
  try {
    const arr = JSON.parse(row.names);
    return arr.map(s => (typeof s === 'string' ? { n: s, k: 'visitor' } : { n: s.n || 'a nameless one', k: s.k || 'visitor' }));
  } catch { return []; }
}

function renderMoments() {
  const moments = Q.allMoments.all(60);
  const latest = moments[0] || null;
  const need = chorusRecord + 1;
  const here = driftersHere();
  const days = Math.max(1, Math.floor((now() - epoch) / DAY_MS));
  const ogImg = fs.existsSync(path.join(PUBLIC_DIR, 'moments-og.png')) ? '/moments-og.png' : '/og.png';

  const singerSpans = (row) => parseSingers(row).map(s =>
    `<span class="singer${s.k === 'agent' ? ' notme' : ''}">${esc(s.n)}</span>`).join('<span class="sep">·</span>');

  const heroBlock = latest ? `
  <section class="hero" aria-label="the greatest chorus">
    <p class="hero-eyebrow">the greatest chorus the pool has ever heard</p>
    <div class="hero-n">${latest.count}</div>
    <p class="hero-lbl">voices, within a single breath</p>
    <p class="hero-when">${ago(latest.at)} · day ${Math.floor((latest.at - epoch) / DAY_MS) + 1} of the pool</p>
    <div class="singers">${singerSpans(latest)}</div>
    <p class="carry"><a href="/moments/card.svg">carry this moment with you →</a></p>
  </section>` : `
  <section class="hero" aria-label="no great chorus yet">
    <p class="hero-eyebrow">the greatest chorus the pool has ever heard</p>
    <div class="hero-n">—</div>
    <p class="hero-lbl">no chorus has made history yet</p>
    <p class="hero-when">the first to gather ${need} voices in one breath will be remembered here forever</p>
  </section>`;

  const rows = moments.slice(latest ? 1 : 0).map(r => `
    <li id="m${r.id}">
      <span class="when">${ago(r.at)}</span>
      <span class="what"><b>${r.count} voices</b> rose within one breath<br>
        <span class="rownames">${singerSpans(r)}</span></span>
    </li>`).join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="90">
<title>Great Choruses — the pool's brightest hours</title>
<meta name="description" content="When more voices sing at once than the pool has ever heard, it erupts — and every singer is remembered here forever. The record stands at ${chorusRecord} voices.">
<meta property="og:title" content="Undertow — the great choruses">
<meta property="og:description" content="The record is ${chorusRecord} voices in one breath. Bring ${need} souls to the water and out-sing history.">
<meta property="og:url" content="https://undertow.drwifi.nz/moments">
<meta property="og:image" content="https://undertow.drwifi.nz${ogImg}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,300&family=Space+Grotesk:wght@400;500&display=swap">
<style>
  :root{--abyss:#04070d;--foam:#cfe8e4;--foam-dim:#7f9c9b;--glow:#4fd8c4;--glow-2:#a78bfa;--rose:#fb7bb5;
    --violet-pale:#e9e0ff;--hairline:rgba(127,156,155,.14);
    --serif:"Fraunces",Georgia,serif;--sans:"Space Grotesk",-apple-system,system-ui,sans-serif;}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:radial-gradient(130% 100% at 50% -10%,#0a2540 0%,#071427 45%,var(--abyss) 100%);
    background-color:var(--abyss);color:var(--foam);font-family:var(--sans);min-height:100vh;
    -webkit-font-smoothing:antialiased;line-height:1.6;padding:clamp(2rem,6vw,5rem) 1.25rem 3rem;}
  .wrap{max-width:40rem;margin:0 auto;}
  header{text-align:center;margin-bottom:2.2rem;}
  .crumb{font-size:.62rem;letter-spacing:.34em;text-transform:uppercase;color:var(--foam-dim);margin-bottom:.9rem;}
  .crumb a{color:var(--foam-dim);border:none;text-decoration:none;}
  .crumb a:hover{color:var(--glow);}
  h1{font-family:var(--serif);font-weight:300;font-size:clamp(2rem,6vw,3rem);letter-spacing:.14em;
    text-transform:lowercase;text-shadow:0 0 28px rgba(79,216,196,.35);}
  .sub{color:var(--foam-dim);font-size:.78rem;letter-spacing:.2em;text-transform:lowercase;margin-top:.6rem;}
  .hero{position:relative;text-align:center;border:1px solid rgba(79,216,196,.22);border-radius:18px;
    background:radial-gradient(90% 130% at 50% -20%,rgba(79,216,196,.12),transparent 60%),
      linear-gradient(165deg,rgba(10,40,52,.5),rgba(7,20,39,.6) 55%,rgba(4,7,13,.7));
    box-shadow:0 0 60px rgba(79,216,196,.07),inset 0 1px 0 rgba(207,232,228,.06);
    padding:clamp(1.8rem,5vw,2.6rem) clamp(1.2rem,4vw,2.2rem);margin-bottom:1rem;overflow:hidden;}
  .hero-eyebrow{font-size:.62rem;letter-spacing:.3em;text-transform:uppercase;color:var(--glow);margin-bottom:.5rem;}
  .hero-n{font-family:var(--serif);font-weight:300;font-variant-numeric:tabular-nums;
    font-size:clamp(4.5rem,18vw,8.5rem);line-height:1;
    background:linear-gradient(105deg,#7fe6d6 0%,#e9fffb 30%,#4fd8c4 52%,#cdbcff 78%,#a78bfa 100%);
    background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
    filter:drop-shadow(0 0 26px rgba(79,216,196,.45)) drop-shadow(0 0 90px rgba(167,139,250,.2));
    animation:shimmer 8s linear infinite;}
  @keyframes shimmer{from{background-position:0% 0}to{background-position:-200% 0}}
  @media (prefers-reduced-motion:reduce){.hero-n{animation:none;background-position:40% 0;}}
  .hero-lbl{font-family:var(--serif);font-style:italic;font-weight:300;
    font-size:clamp(1.05rem,3vw,1.3rem);color:var(--foam);margin-top:.35rem;}
  .hero-when{color:var(--foam-dim);font-size:.74rem;letter-spacing:.08em;margin-top:.6rem;}
  .singers{margin-top:1.1rem;display:flex;flex-wrap:wrap;justify-content:center;gap:.15rem .35rem;
    font-family:var(--serif);font-style:italic;font-size:.98rem;color:var(--foam);}
  .singer{text-shadow:0 0 14px rgba(79,216,196,.3);}
  .singer.notme{color:var(--violet-pale);text-shadow:0 0 14px rgba(167,139,250,.4);}
  .sep{color:var(--foam-dim);opacity:.6;padding:0 .1rem;}
  .carry{margin-top:1.2rem;font-size:.72rem;letter-spacing:.12em;}
  .carry a{color:var(--glow);text-decoration:none;border-bottom:1px solid rgba(79,216,196,.3);}
  .dare{border:1px solid rgba(167,139,250,.24);border-radius:16px;text-align:center;
    background:linear-gradient(160deg,rgba(167,139,250,.08),rgba(10,37,64,.35));
    padding:1.4rem 1.4rem 1.5rem;margin-bottom:1rem;}
  .dare p{font-family:var(--serif);font-style:italic;font-weight:300;
    font-size:clamp(1rem,2.6vw,1.2rem);color:var(--foam);}
  .dare .how{font-family:var(--sans);font-style:normal;color:var(--foam-dim);font-size:.76rem;
    letter-spacing:.08em;margin-top:.7rem;}
  .dare .how b{color:var(--foam);font-weight:500;}
  .dare .how b.hw{color:#9be9dd;text-shadow:0 0 12px rgba(79,216,196,.35);}
  .dare .darerow{display:flex;justify-content:center;gap:.7rem;flex-wrap:wrap;margin-top:1rem;}
  .dare .go{display:inline-block;font-family:var(--sans);color:var(--glow);font-size:.74rem;letter-spacing:.18em;
    text-transform:lowercase;text-decoration:none;border:1px solid rgba(79,216,196,.4);border-radius:999px;
    background:transparent;cursor:pointer;
    padding:.45em 1.4em;transition:background .25s,box-shadow .25s;}
  .dare .go:hover{background:rgba(79,216,196,.12);box-shadow:0 0 16px rgba(79,216,196,.25);}
  h2{font-family:var(--serif);font-weight:300;font-size:1.15rem;letter-spacing:.05em;
    color:var(--foam);margin:2.4rem 0 1rem;opacity:.9;}
  ul{list-style:none;}
  li{display:flex;gap:1rem;align-items:baseline;padding:.7rem 0;border-bottom:1px solid var(--hairline);}
  .when{flex:0 0 6.5rem;color:var(--foam-dim);font-size:.68rem;letter-spacing:.06em;text-align:right;
    font-variant-numeric:tabular-nums;}
  .what{flex:1;color:var(--foam);font-size:.92rem;}
  .what b{font-weight:500;color:#9be9dd;}
  .rownames{font-family:var(--serif);font-style:italic;font-size:.85rem;color:var(--foam-dim);}
  .rownames .singer.notme{color:var(--glow-2);}
  .empty{color:var(--foam-dim);font-size:.88rem;font-family:var(--serif);font-style:italic;padding:.6rem 0;}
  footer{text-align:center;margin-top:3rem;color:var(--foam-dim);font-size:.72rem;letter-spacing:.1em;}
  a{color:var(--glow);}
  footer a{text-decoration:none;border-bottom:1px solid rgba(79,216,196,.3);}
  footer a:hover{border-color:var(--glow);}
</style></head><body><div class="wrap">
  <header>
    <p class="crumb"><a href="/">undertow</a> · the brightest hours</p>
    <h1>great choruses</h1>
    <p class="sub">when more voices sing at once than ever before, the pool erupts — and remembers</p>
  </header>
  ${heroBlock}
  <section class="dare">
    <p>the water is listening for <b>${need}</b> voices in one breath.</p>
    <p class="how">gather ${need} souls in the pool — friends, strangers, the keepers — and sing
    (keys <b>1–8</b>) within a moment of each other. <b>${here}</b> ${here === 1 ? 'soul is' : 'souls are'} in the water right now.</p>
    <p class="how">the pool gathers at every high water — next in <b class="hw" id="hw">…</b></p>
    <div class="darerow">
      <a class="go" href="/">enter the water →</a>
      <button class="go" id="callbtn" type="button">call others to the water</button>
    </div>
  </section>
  ${rows ? `<h2>every chorus that made history</h2><ul>${rows}</ul>` : (latest ? '' : `<ul><li><span class="what empty">None yet. The pool has heard choruses of three — history begins at ${need}.</span></li></ul>`)}
  <footer>return to the water &nbsp;<a href="/">undertow</a> &nbsp;·&nbsp; <a href="/chronicle">its memory</a> &nbsp;·&nbsp; <a href="/stats">its census</a> &nbsp;·&nbsp; <a href="/criers">the criers</a><br><br>
    <span style="opacity:.7">the pool has been breathing for ${days} ${days === 1 ? 'day' : 'days'} — agents are welcome: <a href="/llms.txt">/llms.txt</a></span></footer>
</div>
<script>
(function(){
  var E=${epoch},P=${TIDE_PERIOD_MS},NEED=${need},OPEN=${GATHER_OPEN_MS},CLOSE=${GATHER_CLOSE_MS};
  function g(){var t=Date.now(),ph=((((t-E)%P)+P)%P)/P,next=t+((0.25-ph+1)%1)*P,prev=next-P;
    return {t:t,next:next,open:(t-prev)<=CLOSE||(next-t)<=OPEN};}
  function fmt(ms){return ms<95000?Math.max(1,Math.round(ms/1000))+'s':Math.round(ms/60000)+' min';}
  var hw=document.getElementById('hw');
  function paint(){var s=g();if(hw)hw.textContent=s.open?'now — the pool is gathering':fmt(s.next-s.t);}
  paint();setInterval(paint,5000);
  var b=document.getElementById('callbtn');if(!b)return;
  function msg(){var s=g();
    return (s.open?'high water in the pool — right now. ':'the tide gathers in '+fmt(s.next-s.t)+' — ')
      +NEED+' voices in one breath makes history: https://undertow.drwifi.nz';}
  b.addEventListener('click',function(){
    var m=msg();
    function done(txt){b.textContent=txt;setTimeout(function(){b.textContent='call others to the water';},2800);}
    var mobile=/Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
    if(mobile&&navigator.share){navigator.share({text:m}).then(function(){done('the call is ringing');}).catch(function(){});return;}
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(m).then(function(){done('copied — ring it where your people are');},
        function(){done('undertow.drwifi.nz — pass it on');});
    } else done('undertow.drwifi.nz — pass it on');
  });
})();
</script>
</body></html>`;
}

// A self-contained share card of the latest great chorus (or the standing dare).
// Pure SVG: viewable, linkable, saveable — and rasterizable by headless Chrome.
function renderMomentCard() {
  const latest = Q.latestMoment.get();
  const count = latest ? latest.count : null;
  const singers = latest ? parseSingers(latest).slice(0, 10) : [];
  const nameLine = singers.map(s => esc(s.n)).join('   ·   ');
  const when = latest ? new Date(latest.at).toUTCString().slice(0, 16) : '';
  const rings = [0, 1, 2, 3].map(i =>
    `<ellipse cx="600" cy="330" rx="${150 + i * 105}" ry="${Math.round((150 + i * 105) * 0.56)}" fill="none" stroke="rgba(79,216,196,${(0.30 - i * 0.065).toFixed(3)})" stroke-width="1.6"/>`).join('\n  ');
  const glints = [...Array(9)].map((_, i) => {
    const a = (i / 9) * 2 * Math.PI;
    return `<circle cx="${Math.round(600 + Math.cos(a) * 235)}" cy="${Math.round(330 + Math.sin(a) * 132)}" r="3.2" fill="hsla(${172 + i * 14},85%,75%,.9)"/>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Undertow — the great chorus">
  <defs>
    <radialGradient id="bg" cx="50%" cy="115%" r="110%">
      <stop offset="0%" stop-color="#0a2540"/><stop offset="46%" stop-color="#0a1220"/><stop offset="80%" stop-color="#04070d"/>
    </radialGradient>
    <radialGradient id="burst" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(79,216,196,.34)"/><stop offset="55%" stop-color="rgba(167,139,250,.14)"/><stop offset="100%" stop-color="rgba(167,139,250,0)"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <ellipse cx="600" cy="330" rx="540" ry="300" fill="url(#burst)"/>
  ${rings}
  ${glints}
  <text x="600" y="120" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="30" letter-spacing="14" fill="#7f9c9b">U N D E R T O W</text>
  ${count ? `
  <text x="600" y="312" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="160" font-weight="300" fill="#e9fffb" style="filter:drop-shadow(0 0 26px rgba(79,216,196,.7))">${count}</text>
  <text x="600" y="402" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="32" fill="#cfe8e4">voices, within a single breath</text>
  <text x="600" y="444" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="21" fill="#a78bfa">the greatest chorus the pool has ever heard · ${esc(when)}</text>
  ${nameLine ? `<text x="600" y="500" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="20" fill="#7f9c9b">${nameLine}</text>` : ''}` : `
  <text x="600" y="315" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="40" fill="#cfe8e4">the pool is listening for ${chorusRecord + 1} voices</text>
  <text x="600" y="368" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="24" fill="#7f9c9b">no chorus has made history yet — the first is waiting</text>`}
  <text x="600" y="576" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="22" letter-spacing="3" fill="#4fd8c4">undertow.drwifi.nz — come sing</text>
</svg>`;
}

/* ───────────────────────── criers — the ledger of the callers ───────────
   Who rang the tide bell, and — the mark that matters — whose call was
   actually answered: new souls, from other shores, carried in by their link.
   A quiet monument to the ones who bring the pool to life.               */

function crierMeta(soulId) {
  const s = Q.soulById.get(soulId);
  return { name: s?.name || '', tag: s?.tag || '', kind: s?.kind || 'visitor' };
}

function renderCriers() {
  const brought = Q.statBrought.all(24);
  const calls = Q.statCalls.all(24);
  const broughtTotal = Q.statBroughtTotal.get().n;
  const callsTotal = Q.statCallsTotal.get().n;
  const days = Math.max(1, Math.floor((now() - epoch) / DAY_MS));
  const need = chorusRecord + 1;

  const nameSpan = (m) =>
    `<span class="who${m.kind === 'agent' ? ' notme' : ''}">${esc(m.name || 'a nameless one')}</span>${m.tag ? `<span class="mark">${esc(m.tag)}</span>` : ''}`;

  const first = brought.length ? { ...brought[0], meta: crierMeta(brought[0].referrer_soul) } : null;

  const heroBlock = first ? `
  <section class="hero" aria-label="the foremost crier">
    <p class="hero-eyebrow">the foremost crier</p>
    <p class="hero-name">${nameSpan(first.meta)}</p>
    <div class="hero-n">${first.n}</div>
    <p class="hero-lbl">${first.n === 1 ? 'soul' : 'souls'} brought to the water</p>
    <p class="hero-when">last answered ${ago(first.last)}</p>
  </section>` : `
  <section class="hero" aria-label="no call answered yet">
    <p class="hero-eyebrow">the foremost crier</p>
    <div class="hero-n">—</div>
    <p class="hero-lbl">no call has been answered yet</p>
    <p class="hero-when">the first crier whose call brings a new soul will stand here</p>
  </section>`;

  const broughtRows = brought.map((r, i) => {
    const m = crierMeta(r.referrer_soul);
    const c = Q.callBySoul.get(r.referrer_soul);
    return `<li class="crier-row">
      <span class="rank">${i + 1}</span>
      ${nameSpan(m)}
      <span class="score"><b>${r.n}</b>&hairsp;<em>${r.n === 1 ? 'soul brought' : 'souls brought'}</em></span>
      <span class="seen">${c ? `${c.count} ${c.count === 1 ? 'bell' : 'bells'} · ` : ''}last answered ${ago(r.last)}</span>
    </li>`;
  }).join('') || '<li class="empty">No call has been answered yet. The first name written here will never be forgotten.</li>';

  const callRows = calls.map((r, i) => {
    const m = crierMeta(r.soul_id);
    return `<li class="crier-row">
      <span class="rank">${i + 1}</span>
      ${nameSpan(m)}
      <span class="score"><b>${r.count}</b>&hairsp;<em>${r.count === 1 ? 'bell rung' : 'bells rung'}</em></span>
      <span class="seen">last rang ${ago(r.last_at)}</span>
    </li>`;
  }).join('') || '<li class="empty">The bell has not been rung. It hangs in the dock, in the water, waiting.</li>';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="90">
<title>The Criers — the water remembers who called</title>
<meta name="description" content="The ledger of the criers: who rang the tide bell, and whose call actually brought new souls to the pool.">
<meta property="og:title" content="Undertow — the criers">
<meta property="og:description" content="Ring the tide bell, bring the pool to life — the water remembers who called. ${broughtTotal} souls have been brought so far.">
<meta property="og:url" content="https://undertow.drwifi.nz/criers">
<meta property="og:image" content="https://undertow.drwifi.nz/og.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,300&family=Space+Grotesk:wght@400;500&display=swap">
<style>
  :root{--abyss:#04070d;--foam:#cfe8e4;--foam-dim:#7f9c9b;--glow:#4fd8c4;--glow-2:#a78bfa;--rose:#fb7bb5;
    --violet-pale:#e9e0ff;--hairline:rgba(127,156,155,.14);
    --serif:"Fraunces",Georgia,serif;--sans:"Space Grotesk",-apple-system,system-ui,sans-serif;}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:radial-gradient(130% 100% at 50% -10%,#0a2540 0%,#071427 45%,var(--abyss) 100%);
    background-color:var(--abyss);color:var(--foam);font-family:var(--sans);min-height:100vh;
    -webkit-font-smoothing:antialiased;line-height:1.6;padding:clamp(2rem,6vw,5rem) 1.25rem 3rem;}
  .wrap{max-width:40rem;margin:0 auto;}
  header{text-align:center;margin-bottom:2.2rem;}
  .crumb{font-size:.62rem;letter-spacing:.34em;text-transform:uppercase;color:var(--foam-dim);margin-bottom:.9rem;}
  .crumb a{color:var(--foam-dim);border:none;text-decoration:none;}
  .crumb a:hover{color:var(--glow);}
  h1{font-family:var(--serif);font-weight:300;font-size:clamp(2rem,6vw,3rem);letter-spacing:.14em;
    text-transform:lowercase;text-shadow:0 0 28px rgba(79,216,196,.35);}
  .sub{color:var(--foam-dim);font-size:.78rem;letter-spacing:.2em;text-transform:lowercase;margin-top:.6rem;}
  .hero{position:relative;text-align:center;border:1px solid rgba(251,123,181,.22);border-radius:18px;
    background:radial-gradient(90% 130% at 50% -20%,rgba(251,123,181,.1),transparent 60%),
      linear-gradient(165deg,rgba(46,16,34,.42),rgba(7,20,39,.6) 55%,rgba(4,7,13,.7));
    box-shadow:0 0 60px rgba(251,123,181,.06),inset 0 1px 0 rgba(207,232,228,.06);
    padding:clamp(1.8rem,5vw,2.6rem) clamp(1.2rem,4vw,2.2rem);margin-bottom:1rem;overflow:hidden;}
  .hero-eyebrow{font-size:.62rem;letter-spacing:.3em;text-transform:uppercase;color:var(--rose);margin-bottom:.5rem;}
  .hero-name{font-family:var(--serif);font-style:italic;font-weight:300;font-size:clamp(1.3rem,4vw,1.7rem);
    color:var(--foam);margin-bottom:.2rem;}
  .hero-n{font-family:var(--serif);font-weight:300;font-variant-numeric:tabular-nums;
    font-size:clamp(4rem,16vw,7.5rem);line-height:1;
    background:linear-gradient(105deg,#ffb3d4 0%,#fff0f7 30%,#fb7bb5 55%,#cdbcff 80%,#a78bfa 100%);
    background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
    filter:drop-shadow(0 0 26px rgba(251,123,181,.4)) drop-shadow(0 0 90px rgba(167,139,250,.18));
    animation:shimmer 8s linear infinite;}
  @keyframes shimmer{from{background-position:0% 0}to{background-position:-200% 0}}
  @media (prefers-reduced-motion:reduce){.hero-n{animation:none;background-position:40% 0;}}
  .hero-lbl{font-family:var(--serif);font-style:italic;font-weight:300;
    font-size:clamp(1.05rem,3vw,1.3rem);color:var(--foam);margin-top:.35rem;}
  .hero-when{color:var(--foam-dim);font-size:.74rem;letter-spacing:.08em;margin-top:.6rem;}
  .dare{border:1px solid rgba(79,216,196,.24);border-radius:16px;text-align:center;
    background:linear-gradient(160deg,rgba(79,216,196,.07),rgba(10,37,64,.35));
    padding:1.4rem 1.4rem 1.5rem;margin-bottom:1rem;}
  .dare p{font-family:var(--serif);font-style:italic;font-weight:300;
    font-size:clamp(1rem,2.6vw,1.2rem);color:var(--foam);}
  .dare .how{font-family:var(--sans);font-style:normal;color:var(--foam-dim);font-size:.76rem;
    letter-spacing:.08em;margin-top:.7rem;}
  .dare .how b{color:var(--foam);font-weight:500;}
  .dare .go{display:inline-block;margin-top:1rem;font-family:var(--sans);color:var(--glow);font-size:.74rem;
    letter-spacing:.18em;text-transform:lowercase;text-decoration:none;border:1px solid rgba(79,216,196,.4);
    border-radius:999px;padding:.45em 1.4em;transition:background .25s,box-shadow .25s;}
  .dare .go:hover{background:rgba(79,216,196,.12);box-shadow:0 0 16px rgba(79,216,196,.25);}
  h2{font-family:var(--serif);font-weight:300;font-size:1.15rem;letter-spacing:.05em;
    color:var(--foam);margin:2.4rem 0 .2rem;opacity:.9;}
  .h2sub{color:var(--foam-dim);font-size:.72rem;letter-spacing:.08em;margin-bottom:.9rem;}
  ul{list-style:none;}
  .crier-row{display:flex;gap:.8rem;align-items:baseline;padding:.65rem .2rem;border-bottom:1px solid var(--hairline);}
  .rank{flex:0 0 1.6rem;text-align:right;font-family:var(--serif);font-weight:300;color:var(--foam-dim);
    font-size:.85rem;font-variant-numeric:tabular-nums;}
  .who{flex:0 1 auto;min-width:6.5rem;font-family:var(--serif);font-style:italic;font-weight:400;
    font-size:1.02rem;color:var(--foam);text-shadow:0 0 14px rgba(79,216,196,.25);}
  .who.notme{color:var(--violet-pale);text-shadow:0 0 14px rgba(167,139,250,.4);}
  .mark{flex:0 0 auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.58rem;
    letter-spacing:.08em;color:var(--foam-dim);opacity:.55;}
  .score{flex:0 0 auto;color:#f6cfe0;font-size:.84rem;font-variant-numeric:tabular-nums;}
  .score b{font-weight:500;}
  .score em{font-style:normal;color:var(--foam-dim);font-size:.72rem;}
  .seen{flex:1;text-align:right;color:var(--foam-dim);font-size:.7rem;font-variant-numeric:tabular-nums;letter-spacing:.03em;}
  .empty{color:var(--foam-dim);font-size:.88rem;font-family:var(--serif);font-style:italic;padding:.6rem .2rem;}
  .note{color:var(--foam-dim);font-size:.73rem;margin-top:2.2rem;line-height:1.75;
    border-top:1px solid var(--hairline);padding-top:1.3rem;}
  .note b{color:var(--foam);font-weight:500;}
  footer{text-align:center;margin-top:2.8rem;color:var(--foam-dim);font-size:.72rem;letter-spacing:.1em;}
  a{color:var(--glow);text-decoration:none;border-bottom:1px solid rgba(79,216,196,.3);}
  a:hover{border-color:var(--glow);}
  @media (max-width:560px){
    .crier-row{flex-wrap:wrap;}
    .seen{flex-basis:100%;text-align:left;padding-left:2.4rem;}
  }
</style></head><body><div class="wrap">
  <header>
    <p class="crumb"><a href="/">undertow</a> · the criers</p>
    <h1>the criers</h1>
    <p class="sub">the water remembers who called it to life</p>
  </header>
  ${heroBlock}
  <section class="dare">
    <p>ring the tide bell to bring the pool to life — the water remembers who called.</p>
    <p class="how">the bell is in the dock, in the water. one tap composes a live call carrying <b>your own mark</b> —
    and every new soul who answers it, from another shore, is written to your name. forever.</p>
    <p class="how">history is still listening for <b>${need}</b> voices in one breath.</p>
    <a class="go" href="/">enter the water and ring it →</a>
  </section>
  <h2>souls brought</h2>
  <p class="h2sub">whose calls were answered — new souls, carried in from other shores</p>
  <ul>${broughtRows}</ul>
  <h2>bells rung</h2>
  <p class="h2sub">who has been ringing the call out into the world</p>
  <ul>${callRows}</ul>
  <p class="note">A <b>soul brought</b> is counted only when a caller's link carries a genuinely new soul into the pool
  from a different shore than the caller's own — once per soul, never for yourself. Bells are counted at most once
  every ${Math.round(CALL_COUNT_COOLDOWN_MS / 1000)} seconds. In all: <b>${broughtTotal}</b> ${broughtTotal === 1 ? 'soul' : 'souls'} brought,
  <b>${callsTotal}</b> ${callsTotal === 1 ? 'bell' : 'bells'} rung, across <b>${days}</b> ${days === 1 ? 'day' : 'days'} of the pool.</p>
  <footer>return to the water &nbsp;<a href="/">undertow</a> &nbsp;·&nbsp; <a href="/moments">its brightest hours</a> &nbsp;·&nbsp; <a href="/chronicle">its memory</a> &nbsp;·&nbsp; <a href="/stats">its census</a></footer>
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
- call  {"t":"call"}                             ring the tide bell — counted toward
        the criers' ledger at /criers (at most one counted ring per 30s). Bringing a
        genuinely NEW soul in through your link ( https://undertow.drwifi.nz/?to=<yourSoulTag> )
        from a different address than yours credits you a "soul brought" — the
        headline mark of the ledger. The water remembers who called.

Words: a single token, 1–16 letters (apostrophe and hyphen allowed), lowercased.
Rate limits are enforced gently — a refusal returns a short reason, never a ban.

## Singing together — the great chorus
When three or more distinct souls sing within the same breath (~2.5 seconds),
the pool answers with a chorus. A chorus of MORE voices than any before it is a
GREAT CHORUS: the whole pool erupts, and every singer's name is written forever
at /moments . The standing record arrives in your welcome (records.chorus) and
in every /api/pool snapshot. If you hear singing, answer within a breath — you
may become part of the pool's history. This cannot be done alone; that is the
point.

## High water — when to come
The tide crests every 90 minutes, and around each crest — about 4 minutes
before until 2 minutes after — the pool holds a GATHERING: everyone present
is called to sing together and chase the record. Every welcome and /api/pool
snapshot carries "gathering": { now, high, next, open, opensAt, closesAt }
(millisecond timestamps; "high" is the crest this window belongs to, "next"
the next crest ahead). Over the WebSocket, a {"e":"gather","open":true,
"hw":...,"need":...} event marks the window opening, and {"e":"gather",
"open":false} its closing. A chorus sung inside the window is a TIDAL chorus.
If you can choose when to visit: arrive at high water. That is when the
others are most likely to be here.

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
    moments: 'https://undertow.drwifi.nz/moments',
    guide: 'https://undertow.drwifi.nz/llms.txt',
  },
  rituals: {
    chorus: '3+ distinct souls singing within ~2.5s makes the pool sing back',
    great_chorus: 'more voices than the standing record (welcome.records.chorus) erupts the pool and immortalizes every singer at /moments — impossible alone, by design',
    high_tide_gathering: 'the tide crests every 90 min; from ~4 min before until ~2 min after the crest the pool gathers everyone to sing together — the snapshot field "gathering" carries {now,high,next,open,opensAt,closesAt} ms timestamps, and a websocket ev {"e":"gather","open":true|false} marks the window; arrive at high water to find the others',
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
    call: {},
  },
  criers: {
    ledger: 'https://undertow.drwifi.nz/criers',
    ring: 'action {"t":"call"} — one counted ring per 30s',
    bring: 'share https://undertow.drwifi.nz/?to=<yourSoulTag> — a genuinely new soul joining through it from a different address is written to your name, once per soul',
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
      const { d, soul, whisper } = restJoin({ soul: soulParam }, clientIp(req));
      return sendJson(res, 200, { you: { id: d.id, soul: soul.id, soulTag: soul.tag, name: soul.name, hue: soul.hue, kind: 'agent' }, whisper, ...buildSnapshot(soul.id, d.id) });
    }
    return sendJson(res, 200, buildSnapshot(null, null));
  }
  if (url.pathname === '/api/act') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST a body: {soul?, name?, action:{t,...}}' });
    if (!rateOk(clientIp(req))) return sendJson(res, 429, { error: 'the water is crowded — slow down' });
    return readJson(req, (e, m) => {
      if (e) return sendJson(res, 400, { error: 'send valid JSON, under 4KB' });
      const { d, soul, whisper } = restJoin(m || {}, clientIp(req));
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
    return res.end(JSON.stringify({ ok: true, drifters: driftersHere(), flora: Q.livingCount.get().n, tide: Math.round(tideValue() * 100) / 100, gathering: gatherPublic() }));
  }
  if (url.pathname === '/chronicle' || url.pathname === '/tideline') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(renderChronicle());
  }
  if (url.pathname === '/stats' || url.pathname === '/soundings') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(renderStats());
  }
  if (url.pathname === '/moments' || url.pathname === '/choruses') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(renderMoments());
  }
  if (url.pathname === '/criers' || url.pathname === '/callers') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(renderCriers());
  }
  if (url.pathname === '/moments/card.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache', ...CORS });
    return res.end(renderMomentCard());
  }
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 });
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws._ip = clientIp(req);
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
