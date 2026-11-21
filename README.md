# Einklang
Deterministic audio visualizer (German *Einklang*: "unison"). Every screen shows the same scene state on the same tick. See [SPEC.md](SPEC.md) for the full design and [tickets/](tickets) for the roadmap.

## Status
The current code is the **JS prototype** (Canvas2D, one scene, file + live modes). It's the reference for the protocol and determinism rules. v1 replaces it with the TypeScript/Vite, WebGPU + WebGL2 build described in the spec.

## Run the prototype

    node server.js          # Node 18+, no deps. PORT=8080 default

Open `http://<host>:8080` on each device. To verify sync, check that the `hash` in the HUD matches across hosts. Press `h` to hide the UI.

- **File mode**: any host drops in a track. It gets analyzed once, the features go to every host, and playback starts 2.5 s later. Tick "audio here" on hosts that should play sound.
- **Live mode**: the leader captures from a mic or line-in and streams features. Everyone renders 100 ms behind to absorb network jitter. Browsers only allow audio capture on localhost or https, so run the leader on the server machine at `http://localhost:8080`, or use `tailscale serve 8080` to get https.
- **offset ms**: a per-host trim for display latency (TV vs. panel). It's saved per device.

How it works: `scene(frame, features)` uses integers only (sine LUT built from IEEE-exact ops, imul hash PRNG). It's stateless with 600 frames of lookback, so late joiners and dropped frames can't drift. The frame number comes from a server clock synced NTP-style (min-RTT sample).
