(function(root, factory){ var m = factory();
    if (typeof module === 'object' && module.exports) { module.exports = m; }
    else { root.SHOAL = root.SHOAL || {}; root.SHOAL.Terrain = m; }
  })(typeof self !== 'undefined' ? self : this, function(){

  function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}

  var W = 100, H = 100;

  function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
  function smooth(t){ return t * t * (3 - 2 * t); } // smoothstep on [0,1]

  /* Reusable seeded 2D value-noise factory. Returns valueNoise(x, y, scale, seedOffset)
   * producing bilinear+smoothstep interpolated hashed lattice values in [-1, 1]. */
  function makeNoise(seed){
    var s = (seed | 0) >>> 0;
    function lat(ix, iy, off){ // hash a lattice corner to [0,1)
      var h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) +
               Math.imul(s + off * 1013904223, 2246822519)) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }
    return function valueNoise(x, y, scale, seedOffset){
      var off = (seedOffset | 0) >>> 0;
      var gx = x / scale, gy = y / scale;
      var x0 = Math.floor(gx), y0 = Math.floor(gy);
      var fx = smooth(gx - x0), fy = smooth(gy - y0);
      var a = lat(x0, y0, off),     b = lat(x0 + 1, y0, off);
      var c = lat(x0, y0 + 1, off), d = lat(x0 + 1, y0 + 1, off);
      var top = a + (b - a) * fx, bot = c + (d - c) * fx;
      return (top + (bot - top) * fy) * 2 - 1;
    };
  }

  /* Distance from point (px,py) to segment (ax,ay)-(bx,by). */
  function segDist(px, py, ax, ay, bx, by){
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
    var ex = px - (ax + dx * t), ey = py - (ay + dy * t);
    return Math.sqrt(ex * ex + ey * ey);
  }

  /* Distance from (x,y) to the channel polyline; Infinity if no channel. */
  function channelDist(pts, x, y){
    var d = Infinity;
    for (var i = 0; i < pts.length - 1; i++){
      var dd = segDist(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (dd < d) d = dd;
    }
    return d;
  }

  function generate(seed){
    var rng = mulberry32(seed);
    var noise = makeNoise(seed);

    /* --- Feature placement (rng order fixed for determinism) --- */
    var basin = { cx: 62 + rng() * 26, cy: 55 + rng() * 30, r: 14 };
    var pinnacle = { x: 35 + rng() * 20, y: 25 + rng() * 35, r: 3.5 };
    var high2 = { x: 20 + rng() * 18, y: 55 + rng() * 25 };

    /* Channel: waypoints north->south, east half, meandering rng walk. */
    var channel = [];
    var cx = 70 + rng() * 15;
    for (var cy = 0; cy < H; cy += 6){
      channel.push({ x: Math.round(cx), y: cy });
      cx = clamp(cx + (rng() * 2 - 1) * 9, 62, 92);
    }

    /* --- Depth field (fathoms) --- */
    var depth = new Float32Array(W * H);
    for (var y = 0; y < H; y++){
      for (var x = 0; x < W; x++){
        // 1. Base plane: ~30 fm west -> ~120 fm east, plus gentle N->S tilt.
        var d = 30 + 90 * smooth(x / (W - 1)) + 10 * (y / (H - 1));
        // 2. Shelf: broad plateau lifting the west third, smoothed edge.
        d -= 12 * smooth(clamp((38 - x) / 6, 0, 1));
        // 3. Basin: gaussian depression, SE quadrant.
        var bx = x - basin.cx, by = y - basin.cy;
        d += 85 * Math.exp(-(bx * bx + by * by) / (2 * 14 * 14));
        // 4. Pinnacle: sharp gaussian bump (shoal hazard).
        var px = x - pinnacle.x, py = y - pinnacle.y;
        d -= 70 * Math.exp(-(px * px + py * py) / (2 * 2.2 * 2.2));
        // 5. high2: second, broader bump forming a saddle with the pinnacle.
        var hx = x - high2.x, hy = y - high2.y;
        d -= 35 * Math.exp(-(hx * hx + hy * hy) / (2 * 5 * 5));
        // 7. Channel: deepen near the polyline.
        var cd = channelDist(channel, x, y);
        if (cd < 3.5) d += 24 * smooth(1 - cd / 3.5);
        // 8. Value noise: 3 octaves, +/-~7 fm of texture.
        d += 7 * (0.55 * noise(x, y, 18, 0) +
                  0.30 * noise(x, y, 8, 1) +
                  0.15 * noise(x, y, 3.5, 2));
        // Peak guarantee: cap inside the hazard radius so the pinnacle top
        // stays <= 16 fm regardless of basin tail or noise.
        if (px * px + py * py < pinnacle.r * pinnacle.r && d > 16) d = 16;
        depth[y * W + x] = clamp(d, 6, 235);
      }
    }

    function idx(x, y){ return y * W + x; }
    function depthAt(x, y){
      return depth[idx(clamp(Math.round(x), 0, W - 1), clamp(Math.round(y), 0, H - 1))];
    }

    /* Deepest single tile. */
    var deepest = { x: 0, y: 0, d: -Infinity };
    for (var i = 0; i < depth.length; i++){
      if (depth[i] > deepest.d) deepest = { x: i % W, y: (i / W) | 0, d: depth[i] };
    }

    /* 6. Saddle: point of maximum depth along the pinnacle<->high2 line. */
    var saddle = { x: 0, y: 0 }, saddleD = -Infinity;
    for (var s = 0; s <= 64; s++){
      var t = s / 64;
      var sx = Math.round(pinnacle.x + (high2.x - pinnacle.x) * t);
      var sy = Math.round(pinnacle.y + (high2.y - pinnacle.y) * t);
      var sd = depthAt(sx, sy);
      if (sd > saddleD){ saddleD = sd; saddle = { x: sx, y: sy }; }
    }

    function dist(x, y, p){ var dx = x - p.x, dy = y - p.y; return Math.sqrt(dx * dx + dy * dy); }

    /* Classification, evaluated in priority order. */
    function classify(x, y){
      x = clamp(Math.round(x), 0, W - 1); y = clamp(Math.round(y), 0, H - 1);
      var d = depth[idx(x, y)];
      if (dist(x, y, pinnacle) < pinnacle.r && d < 30) return 'pinnacle';
      if (dist(x, y, saddle) <= 2.5) return 'saddle';
      if (d >= 145 || dist(x, y, { x: basin.cx, y: basin.cy }) < basin.r) return 'basin';
      if (channelDist(channel, x, y) < 3.5) return 'channel';
      if (d < 60 && x < 50) return 'shelf';
      if (d >= 40 && d <= 100) return 'slope';
      return 'deep';
    }

    /* Relics: exactly 3, rng-picked from matching tiles, never on the pinnacle. */
    function pickRelic(type, test, fallback){
      var cands = [];
      for (var ry = 0; ry < H; ry++) for (var rx = 0; rx < W; rx++){
        if (dist(rx, ry, pinnacle) < pinnacle.r + 1) continue;
        if (test(rx, ry, depth[idx(rx, ry)])) cands.push({ x: rx, y: ry, type: type });
      }
      if (!cands.length) cands.push({ x: fallback.x, y: fallback.y, type: type });
      return cands[(rng() * cands.length) | 0];
    }
    var pinnTile = { x: Math.round(pinnacle.x), y: Math.round(pinnacle.y) };
    var relics = [
      pickRelic('skiff', function(x, y, d){ return d >= 48 && d <= 62 && x >= 28 && x <= 50; },
                { x: 38, y: 50 }),
      pickRelic('whalefall', function(x, y, d){ return d >= 150; },
                { x: Math.round(basin.cx), y: Math.round(basin.cy) }),
      pickRelic('metridium', function(x, y, d){
                  var dd = dist(x, y, pinnacle); return dd >= pinnacle.r + 1 && dd < 9 && d < 45; },
                { x: pinnTile.x + 6, y: pinnTile.y })
    ];

    function gradient(x, y){
      var rx = Math.round(x), ry = Math.round(y);
      var x0 = clamp(rx - 1, 0, W - 1), x1 = clamp(rx + 1, 0, W - 1);
      var y0 = clamp(ry - 1, 0, H - 1), y1 = clamp(ry + 1, 0, H - 1);
      return {
        gx: (depth[idx(x1, ry)] - depth[idx(x0, ry)]) / (x1 - x0 || 1),
        gy: (depth[idx(rx, y1)] - depth[idx(rx, y0)]) / (y1 - y0 || 1)
      };
    }

    function tilesMatching(fn){
      var out = [];
      for (var ty = 0; ty < H; ty++) for (var tx = 0; tx < W; tx++){
        if (fn(tx, ty, depth[idx(tx, ty)])) out.push({ x: tx, y: ty });
      }
      return out;
    }

    return {
      W: W, H: H, seed: seed, depth: depth,
      features: {
        basin: basin, deepest: deepest, pinnacle: pinnacle, high2: high2,
        saddle: saddle, channel: channel, relics: relics
      },
      idx: idx, depthAt: depthAt, classify: classify,
      tilesMatching: tilesMatching, gradient: gradient
    };
  }

  var api = { generate: generate, makeNoise: makeNoise };
  return api;
  });


