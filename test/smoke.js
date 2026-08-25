/* SHOAL headless smoke test.
 * Runs the real game modules in Node with the DOM mocked. Proves:
 *   - terrain determinism + feature sanity
 *   - swarm reveal, mow autopilot, pinnacle snag honesty
 *   - quest targets are real (measuring completes them), relics fire,
 *     sawyer fence gates, hidden exception quest unlocks after tracking
 *   - storms spawn/track; the deep-current exception actually stacks in the basin
 *   - cartography: marching squares produces isobaths; same-ink export JSON
 * Run: node test/smoke.js
 */
'use strict';

/* ------------------------------------------------ DOM mock (for render) */
const noop = () => {};
const stubCtx = () => {
  const ctx = {
    canvas: { width: 800, height: 800 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', globalAlpha: 1
  };
  for (const fn of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'arc', 'ellipse',
                    'closePath', 'fill', 'stroke', 'save', 'restore', 'translate', 'rotate',
                    'setLineDash', 'fillText', 'createLinearGradient', 'createRadialGradient']) {
    ctx[fn] = fn.startsWith('create') ? () => ({ addColorStop: noop }) : noop;
  }
  return ctx;
};
global.document = {
  createElement: (tag) => {
    if (tag === 'canvas') {
      const cv = { width: 1000, height: 1130, toBlob: (cb) => cb({ size: 1 }) };
      cv.getContext = () => stubCtx();
      return cv;
    }
    return { style: {}, classList: { add: noop, remove: noop } };
  }
};
global.self = global;

/* ------------------------------------------------ load modules */
const T = require('../js/terrain.js');
const R = require('../js/rovs.js');
const Q = require('../js/quests.js');
const S = require('../js/storms.js');
const D = require('../js/render.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}
function section(s) { console.log('\n== ' + s); }

/* ------------------------------------------------ terrain */
section('terrain');
const SEED = 20260824;
const t1 = T.generate(SEED), t2 = T.generate(SEED);
ok(t1.W === 100 && t1.H === 100, '100x100 grid');
ok(Array.from(t1.depth).every((d, i) => d === t2.depth[i]), 'deterministic for seed');
let mn = 1e9, mx = -1e9;
for (const d of t1.depth) { mn = Math.min(mn, d); mx = Math.max(mx, d); }
ok(mn >= 6 && mx <= 235, 'depth clamped [' + mn.toFixed(1) + ', ' + mx.toFixed(1) + ']');
ok(mx >= 165, 'basin reaches real depth (' + mx.toFixed(1) + ' fm)');
const pin = t1.features.pinnacle;
ok(t1.depthAt(pin.x | 0, pin.y | 0) <= 20, 'pinnacle is a genuine hazard (' +
   t1.depthAt(pin.x | 0, pin.y | 0).toFixed(1) + ' fm)');
const validCls = new Set(['pinnacle', 'shelf', 'slope', 'saddle', 'channel', 'basin', 'deep']);
let clsOK = true, shelfCount = 0, basinCount = 0;
for (let y = 0; y < 100; y += 3) for (let x = 0; x < 100; x += 3) {
  const c = t1.classify(x, y);
  if (!validCls.has(c)) clsOK = false;
  if (c === 'shelf') shelfCount++;
  if (c === 'basin') basinCount++;
}
ok(clsOK, 'classify returns valid labels');
ok(shelfCount > 10, 'real shelf exists (' + shelfCount + ' sampled shelf tiles)');
ok(basinCount > 3, 'real basin exists (' + basinCount + ' sampled basin tiles)');
ok(Array.isArray(t1.features.relics) && t1.features.relics.length === 3, '3 deterministic relics');
ok(t1.features.channel.length >= 12, 'deep-current channel waypoints (' + t1.features.channel.length + ')');
const g = t1.gradient(50, 50);
ok(Math.hypot(g.gx, g.gy) > 0.01, 'gradient magnitude > 0');
ok(typeof t1.tilesMatching === 'function' && t1.tilesMatching(() => true).length === 10000, 'tilesMatching');

/* ------------------------------------------------ rovs: reveal + mow + snag */
section('bloodhound swarm');
const terrain = t1;
const swarm = R.createSwarm({ x: 50, y: 12 });
const measured = new Uint8Array(100 * 100);
ok(swarm.rovs.length === 6, 'six ROVs');
let res = R.update(swarm, 0.016, { ax: 1, ay: 0 }, terrain, measured, 0.016);
ok(res.revealed.length > 0, 'movement reveals true bottom tiles (' + res.revealed.length + ')');

/* mow autopilot: serpentine coverage */
const swarm2 = R.createSwarm({ x: 50, y: 20 });
const meas2 = new Uint8Array(100 * 100);
R.update(swarm2, 0.016, { toggleMow: true }, terrain, meas2, 0.016);
let mowRes;
for (let i = 0; i < 3000; i++) { /* 48s of mowing */
  mowRes = R.update(swarm2, 0.016, {}, terrain, meas2, (i + 2) * 0.016);
}
ok(swarm2.stats.sweeps >= 3, 'autopilot lays sweeps (' + swarm2.stats.sweeps + ' sweeps)');
ok(R.coveragePct(meas2) > 4, 'mowing builds the photograph (' + R.coveragePct(meas2).toFixed(1) + '% charted)');
ok(swarm2.stats.mowTiles > 0 && swarm2.stats.mowTiles <= swarm2.stats.tiles, 'mow tiles counted');

/* mow rows must advance and not overlap wildly: check y grew */
ok(swarm2.mow.yRow > 20, 'rows step down the map (yRow ' + swarm2.mow.yRow.toFixed(1) + ')');

/* snag: the game never lies — fast transit over the pinnacle fouls ROVs */
const swarm3 = R.createSwarm({ x: pin.x, y: pin.y });
const meas3 = new Uint8Array(100 * 100);
let snagged = 0, lostEv = 0;
for (let i = 0; i < 400; i++) { /* 6.4s fast circles over the pinnacle */
  const r3 = R.update(swarm3, 0.016,
    { ax: Math.cos(i * 0.3), ay: Math.sin(i * 0.3) }, terrain, meas3, i * 0.016);
  for (const ev of r3.events) {
    if (ev.type === 'snag') snagged++;
    if (ev.type === 'lost') lostEv++;
  }
}
ok(snagged > 0, 'pinnacles the charts missed snag fast ROVs (' + snagged + ' fouls, ' + lostEv + ' losses)');

/* ------------------------------------------------ quests */
section('quest engine');
const built = Q.buildQuests(terrain);
ok(built.quests.length === 8, 'eight quests (q0..q7)');
const q0 = built.quests[0];
ok(q0.kind === 'sawyer', 'quest 0 is the fence');
const gs0 = { measured: new Uint8Array(10000), relicsFound: {}, stormsTracked: 0,
              rightCalls: 0, exceptionLogged: false, sawyer: { bed: false, teeth: false } };
ok(q0.progress(gs0).cur === 0, 'fence starts locked');
gs0.sawyer.bed = true; gs0.sawyer.teeth = true;
ok(Q.isDone(q0, gs0), 'chores unlock the swarm');

/* chart quests are real: measure their actual target tiles -> they complete */
const gs1 = { measured: new Uint8Array(10000), relicsFound: {}, stormsTracked: 0,
              rightCalls: 0, exceptionLogged: false, sawyer: { bed: true, teeth: true } };
const q1 = built.quests[1]; /* shelf 40-60 fm west face */
const p0 = q1.progress(gs1);
ok(p0.goal > 20, 'q1 target computed from hidden terrain (' + p0.goal + ' tiles)');
/* simulate completing q1 by measuring exactly its tiles */
q1.targets.forEach(i => { gs1.measured[i] = 1; });
ok(Q.isDone(q1, gs1), 'measuring the real tiles completes the quest');

/* hidden exception quest */
const q7 = built.quests[7];
ok(q7.hidden && q7.rare, 'q7 hidden + rare');
ok(!q7.unlocksWhen(gs1), 'q7 stays hidden before first tracked storm');
gs1.stormsTracked = 1;
ok(q7.unlocksWhen(gs1), 'q7 revealed after first tracked storm');
gs1.exceptionLogged = true;
ok(Q.isDone(q7, gs1), 'annotating completes the rarest achievement');

/* relics fire on reveal */
const gs2 = { relicsFound: {} };
const skiff = terrain.features.relics.find(r => r.type === 'skiff');
const foundNow = Q.checkRelics(gs2, terrain, [{ x: skiff.x, y: skiff.y }]);
ok(foundNow.length === 1 && foundNow[0].id === 'skiff', 'relic discovered when sounded');
ok(Q.checkRelics(gs2, terrain, [{ x: skiff.x, y: skiff.y }]).length === 0, 'no double-discovery');

/* ------------------------------------------------ storms + the exception */
section('fish storms');
const sys = S.createStormSystem(SEED ^ 0x5EED, terrain);
const cursor = { x: 50, y: 50 };
const tracker = S.createTracker();
let stacked = null, trackDone = null, trackedStorm = null;
for (let i = 0; i < 13000; i++) { /* 208s sim */
  const dt = 0.016;
  const evs = S.update(sys, dt);
  for (const ev of evs) {
    if (ev.type === 'exceptionStacked') stacked = ev;
  }
  if (!trackedStorm && sys.storms.length) {
    trackedStorm = sys.storms[0];
    tracker.stormId = trackedStorm.id;
  }
  const st = sys.storms.find(s => s.id === tracker.stormId);
  if (st) { cursor.x = st.cx; cursor.y = st.cy; } /* perfect helmsman */
  const tr = S.updateTracker(tracker, sys, cursor, dt);
  if (tr && tr.completed && !trackDone) trackDone = sys.time;
}
ok(sys.totalSpawned >= 2, 'storms spawn on schedule (' + sys.totalSpawned + ' spawned)');
ok(trackDone !== null && trackDone <= 70, '20-min track completes in ~60s of play (' +
   (trackDone === null ? 'never' : trackDone.toFixed(1) + 's') + ')');
ok(stacked !== null, 'THE DEEP-CURRENT EXCEPTION: storm stacks in the deepest basin');
if (stacked) {
  const dp = terrain.features.deepest;
  ok(Math.hypot(stacked.x - dp.x, stacked.y - dp.y) <= 4,
     'stacked within 4 tiles of the deepest point');
  ok(stacked.depth >= 165, 'fish on bottom, deep (' + stacked.depth.toFixed(0) + ' fm)');
}
/* predict helper */
const anyStorm = sys.storms[0];
if (anyStorm) {
  const p = S.predict(sys, anyStorm, 8);
  ok(p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100, 'predict stays on the chart');
}

/* ------------------------------------------------ cartography */
section('cartography (same ink)');
/* marching squares on a synthetic ridge: field = x, iso at 50 -> vertical line */
const segs = D.isobathSegments(new Float32Array(10000).map((_, i) => (i % 100)), null, 50);
ok(segs.length === 99, 'marching squares: one isobath per row (99 rows)');
/* real terrain isobaths only where measured */
const m4 = new Uint8Array(10000);
for (let y = 40; y < 44; y++) for (let x = 40; x < 44; x++) m4[y * 100 + x] = 1;
const segs4 = D.isobathSegments(terrain.depth, m4, 60);
ok(segs4.length > 0, 'isobaths drawn only from sounded tiles (' + segs4.length + ' segments)');

/* export JSON is the artifact */
const state = {
  seed: SEED, terrain: terrain, measured: m4, measuredCount: 16,
  relics: built.relics.map(r => ({ type: r.id, x: r.x, y: r.y, found: false, note: r.flavor })),
  annotations: [{ x: 70, y: 60, text: 'deep current — fish on bottom, 204 fm', exception: true }],
  losses: [], questLog: [{ title: 'x', done: true }],
  score: { tiles: 16, stormsTracked: 1, rightCalls: 3, score: 331 }, xp: 100, rank: 'Deckhand',
  watchLog: [{ t: 90, note: 'biolog: unknown — translucent' }]
};
const json = D.exportJSON(state);
ok(json.seed === SEED && json.soundedTiles === 16, 'JSON carries the survey');
ok(json.tiles.length === 16 && json.tiles[0].d > 0, 'JSON tiles carry true fathoms');
ok(json.annotations[0].exception === true, 'exception rides in the JSON, same record');
ok(json.watchLog.length === 1, 'the log of what drifts by is saved like everything else');
const pngCanvas = D.exportCanvas(state);
ok(!!pngCanvas, 'PNG chart renders headless (canvas + stub)');

/* palette sanity: deeper = darker */
const p30 = D.palette(30), p200 = D.palette(200);
ok(p200[0] < p30[0] && p200[2] < p30[2], 'palette darkens with depth');

/* ------------------------------------------------ integration: a full session */
section('full session sim');
const tm = T.generate(SEED);
const mq = new Uint8Array(10000);
const sw = R.createSwarm({ x: 50, y: 10 });
const bu = Q.buildQuests(tm);
const sy = S.createStormSystem(SEED ^ 0x5EED, tm);
const tk = S.createTracker();
const cur = { x: 50, y: 50 };
let exStack = null;
let sessTime = 0;
for (let i = 0; i < 12000; i++) { /* 192s session: mow, track, annotate */
  const dt = 0.016;
  sessTime += dt;
  const inp = i === 10 ? { toggleMow: true } : {};
  R.update(sw, dt, inp, tm, mq, sessTime);
  for (const ev of S.update(sy, dt)) if (ev.type === 'exceptionStacked') exStack = ev;
  if (!tk.stormId && sy.storms.length) tk.stormId = sy.storms[0].id;
  const st = sy.storms.find(s => s.id === tk.stormId);
  if (st) { cur.x = st.cx; cur.y = st.cy; }
  S.updateTracker(tk, sy, cur, dt);
}
const gss = {
  measured: mq, relicsFound: {}, stormsTracked: tk.done ? 1 : 0,
  rightCalls: 2, exceptionLogged: !!exStack, sawyer: { bed: true, teeth: true }
};
ok(R.coveragePct(mq) > 8, 'session charted real bottom (' + R.coveragePct(mq).toFixed(1) + '%)');
ok(tk.done, 'session completed a 20-minute track');
ok(Q.isDone(bu.quests[1], gss) || q1Progress(gss, bu), 'shelf quest advanced/complete from mowing alone');
function q1Progress(g, b) { return b.quests[1].progress(g).cur > 200; }
ok(!!exStack, 'session witnessed the deep-current exception');

/* ------------------------------------------------ verdict */
console.log('\n' + '='.repeat(50));
console.log('PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
