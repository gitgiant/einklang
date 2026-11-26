# Handoff

Newest first. Keep short; prune the oldest entries.

## State
- **Status 2026-11-26:** v1 complete, **WebGPU only** (no WebGL2 fallback: user decision, don't offer it). **Lab** (`docs/prd-lab.md`, tickets #20–#26): #20 graph runtime, #21 graph is the pipeline, #22 lab CLI + gate, #23 asset import, #24 voting are done. Open: #26 sprites/text/style packs, #25 agents.
- **Architecture now:** every scene is a graph in `lab/scenes/*.json` (v1 scenes = one synced `core-*` piece each), built from pieces in `lab/pieces/<kind>/<id>/` (`piece.json` + `driver.ts` and/or WGSL; the auto-shader path is `fn shade(uv)`). The Engine runs the show graph: scenes → `core-transition` → `core-post` → canvas. Piece API: `lab/api/index.ts`. The hash covers the graph inputs, and v1 state parity is unit-tested.
- **Run:**
  - `npm run build && npm run server` prints the join URLs with `?t=<token>` (token in `.einklang-token`).
  - Dev: `npm run dev` + server, then `http://localhost:5173/?t=<token>`.
  - Gallery, no server needed: `/gallery.html?scene=core-demo`.
  - iPhone/iPad: `https://desktop-l8u8ccm.tailff0f31.ts.net/?t=<token>` (`tailscale serve`, server on `BIND=0.0.0.0`).
- **Checks:**
  - `npm run typecheck`
  - `npm test` (73)
  - `npm run build && npm run e2e` (28 checks, two headless WebGPU hosts, hashes per tick; votes + gallery vote included)
  - `npm run lab -- gate --all` (all scenes, 1080p, 3 fixtures, ~2 min)
- **Lab CLI:** `npm run lab -- validate | render <scene|piece> [--fixture all] [--cpu] | gate [--all] [--junit f] | new <kind> <vendor-slug> | fixtures`. Artifacts go to `lab/out/` (gitignored). No GPU means it falls back to SwiftShader (~50x slower, budget not enforced).
- **Assets:** `lab/assets/` (29 MB, space_sim's own .vox, provenance + license in `index.json`; re-copy with `npm run lab -- import-space-sim`). A piece lists files in `piece.json` `assets` (`assets/...` = shared, else its own folder), reads them with `GpuInit.asset(path)` and parses with `parseVox`/`voxWorld` from `lab/api`. The `virtual:lab-assets` Vite plugin inlines only declared files into the engine chunk (base64), so every asset adds to page load: keep them small, or switch to an async preload if this grows. Furniture with third-party props is `license: "unsettled"` and can't be used.
- **Votes:** `+`/`-` (live, toast everywhere, `-` skips), Select+△/✕ on pads, gallery 👍/👎 + tags. Server appends `data/votes.jsonl` (gitignored), list = every non-retired lab scene, net <= -2 drops out. `]`/`>`/R1 and the panel's **auto** pick by weight 2^score. `npm run lab -- feedback` writes `lab/feedback.json` + `lab/FEEDBACK.md` and retires scene files (commit them).
- **Untested:** `hauptling.json` + `hauptling.Dockerfile` (Chrome in the worker image). This PC's WSL has no Docker or Hauptling, so whether Chrome sees the GPU under `--gpus all` is unproven.
- **Open:**
  - lab: recording a `.feat` fixture from real audio; vote param correlation in the digest
  - pad vote chord not covered by tests (no real pad here)
  - v2: #13 extension leader, #14 beat tracking, #15 anticipation
  - v3: drift mode, WebHID
  - flow looks finer/foggier at big N (question for the user)
  - MIDI CC learn; real MIDI/pad device test
- **Gotchas:**
  - Never `git worktree remove` a worktree holding a `node_modules` junction: it deletes files through it (restore with `npm install`; `npm ci` fails while the user's Vite dev server runs).
  - Python heredocs through the Bash tool can turn `'\n'` into real newlines in TS source; use the Edit tool for escapes.

## Log
- **2026-11-26 · UI polish.** Gallery info text off by default (`i` / `hud=1`); transitions default 8 beats (gallery cycle 4 bars at 8); controls fade after 3 s without input on both pages (`src/web/idle.ts`); vote panel shows the scene name.
- **2026-11-26 · voting (#24 done).**
  - User chose weighted next + server auto-rotation (no rotation existed before). `step` stays ordered; `weighted` is new.
  - `src/core/votes.ts` (format, tally, weight, retire), Room `vote()` / `tickAuto()`, `POST /vote` + `GET /scores`, toast, gallery panel, `scripts/lab/feedback.ts`.
- **2026-11-26 · asset import (#23 done).**
  - 568 files copied (no `third_party/`); `.vox` parser handles multi-model files and the nTRN/nGRP/nSHP scene graph (space_sim ships are hull + placed parts).
  - Lint: declared asset exists, shared license matches `index.json`, 2 MB cap counts shared files.
  - Exemplar `claude-vox-ship` (instanced cubes, band glow along the hull, onsets shatter it) + scene `claude-vox-fleet`; gate passes at 1080p (~0.9 ms whole show).
- **2026-11-26 · lab CLI + gate (#22 done).**
  - `scripts/lab`: validate (schema, lint, size), render (headless Chrome via Vite, GPU or SwiftShader; contact sheet + webm via mediabunny + stats), gate (changed items incl. untracked, 1080p, 3 fixtures, JUnit + `lab/out/gate.md`), new (scaffold).
  - Synthetic fixtures in `src/core/fixtures.ts`; piece harness in `src/core/graph/harness.ts`.
  - Checks: errors mapped to the piece file and line, NaN, black, blown out, frozen, no audio reaction, ms/frame. Dark or still on `quiet` only warns.
  - Verified: planted black and broken pieces fail, a scaffolded one passes.
- **2026-11-26 · graph is the pipeline (#21 done).**
  - Old `scenes.ts`/`post.ts`/`transition.ts` deleted; their WGSL lives in piece folders.
  - Scene files carry `post`; pads reach pieces as `ctx.pads`. Sims get `budget` / `bench` / `invalidate` via the piece API; `lab/api/prims.ts` draws display lists.
  - Room hash values changed; e2e 0 mismatches; stills match the previous commit except for trail-timing noise.
- **2026-11-26 · lab PRD (#20–#26).**
  - Grilled one question at a time:
    - free-form pieces
    - full node graph replaces the pipeline
    - rich ports
    - `einklang-lab` CLI
    - in-repo `lab/`
    - owner-only votes, all scenes live, net ≤ −2 retires
    - votes as `data/votes.jsonl` → committed digest
    - Hauptling delegator `lab` skill
    - pieces edited in place
    - space_sim own .vox imported
    - CC0 downloads via egress
  - Later added retro/text/sprites/generative tools; AI sprites code-drawn by default, image API opt-in (`imagegen: N`).
