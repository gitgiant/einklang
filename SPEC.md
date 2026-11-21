# Einklang — Spec

**Einklang** (German: "unison, accord"). Deterministic audio visualizer for multiple screens in the same room (Windows laptop, Steam Deck, any Chrome host). Every host shows **identical scene state on the same 60 Hz tick**. Pixel output may differ by sub-pixel shading between GPUs.

## 1. Sync model
- **Clock**: NTP-style offset to the server clock, using the min-RTT sample from the last 20. `tick = floor((serverNow + hostOffset - start) * 60 / 1000)`.
- **Tick**: fixed at 60 Hz for sim, inputs and features. Displays at 90/120/144 Hz interpolate closed-form state and uniforms between ticks. Sims show their latest tick.
- **Verification**: the HUD shows `tick` and a hash of the scene state (FNV over integer state/uniforms). Matching hashes mean the hosts are in sync.
- **Host offset**: per-device ms trim for display latency, visuals only, persisted per device.
- **Determinism rules**: scene state uses only integer math (Int32, `Math.imul`, LUT trig built from IEEE-exact ops, hash PRNG). No `Math.sin/cos/exp/pow` in state paths. Floats are allowed only in final shading.
- **Feedback FX** (trails/echo) are GPU-pixel state. After a join or stutter they converge within ~1 s. This is accepted.

## 2. Audio modes
| Mode | Source | Render delay | Notes |
|---|---|---|---|
| File | uploaded track | 0 (pre-analyzed) | Leader analyzes once; features go to all hosts; optional audio playback per host with drift correction |
| Instrument | mixer line-in (LiveTrak L6 Max USB) on the server PC | 1–2 ticks, same on all hosts including the leader | Leader runs at `localhost` (getUserMedia needs a secure context) |
| PA-delay | YouTube or any tab | D = 250 ms | Chrome MV3 extension is the full leader: `tabCapture` (offscreen doc) → analysis → features over WS; captured audio replayed through `DelayNode(D)`. The lookahead feeds **anticipation FX**. Fallbacks: VB-Cable capture, or `getDisplayMedia` tab audio in the page |

**Feature frame** (per tick): 16 log bands, RMS, onset, plus beat phase/BPM, plus an optional decimated L/R waveform (Oscilloscope scene).

**Tempo priority**: MIDI clock > audio beat tracking (on the leader, from onsets) > tap tempo (pad button). The first MIDI clock seen is master and stays master until it has been silent for 2 s.

## 3. Inputs
All inputs from any host are relayed through the server and stamped with an **effective tick = now + input delay**, so every host applies them on the same tick.

**MIDI** (Web MIDI, any Chrome host, Deck/Steamtakt included): clock → BPM and beat phase; note-on/velocity → triggers (pitch → color/position); CCs → params; transport start/stop → timeline.

**Gamepads** (Deck + PS5 DualSense, any host). Multiplayer: each pad gets its own color and effect layer, mixed into one scene.
- Face buttons: momentary FX, sustained while held. ✕ shockwave, ○ strobe, △ kaleido mirror, □ invert/glitch.
- L stick: FX center. R stick: rotation/zoom drift. L2/R2: feedback trails / bloom amount.
- L1/R1: scene prev/next, quantized to the beat or bar. D-pad: palette, per-host view.
- Also: manual hit, blackout, freeze, tap tempo, drift toggle.
- **WebHID extras (v3)**: gyro → camera tilt, touchpad → paint, lightbar = scene color, haptics on the beat.

## 4. Views & scenes
- Synced **preset list**. The server holds `{sceneId, switchTick}`.
- **Per-host view**: the default comes from the `?view=N` URL; the controller can override per host (hosts register a name).
- **v1 scenes** (each proves a pipeline): Radial spectrum (port), Tunnel/warp (trails + post-FX), Oscilloscope/Lissajous (waveform stream), Curl-noise flow field (fixed-point compute + WebGL2 transform-feedback fallback).
- **Backlog**: Boids, Strange attractor, Smoke/fluid, Physarum, N-body galaxy, SPH liquid, MIDI charge field, Reaction-diffusion, Ridgeline terrain, Voronoi shatter, Raymarched SDF.

## 5. Rendering
- **WebGPU primary, WebGL2 fallback.** Chrome's WebGPU rollout on Linux has started with Intel Gen12+ GPUs, so the Deck's AMD GPU may only get WebGL2.
- Shaders are written **once in WGSL** and converted to GLSL ES 3.0 at build time with **naga**. CI compiles both.
- **Particle sims**: fixed-point i32 compute, so results are bit-identical on every GPU. The WebGL2 fallback runs the same integer sim through transform feedback; this is the only hand-written GLSL.
- **Reseed** on scene enter and every 8 bars. A late joiner fast-forwards from the last reseed at ~50 steps per frame, using the server's 8-bar log of features and inputs.
- **Drift mode** (global pad toggle): sims switch to float math and each host evolves independently. Scene, beat and inputs stay shared. Turning it off resyncs at the next bar.
- **Particle budget**: hosts report a benchmark on join and the server sets N to what the weakest host can run. Stronger GPUs add decorative, non-interacting closed-form "dust" on top. A weaker host joining mid-scene triggers a renegotiation of N at the next reseed and shows dust only until then.

## 6. Server & security
- Plain Node, no dependencies: static files, WS (RFC 6455), clock sync, relay, track hosting with Range support, the 8-bar replay log, and state that it decides (scene, views, N, clock master, mode).
- Binds to the tailnet or localhost only. A **room token** in the URL is required for all WS and HTTP operations.

## 7. Stack
TypeScript + Vite, with a shared core used by the page, the extension and the server. Build: Vite + naga. The existing prototype in `public/` + `server.js` is the reference for the protocol and determinism.

## 8. Milestones
- **v1**: TS/Vite port, WebGPU + WebGL2 renderer, 4 scenes, presets + views, pads (multiplayer), MIDI, file + instrument modes, token auth.
- **v2**: Chrome extension leader, PA-delay with anticipation FX, audio beat tracking, tap tempo.
- **v3**: WebHID extras, drift mode polish, backlog scenes.
