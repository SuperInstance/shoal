(function(root, factory){ var m = factory();
    if (typeof module === 'object' && module.exports) { module.exports = m; }
    else { root.SHOAL = root.SHOAL || {}; root.SHOAL.Rovs = m; }
  })(typeof self !== 'undefined' ? self : this, function(){
    'use strict';

    /* ---- constants ---- */
    var SIZE = 100;                 // seafloor is SIZE x SIZE tiles
    var TILES = SIZE * SIZE;
    var SONAR_R = 1.6;              // sounder radius, in tiles
    var SONAR_R2 = SONAR_R * SONAR_R;
    var FREE_SPEED = 9;             // tiles/sec under direct control
    var MOW_SPEED = 6.5;            // tiles/sec on autopilot
    var SNAG_SPEED = 4.5;           // pinnacles only bite above this speed
    var SNAG_PER_SEC = 0.5;         // mercy roll probability per second on a pinnacle
    var FOUL_SEC = 12;              // seconds a snagged ROV is out of action
    var HULL_HIT = 34;              // hull damage per snag
    var MIN = 1.5, MAX = 98.5;      // anchor clamp
    var FREE_SPACING = 1.5;         // default formation spacing in free mode
    var ROV_COUNT = 6;

    function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}

    /* Module-level, constant-seeded: snag rolls stay deterministic across tests. */
    var snagRng = mulberry32(0x9E3779B9);

    function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

    /* Formation offsets (formation space: +x is the nose/heading direction).
     * 'abreast' spreads perpendicular to the nose — that is the mowing line:
     * six sounders sweeping side by side, ladder across the bottom. */
    function formations(spacing){
      var s = spacing;
      return {
        line: [[-2.5*s,0],[-1.5*s,0],[-0.5*s,0],[0.5*s,0],[1.5*s,0],[2.5*s,0]],
        abreast: [[0,-2.5*s],[0,-1.5*s],[0,-0.5*s],[0,0.5*s],[0,1.5*s],[0,2.5*s]],
        wedge: [[1.5*s,0],[-0.5*s,-1*s],[-0.5*s,1*s],[-1.5*s,-2*s],[-1.5*s,2*s],[-2.5*s,0]],
        ladder: [[-1*s,-1*s],[-1*s,0],[-1*s,1*s],[0,-1*s],[0,0],[0,1*s]]
      };
    }

    function createSwarm(opts){
      opts = opts || {};
      var ax = typeof opts.x === 'number' ? opts.x : 50;
      var ay = typeof opts.y === 'number' ? opts.y : 50;
      var offs = formations(FREE_SPACING).line;
      var rovs = [];
      for (var i = 0; i < ROV_COUNT; i++){
        rovs.push({ id: 'H' + (i + 1), x: ax + offs[i][0], y: ay + offs[i][1],
                    alive: true, fouledUntil: 0, hull: 100 });
      }
      return {
        rovs: rovs,
        anchor: { x: ax, y: ay },
        heading: 0,
        speed: 0,
        mode: 'free',
        formation: 'line',
        mow: { dir: 1, spacing: 8, rowStep: 0, yRow: ay, minX: 2, maxX: 97, paused: false },
        stats: { tiles: 0, mowTiles: 0, sweeps: 0, fouls: 0, lost: 0 }
      };
    }

    /* terrain fields may be functions (x,y) or flat arrays indexed y*SIZE+x. */
    function terrainAt(terrain, key, x, y){
      var src = terrain && terrain[key];
      if (src == null) return undefined;
      return typeof src === 'function' ? src(x, y) : src[y * SIZE + x];
    }

    function update(swarm, dt, input, terrain, measured, timeSec){
      input = input || {};
      dt = +dt || 0;
      timeSec = +timeSec || 0;
      var events = [], revealed = [];
      var a = swarm.anchor, mow = swarm.mow;

      /* ---- controls ---- */
      if (input.mowSpacingDelta) mow.spacing = clamp(mow.spacing + input.mowSpacingDelta, 4, 14);
      mow.rowStep = 2.5 * mow.spacing + 2.5;
      if (input.toggleMow){
        if (swarm.mode === 'mow'){ swarm.mode = 'free'; }
        else {
          swarm.mode = 'mow';
          mow.yRow = a.y;
          mow.paused = false;
          mow.dir = a.x < (mow.minX + mow.maxX) / 2 ? 1 : -1; // head for the farther side
        }
      }
      if (swarm.mode === 'mow'){
        swarm.formation = 'abreast'; // mowing = line abreast, spread across the swath
      } else if (input.setFormation === 'line' || input.setFormation === 'wedge' || input.setFormation === 'ladder'){
        swarm.formation = input.setFormation;
      }

      /* ---- movement ---- */
      if (swarm.mode === 'mow' && !mow.paused){
        var nx = a.x + mow.dir * MOW_SPEED * dt;
        if (nx >= mow.maxX || nx <= mow.minX){
          nx = clamp(nx, mow.minX, mow.maxX);
          mow.dir *= -1;
          mow.yRow = clamp(mow.yRow + mow.rowStep, MIN, MAX);
          swarm.stats.sweeps++;
          events.push({ type: 'sweepEnd', dir: mow.dir });
        }
        var oy = a.y, ox = a.x;
        a.x = nx;
        a.y += clamp(mow.yRow - a.y, -MOW_SPEED * dt, MOW_SPEED * dt); // smooth row follow
        var mdx = a.x - ox, mdy = a.y - oy;
        if (mdx || mdy) swarm.heading = Math.atan2(mdy, mdx);
        swarm.speed = dt > 0 ? Math.sqrt(mdx * mdx + mdy * mdy) / dt : 0;
      } else if (swarm.mode === 'free'){
        var ix = clamp(+input.ax || 0, -1, 1);
        var iy = clamp(+input.ay || 0, -1, 1);
        var mag = Math.sqrt(ix * ix + iy * iy);
        if (mag > 1){ ix /= mag; iy /= mag; mag = 1; } // normalize diagonals
        if (mag > 1e-6){
          a.x = clamp(a.x + ix * FREE_SPEED * dt, MIN, MAX);
          a.y = clamp(a.y + iy * FREE_SPEED * dt, MIN, MAX);
          swarm.heading = Math.atan2(iy, ix);
          swarm.speed = FREE_SPEED * mag;
        } else {
          swarm.speed = 0;
        }
      } else {
        swarm.speed = 0;
      }

      /* ---- station keeping, reveal, snag ---- */
      var spacing = swarm.mode === 'mow' ? mow.spacing / 2 : FREE_SPACING;
      var offs = formations(spacing)[swarm.formation] || formations(spacing).line;
      var cos = Math.cos(swarm.heading), sin = Math.sin(swarm.heading);

      for (var i = 0; i < swarm.rovs.length; i++){
        var rov = swarm.rovs[i];
        if (!rov.alive) continue;
        if (timeSec < rov.fouledUntil){ rov.x = a.x; rov.y = a.y; continue; } // fouled: towed, silent
        var o = offs[i];
        rov.x = clamp(a.x + o[0] * cos - o[1] * sin, 0, SIZE - 1);
        rov.y = clamp(a.y + o[0] * sin + o[1] * cos, 0, SIZE - 1);

        // reveal every tile whose center falls inside the sounder radius
        var x0 = Math.max(0, Math.floor(rov.x - SONAR_R)), x1 = Math.min(SIZE - 1, Math.ceil(rov.x + SONAR_R));
        var y0 = Math.max(0, Math.floor(rov.y - SONAR_R)), y1 = Math.min(SIZE - 1, Math.ceil(rov.y + SONAR_R));
        for (var ty = y0; ty <= y1; ty++){
          for (var tx = x0; tx <= x1; tx++){
            var dx = tx + 0.5 - rov.x, dy = ty + 0.5 - rov.y;
            if (dx * dx + dy * dy > SONAR_R2) continue;
            var idx = ty * SIZE + tx;
            if (measured[idx] === 0){
              measured[idx] = 1;
              revealed.push({ x: tx, y: ty });
              swarm.stats.tiles++;
              if (swarm.mode === 'mow') swarm.stats.mowTiles++;
            }
          }
        }

        // snag: only at speed, only on pinnacles, and only if the mercy roll fails
        if (swarm.speed > SNAG_SPEED && terrain){
          var ptx = Math.floor(rov.x), pty = Math.floor(rov.y);
          if (ptx >= 0 && ptx < SIZE && pty >= 0 && pty < SIZE &&
              terrainAt(terrain, 'classify', ptx, pty) === 'pinnacle' &&
              snagRng() < SNAG_PER_SEC * dt){
            rov.fouledUntil = timeSec + FOUL_SEC;
            rov.hull -= HULL_HIT;
            swarm.stats.fouls++;
            events.push({ type: 'snag', rov: rov.id, x: ptx, y: pty, depth: terrainAt(terrain, 'depth', ptx, pty) });
            if (rov.hull <= 0){
              rov.alive = false;
              swarm.stats.lost++;
              events.push({ type: 'lost', rov: rov.id, x: ptx, y: pty });
            }
          }
        }
      }

      return { revealed: revealed, events: events };
    }

    function aliveCount(swarm){
      var n = 0;
      for (var i = 0; i < swarm.rovs.length; i++) if (swarm.rovs[i].alive) n++;
      return n;
    }

    function coveragePct(measured){
      var n = 0;
      for (var i = 0; i < TILES; i++) if (measured[i]) n++;
      return (n / TILES) * 100;
    }

    var api = {
      SONAR_R: SONAR_R,
      createSwarm: createSwarm,
      formations: formations,
      update: update,
      aliveCount: aliveCount,
      coveragePct: coveragePct
    };
    return api;
  });


