/* SHOAL.Render — the cartographer.
 * Doctrine: exceptions are terrain too. Annotations render through the SAME
 * inking pipeline as measured isobaths — same stroke, same font, same ink.
 * The map IS the artifact: exportPNG / exportJSON produce the deliverable.
 */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) { module.exports = m; }
  else { root.SHOAL = root.SHOAL || {}; root.SHOAL.Render = m; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 100, H = 100;

  /* ---------------------------------------------------------------- ink */
  var INK = '#22303f';          // the one ink. contours, labels, annotations
  var INK_INDEX = '#141e29';    // index isobaths (every 100 fm), heavier hand
  var PAPER = '#e9e2cf';
  var UNSURVEYED = '#20262d';
  var GOLD = '255, 200, 60';

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* Fathom palette — shallow warm bank to deep basin. */
  function palette(d) {
    var stops = [
      [0, 214, 199, 155], [30, 168, 186, 158], [60, 118, 168, 160],
      [100, 78, 138, 148], [150, 52, 96, 118], [200, 34, 62, 82], [240, 24, 42, 56]
    ];
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stops[i], b = stops[i + 1];
      if (d <= b[0]) {
        var t = Math.max(0, (d - a[0]) / (b[0] - a[0]));
        return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
      }
    }
    return [24, 42, 56];
  }
  function depthFill(d) {
    var c = palette(d);
    return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
  }

  /* ------------------------------------------------- marching squares */
  /* Isobath segments over a field, honoring a mask of usable corners.
   * Corner bits: tl=1 tr=2 br=4 bl=8. Edges: top, right, bottom, left. */
  var CASES = {
    1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]],
    6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]],
    11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]], 15: []
  };

  function isobathSegments(field, mask, iso) {
    var segs = [];
    for (var y = 0; y < H - 1; y++) {
      for (var x = 0; x < W - 1; x++) {
        var i = y * W + x;
        if (mask) {
          if (!mask[i] || !mask[i + 1] || !mask[i + W] || !mask[i + W + 1]) continue;
        }
        var tl = field[i], tr = field[i + 1], br = field[i + W + 1], bl = field[i + W];
        var c = (tl > iso ? 1 : 0) | (tr > iso ? 2 : 0) | (br > iso ? 4 : 0) | (bl > iso ? 8 : 0);
        if (c === 0 || c === 15) continue;
        var pairs = CASES[c];
        var ex = [x + (iso - tl) / (tr - tl), y,                 /* top */
                   x + 1, y + (iso - tr) / (br - tr),           /* right */
                   x + (iso - bl) / (br - bl), y + 1,           /* bottom */
                   x, y + (iso - tl) / (bl - tl)];              /* left */
        for (var p = 0; p < pairs.length; p++) {
          var e0 = pairs[p][0], e1 = pairs[p][1];
          segs.push({ ax: ex[e0 * 2], ay: ex[e0 * 2 + 1], bx: ex[e1 * 2], by: ex[e1 * 2 + 1] });
        }
      }
    }
    return segs;
  }

  /* THE inker. Every contour line and every annotation goes through here —
   * same hand, same ink. Exceptions are terrain too. */
  function inkSegments(ctx, segs, view, style) {
    if (!segs.length) return;
    ctx.save();
    ctx.strokeStyle = style && style.heavy ? INK_INDEX : INK;
    ctx.lineWidth = style && style.heavy ? 1.8 : 0.9;
    ctx.setLineDash(style && style.dash ? [4, 4] : []);
    ctx.beginPath();
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      ctx.moveTo(view.ox + s.ax * view.s, view.oy + s.ay * view.s);
      ctx.lineTo(view.ox + s.bx * view.s, view.oy + s.by * view.s);
    }
    ctx.stroke();
    ctx.restore();
  }

  function inkLabel(ctx, x, y, text, view, opts) {
    ctx.save();
    ctx.font = (opts && opts.big ? 'bold ' : '') + '11px Georgia, serif';
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.fillText(text, view.ox + x * view.s, view.oy + y * view.s);
    ctx.restore();
  }

  /* ------------------------------------------------- inferred surface */
  /* Splined best-guess for unmapped tiles: inverse-distance weighting from
   * measured tiles in a local window. Used ONLY for export — in play, the
   * unsurveyed void stays void. The game never lies. */
  function inferredField(state) {
    var depth = state.terrain.depth, measured = state.measured;
    var out = new Float32Array(W * H), outMask = new Uint8Array(W * H);
    var R = 14;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        if (measured[i]) { out[i] = depth[i]; outMask[i] = 1; continue; }
        var num = 0, den = 0;
        for (var dy = -R; dy <= R; dy += 2) {
          var yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (var dx = -R; dx <= R; dx += 2) {
            var xx = x + dx; if (xx < 0 || xx >= W) continue;
            var j = yy * W + xx;
            if (!measured[j]) continue;
            var d2 = dx * dx + dy * dy || 1;
            num += depth[j] / d2; den += 1 / d2;
          }
        }
        if (den > 0) { out[i] = num / den; outMask[i] = 1; }
      }
    }
    return { field: out, mask: outMask };
  }

  /* ------------------------------------------------- tile layer */
  function drawTiles(ctx, state, view, useInferred) {
    var depth = state.terrain.depth, measured = state.measured;
    var inf = useInferred ? inferredField(state) : null;
    var s = view.s;
    ctx.fillStyle = UNSURVEYED;
    ctx.fillRect(view.ox, view.oy, W * s, H * s);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        var d = null;
        if (measured[i]) d = depth[i];
        else if (inf && inf.mask[i]) d = inf.field[i];
        if (d === null) continue;
        ctx.fillStyle = depthFill(d);
        ctx.globalAlpha = measured[i] ? 1 : 0.38;
        ctx.fillRect(view.ox + x * s, view.oy + y * s, s + 0.5, s + 0.5);
      }
    }
    ctx.globalAlpha = 1;
    /* unsurveyed void hatch, so the paper admits what it doesn't know */
    if (!useInferred) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (var k = 0; k < W; k += 10) {
        ctx.beginPath();
        ctx.moveTo(view.ox + k * s, view.oy);
        ctx.lineTo(view.ox + k * s, view.oy + H * s);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawContours(ctx, state, view, useInferred) {
    var depth = state.terrain.depth, measured = state.measured;
    var field = depth, mask = measured;
    if (useInferred) {
      var inf = inferredField(state);
      field = inf.field; mask = inf.mask;
    }
    for (var iso = 20; iso <= 220; iso += 20) {
      var segs = isobathSegments(field, mask, iso);
      inkSegments(ctx, segs, view, { heavy: iso % 100 === 0, dash: useInferred });
    }
  }

  /* ------------------------------------------------- annotations (same ink) */
  function drawAnnotations(ctx, state, view) {
    ctx.save();
    for (var i = 0; i < state.annotations.length; i++) {
      var a = state.annotations[i];
      var px = view.ox + a.x * view.s, py = view.oy + a.y * view.s;
      /* leader circle + line — inker-styled, same stroke as isobaths */
      ctx.strokeStyle = a.exception ? INK_INDEX : INK;
      ctx.lineWidth = a.exception ? 1.8 : 0.9;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.moveTo(px + 6, py); ctx.lineTo(px + 16, py - 14);
      ctx.stroke();
      ctx.font = 'italic 12px Georgia, serif';
      ctx.fillStyle = a.exception ? INK_INDEX : INK;
      ctx.textAlign = 'left';
      ctx.fillText(a.text, px + 19, py - 16);
    }
    ctx.restore();
  }

  /* ------------------------------------------------- relics & losses */
  function drawRelics(ctx, state, view) {
    ctx.save();
    for (var i = 0; i < state.relics.length; i++) {
      var r = state.relics[i];
      if (!r.found) continue; /* unfound wrecks are not on any chart */
      var px = view.ox + r.x * view.s, py = view.oy + r.y * view.s;
      ctx.strokeStyle = INK; ctx.lineWidth = 1.1; ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(px - 4, py - 4); ctx.lineTo(px + 4, py + 4);
      ctx.moveTo(px + 4, py - 4); ctx.lineTo(px - 4, py + 4);
      ctx.stroke();
      ctx.font = 'italic 10px Georgia, serif'; ctx.fillStyle = INK;
      ctx.textAlign = 'left';
      ctx.fillText(r.label || r.type, px + 6, py + 3);
    }
    ctx.restore();
  }

  function drawLosses(ctx, state, view) {
    ctx.save();
    for (var i = 0; i < state.losses.length; i++) {
      var L = state.losses[i];
      var px = view.ox + L.x * view.s, py = view.oy + L.y * view.s;
      ctx.strokeStyle = '#8e2f2f'; ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.moveTo(px - 3, py - 3); ctx.lineTo(px + 3, py + 3);
      ctx.stroke();
      ctx.font = '9px Georgia, serif'; ctx.fillStyle = '#8e2f2f'; ctx.textAlign = 'left';
      ctx.fillText(L.rov + ' lost ' + Math.round(L.depth) + ' fm', px + 7, py + 3);
    }
    ctx.restore();
  }

  /* ------------------------------------------------- storms as weather */
  function drawStorms(ctx, sys, time, view, selectedId) {
    if (!sys) return;
    for (var i = 0; i < sys.storms.length; i++) {
      var st = sys.storms[i];
      var px = view.ox + st.cx * view.s, py = view.oy + st.cy * view.s;
      var rpx = st.r * view.s;
      var rng = mulberry32(st.seed);
      var n = Math.min(110, 30 + st.biomass);
      ctx.save();
      /* cloud body */
      var grad = ctx.createRadialGradient(px, py, 0, px, py, rpx * 1.4);
      grad.addColorStop(0, 'rgba(' + GOLD + ',0.34)');
      grad.addColorStop(0.6, 'rgba(' + GOLD + ',0.16)');
      grad.addColorStop(1, 'rgba(' + GOLD + ',0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(px, py, rpx * 1.4, 0, Math.PI * 2); ctx.fill();
      /* motes — the shape is the signal: tight=feeding, scattered=pursued,
       * column=the deep current doing what fish sometimes do */
      var lean = st.mode === 'column' || st.mode === 'stacked';
      for (var k = 0; k < n; k++) {
        var ang = rng() * Math.PI * 2;
        var rr = Math.sqrt(rng()) * rpx * (st.mode === 'feeding' || lean ? 0.55 : 1.0);
        var drift = Math.sin(time * 1.7 + st.seed + k) * 3;
        var mx, my;
        if (lean) { /* single column leaning downhill */
          mx = px + Math.cos(ang) * rpx * 0.22 + (k / n) * drift * 0.6;
          my = py - (k / n) * rpx * 1.5 + rr * 0.18;
        } else {
          mx = px + Math.cos(ang) * rr + drift;
          my = py + Math.sin(ang) * rr * 0.8;
        }
        var a = 0.55 + 0.4 * Math.sin(k * 2.3 + time * 3 + st.seed);
        ctx.fillStyle = 'rgba(' + GOLD + ',' + a.toFixed(2) + ')';
        ctx.fillRect(mx, my, 2, 2);
      }
      if (st.id === selectedId) {
        ctx.strokeStyle = 'rgba(' + GOLD + ',0.9)'; ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.arc(px, py, rpx + 8, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }

  /* ------------------------------------------------- swarm & cursor */
  function drawSwarm(ctx, swarm, time, view) {
    if (!swarm) return;
    for (var i = 0; i < swarm.rovs.length; i++) {
      var r = swarm.rovs[i];
      var px = view.ox + r.x * view.s, py = view.oy + r.y * view.s;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(swarm.heading);
      if (!r.alive) {
        ctx.strokeStyle = '#5a6672'; ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-4, -4); ctx.lineTo(4, 4); ctx.moveTo(4, -4); ctx.lineTo(-4, 4);
        ctx.stroke();
      } else if (time < r.fouledUntil) {
        ctx.strokeStyle = '#7d8791'; ctx.lineWidth = 1.3;
        ctx.strokeRect(-4, -4, 8, 8);
        ctx.beginPath(); ctx.arc(0, 0, 7 + Math.sin(time * 6) * 2, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.fillStyle = '#69d2c8';
        ctx.beginPath();
        ctx.moveTo(6, 0); ctx.lineTo(-4, 3.5); ctx.lineTo(-4, -3.5); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      if (r.alive) {
        ctx.fillStyle = 'rgba(105,210,200,0.9)';
        ctx.font = '8px monospace'; ctx.textAlign = 'center';
        ctx.fillText(r.id, px, py + 14);
      }
    }
    /* mow sweep guide */
    if (swarm.mode === 'mow') {
      var y = view.oy + swarm.mow.yRow * view.s;
      ctx.save();
      ctx.strokeStyle = 'rgba(105,210,200,0.35)';
      ctx.setLineDash([2, 6]); ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(view.ox + 2 * view.s, y);
      ctx.lineTo(view.ox + 97 * view.s, y);
      ctx.stroke();
      var ny = y + swarm.mow.rowStep * view.s;
      ctx.beginPath();
      ctx.moveTo(view.ox + 2 * view.s, ny);
      ctx.lineTo(view.ox + 97 * view.s, ny);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  function drawCursor(ctx, cursor, view, flash) {
    var px = view.ox + cursor.x * view.s, py = view.oy + cursor.y * view.s;
    ctx.save();
    ctx.strokeStyle = flash && flash.hit ? '#7be27b' : '#69d2c8';
    ctx.lineWidth = flash ? 2.2 : 1.2;
    ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - 14, py); ctx.lineTo(px - 6, py);
    ctx.moveTo(px + 6, py); ctx.lineTo(px + 14, py);
    ctx.moveTo(px, py - 14); ctx.lineTo(px, py - 6);
    ctx.moveTo(px, py + 6); ctx.lineTo(px, py + 14);
    ctx.stroke();
    if (flash && !flash.hit) {
      ctx.strokeStyle = '#c96a5a';
      ctx.beginPath();
      ctx.moveTo(px - 8, py - 8); ctx.lineTo(px + 8, py + 8);
      ctx.moveTo(px + 8, py - 8); ctx.lineTo(px - 8, py + 8);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ------------------------------------------------- watching mode feeds */
  /* Six camera feeds tiled in the dark. No quests. No score. Just the bottom
   * moving past in the ROV lights, slow as clouds. */
  function drawFeed(ctx, rov, terrain, trail, time, seed) {
    var w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.fillStyle = '#04070c';
    ctx.fillRect(0, 0, w, h);
    /* cross-section: last N positions of this ROV, bottom profile under them */
    var n = Math.min(trail.length, 48);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (var i = 0; i < n; i++) {
      var t = trail[trail.length - 1 - i];
      var d = terrain.depthAt(Math.max(0, Math.min(99, t.x | 0)), Math.max(0, Math.min(99, t.y | 0)));
      var yLine = h * 0.35 + (d / 240) * h * 0.55;
      ctx.lineTo((i / 47) * w, yLine);
    }
    ctx.lineTo(w, h); ctx.closePath();
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(30,42,54,0.95)');
    g.addColorStop(1, 'rgba(9,13,18,1)');
    ctx.fillStyle = g; ctx.fill();
    /* light cone from the camera */
    var lg = ctx.createLinearGradient(0, 0, 0, h * 0.8);
    lg.addColorStop(0, 'rgba(150,190,215,0.28)');
    lg.addColorStop(1, 'rgba(150,190,215,0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.moveTo(w * 0.45, 0); ctx.lineTo(w * 0.55, 0);
    ctx.lineTo(w * 0.85, h * 0.8); ctx.lineTo(w * 0.15, h * 0.8);
    ctx.closePath(); ctx.fill();
    /* drifters — seeded, slow; some nobody has ever seen */
    var rng = mulberry32(seed + ((time / 9) | 0));
    var count = 1 + (rng() * 2 | 0);
    for (var k = 0; k < count; k++) {
      var dx = rng() * w, dy = h * (0.35 + rng() * 0.4);
      var rare = rng() > 0.93;
      ctx.fillStyle = rare ? 'rgba(200,160,255,0.8)' : 'rgba(140,170,190,0.5)';
      ctx.beginPath();
      ctx.ellipse(dx, dy + Math.sin(time + k) * 2, rare ? 7 : 4, rare ? 2.4 : 1.6, rng() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(120,140,155,0.7)';
    ctx.font = '9px monospace'; ctx.textAlign = 'left';
    ctx.fillText(rov.id + ' CAM ' + Math.round(rov.x) + ',' + Math.round(rov.y), 6, 12);
  }

  /* ------------------------------------------------- export */
  function exportCanvas(state) {
    var cv = document.createElement('canvas');
    cv.width = 1000; cv.height = 1130;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, cv.width, cv.height);

    /* title block */
    ctx.fillStyle = INK; ctx.textAlign = 'left';
    ctx.font = 'bold 26px Georgia, serif';
    ctx.fillText('SHOAL — HYDROGRAPHIC SURVEY', 60, 56);
    ctx.font = '13px Georgia, serif';
    var pct = (state.measuredCount / (W * H) * 100).toFixed(1);
    ctx.fillText('100 × 100 tiles · seed ' + state.seed + ' · bloodhound swarm survey · ' +
      state.measuredCount + ' tiles sounded (' + pct + '%) · ' +
      state.score.stormsTracked + ' storms tracked · ' + state.score.rightCalls + ' right-spot calls', 60, 82);

    var view = { ox: 60, oy: 110, s: 8.8 };
    /* frame */
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.strokeRect(view.ox - 3, view.oy - 3, W * view.s + 6, H * view.s + 6);

    drawTiles(ctx, state, view, true);       /* measured + splined best-guess */
    drawContours(ctx, state, view, true);    /* dashed where inferred */
    drawRelics(ctx, state, view);
    drawAnnotations(ctx, state, view);       /* same ink as the contours */
    drawLosses(ctx, state, view);

    /* legend */
    var lx = 60, ly = 1030;
    ctx.font = '12px Georgia, serif'; ctx.fillStyle = INK; ctx.textAlign = 'left';
    ctx.fillText('INK', lx, ly - 16);
    ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 34, ly); ctx.stroke();
    ctx.fillText('isobath 20 fm (solid = sounded)', lx + 42, ly + 4);
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(lx + 300, ly); ctx.lineTo(lx + 334, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText('splined best-guess (dashed)', lx + 342, ly + 4);
    ctx.beginPath(); ctx.arc(lx + 590, ly, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.moveTo(lx + 590 + 5, ly); ctx.lineTo(lx + 606, ly - 12); ctx.stroke();
    ctx.font = 'italic 12px Georgia, serif';
    ctx.fillText('annotation — exceptions are terrain too', lx + 614, ly + 4);

    /* scale bar: 10 tiles = 60 fm vertical at shelf rate */
    ctx.font = '12px Georgia, serif';
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(840, 1010); ctx.lineTo(840, 1010 - 10 * 8.8);
    ctx.moveTo(834, 1010); ctx.lineTo(846, 1010);
    ctx.moveTo(834, 1010 - 88); ctx.lineTo(846, 1010 - 88);
    ctx.stroke();
    ctx.fillText('10 tiles', 852, 1014);
    ctx.fillText('N ↑', 852, 996);
    return cv;
  }

  function exportJSON(state) {
    var tiles = [];
    for (var i = 0; i < state.measured.length; i++) {
      if (state.measured[i]) tiles.push({ x: i % W, y: (i / W) | 0, d: Math.round(state.terrain.depth[i] * 10) / 10 });
    }
    return {
      game: 'shoal', kind: 'hydrographic survey artifact',
      seed: state.seed, grid: { w: W, h: H, units: 'fathoms' },
      soundedTiles: state.measuredCount,
      tiles: tiles,
      relics: state.relics.map(function (r) {
        return { type: r.type, x: r.x, y: r.y, found: !!r.found, note: r.note };
      }),
      annotations: state.annotations,
      losses: state.losses,
      quests: state.questLog.map(function (q) {
        return { title: q.title, done: q.done };
      }),
      score: state.score, xp: state.xp, rank: state.rank,
      stormsTracked: state.score.stormsTracked,
      rightSpotCalls: state.score.rightCalls,
      watchLog: state.watchLog
    };
  }

  return {
    INK: INK, palette: palette, depthFill: depthFill,
    isobathSegments: isobathSegments, inkSegments: inkSegments, inkLabel: inkLabel,
    drawTiles: drawTiles, drawContours: drawContours, drawAnnotations: drawAnnotations,
    drawRelics: drawRelics, drawLosses: drawLosses, drawStorms: drawStorms,
    drawSwarm: drawSwarm, drawCursor: drawCursor, drawFeed: drawFeed,
    exportCanvas: exportCanvas, exportJSON: exportJSON
  };
});
