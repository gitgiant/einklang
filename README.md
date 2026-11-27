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
- Tests: pinned determinism hashes, order-independence, flow-sim independence, hit events, MIDI (sanitizing, clock master election and beat stamping, CC persistence, note/beat/CC features), and server integration (auth, events, quantized switching, views, file mode). CI runs typecheck, tests and build. `npm run e2e` runs two real WebGPU browser hosts and checks they produce identical hashes at the same ticks, including while a third socket plays MIDI clock, notes and a CC.

Not done yet:
- Without a MIDI clock the beat grid is a fixed 28 ticks per beat, until beat tracking (#14) lands. The flow sim's reseed period stays on that fixed grid.
- There is no display-rate interpolation yet (#12).
- MIDI CCs use a fixed map (no MIDI learn), and MIDI start/stop doesn't start or stop file playback. Drift mode (pads) and WebHID extras aren't implemented.

## Run

    npm install

- **Gallery** (no server, synthetic demo track): `npm run dev`, then open `http://localhost:5173/gallery.html`. Keys `1`–`4` switch scenes, `g` toggles the grid and `h` hides the UI. URL params: `scene=`, `grid=1`, `start=<s>`, `stop=<s>`, `hud=0`.
- **Synced app, prod**: `npm run build && npm run server`. The server prints join URLs ending in `?t=<token>` (https for other devices, see [HTTPS](#https); http for this machine); open one on each device. The token is generated on first run and saved to `.einklang-token`; set `EINKLANG_TOKEN` to choose your own. Set `EINKLANG_LAN=1` to serve the LAN as well.
- **Synced app, dev**: run `npm run server` and `npm run dev` together, then open `http://localhost:5173/?t=<token>`. Vite proxies `/ws` and `/track` to the server.
- **Mockups**: `npm run mockups` renders `docs/mockups/*.png` using real WebGPU in headless Chrome.
- **Checks**: `npm run typecheck`, `npm test`, and `npm run build && npm run e2e` (needs Chrome with WebGPU).

Requires Node 22.6+ and a Chrome with WebGPU.

### HTTPS
Other devices need https: over plain http there is no WebGPU, mic, screen share or wake lock. `npm run server` serves it on port **8444** (http stays on 8080 for `localhost`, dev and `tailscale serve`).

- **Tailscale** (default, nothing to set): the server runs `tailscale cert` for this machine's `*.ts.net` name into `.einklang-certs/` (gitignored), and renews it when it has less than 14 days left (checked at start and daily, applied without a restart). Needs MagicDNS and HTTPS certificates enabled in the tailnet; on Linux the user also needs `sudo tailscale set --operator=$USER`. If it fails, the server warns and runs on http only.
- **LAN without Tailscale** (`EINKLANG_LAN=1`, e.g. a Steam Deck on `192.168.0.x`): also listens on this machine's private IPv4 addresses (not VM/WSL/Docker adapters) and serves them a self-signed certificate for those addresses, the hostname and `<hostname>.local`. It is generated once (replaced only for a new address or within 14 days of its 825-day expiry); the server prints its SHA-256 fingerprint. On the device, compare it in the browser's certificate viewer and accept the warning. Windows asks to let Node through the firewall: allow it on private networks.
- **Redirect**: plain-http requests from other devices get a 308 to https with the same path and `?t=` (LAN devices to the LAN address, others to `EINKLANG_PUBLIC_URL` or the `ts.net` name); their `ws://` upgrades are refused. Requests from this machine's loopback, which includes `tailscale serve`, are served as they are. A bookmark without `?t=` has to be opened once with it, since the cookie doesn't carry over from the http address.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EINKLANG_HTTPS` | on | `0` turns the server's own HTTPS off |
| `EINKLANG_HTTPS_PORT` | `8444` | HTTPS port (8443 is often taken by another `tailscale serve`) |
| `EINKLANG_CERT`, `EINKLANG_KEY` | | PEM files to serve instead of the Tailscale certificate (set both; re-read daily) |
| `EINKLANG_PUBLIC_URL` | | https URL to redirect to and print, e.g. your `tailscale serve` address |
| `EINKLANG_HTTP_PORT` | | extra port (e.g. `80`) that only redirects |
| `EINKLANG_LAN` | off | `1`: LAN addresses plus self-signed certificate |
| `PORT`, `BIND`, `EINKLANG_TOKEN` | `8080`, localhost + tailnet | `BIND` replaces the address list, also the LAN ones |

To verify sync, open the debug panel (`d`) and check that the `hash` matches across hosts.

- **File mode**: any host loads tracks with **files** (one or more) or **folder** (every audio file in it, in natural path order). Formats are whatever Chrome decodes: mp3, wav, flac, ogg/opus, m4a/aac, webm. Each track is decoded and analyzed (in a worker) on that host, the features go to every host, and playback starts 2.5 s later. The next track is prepared while the current one plays, and the list auto-advances and wraps. Tick "audio here" on hosts that should play sound.
- **Transport bar** (bottom, on every host): prev (restarts the track if past 3 s), play/pause (`p`), next, track name and position, and a progress bar you click or drag to seek (`←`/`→` seek ±10 s). Pause freezes the picture on every host. Prev/next from any host are relayed to the host that holds the files; if that host leaves, the list goes with it.
- **Live mode**: the leader captures from a mic or line-in and streams features. Everyone renders 100 ms behind to absorb network jitter. Browsers only allow audio capture on localhost or https, so run the leader on the server machine at `http://localhost:8080`, or open the server's [https](#https) URL.
- **offset ms**: a per-host trim for display latency (TV vs. panel). It's saved per device.
- **Scene, quantize, hit, hosts**:
  - The live list is every lab scene not retired by votes. `[` (or `<`) steps back in list order; `]` (or `>`) picks another scene at random, weighted by votes. The picker jumps straight to one. Switches land on the next beat, bar, or immediately (the "on" selector).
  - **auto**: the server switches every 4, 8 or 16 bars to a vote-weighted pick, with the transition chosen when it was turned on.
  - Space sends a manual hit. `h` hides all the UI.
  - **Lyrics**: put a `.lrc` file next to a track with the same name (`song.mp3` + `song.lrc`) and pick both (or the folder). Text pieces show the current line on every host.
  - **Votes** (owner only: anyone with the token): `+` / `-` vote on the scene showing; a toast appears on every host. `-` also skips to a weighted pick at the next boundary. Score = ups - downs; a 👍 doubles a scene's rotation weight and a 👎 halves it, and at -2 the scene leaves the live list. Votes go to `data/votes.jsonl`. The gallery has 👍/👎 and reason tags too (it needs the server for that).
  - **hosts** lists connected hosts and lets you override each one's view. `?name=` names a host.
- **MIDI**: press **midi** on any Chrome host that has a MIDI device (the choice is remembered). Enable it on only one host per device, or every note arrives twice.
  - **Clock**: the first host to send one is the master until it goes silent for 2 s. Its tempo and beat phase set the room's beat grid, so beat and bar quantizing follow the clock. MIDI start makes the next beat a downbeat. In the radial scene the core thumps on every beat.
  - **Notes**: each note-on counts as an onset in every scene. In the radial scene, pitch sets the burst's direction and color, and octave sets its speed.
  - **CCs**: CC 1 (mod wheel) rotates every scene's palette. CC 74, 71 and 10 also reach the scenes as params, but no scene uses them yet. The last value of each CC is kept across track changes and sent to late joiners.
- **Gamepads**: plug any pad into any host (Chrome, standard mapping: DualSense, Xbox, Deck). There is nothing to enable; press a button. Each pad gets a room-wide color, and its own layer: a cursor at its FX center plus the shockwaves it fires. Effects from all pads mix.
  - ✕/A shockwave (repeats while held), ○/B strobe, □/X invert + glitch, △/Y kaleido around the pad's center. Share/View: blackout while held.
  - Left stick: FX center. Right stick: rotation (x) and zoom (y) drift of the trails. L2: trails. R2: bloom.
  - L1/R1: previous scene / weighted next (uses the "on" quantize). Select+△ / Select+✕: vote up / down (△ and ✕ don't fire their FX while Select is held; Select's blackout still does). D-pad left/right: palette. Up/down: this host's view.
  - L3: hit. R3: freeze toggle (the scene stops; trails and FX keep moving). Options/Menu: tap tempo (sets the beat grid when no MIDI clock is running).
  - Pad state goes out only when it changes, at most once per tick, and is stamped like any event. The FX are a pure function of the event log, so every host draws the same thing.
- **Debug panel**: press `d`, click **debug**, or add `?debug=1`. On top is the frame-time view: a histogram over the last 5 s / 30 s / since scene start / since load (coloured against the display's refresh rate, detected from `requestAnimationFrame`), avg / median / p95 / p99 / worst, dropped frames (> 1.5 refresh intervals), long tasks and GPU ms (where the browser has them), a table of the last 10 scenes and transitions, **reset** and **copy as text**. The gallery has the same view (`d`, or **debug** in the picker's display tab). Below it the app's panel shows a frame-time graph with hitches marked in red, fps, p99 and max frame time, recent hitches, and skipped or repeated ticks. It also shows network stats (RTT, clock offset, message and byte rates, live-feature gaps, late events), room state (epoch, scene schedule, grid, hosts) and MIDI status (inputs, local clock, room clock master, CC values).

How it works: each scene's `state(tick, features)` uses integers only. Scenes are stateless with 600 ticks of lookback, so late joiners and dropped frames can't drift. The flow field is the exception: it is a sim, so it reseeds every 8 bars and fast-forwards up to 50 steps per frame. The tick comes from a server clock synced NTP-style (min-RTT sample).
