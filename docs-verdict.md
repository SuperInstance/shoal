# SHOAL — Blind Tournament Verdict

**WINNER: BUILD ALPHA (shoal-kimi)** — 35/40 vs 31.5/40

## Scoring

| Criterion | ALPHA | BETA |
|---|---|---|
| Code quality / architecture | 8 | 9 |
| Doctrine fidelity | 9 | 7.5 |
| Playability | 9 | 6.5 |
| Test rigor | 9 | 8 |

## What each did better

**ALPHA** — The game is *alive*. Mow autopilot with adjustable row spacing, three formations, click-to-lock storm telemetry with a boat-time clock (20 min → 60 s), right-spot calls scored against the storm's **actual predicted future position** (misses logged and docked), free-text annotations, six-feed watching mode with real bottom cross-sections and biolog log, marching-squares isobaths with a genuine same-ink pipeline (contours and annotations share `inkSegments`, stroke, font), export PNG with title block/legend/scale bar. Doctrine: the deep-current exception is **rare, scheduled (~105 s), missable, retry-once** — the rarest achievement, hidden until first track, exactly the fiction's cadence. Unswept water stays void in play; inference appears only in export, dashed. Tests: 63 assertions; boot.js drives the **real main.js loop** through a DOM shim — fence → unlock → mow → telemetry → exports → watch.

**BETA** — Cleaner engineering: ESM, pure modules, shared `subRng` streams, headless orchestrator; per-quest MOW button; TIME_SCALE=25. Doctrine wins: Sawyer chore **passages played straight** ("mint and diesel"), bloodhound **3-in-4 confidence self-report** ("saying so myself: dry"), refused false annotations ("the map keeps only true things"), same-ink tested by deepEqual, and a Market mode (price board keyed to storm activity, story-attached chinook at 3×). Tests are modern property checks (deep-basin BFS connectivity, score monotonicity, guesses-differ-from-truth). Weaknesses: exception triggers whenever any storm drifts over the basin (common, not exceptional); track quest auto-ticks in fish mode (passive); render is flat tile fills, no isobaths; and **market is browser-dead — `catchPool` is never filled** (`speciesAt` imported, unused), so every sell fails. Untested wiring is exactly where the bug lives.

## Graft list (BETA → ALPHA)

1. **Market mode** — ports, weather-shifted price board, story-attached Juneau quest paying 3×. Wire it: land `speciesAt(depth)` fish into the hold on right-spot hits.
2. **Sawyer passages + 3-in-4 confidence language** — pure prose, near-zero risk, high doctrine value.
3. **Pure-module refactor** — extract main.js rules into a headless orchestrator and consolidate the copy-pasted mulberry32s into one seeded-rng module with per-system streams; enables BETA-style property tests over ALPHA's loop.

*Judged blind, both suites run green. The map is the artifact.*
