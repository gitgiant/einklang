# Einklang
Deterministic audio visualizer (German *Einklang*: "unison"). Every screen shows the same scene state on the same tick. See [SPEC.md](SPEC.md) for the full design and [tickets/](tickets) for the roadmap.

![The four v1 scenes](docs/mockups/grid.png)

## Status
TypeScript + Vite, **WebGPU only** for now (the WebGL2/naga fallback in the spec is deferred). Done so far:

- Shared integer core (`src/core`): sine LUT, hash, the demo track, four scenes as pure `state(tick, features)` functions.
- WebGPU renderer (`src/web`): display-list SDF renderer, HDR post chain (feedback trails, bloom, ACES), and the four v1 scenes: radial spectrum (bit-identical port of the prototype), tunnel/warp, oscilloscope/Lissajous, and a fixed-point curl-noise flow field (131k particles).
- The flow field runs as i32 compute. The page checks the GPU result against the CPU reference (`gpu≡cpu ✓` in the HUD) every 2 s.
- Server (TS, no runtime dependencies), split into `ws.ts` (WebSocket framing), `auth.ts` (token and bind addresses) and `room.ts` (protocol):
  - **Room token (#2)**: it listens only on localhost and tailnet addresses. Every HTTP and WS request needs the token.
  - **Protocol v2 (#3)**: the server owns the mode, scene schedule, presets, beat grid and host views. Inputs become tick-stamped events, applied `INPUT_DELAY` (6) ticks after the server receives them. Joiners get the event log and the live feature ring (2 reseed periods). If an event arrives late, the flow sim rewinds and replays it.
  - **Presets and views (#9)**: scene switches land on the next beat or bar. Each host has a view (normal, mirror, flip, rotate 180, zoom, kaleido): its default comes from `?view=N`, and any host can override it from the hosts list.
- Tests: pinned determinism hashes, order-independence, flow-sim independence, hit events, and server integration (auth, events, quantized switching, views, file mode). CI runs typecheck, tests and build. `npm run e2e` runs two real WebGPU browser hosts and checks they produce identical hashes at the same ticks.

Not done yet:
- The beat grid is a fixed 28 ticks per beat until MIDI clock (#11) or beat tracking (#14) set it.
- The scope builds its waveform from the bands until the waveform stream (#7) exists.
- There is no display-rate interpolation yet (#12).
- Pads (#10) and MIDI (#11) will send their inputs as events; for now the only event is a manual hit.

## Run

    npm install

- **Gallery** (no server, synthetic demo track): `npm run dev`, then open `http://localhost:5173/gallery.html`. Keys `1`–`4` switch scenes, `g` toggles the grid and `h` hides the UI. URL params: `scene=`, `grid=1`, `start=<s>`, `stop=<s>`, `hud=0`.
- **Synced app, prod**: `npm run build && npm run server`. The server prints a join URL ending in `?t=<token>` for localhost and each tailnet address; open it on each device. The token is generated on first run and saved to `.einklang-token`; set `EINKLANG_TOKEN` to choose your own. Set `BIND=0.0.0.0` to listen on the LAN as well.
- **Synced app, dev**: run `npm run server` and `npm run dev` together, then open `http://localhost:5173/?t=<token>`. Vite proxies `/ws` and `/track` to the server.
- **Mockups**: `npm run mockups` renders `docs/mockups/*.png` using real WebGPU in headless Chrome.
- **Checks**: `npm run typecheck`, `npm test`, and `npm run build && npm run e2e` (needs Chrome with WebGPU).

Requires Node 22.6+ and a Chrome with WebGPU.

To verify sync, check that the `hash` in the HUD matches across hosts.

- **File mode**: any host drops in a track. It gets analyzed once, the features go to every host, and playback starts 2.5 s later. Tick "audio here" on hosts that should play sound.
- **Live mode**: the leader captures from a mic or line-in and streams features. Everyone renders 100 ms behind to absorb network jitter. Browsers only allow audio capture on localhost or https, so run the leader on the server machine at `http://localhost:8080`, or use `tailscale serve 8080` to get https.
- **offset ms**: a per-host trim for display latency (TV vs. panel). It's saved per device.
- **Scene, quantize, hit, hosts**:
  - `[` and `]`, or the arrows, step through the presets; the picker jumps straight to one. Switches land on the next beat, bar, or immediately (the "on" selector).
  - Space sends a manual hit.
  - **hosts** lists connected hosts and lets you override each one's view. `?name=` names a host.

How it works: each scene's `state(tick, features)` uses integers only. Scenes are stateless with 600 ticks of lookback, so late joiners and dropped frames can't drift. The flow field is the exception: it is a sim, so it reseeds every 8 bars and fast-forwards up to 50 steps per frame. The tick comes from a server clock synced NTP-style (min-RTT sample).
