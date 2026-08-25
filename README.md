# SHOAL — the fleet below

A single-page web game that is secretly a bathymetry mapper. Six BLOODHOUND ROVs,
one hidden 100×100 synthetic seafloor, quests that are real work wearing the
typography of play. Built from the fiction-as-spec:
`/home/eileen/projects/ai-writings/fiction/the-fleet-below.md`

## Run

No server, no build step, no network calls:

```
cd /home/eileen/projects/shoal-kimi
python3 -m http.server 8901     # or any static server
# open http://localhost:8901
```

Opening `index.html` directly from the filesystem also works.

## Play

| Key | Action |
|-----|--------|
 WASD / arrows — steer the swarm
 M — toggle **MOW** autopilot (serpentine survey, 2× XP per tile)
 1 / 2 / 3 — formation: line / wedge / ladder
 [ ] — mow row spacing
 click a golden storm — put the telemetry on it
 TAB — cycle storm selection
 C — **right-spot call**: is the boat in the right spot? (scored against where the storm will be)
 E — annotate the chart (annotation goes down in the same ink as the contours)
 N — night watch: six camera feeds, no quests, no score
 SPACE — pause

**Quest 0** is the fence: make the bed, brush teeth — done straight — then the
bloodhounds unlock.

**The deep-current exception**: rarely, a storm becomes a single column leaning
downhill and stacks in the deepest basin, ignoring every edge rule the tutorial
taught you. Find it, put the telemetry cursor on it, press E, and the annotation
renders through the same inking pipeline as the measured isobaths — same stroke,
same font, same ink. Exceptions are terrain too. Rarest achievement in the game.

**Export** (right panel): the completed chart as PNG (measured tiles in full
ink, splined best-guess for unmapped areas in dashed ink, annotations in the
same ink) and the full survey as JSON. The map IS the artifact.

## The game never lies

- Quest targets are computed from the actual hidden terrain at seed time —
  "Chart the shelf 40–60 fathoms, west face" is completable only by genuinely
  sounding those tiles.
- Relics (sunken skiff, whale fall, metridium garden) sit at deterministic
  spots and appear only when their tiles are measured.
- Pinnacles the charts missed snag fast ROVs; losses are shown plainly,
  no spin, red on the chart.
- Right-spot calls are scored against the storm's real future position;
  misses are logged as misses. The fourth time, he says so himself.
- 20 minutes of boat telemetry compresses to ~60 seconds of play (telemetry
  clock shows boat time).

## Architecture

```
index.html          one page, six scripts, no build step
css/style.css       wheelhouse terminal aesthetic
js/terrain.js       procedural seafloor: shelf, pinnacle, saddle, basin, channel (kimi pass)
js/rovs.js          6-ROV swarm, formations, mow autopilot, snag honesty (kimi pass)
js/quests.js        quest engine — targets generated from hidden terrain (kimi pass)
js/storms.js        fish storms as weather + the deep-current exception (kimi pass)
js/render.js        cartography: marching-squares isobaths, SAME-INK annotations, PNG/JSON export
js/main.js          game loop, input, HUD, Sawyer fence, watch mode
test/smoke.js       headless logic suite (49 assertions)
test/boot.js        DOM-shim boot test of the real main.js loop (14 assertions)
prompts/, out/      lane-tool provenance (kimi -p passes, reviewed + integrated)
```

Determinism: default seed 20260824; append `#seed=12345` to the URL to re-roll
the world (wrecks included — they move with the seed, never mid-game).

## Tests

```
node --check js/*.js
node test/smoke.js   # terrain/swarm/quests/storms/cartography/full-session
node test/boot.js    # boots main.js with a DOM shim, runs the frame loop
```
