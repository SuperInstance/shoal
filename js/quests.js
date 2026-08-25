(function(root, factory){ var m = factory();
    if (typeof module === 'object' && module.exports) { module.exports = m; }
    else { root.SHOAL = root.SHOAL || {}; root.SHOAL.Quests = m; }
  })(typeof self !== 'undefined' ? self : this, function(){
    'use strict';

    function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}


    // Relic spots may arrive as an array [{x,y,type}] (terrain module) or a map
    // {type:{x,y}}. Normalize — discovery must never silently fail on shape.
    function relicSpots(terrain){
      var raw = (terrain.features && terrain.features.relics) || [];
      var out = {};
      if (Array.isArray(raw)){
        for (var i = 0; i < raw.length; i++) out[raw[i].type] = raw[i];
      } else {
        for (var k in raw) if (raw[k] && raw[k].x !== undefined) out[k] = raw[k];
      }
      return out;
    }
    void mulberry32; // kept verbatim per module contract; quest targets come from terrain, not RNG

    var W = 100, H = 100; // measured is Uint8Array(10000) => 100x100 grid, index = y*100+x

    // --- terrain helpers (defensive: work with or without terrain.tilesMatching) ---

    function depthAt(terrain, x, y){ return terrain.depth[y * W + x]; }

    // Collect tile indices matching pred({x,y,depth,cls}). Uses terrain.tilesMatching
    // when present; otherwise scans the depth grid directly. Either way the target
    // set is computed from the real hidden terrain, never invented.
    function matchTiles(terrain, pred){
      if (typeof terrain.tilesMatching === 'function'){
        /* terrain passes (x, y, depth) and returns [{x,y}] — bridge shapes */
        var hits = terrain.tilesMatching(function(x, y, d){
          return pred({ x: x, y: y, depth: d, cls: (typeof terrain.classify === 'function') ? terrain.classify(x, y) : null });
        });
        return hits.map(function(t){ return (typeof t === 'number') ? t : t.y * W + t.x; });
      }
      var out = [];
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++){
        var d = depthAt(terrain, x, y);
        var c = (typeof terrain.classify === 'function') ? terrain.classify(x, y) : null;
        if (pred({ x: x, y: y, depth: d, cls: c })) out.push(y * W + x);
      }
      return out;
    }

    function countMeasured(gameState, targets){
      var n = 0, m = gameState.measured;
      for (var i = 0; i < targets.length; i++) if (m[targets[i]]) n++;
      return n;
    }

    function goalOf(count, pct){ return count > 0 ? Math.max(1, Math.floor(count * pct)) : 0; }

    // Distance from (x,y) to the channel, given features.channel as a list of
    // points or segments ({x,y} | {a:{x,y},b:{x,y}} | {x1,y1,x2,y2}).
    function distToChannel(channel, x, y){
      var best = Infinity;
      for (var i = 0; i < channel.length; i++){
        var s = channel[i], d;
        if (s.a && s.b){ d = distSeg(x, y, s.a.x, s.a.y, s.b.x, s.b.y); }
        else if (s.x1 !== undefined){ d = distSeg(x, y, s.x1, s.y1, s.x2, s.y2); }
        else { var dx = x - s.x, dy = y - s.y; d = Math.sqrt(dx * dx + dy * dy); }
        if (d < best) best = d;
      }
      return best;
    }

    function distSeg(px, py, x1, y1, x2, y2){
      var dx = x2 - x1, dy = y2 - y1;
      var L2 = dx * dx + dy * dy;
      var t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      var cx = x1 + t * dx - px, cy = y1 + t * dy - py;
      return Math.sqrt(cx * cx + cy * cy);
    }

    // --- relics ---

    var RELIC_FLAVOR = {
      skiff: 'A sunken skiff, paint gone to rust. The insurance company has not heard of this one.',
      whalefall: 'A whale fall. The bones hold a slow city.',
      metridium: 'A garden of metridiums swaying like a slowed-down crowd.'
    };

    function buildRelics(terrain){
      var spots = relicSpots(terrain);
      return ['skiff', 'whalefall', 'metridium'].map(function(id){
        var s = spots[id] || { x: -1, y: -1 };
        return { id: id, x: s.x, y: s.y, found: false, flavor: RELIC_FLAVOR[id] };
      });
    }

    // --- quests ---

    function chartQuest(id, title, desc, xp, targets, pct, label){
      var goal = goalOf(targets.length, pct);
      return {
        id: id, kind: 'chart', title: title, desc: desc, xp: xp, targets: targets,
        progress: function(gameState){
          return { cur: countMeasured(gameState, targets), goal: goal, label: label };
        }
      };
    }

    function buildQuests(terrain){
      var feats = terrain.features || {};
      var relics = buildRelics(terrain);

      var quests = [];

      // q0 — the onboarding fence. Done straight: real chores, real checkboxes.
      quests.push({
        id: 'q0', kind: 'sawyer',
        title: 'Swarm time is earned',
        desc: 'Make the bed. Brush your teeth. Then the bloodhounds are yours.',
        xp: 10,
        steps: ['Make the bed', 'Brush teeth'],
        progress: function(gs){
          var s = gs.sawyer || {};
          return { cur: (s.bed ? 1 : 0) + (s.teeth ? 1 : 0), goal: 2, label: 'chores done' };
        }
      });

      quests.push(chartQuest('q1', 'Chart the shelf, 40–60 fathoms — west face',
        'Sound every tile of the western shelf face between 40 and 60 fathoms.',
        60, matchTiles(terrain, function(t){ return t.depth >= 40 && t.depth <= 60 && t.x < 45; }),
        0.80, 'tiles sounded'));

      quests.push(chartQuest('q2', 'Chart the basin floor',
        'Map the basin floor: every tile classed as basin, or deeper than 150 fathoms.',
        80, matchTiles(terrain, function(t){ return t.cls === 'basin' || t.depth >= 150; }),
        0.60, 'basin tiles'));

      var saddle = feats.saddle || { x: -999, y: -999 };
      quests.push(chartQuest('q3', 'Sound the saddle',
        'Tight survey of the saddle: every tile within 6 of the saddle point.',
        80, matchTiles(terrain, function(t){
          var dx = t.x - saddle.x, dy = t.y - saddle.y;
          return dx * dx + dy * dy <= 36;
        }), 0.90, 'saddle tiles'));

      var channel = feats.channel || [];
      quests.push(chartQuest('q4', 'Trace the deep current',
        'Follow the channel: sound the tiles within 4 of the deep current.',
        80, matchTiles(terrain, function(t){ return distToChannel(channel, t.x, t.y) <= 4; }),
        0.50, 'current tiles'));

      quests.push({
        id: 'q5', kind: 'relic',
        title: 'Salvage log — find the wrecks',
        desc: 'Three marks on no chart: a sunken skiff, a whale fall, a garden of metridiums. Find them all.',
        xp: 120,
        progress: function(gs){
          var r = gs.relicsFound || {};
          var cur = (r.skiff ? 1 : 0) + (r.whalefall ? 1 : 0) + (r.metridium ? 1 : 0);
          return { cur: cur, goal: 3, label: 'relics found' };
        }
      });

      quests.push({
        id: 'q6', kind: 'track',
        title: 'Track a fish storm for 20 minutes',
        desc: 'Hold on a fish storm for 20 minutes of boat time. The telemetry clock handles the compression.',
        xp: 100,
        progress: function(gs){ return { cur: gs.stormsTracked | 0, goal: 1, label: 'storms tracked' }; }
      });

      quests.push({
        id: 'q7', kind: 'exception',
        title: 'Log the anomaly',
        desc: 'Sometimes fish stack in the deepest basin and ignore every edge rule. Find it. Annotate it in the same ink.',
        xp: 200,
        hidden: true, // revealed once the first tracked storm completes
        rare: true,   // the game's rarest achievement
        unlocksWhen: function(gs){ return (gs.stormsTracked | 0) >= 1; },
        progress: function(gs){ return { cur: gs.exceptionLogged ? 1 : 0, goal: 1, label: 'anomaly logged' }; }
      });

      var achievements = ['First Tile', 'Mow Hand', 'Cartographer', 'Bloodhound', 'The Deep-Current Exception'];

      return { quests: quests, relics: relics, achievements: achievements };
    }

    // --- runtime checks ---

    // newlyRevealed: array of tile indices (or {x,y}) revealed this tick.
    // Any tile within 2 of an unfound relic spot marks it found; returns the
    // relic objects discovered this tick.
    function checkRelics(gameState, terrain, newlyRevealed){
      var spots = relicSpots(terrain);
      var found = gameState.relicsFound = gameState.relicsFound || {};
      var discovered = [];
      var ids = ['skiff', 'whalefall', 'metridium'];
      for (var i = 0; i < newlyRevealed.length; i++){
        var t = newlyRevealed[i];
        var x = (typeof t === 'number') ? t % W : t.x;
        var y = (typeof t === 'number') ? (t / W) | 0 : t.y;
        for (var j = 0; j < ids.length; j++){
          var id = ids[j];
          if (found[id]) continue;
          var s = spots[id];
          if (!s) continue;
          var dx = x - s.x, dy = y - s.y;
          if (dx * dx + dy * dy <= 4){
            found[id] = true;
            discovered.push({ id: id, x: s.x, y: s.y, found: true, flavor: RELIC_FLAVOR[id] });
          }
        }
      }
      return discovered;
    }

    function isDone(quest, gameState){
      var p = quest.progress(gameState);
      return p.cur >= p.goal;
    }

    var api = {
      buildQuests: buildQuests,
      checkRelics: checkRelics,
      isDone: isDone,
      RELIC_FLAVOR: RELIC_FLAVOR
    };
    return api;
  });

