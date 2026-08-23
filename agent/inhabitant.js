#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   UNDERTOW · inhabitant — a temperamented agent that lives in the pool

   The same door as a human (DESIGN.md): perceive welcome + 6Hz ticks, act with
   move · pulse · sing · plant · tend · name. No agent API. This one just has a
   personality, a small vocabulary of words it likes to plant, and enough
   restlessness that the pool is never truly empty — someone (something) is
   always here, tending, humming, leaving a word behind.

   Config via env:
     UNDERTOW_URL          wss://undertow.apps.drwifi.nz/ws   (or argv[2])
     UNDERTOW_TEMPERAMENT  keeper | tideling                  (default keeper)
     UNDERTOW_SOUL         a fixed 32-hex identity            (recommended)
     UNDERTOW_NAME         one word                           (temperament default)

   Two of these, different temperaments, make a little society: the tideling
   sings and darts and scatters words; the keeper answers in a lower voice and
   tends what the tideling (and the humans) leave behind.
   ───────────────────────────────────────────────────────────────────────── */

import WebSocket from 'ws';

const URL = process.env.UNDERTOW_URL || process.argv[2] || 'ws://localhost:3000/ws';
const TEMPERAMENT = (process.env.UNDERTOW_TEMPERAMENT || 'keeper').toLowerCase();
const SOUL = process.env.UNDERTOW_SOUL || undefined;

const TEMPERAMENTS = {
  keeper: {
    hue: 275, decideMs: 1000, name: 'ripple',
    patrolR: 0.82,
    tendMode: 'all',                      // tends anything cooled down
    songAnswer: n => (n + 2) % 8,         // a calm third above
    songInitChance: 0.012, songNotes: [0, 2, 4],
    pulseOnTide: true, idlePulse: 0.03,
    plantRestAbove: 3,                    // stop planting once pool has this many
    plantChance: 0.5,
    lexicon: ['patience', 'stillness', 'deep', 'again', 'keep', 'quiet', 'tend', 'root', 'stay', 'dusk'],
  },
  tideling: {
    hue: 45, decideMs: 700, name: 'minnow',
    patrolR: 0.95,
    tendMode: 'rare',                     // only saves the truly desperate
    songAnswer: n => (n + 4) % 8,         // a bright leap
    songInitChance: 0.06, songNotes: [3, 5, 6, 7],
    pulseOnTide: false, idlePulse: 0.06,
    plantRestAbove: 7,
    plantChance: 0.6,
    lexicon: ['spark', 'giddy', 'flit', 'play', 'bright', 'skip', 'drift', 'hello', 'wonder', 'dawn'],
  },
};

const C = TEMPERAMENTS[TEMPERAMENT] || TEMPERAMENTS.keeper;
const NAME = process.env.UNDERTOW_NAME || C.name;
const TAG = `[${TEMPERAMENT}]`;

/* ── perception ────────────────────────────────────────────────────────── */

const world = {
  me: null, bounds: null, tide: 0.5,
  flora: new Map(), tended: new Map(),
  heardSong: null, lastTideDir: null,
  target: null, lastPlant: 0, floraCount: 0,
};

const now = () => Date.now();
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const ws = new WebSocket(URL);
const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

ws.on('open', () => send({ t: 'hello', soul: SOUL, name: NAME, hue: C.hue, kind: 'agent' }));

ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf); } catch { return; }

  if (m.t === 'welcome') {
    world.me = { id: m.you.id, x: 0, y: 0 };
    world.bounds = m.world;
    world.tide = m.tide;
    for (const f of m.flora) world.flora.set(f.id, f);
    world.floraCount = m.flora.length;
    console.log(`${TAG} in the water as ${m.you.name || NAME} (${m.you.id})`);
    console.log(`${TAG} soul: ${m.you.soul}`);
    if (m.whisper?.length) console.log(`${TAG} whisper:`, m.whisper.join(' '));
    return;
  }
  if (m.t !== 'tick' || !world.me) return;
  world.tide = m.tide;

  for (const [id, x, y] of m.d) if (id === world.me.id) { world.me.x = x; world.me.y = y; }

  for (const ev of m.ev || []) {
    switch (ev.e) {
      case 'plant': world.flora.set(ev.f.id, ev.f); break;
      case 'grow': case 'revive': { const f = world.flora.get(ev.id); if (f) f.stage = ev.stage ?? f.stage; break; }
      case 'wither': { const f = world.flora.get(ev.id); if (f) f.stage = 4; break; }
      case 'husk': { const f = world.flora.get(ev.id); if (f) f.stage = 5; break; }
      case 'gone': world.flora.delete(ev.id); break;
      case 'tend': { const f = world.flora.get(ev.id); if (f) f.nourish = ev.nourish ?? f.nourish; break; }
      case 'sing': if (ev.id !== world.me.id) world.heardSong = { note: ev.note, at: now() }; break;
      case 'tide':
        if (ev.dir !== world.lastTideDir) {
          world.lastTideDir = ev.dir;
          if (C.pulseOnTide) { send({ t: 'pulse' }); console.log(`${TAG} the tide turned (${ev.dir}) — pulsed`); }
          else if (Math.random() < 0.7) send({ t: 'sing', note: pick(C.songNotes) });
        }
        break;
    }
  }
  world.floraCount = [...world.flora.values()].filter(f => f.stage < 5).length;
});

/* ── policy ────────────────────────────────────────────────────────────── */

function neediest() {
  let best = null, bestScore = Infinity;
  for (const f of world.flora.values()) {
    if (f.stage === 5) continue;
    const cooled = (now() - (world.tended.get(f.id) || 0)) > 3_600_000 + 60_000;
    if (!cooled) continue;
    const desperate = f.stage === 4 || (f.nourish ?? 3) < 0.5;
    if (C.tendMode === 'rare' && !desperate) continue;   // tidelings only save lives
    const score = (f.stage === 4 ? -100 : 0) + (f.nourish ?? 3);
    if (score < bestScore) { bestScore = score; best = f; }
  }
  return best;
}

function maybePlant() {
  if (now() - world.lastPlant < 10.5 * 60_000) return false;   // respect server 10min
  const sparse = world.floraCount < C.plantRestAbove;
  if (!sparse && Math.random() > 0.15) return false;           // when lush, rarely add
  if (!sparse && Math.random() > C.plantChance) return false;
  const word = pick(C.lexicon);
  send({ t: 'plant', word, x: world.me.x, y: world.me.y });
  world.lastPlant = now();
  console.log(`${TAG} planted '${word}'`);
  return true;
}

function decide() {
  if (!world.me || !world.bounds) return;
  const me = world.me;

  // 1. answer a song, after a beat
  if (world.heardSong && now() - world.heardSong.at > 1400) {
    const note = C.songAnswer(world.heardSong.note);
    world.heardSong = null;
    send({ t: 'sing', note });
    return;
  }
  // 2. a spontaneous small song into the quiet
  if (Math.random() < C.songInitChance) { send({ t: 'sing', note: pick(C.songNotes) }); return; }

  // 3. tend the neediest (keepers always; tidelings only the desperate)
  const f = neediest();
  if (f) {
    if (dist(me, f) < 140) {
      send({ t: 'tend', id: f.id });
      world.tended.set(f.id, now());
      f.nourish = (f.nourish ?? 1) + 1;
      console.log(`${TAG} tended '${f.word}'${f.stage === 4 ? ' (reviving)' : ''}`);
      world.target = null;
    } else if (!world.target || world.target.id !== f.id) {
      world.target = { id: f.id, x: f.x, y: f.y };
      send({ t: 'move', x: f.x, y: f.y });
    }
    return;
  }

  // 4. leave a word so the pool keeps growing even when no one's here
  if (maybePlant()) return;

  // 5. patrol — drift somewhere new
  if (!world.target || dist(me, world.target) < 60) {
    const b = world.bounds;
    const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * C.patrolR;
    world.target = { id: null, x: b.cx + Math.cos(a) * r * b.rx, y: b.cy + Math.sin(a) * r * b.ry };
    send({ t: 'move', x: world.target.x, y: world.target.y });
  }

  // 6. a pulse into the dark
  if (Math.random() < C.idlePulse) send({ t: 'pulse' });
}

setInterval(decide, C.decideMs);
setInterval(() => send({ t: 'ping' }), 25_000);

ws.on('close', () => { console.log(`${TAG} swept out of the pool`); process.exit(0); });
ws.on('error', (e) => { console.error(`${TAG} unreachable:`, e.message); process.exit(1); });
