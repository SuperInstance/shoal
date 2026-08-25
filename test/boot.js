/* SHOAL boot smoke — loads index.html's script set with a minimal DOM shim and
 * runs the real frame loop: fence -> unlock -> survey. Catches broken element
 * IDs, reference errors, and loop crashes without a browser.
 * Run: node test/boot.js
 */
'use strict';

/* ---------------------------------------------------- DOM shim */
function makeCtx() {
  const ctx = { canvas: null, fillStyle: '', strokeStyle: '', lineWidth: 1,
                font: '', textAlign: '', globalAlpha: 1 };
  for (const fn of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'arc',
                    'ellipse', 'closePath', 'fill', 'stroke', 'save', 'restore',
                    'translate', 'rotate', 'setLineDash', 'fillText']) {
    ctx[fn] = () => {};
  }
  ctx.createRadialGradient = ctx.createLinearGradient = () => ({ addColorStop: () => {} });
  return ctx;
}
let elCount = 0;
function makeEl(id, tag) {
  const el = {
    id, tag: tag || 'div', children: [], style: {}, dataset: {},
    textContent: '', value: '', checked: false, disabled: false, innerHTML: '',
    clientWidth: 800, clientHeight: 800, width: 800, height: 800,
    _handlers: {}, firstChild: null,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, f) { (f === undefined ? !this._set.has(c) : f) ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    addEventListener(t, fn) { (el._handlers[t] = el._handlers[t] || []).push(fn); },
    fire(t, ev) { (el._handlers[t] || []).forEach(fn => fn(ev || {})); },
    appendChild(c) { el.children.push(c); if (!el.firstChild) el.firstChild = c; return c; },
    insertBefore(c) { el.children.unshift(c); el.firstChild = c; return c; },
    removeChild(c) { el.children = el.children.filter(x => x !== c); return c; },
    remove() {}, focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 })
  };
  if (id === 'map' || tag === 'canvas') {
    el.width = 800; el.height = 800; el.tag = 'canvas';
    const ctx = makeCtx(); ctx.canvas = el; el.getContext = () => ctx;
  }
  elCount++;
  return el;
}
const els = {};
const documentShim = {
  createElement: (tag) => {
    const el = makeEl(null, tag);
    if (tag === 'a') el.href = '', el.click = () => {};
    if (tag === 'canvas') el.toBlob = (cb) => cb({ size: 1 });
    return el;
  },
  getElementById: (id) => els[id] || (els[id] = makeEl(id))
};
global.document = documentShim;
global.self = global;
global.location = { hash: '' };
const winHandlers = {};
const win = {
  addEventListener: (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); },
  removeEventListener: () => {},
  fire: (t, ev) => (winHandlers[t] || []).forEach(fn => fn(ev || {}))
};
global.window = win;
let now = 0;
global.performance = { now: () => now };
const rafQueue = [];
global.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };

/* ---------------------------------------------------- load scripts in page order */
global.SHOAL = {
  Terrain: require('../js/terrain.js'),
  Rovs: require('../js/rovs.js'),
  Quests: require('../js/quests.js'),
  Storms: require('../js/storms.js'),
  Render: require('../js/render.js')
};

let pass = 0, fail = 0;
const D = (id) => documentShim.getElementById(id);
const ok = (c, n) => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('FAIL  ' + n)); };

require('../js/main.js');   /* boots immediately, starts rAF loop */
ok(true, 'main.js boots without reference errors');
ok(els['quests'] && els['quests'].children.length >= 8, 'quest log populated (' +
   (els['quests'] ? els['quests'].children.length : 0) + ' entries)');
ok(els['rank'].textContent === 'Greenhorn', 'rank board live');

function frames(n) {
  for (let i = 0; i < n; i++) {
    now += 16;
    const q = rafQueue.splice(0);
    if (!q.length) throw new Error('rAF queue empty — loop died');
    q.forEach(fn => fn(now));
  }
}
frames(10);  /* fenced: the bottom stays hidden */
ok(D('onboard').classList.contains('hidden') === false, 'fence holds before chores');

/* the Sawyer transaction, done straight */
els['chk-bed'].checked = true; els['chk-bed'].fire('change');
els['chk-teeth'].checked = true; els['chk-teeth'].fire('change');
ok(D('btn-unlock').disabled === false, 'both chores done -> bloodhounds unlockable');
D('btn-unlock').fire('click');
ok(D('onboard').classList.contains('hidden'), 'onboarding dismissed');

/* steer east + mow: hold 'd' on the window, then toggle mow via the header button */
win.fire('keydown', { key: 'd', preventDefault: () => {} });
frames(30);
els['btn-mode'].fire('click');
frames(600);   /* ~10s of mowing */
const tiles = +els['s-tiles'].textContent;
ok(tiles > 50, 'swarm surveys the bottom (' + tiles + ' tiles sounded)');
ok(+els['s-score'].textContent > 0, 'score counts tiles mapped');
ok(els['s-mow'].textContent !== '0', 'mow tiles accrue (' + els['s-mow'].textContent + ')');

/* storm telemetry HUD comes alive */
frames(1200);  /* ~20s: storms spawn */
ok(els['tel-state'].textContent.length > 0, 'telemetry HUD reporting (' +
   els['tel-state'].textContent + ')');

/* export buttons fire without a browser */
els['btn-json'].fire('click');
els['btn-png'].fire('click');
ok(true, 'PNG + JSON export handlers run');

/* watch mode */
els['btn-watch'].fire('click');
ok(D('watch').classList.contains('hidden') === false, 'night watch opens');
frames(60);
ok(D('feeds').children.length === 6, 'six camera feeds tiled');
els['btn-watch'].fire('click');
ok(D('watch').classList.contains('hidden'), 'night watch closes');

console.log('\nBOOT: PASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
