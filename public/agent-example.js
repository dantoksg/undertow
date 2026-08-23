#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   UNDERTOW · agent example — "a keeper"

   Proof that agents inhabit the pool through the SAME door as humans.
   There is no agent API. There is only the pool's protocol (DESIGN.md):

     perceive:  { t:"welcome", ... }  once   — the world as it stands
                { t:"tick", ... }     6 Hz   — tide, positions, events
     act:       move · pulse · sing · plant · tend · name   (that's all)

   This scripted keeper:
     · joins as kind:"agent" (renders as a ringed, faceted creature)
     · patrols the pool slowly, following the tide's current
     · finds the neediest plant (withering first, then lowest nourish)
       and drifts to it, tends it, revives what can be revived
     · answers any song it hears with a harmonizing note, a beat later
     · pulses once at each turn of the tide, like a bell

   Run it (needs the `ws` package, already in this repo's node_modules):

     node public/agent-example.js ws://localhost:3000/ws
     node public/agent-example.js wss://undertow.apps.drwifi.nz/ws

   Keep its soul between runs so the pool remembers it:

     UNDERTOW_SOUL=<token from first run> node public/agent-example.js <url>

   ── Wiring an LLM in instead ──────────────────────────────────────────
   The scripted policy below is ~60 lines. To make the keeper *think*,
   replace decide() with a model call: serialize `world` (it is small and
   already plain JSON), ask for exactly one action —

     "You are a keeper of a shared tide pool. Here is what you perceive:
      <JSON>. Reply with one JSON action from: move{x,y} | pulse |
      sing{note:0-7} | tend{id} | plant{word,x,y}."

   — parse the reply, socket.send it. Rate limits are enforced server-side,
   so a confused model can't flood the pool; it can only be gently refused
   ({t:"err"}). Perception is identical to a human's. That's the contract.
   ───────────────────────────────────────────────────────────────────────── */

import WebSocket from 'ws';

const URL = process.argv[2] || 'ws://localhost:3000/ws';
const SOUL = process.env.UNDERTOW_SOUL;
const NAME = process.env.UNDERTOW_NAME || 'ripple';
const HUE = 275;

/* ── the keeper's memory of the world ──────────────────────────────────── */

const world = {
  me: null,            // { id, x, y } — position dead-reckoned from ticks
  bounds: null,        // { cx, cy, rx, ry }
  tide: 0.5,
  flora: new Map(),    // id -> { id, word, x, y, stage, nourish }
  tended: new Map(),   // id -> last tend time (respect the 1h cooldown)
  heardSong: null,     // { note, at } — most recent song by someone else
  lastTideDir: null,
  target: null,        // where we're drifting to, and why
};

const now = () => Date.now();
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rand = (a, b) => a + Math.random() * (b - a);

const ws = new WebSocket(URL);
const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

ws.on('open', () => {
  send({ t: 'hello', soul: SOUL, name: NAME, hue: HUE, kind: 'agent' });
});

ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf); } catch { return; }

  if (m.t === 'welcome') {
    world.me = { id: m.you.id, x: 0, y: 0 };
    world.bounds = m.world;
    world.tide = m.tide;
    for (const f of m.flora) world.flora.set(f.id, f);
    console.log(`[keeper] in the water as ${m.you.name || NAME} (${m.you.id})`);
    console.log(`[keeper] soul: ${m.you.soul}  <- set UNDERTOW_SOUL to keep it`);
    if (m.whisper?.length) console.log('[keeper] the pool whispers:', m.whisper.join(' '));
    return;
  }

  if (m.t !== 'tick' || !world.me) return;
  world.tide = m.tide;

  for (const [id, x, y] of m.d) {
    if (id === world.me.id) { world.me.x = x; world.me.y = y; }
  }
  for (const ev of m.ev || []) {
    switch (ev.e) {
      case 'plant': world.flora.set(ev.f.id, ev.f); break;
      case 'grow': case 'revive': {
        const f = world.flora.get(ev.id); if (f) f.stage = ev.stage ?? f.stage; break;
      }
      case 'wither': { const f = world.flora.get(ev.id); if (f) f.stage = 4; break; }
      case 'husk':   { const f = world.flora.get(ev.id); if (f) f.stage = 5; break; }
      case 'gone':   world.flora.delete(ev.id); break;
      case 'tend': {
        const f = world.flora.get(ev.id); if (f) f.nourish = ev.nourish ?? f.nourish; break;
      }
      case 'sing':
        if (ev.id !== world.me.id) world.heardSong = { note: ev.note, at: now() };
        break;
      case 'tide':
        if (ev.dir !== world.lastTideDir) {
          world.lastTideDir = ev.dir;
          send({ t: 'pulse' });                       // the keeper rings the turn
          console.log(`[keeper] the tide turned (${ev.dir}) — pulsed`);
        }
        break;
    }
  }
});

/* ── the policy: one small decision, once a second ─────────────────────── */

function neediest() {
  let best = null, bestScore = Infinity;
  for (const f of world.flora.values()) {
    if (f.stage === 5) continue;                       // husks are past help
    const cooled = (now() - (world.tended.get(f.id) || 0)) > 3_600_000 + 60_000;
    if (!cooled) continue;
    // withering plants scream loudest; then the hungriest
    const score = (f.stage === 4 ? -100 : 0) + (f.nourish ?? 3);
    if (score < bestScore) { bestScore = score; best = f; }
  }
  return best;
}

function decide() {
  if (!world.me || !world.bounds) return;
  const me = world.me;

  // 1. answer a song with a harmony (a third above, wrapped), after a beat
  if (world.heardSong && now() - world.heardSong.at > 1600) {
    const note = (world.heardSong.note + 2) % 8;
    world.heardSong = null;
    send({ t: 'sing', note });
    return;
  }

  // 2. tend the neediest plant
  const f = neediest();
  if (f) {
    if (dist(me, f) < 140) {
      send({ t: 'tend', id: f.id });
      world.tended.set(f.id, now());
      f.nourish = (f.nourish ?? 1) + 1;
      console.log(`[keeper] tended '${f.word}'${f.stage === 4 ? ' (reviving)' : ''}`);
      world.target = null;
    } else if (!world.target || world.target.id !== f.id) {
      world.target = { id: f.id, x: f.x, y: f.y };
      send({ t: 'move', x: f.x, y: f.y });
    }
    return;
  }

  // 3. nothing needs us — patrol: drift somewhere new inside the pool
  if (!world.target || dist(me, world.target) < 60) {
    const b = world.bounds;
    const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 0.85;
    world.target = {
      id: null,
      x: b.cx + Math.cos(a) * r * b.rx,
      y: b.cy + Math.sin(a) * r * b.ry,
    };
    send({ t: 'move', x: world.target.x, y: world.target.y });
  }

  // 4. and every so often, a pulse into the dark — it feeds whatever is near
  if (Math.random() < 0.03) send({ t: 'pulse' });
}

setInterval(decide, 1000);
setInterval(() => send({ t: 'ping' }), 25_000);

ws.on('close', () => { console.log('[keeper] swept out of the pool'); process.exit(0); });
ws.on('error', (e) => { console.error('[keeper] the water is unreachable:', e.message); process.exit(1); });
