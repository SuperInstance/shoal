/* SHOAL main — the wheelhouse. Glues terrain, swarm, storms, quests, cartography.
 * The game never lies: every quest target, relic, and annotation is real
 * work wearing the typography of play.
 */
(function () {
  'use strict';
  var T = SHOAL.Terrain, R = SHOAL.Rovs, Q = SHOAL.Quests,
      S = SHOAL.Storms, D = SHOAL.Render;

  /* ------------------------------------------------------------ state */
  var seed = 20260824;
  var m = location.hash.match(/seed=(\d+)/);
  if (m) seed = +m[1];

  var terrain = T.generate(seed);
  var built = Q.buildQuests(terrain);
  var swarm = R.createSwarm({ x: 50, y: 12 });
  var measured = new Uint8Array(100 * 100);
  var stormSys = S.createStormSystem(seed ^ 0x5EED, terrain);
  var tracker = S.createTracker();

  var state = {
    seed: seed, terrain: terrain, measured: measured, measuredCount: 0,
    swarm: swarm, stormSys: stormSys, tracker: tracker,
    quests: built.quests, relics: normalizeRelics(built.relics, terrain),
    annotations: [], losses: [],
    score: { tiles: 0, stormsTracked: 0, rightCalls: 0, score: 0 },
    xp: 0, rank: 'Greenhorn',
    sawyer: { bed: false, teeth: false, unlocked: false },
    exceptionLogged: false, exceptionStackedAt: null,
    watchLog: [], log: [], questLog: [],
    watching: false, paused: false, time: 0
  };
  function gameStateForQuests() {
    return {
      measured: measured, relicsFound: relicsFoundMap(),
      stormsTracked: state.score.stormsTracked, rightCalls: state.score.rightCalls,
      exceptionLogged: state.exceptionLogged, sawyer: state.sawyer
    };
  }
  function relicsFoundMap() {
    var o = {};
    state.relics.forEach(function (r) { o[r.type] = !!r.found; });
    return o;
  }

  /* quests module may hand relics as {id,...} array or map-form spots;
   * normalize to render/state shape regardless. */
  function normalizeRelics(relics, terr) {
    var spots = (terr.features && terr.features.relics) || [];
    var byType = {};
    if (Array.isArray(spots)) {
      spots.forEach(function (s) { byType[s.type] = s; });
    } else {
      Object.keys(spots).forEach(function (k) { byType[k] = spots[k]; });
    }
    var out = [];
    (relics || []).forEach(function (r) {
      var type = r.type || r.id;
      var spot = byType[type] || r;
      out.push({
        type: type, x: spot.x, y: spot.y, found: false,
        note: r.flavor || r.note || Q.RELIC_FLAVOR[type] || '',
        label: ({ skiff: 'skiff', whalefall: 'whale fall', metridium: 'metridiums' })[type] || type
      });
    });
    if (!out.length) { /* fallback: build from terrain spots directly */
      Object.keys(byType).forEach(function (k) {
        out.push({ type: k, x: byType[k].x, y: byType[k].y, found: false,
          note: Q.RELIC_FLAVOR[k] || '', label: k });
      });
    }
    return out;
  }

  /* ------------------------------------------------------------ dom */
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('map'), ctx = canvas.getContext('2d');
  var view = { ox: 0, oy: 0, s: 8 };
  var cursor = { x: 50, y: 50 };
  var flash = null;           // right-spot verdict
  var selectedStormId = null;
  var keys = {};
  var viewScale = 8;

  /* ------------------------------------------------------------ input */
  window.addEventListener('keydown', function (e) {
    if (annotateOpen) {
      if (e.key === 'Enter') { saveAnnotation(); e.preventDefault(); }
      if (e.key === 'Escape') closeAnnotation();
      return; /* typing belongs to the annotation, not the helm */
    }
    keys[e.key.toLowerCase()] = true;
    var k = e.key.toLowerCase();
    if (k === 'm') toggleMow();
    if (k === '1') setFormation('line');
    if (k === '2') setFormation('wedge');
    if (k === '3') setFormation('ladder');
    if (k === '[') spacingDelta(-1);
    if (k === ']') spacingDelta(1);
    if (k === ' ') { state.paused = !state.paused; swarm.mow.paused = state.paused; e.preventDefault(); }
    if (k === 'n') toggleWatch();
    if (k === 'e') openAnnotation();
    if (k === 'c') rightSpotCall();
    if (k === 'tab') { cycleStorm(); e.preventDefault(); }
  });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });

  function canvasPos(e) {
    var r = canvas.getBoundingClientRect();
    var scale = canvas.width / r.width;
    return {
      x: ((e.clientX - r.left) * scale - view.ox) / view.s,
      y: ((e.clientY - r.top) * scale - view.oy) / view.s
    };
  }
  canvas.addEventListener('mousemove', function (e) {
    var p = canvasPos(e); cursor.x = p.x; cursor.y = p.y;
  });
  canvas.addEventListener('click', function (e) {
    var p = canvasPos(e);
    /* select a storm if clicked near one, else place the fishing cursor there */
    var best = null, bd = 1e9;
    state.stormSys.storms.forEach(function (s) {
      var d = Math.hypot(s.cx - p.x, s.cy - p.y);
      if (d < s.r + 2 && d < bd) { bd = d; best = s; }
    });
    if (best) selectStorm(best.id);
  });

  /* ------------------------------------------------------------ sawyer */
  var chkBed = $('chk-bed'), chkTeeth = $('chk-teeth'), btnUnlock = $('btn-unlock');
  function fenceCheck() {
    btnUnlock.disabled = !(chkBed.checked && chkTeeth.checked);
  }
  chkBed.addEventListener('change', function () {
    state.sawyer.bed = chkBed.checked; fenceCheck(); questsDirty = true;
  });
  chkTeeth.addEventListener('change', function () {
    state.sawyer.teeth = chkTeeth.checked; fenceCheck(); questsDirty = true;
  });
  btnUnlock.addEventListener('click', function () {
    state.sawyer.unlocked = true;
    $('onboard').classList.add('hidden');
    toast('The bloodhounds are yours. Six ROVs. Sound the bottom.');
    addLog('swarm unlocked — survey begins', 'gold');
  });

  /* ------------------------------------------------------------ toasts/log */
  function toast(text, cls) {
    var el = document.createElement('div');
    el.className = 'toast' + (cls ? ' ' + cls : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }
  function addLog(text, cls) {
    state.log.unshift({ t: Math.round(state.time), text: text });
    if (state.log.length > 60) state.log.pop();
    var li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    var logEl = $('log');
    logEl.insertBefore(li, logEl.firstChild);
    while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
  }

  /* ------------------------------------------------------------ controls */
  function toggleMow() {
    if (!state.sawyer.unlocked) return;
    swarm.mow.paused = false;
    pendingToggleMow = true;
  }
  var pendingToggleMow = false;
  function setFormation(f) { pendingFormation = f; }
  var pendingFormation = null;
  function spacingDelta(d) { pendingSpacing += d; }
  var pendingSpacing = 0;
  $('btn-mode').addEventListener('click', toggleMow);
  $('btn-watch').addEventListener('click', toggleWatch);

  /* ------------------------------------------------------------ storms */
  function selectStorm(id) {
    if (tracker.stormId === id) return;
    tracker.stormId = id; tracker.locked = 0;
    selectedStormId = id;
    var s = stormById(id);
    toast(s ? 'Telemetry on storm ' + id + '. Keep the cursor in the cloud.' : 'Telemetry off.');
  }
  function cycleStorm() {
    var list = state.stormSys.storms;
    if (!list.length) { toast('No storms on the water.'); return; }
    var i = -1;
    for (var j = 0; j < list.length; j++) if (list[j].id === selectedStormId) i = j;
    selectStorm(list[(i + 1) % list.length].id);
  }
  function stormById(id) {
    for (var i = 0; i < state.stormSys.storms.length; i++)
      if (state.stormSys.storms[i].id === id) return state.stormSys.storms[i];
    return null;
  }
  var callCooldown = 0;
  function rightSpotCall() {
    if (!state.sawyer.unlocked || state.watching) return;
    if (callCooldown > 0) return;
    callCooldown = 6;
    /* is the boat in the right spot? score against where the storm WILL be */
    var best = null, bd = 1e9;
    state.stormSys.storms.forEach(function (s) {
      var p = S.predict(state.stormSys, s, 8);
      var d = Math.hypot(p.x - cursor.x, p.y - cursor.y);
      if (d < bd) { bd = d; best = { s: s, p: p, d: d }; }
    });
    var hit = best && best.d <= best.s.r;
    if (hit) {
      state.score.rightCalls++;
      flash = { hit: true, x: cursor.x, y: cursor.y };
      toast('Right spot. Gear down.', 'gold');
      addLog('right-spot call: HIT (storm ' + best.s.id + ')', 'gold');
      awardXP(25);
    } else {
      flash = { hit: false, x: cursor.x, y: cursor.y };
      toast('Not the spot. Calling it straight.', 'red');
      addLog('right-spot call: miss', 'red');
      state.score.score = Math.max(0, state.score.score - 10);
    }
    updateScore();
  }

  /* ------------------------------------------------------------ annotation */
  var annotateOpen = false, annoPos = null;
  function openAnnotation() {
    if (!state.sawyer.unlocked || state.watching) return;
    annotateOpen = true; annoPos = { x: cursor.x, y: cursor.y };
    $('annotate').classList.remove('hidden');
    var inp = $('anno-text');
    var stackedNear = null;
    state.stormSys.storms.forEach(function (s) {
      if (s.mode === 'stacked' && Math.hypot(s.cx - cursor.x, s.cy - cursor.y) < s.r + 2) stackedNear = s;
    });
    if (stackedNear) {
      inp.value = 'deep current — fish on bottom, ' + Math.round(terrain.depthAt(Math.floor(stackedNear.cx), Math.floor(stackedNear.cy))) + ' fm';
    } else {
      inp.value = '';
    }
    setTimeout(function () { inp.focus(); }, 30);
  }
  function closeAnnotation() {
    annotateOpen = false;
    $('annotate').classList.add('hidden');
  }
  function saveAnnotation() {
    var text = $('anno-text').value.trim();
    closeAnnotation();
    if (!text) return;
    /* the exception counts if a stacked column sits under the pen — selection
     * or not. Finding it and marking it is the achievement. */
    var stackedNear = state.stormSys.storms.some(function (s) {
      return s.mode === 'stacked' && Math.hypot(s.cx - annoPos.x, s.cy - annoPos.y) < s.r + 3;
    });
    var isException = !!stackedNear && !state.exceptionLogged;
    state.annotations.push({ x: annoPos.x, y: annoPos.y, text: text, exception: isException });
    if (isException) {
      state.exceptionLogged = true;
      toast('ANOMALY LOGGED — same ink as the contours', 'gold');
      addLog('exception annotated: ' + text, 'gold');
      awardXP(200);
      addLog('achievement: The Deep-Current Exception', 'gold');
    } else {
      toast('Annotation logged.');
      addLog('annotation: ' + text);
    }
    questsDirty = true;
  }

  /* ------------------------------------------------------------ watch mode */
  var feedCanvases = [];
  var trails = [[], [], [], [], [], []];
  function toggleWatch() {
    state.watching = !state.watching;
    $('watch').classList.toggle('hidden', !state.watching);
    if (state.watching) {
      if (!feedCanvases.length) {
        var feeds = $('feeds');
        for (var i = 0; i < 6; i++) {
          var cv = document.createElement('canvas');
          cv.width = 320; cv.height = 240;
          feeds.appendChild(cv);
          feedCanvases.push(cv.getContext('2d'));
        }
      }
      addLog('night passage — watching');
    }
  }
  function updateWatch(dt) {
    /* feeds drift even when the swarm is fouled: the bottom moves past regardless */
    for (var i = 0; i < 6; i++) {
      var rov = swarm.rovs[i];
      if (rov.alive) {
        trails[i].push({ x: rov.x, y: rov.y });
        if (trails[i].length > 60) trails[i].shift();
      }
      if (trails[i].length) {
        D.drawFeed(feedCanvases[i], rov, terrain, trails[i], state.time, seed + i * 977);
      }
    }
    /* the biologists' line: some of it nobody has ever seen */
    if (Math.random() < dt / 45) {
      var lines = [
        'biolog: chiton raft, drifting',
        'biolog: squid pair, holding the light',
        'biolog: unknown — translucent, unlogged in any key',
        'biolog: ratfish, three, bottom-following',
        'biolog: something big, passed the cone edge, not identified'
      ];
      var line = lines[(Math.random() * lines.length) | 0];
      state.watchLog.push({ t: Math.round(state.time), note: line });
      if (line.indexOf('unknown') >= 0 || line.indexOf('not identified') >= 0) {
        addLog(line, 'gold');
      }
    }
  }

  /* ------------------------------------------------------------ xp */
  var RANKS = [[0, 'Greenhorn'], [150, 'Deckhand'], [400, 'Swarmhand'],
               [900, 'Wheelhouse'], [1800, 'Cartographer'], [3000, 'The Fleet Below']];
  function awardXP(n) {
    state.xp += n;
    for (var i = RANKS.length - 1; i >= 0; i--) {
      if (state.xp >= RANKS[i][0]) {
        if (state.rank !== RANKS[i][1]) {
          state.rank = RANKS[i][1];
          toast('Record board: ' + state.rank, 'gold');
          addLog('rank: ' + state.rank, 'gold');
        }
        break;
      }
    }
    updateScore();
  }
  var achievements = {};
  function checkAchievements() {
    if (!achievements.first && state.measuredCount > 0) { achievements.first = 1; awardXP(10); }
    if (!achievements.mow && swarm.stats.mowTiles >= 250) {
      achievements.mow = 1; toast('Achievement: Mow Hand', 'gold'); addLog('achievement: Mow Hand', 'gold');
    }
    if (!achievements.carto && state.measuredCount >= 3000) {
      achievements.carto = 1; toast('Achievement: Cartographer', 'gold'); addLog('achievement: Cartographer', 'gold');
    }
  }

  /* ------------------------------------------------------------ hud */
  function updateScore() {
    state.score.score = state.measuredCount + state.score.stormsTracked * 150 + state.score.rightCalls * 25;
    $('s-tiles').textContent = state.measuredCount;
    $('s-mow').textContent = swarm.stats.mowTiles;
    $('s-storms').textContent = state.score.stormsTracked;
    $('s-calls').textContent = state.score.rightCalls;
    $('s-score').textContent = state.score.score;
    $('s-xp').textContent = state.xp;
    $('rank').textContent = state.rank;
  }
  var questsDirty = true;
  function updateQuests() {
    var gs = gameStateForQuests();
    var ul = $('quests');
    ul.innerHTML = '';
    state.questLog = [];
    state.quests.forEach(function (q) {
      if (q.hidden && !(q.unlocksWhen && q.unlocksWhen(gs))) {
        var li = document.createElement('li');
        li.className = 'hiddenq';
        li.innerHTML = '<span class="qtitle">— ? —</span>';
        ul.appendChild(li);
        return;
      }
      var p = q.progress(gs);
      var done = p.cur >= p.goal;
      var li = document.createElement('li');
      li.className = (done ? 'done ' : '') + (q.rare ? 'rare' : '');
      li.innerHTML =
        '<div class="qtitle">' + q.title + '</div>' +
        '<div class="qdesc">' + q.desc + '</div>' +
        '<div class="qprog">' + p.cur + ' / ' + p.goal + ' ' + p.label + '</div>';
      ul.appendChild(li);
      state.questLog.push({ title: q.title, done: done });
      if (done && !q._doneAt) {
        q._doneAt = state.time;
        awardXP(q.xp || 50);
        toast('Quest complete: ' + q.title, 'gold');
        addLog('quest: ' + q.title, 'gold');
      }
    });
  }

  /* ------------------------------------------------------------ exports */
  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  $('btn-png').addEventListener('click', function () {
    var cv = D.exportCanvas(state);
    cv.toBlob(function (b) { download('shoal-survey-' + seed + '.png', b); }, 'image/png');
    toast('Chart exported. The map is the artifact.', 'gold');
    addLog('export: PNG chart');
  });
  $('btn-json').addEventListener('click', function () {
    var data = D.exportJSON(state);
    download('shoal-survey-' + seed + '.json',
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    toast('Survey data exported.');
    addLog('export: JSON survey');
  });

  /* ------------------------------------------------------------ loop */
  var last = performance.now();
  var clockAcc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!state.sawyer.unlocked) { draw(); return; }
    if (state.paused) { draw(); return; }
    state.time += dt;
    callCooldown = Math.max(0, callCooldown - dt);
    if (flash) { flash.t = (flash.t || 0) + dt; if (flash.t > 1.2) flash = null; }

    /* swarm */
    var input = {
      ax: (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0),
      ay: (keys['s'] || keys['arrowdown'] ? 1 : 0) - (keys['w'] || keys['arrowup'] ? 1 : 0),
      toggleMow: pendingToggleMow, setFormation: pendingFormation, mowSpacingDelta: pendingSpacing
    };
    pendingToggleMow = false; pendingFormation = null; pendingSpacing = 0;
    var res = R.update(swarm, dt, input, terrain, measured, state.time);
    state.measuredCount = swarm.stats.tiles;

    res.events.forEach(function (ev) {
      if (ev.type === 'sweepEnd') { toast('Sweep complete. Rows laid: ' + swarm.stats.sweeps); }
      if (ev.type === 'snag') {
        toast(ev.rov + ' snagged a pinnacle the charts missed — ' + Math.round(ev.depth) + ' fm', 'red');
        addLog(ev.rov + ' fouled on uncharted pinnacle', 'red');
        awardXP(-15);
      }
      if (ev.type === 'lost') {
        state.losses.push({ rov: ev.rov, x: ev.x, y: ev.y, depth: terrain.depthAt(ev.x, ev.y) });
        toast(ev.rov + ' lost. Shown plainly: no spin.', 'red');
        addLog(ev.rov + ' LOST — hull breached on pinnacle', 'red');
      }
    });
    /* mow tiles are worth double — the pattern he invented himself */
    if (res.revealed.length) {
      awardXP(res.revealed.length + (swarm.mode === 'mow' ? res.revealed.length : 0));
      var found = Q.checkRelics({ relicsFound: relicsFoundMap() }, terrain, res.revealed);
      found.forEach(function (fr) {
        state.relics.forEach(function (r) { if (r.type === (fr.id || fr.type)) r.found = true; });
        toast('Relic discovered: ' + (fr.flavor || fr.note || fr.id), 'gold');
        addLog('relic: ' + (fr.id || fr.type), 'gold');
        awardXP(60);
      });
      questsDirty = true;
      updateScore();
    }

    /* storms */
    var evs = S.update(stormSys, dt);
    evs.forEach(function (ev) {
      if (ev.type === 'exceptionBegin') {
        addLog('storm ' + ev.id + ': column, leaning downhill — no edge rule holds', 'gold');
        toast('A storm is leaning downhill. The deep current.', 'gold');
      }
      if (ev.type === 'exceptionStacked') {
        state.exceptionStackedAt = { x: ev.x, y: ev.y };
        toast('Fish stacked in the deepest basin. Nobody taught them this.', 'gold');
        addLog('exception: biomass stacked at ' + Math.round(ev.depth) + ' fm', 'gold');
      }
      if (ev.type === 'exceptionMissed') addLog('the deep current passed unlogged');
      if (ev.type === 'rainedOut' && ev.id === selectedStormId) selectedStormId = null;
    });
    var tr = S.updateTracker(tracker, stormSys, cursor, dt);
    if (tr && tr.completed) {
      state.score.stormsTracked++;
      toast('Storm tracked — 20 minutes of telemetry. Bloodhound.', 'gold');
      addLog('storm tracked (20:00 telemetry)', 'gold');
      if (!achievements.bloodhound) {
        achievements.bloodhound = 1;
        toast('Achievement: Bloodhound', 'gold');
        addLog('achievement: Bloodhound', 'gold');
      }
      awardXP(100);
      updateScore(); questsDirty = true;
    }
    if (tr && tr.type === 'trackLost') {
      toast('Storm rained out. Telemetry gap — lock resets.', 'red');
      addLog('track lost: storm rained out', 'red');
      selectedStormId = null;
    }

    checkAchievements();
    if (questsDirty) { questsDirty = false; updateQuests(); }

    /* telemetry clock: 60 s of play renders as 20:00 of boat time */
    var tel = $('tel-clock'), fill = $('tel-fill'), telState = $('tel-state');
    var tracked = stormById(tracker.stormId);
    if (tracked) {
      var remain = Math.max(0, tracker.need - tracker.locked);
      var boatSec = remain * 20; /* 1 s play = 20 s boat */
      tel.textContent = tracker.done ? '00:00' :
        String(Math.floor(boatSec / 60)).padStart(2, '0') + ':' + String(Math.floor(boatSec % 60)).padStart(2, '0');
      fill.style.width = Math.min(100, tracker.locked / tracker.need * 100) + '%';
      telState.textContent = 'storm ' + tracked.id + ' — ' + tracked.mode +
        (tracker.locked > 0 ? ' · lock held' : ' · out of the cloud');
    } else {
      tel.textContent = '20:00';
      fill.style.width = '0%';
      telState.textContent = stormSys.storms.length
        ? stormSys.storms.length + ' storm' + (stormSys.storms.length > 1 ? 's' : '') + ' on the water — click one'
        : 'no storms on the water';
    }

    clockAcc += dt;
    if (clockAcc > 1) {
      clockAcc = 0;
      $('clock').textContent =
        String(Math.floor(state.time / 60)).padStart(2, '0') + ':' + String(Math.floor(state.time % 60)).padStart(2, '0');
    }

    if (state.watching) updateWatch(dt);
    draw();
  }

  /* ------------------------------------------------------------ draw */
  function draw() {
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var wrap = $('mapwrap');
    var fit = Math.min(wrap.clientWidth - 24, wrap.clientHeight - 24, 800);
    view.s = fit / 100;
    view.ox = (canvas.width - fit) / 2;
    view.oy = (canvas.height - fit) / 2;
    canvas.style.width = fit + 'px';
    canvas.style.height = fit + 'px';

    if (!state.sawyer.unlocked) {
      /* the bottom stays hidden until the fence is cleared */
      ctx.fillStyle = '#161d26';
      ctx.fillRect(view.ox, view.oy, view.s * 100, view.s * 100);
      ctx.fillStyle = '#3b4b5c';
      ctx.font = 'italic 16px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('the bottom is down there', canvas.width / 2, canvas.height / 2 - 10);
      ctx.fillText('earn the swarm first', canvas.width / 2, canvas.height / 2 + 14);
      return;
    }
    D.drawTiles(ctx, state, view, false);
    D.drawContours(ctx, state, view, false);
    D.drawRelics(ctx, state, view);
    D.drawAnnotations(ctx, state, view);
    D.drawLosses(ctx, state, view);
    D.drawStorms(ctx, stormSys, state.time, view, selectedStormId);
    D.drawSwarm(ctx, swarm, state.time, view);
    D.drawCursor(ctx, cursor, view, flash);

    /* mow badge */
    if (swarm.mode === 'mow') {
      ctx.fillStyle = '#69d2c8';
      ctx.font = 'italic 12px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.fillText('MOWING — spacing ' + swarm.mow.spacing.toFixed(0) + ' tiles · ' +
        swarm.stats.sweeps + ' sweeps laid', view.ox + 8, view.oy + 16);
    }
  }

  updateQuests();
  updateScore();
  requestAnimationFrame(frame);
})();
