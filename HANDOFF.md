# Handoff

Newest first. Keep short; prune the oldest entries.

## State
- v1 in progress, **WebGPU only**. Tickets done: #1 (scaffold), #4 (renderer, WebGPU side), #5, #6, #8 (sim + GPU≡CPU check; N benchmark not done), #2, #3, #7, #9, #10, #11, #12, #19.
- Run: `npm run build && npm run server` (prints join URLs with `?t=<token>`, token in `.einklang-token`). Dev: `npm run dev` + server, open `http://localhost:5173/?t=<token>`. Gallery needs no server: `/gallery.html`.
- Checks: `npm run typecheck`, `npm test` (38), `npm run build && npm run e2e` (two headless WebGPU hosts + a MIDI socket + Chrome's fake mic for instrument mode, compares hashes per tick).
- Debug panel: `d` / **debug** / `?debug=1` (frame graph + hitches, network, room, MIDI, and the old bottom-left HUD, which is now hidden). e2e opens pages with `?debug=1`; `TRACKS=a.mp3,b.mp3 npm run e2e` tests with real files.
- **WebGPU only, no WebGL2 fallback** (user, 2026-11-26): don't build or offer it.
- iPhone/iPad need https for WebGPU: `tailscale serve --bg 8080` is set up → `https://desktop-l8u8ccm.tailff0f31.ts.net/?t=<token>`. Server currently runs with `BIND=0.0.0.0`.
- Next: #8 N benchmark (hosts report capability, server picks N), then v2 (#13 extension leader, #14 beat tracking, #15 anticipation). Open bits: pad drift mode (float sims) + WebHID (v3), MIDI CC learn, transport → file play, flow reseed on the clock grid, real MIDI/pad device test.

## Log
- **2026-11-26 · instrument mode + interpolation (#12).** Live `Mode` has `delay`; **mic / line-in** asks for 2 ticks (instrument), **capture** keeps 6. A live frame for an already-rendered tick fires the late-event path (sims replay); debug shows delay/late. `SceneDef.state(f, F, sub)`: radial (rotation, ring/burst ages, strip scroll) and tunnel (z, twist, hue, rush) are closed-form in f + sub/256, transitions too; Engine draws the sub state and hashes the sub = 0 one. main/gallery derive sub from modeTickF (`?interp=0` off).
- **2026-11-26 · transitions built (#19).** `core/transitions.ts` (curves, `transitionAt`, `transHash`, `pickRandom`), `room.requestScene` (boundary start, ticks + tpb frozen, seed, random, queue in `scene.earlier`), `gpu/transition.ts` + `transition.wgsl` (one switch over 13 effects), Engine renders both scenes into `post.pairTargets()` and lerps post settings. Panel: **transition** + **length** (localStorage). Gallery: `trans=all|<effect>` auto-cycles every 2 bars, `at=<s>` one-shot for stills, `t` key. e2e runs all 13 effects on two hosts with 0 mismatches. Build notes are in the PRD.
- **2026-11-26 · transitions PRD (#19).** Grilled with the user (one question at a time): mixing before post, server-scheduled `{type, ticks, seed}`, length in beats frozen to ticks, start on the boundary, all 14 effects with per-effect curves, panel selectors (transition + length), server-side random (no cut, no repeat), both scenes live, overlapping requests queued after the running one, seeded params + pad-centred iris/zoom/swirl, gallery auto-cycle. Self-decided: the transition hash mixes both states + progress; no new pad button; e2e runs every effect.
- **2026-11-26 · waveform stream (#7).** Binary frames optionally carry a WAVE_BYTES (512 L/R int8) block per tick: file mode appends all of it after the features (worker computes it; ~60 KB/s of audio), live leader taps L/R with a splitter + analysers. `fileSource`/`mapSource` expose it as `wave(t)`; the scope uses it and auto-gains into its circle (scope golden hash updated deliberately).
