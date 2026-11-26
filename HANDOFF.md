# Handoff

Newest first. Keep short; prune the oldest entries.

## State
- v1 in progress, **WebGPU only** (WebGL2/naga deferred by request). Tickets done: #1 (scaffold), #4 (renderer, WebGPU side), #5, #6, #8 (sim + GPU≡CPU check; N benchmark not done), #2, #3, #9, #11.
- Run: `npm run build && npm run server` (prints join URLs with `?t=<token>`, token in `.einklang-token`). Dev: `npm run dev` + server, open `http://localhost:5173/?t=<token>`. Gallery needs no server: `/gallery.html`.
- Checks: `npm run typecheck`, `npm test` (17), `npm run build && npm run e2e` (two headless WebGPU hosts + a MIDI socket, compares hashes per tick).
- Debug panel: `d` / **debug** / `?debug=1` (frame graph + hitches, network, room, MIDI).
- Next: #10 gamepads (emit events via `send({t:'ev',...})`; add keys past STRIDE like MIDI did), #7 waveform stream, #12 interpolation, #8 N benchmark. MIDI open bits: CC learn, transport → file play, flow reseed on the clock grid, real-device test.

## Log
- **2026-11-25 · MIDI (#11) + debug panel.** `src/web/midi.ts` relays notes/CCs (CCs coalesced per 16 ms) and counts clock; it reports each beat with a server-time timestamp. The server (`Room.onClock`) elects the master (2 s timeout) and stamps a `beat` event for the *next* beat where it will fall, so beats stay deterministic and on time. It also re-anchors `grid` (tpb can be fractional now). Scenes read MIDI through feature keys past STRIDE (`K_NOTE`, `K_BEAT`, `K_PHASE`, `K_BAR`, `K_BPM`, `K_P0..3`) via `withEvents`; pinned hashes are unchanged without MIDI. The latest CC values persist (`ccLast`) across epochs and are sent to joiners. Tested with a fake MIDI socket only; no real device yet. Debug panel in `src/web/debug.ts`.
- **2026-11-25 · audio capture.** "capture tab / app audio" button: `getDisplayMedia` audio → same live-leader path as mic (`startLive`). Needs localhost/https. "audio here" now remembered and auto-ticked for the uploader. Verified analysis with Chrome's fake beeping device; headless tab capture is silent (no audio output), real Chrome untested by me.
- **2026-11-25 · sync (#2 #3 #9).** Server split into `ws.ts`/`auth.ts`/`room.ts`; protocol types in `src/core/protocol.ts`. Token auth (query or cookie), binds localhost + tailnet (`BIND` overrides). Server owns mode/scene schedule/presets/grid/views; events stamped `+INPUT_DELAY` (6 ticks); late events make the flow sim replay. Beat grid is fixed 28 ticks/beat until MIDI/beat tracking. Views: normal/mirror/flip/rot180/zoom/kaleido.
- **2026-11-25 · renderer + scenes.** TS/Vite scaffold; integer core (`src/core`), WebGPU SDF display-list renderer + post chain (trails, bloom, ACES), 4 scenes. Radial is bit-identical to the prototype. Flow field: 131k i32 particles, GPU hash checked against CPU reference in the HUD. Mockups in `docs/mockups/` (`npm run mockups`), single-file gallery via `npm run build:live`.
