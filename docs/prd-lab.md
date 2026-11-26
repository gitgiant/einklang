# PRD: Einklang Lab (agent-generated pieces, a node-graph runtime, and voting)

Status: agreed 2026-11-26 (grill-me interview), not started. Tickets: #20–#25.

## Problem

Einklang has four hand-built scenes, and each new visual means TypeScript and WGSL glued into the Engine by hand. We want a supply of visuals that AI agents (Claude, Codex, agy) can build without help, as **modular pieces** (generators, color, effects, modulators, utilities). Agents should combine those pieces into **scenes**, check their own work in a sandbox, and land it through Hauptling. The owner's up/down votes, live and in the gallery, decide what stays and steer what gets built next.

## Goals

- One piece contract that any of the three agent CLIs can write: a manifest, an optional TS driver and WGSL.
- A **node graph** with typed ports that replaces the current render pipeline. The v1 scenes, global post, pad FX and transitions all become nodes.
- An agent-agnostic sandbox CLI, `einklang-lab`: validate, render previews on the CPU, and run a GPU gate.
- Voting live (keys and pad chord) and in the gallery. Votes prune the live list and feed back to agents through a committed digest.
- The Hauptling delegator picks what to build next from a backlog plus the vote digest.

## Non-goals

- A human graph editor or param panel. Agents do all the authoring, and humans only vote.
- Multiple voters. Only the owner's votes count.
- Runtime hot-loading of pieces. New pieces arrive through git and a rebuild.
- Bit-exact determinism for AI pieces (see Sync).
- A WebGL2 fallback (WebGPU only).

## Decisions

### Sync

- Pieces are **free-form**: floats, `Math.sin` and GPU-side state are allowed anywhere.
- The **hash covers the graph inputs**: scene id and graph version, tick, the feature frame, inputs, and the resolved param values (after modulators, quantized to int). Piece internals (float sims, GPU buffers) are not hashed.
- Ported v1 nodes keep their integer state and opt into hashing with `synced: true` in the manifest. e2e keeps comparing hashes per tick across two hosts.
- Visual input (webcam, screen, video) is per host and not hashed.

### Pieces

- A piece is a folder, `lab/pieces/<kind>/<id>/`, containing:
  - `piece.json`: `id`, `kind`, `ports {in, out}`, `params` (typed, with ranges and defaults), `tags`, `budget` (ms at 1080p and how it scales with N), `author {vendor, model}`, `synced`, `assets[]` with `license`, `changelog[]`.
  - An optional `driver.ts`: `definePiece({ init(gpu), frame(ctx) })`. `ctx` provides `tick`, `sub`, `features`, `inputs`, `device`, `palette`, resolved params and bound input ports.
  - One or more `*.wgsl` files.
- **Piece API sandbox:** pieces import only from `lab/api`. Lint and the gate reject DOM, `fetch`, storage, timers, globals, and imports from outside the piece.
- **IDs:** `<vendor>-<slug>`. Ported built-ins use `core-<slug>`.
- **Edit in place:** an agent may improve an existing piece directly. Every scene using it picks up the change, votes are kept, and a `changelog` line records what changed.
- **Bundling:** Vite `import.meta.glob` over `lab/pieces/**` and `lab/scenes/*.json`. A new piece needs a rebuild.
- **Assets:** procedural first. Small vendored files (`.vox`, `.glb`, `.png`) go in the piece folder or the shared `lab/assets/`, with a size cap of 2 MB per piece and a required license field. CC0 sources (Kenney, Poly Haven) are on the Hauptling egress allowlist so agents can fetch and vendor them.

### Ports

| Port | Payload |
|---|---|
| `tex` | HDR image, rgba16f, at the target resolution |
| `mask` | r16f |
| `field` | 2D vector field (rg16f texture) |
| `particles` | storage buffer, fixed layout: pos, vel, color, age, size; count N |
| `geo` | 3D content (mesh, voxels or SDF), drawn through a `camera` |
| `camera` | view and projection |
| `palette` | N OKLab stops |
| `signal` | a scalar per tick |
| `trigger` | events (onset, note, pad button) |
| `spectrum` | 16 log bands |
| `wave` | decimated L/R waveform |

An edge must join equal port types. Conversions are explicit utility nodes (for example particles→tex splat, geo→tex render, luma→field).

### Graph and Engine

- **The graph replaces the pipeline.** The root **show graph** runs scene A and scene B → transition node → global post / pad FX node → screen.
- The v1 radial, tunnel, scope and flow scenes, `post.wgsl` and the 13 transitions are ported to nodes, and their hashes must match today's.
- **Scene file:** `lab/scenes/<id>.json` holds `nodes[] {id, piece, params, bind}`, `edges[] {from: node.port, to: node.port}`, `author {vendor, model}`, `parent` (for remixes), `status` (`live` or `retired`) and `created`.
- **Modulator bindings:** any numeric param can be bound to a `signal` (a band follower, LFO, CC, pad axis and so on).
- **Evaluation:** topological order, once per frame. `tex` intermediates come from a pooled set of render targets.
- **Budgets:** pieces declare a cost. The existing weakest-host benchmark sets `particles` N, and a scene's total budget is checked at the gate.

### Catalog (seeds `lab/BACKLOG.md`)

- **Generators:**
  - Requested: osc scope / Lissajous, visual input (webcam, screen, video), particle sim, physics (rigid, cloth, soft body), voxel shapes, 3D assets (glTF, .vox).
  - Added: strange attractors, reaction-diffusion, physarum, smoke/fluid, boids, N-body, SPH liquid, SDF raymarch, fractals (mandelbox, julia), L-systems/trees, cellular automata, spectrum terrain/ridgeline, Voronoi, noise fields, text/lyrics, MIDI piano-roll, lasers/lightning, shape grammar, metaballs, string/wave sim.
- **Color:**
  - Requested: palette picker (agent-side: chooses stops) and color-theory harmonies (complementary, triadic, analogous, split, tetradic).
  - Added: image→palette extraction, mood/genre presets, key→hue (circle of fifths), OKLab gradients, palette cycling on the beat, per-pad color, contrast guard (APCA), blackbody/temperature, LUT grading, duotone/tritone mapping, palettes learned from votes.
- **Effects:**
  - Requested: shaders, pixelate, voxelize.
  - **Core:** kaleido, mirror/tile, feedback/trails, bloom, chromatic aberration, glitch/datamosh, CRT/VHS, ASCII/dither (Bayer, error diffusion), halftone, edge/toon, displacement by field, polar warp, slit-scan, echo/time delay, film grain, DOF, god rays, lens flare, posterize, scanlines.
  - **Spatial / warp:** fisheye/barrel, twirl, onset ripple, heat haze, liquify by field, droste/recursive zoom, hyperbolic (Poincaré) tiling, tri/hex mosaic, sphere/cylinder wrap, page curl, Voronoi shatter, pixel sort, mesh-grid displace, sine warp.
  - **Time / feedback:** motion blur, temporal echo stack, zoom feedback (Milkdrop-style), rotate feedback, freeze-frame stutter on the beat, reverse buffer scrub, onion skin, time-displacement map, datamosh P-frame smear.
  - **Color / tone:** hue rotate on the beat, gradient map, thermal/false color, solarize, levels/curves, tonemap (ACES, AgX), bleach bypass, split tone, selective color pop, invert by mask, chroma key, quantize to palette.
  - **Optics / light:** anamorphic streaks, light leaks, vignette, lens dirt, prism split, caustics, volumetric shafts, halation, star filter, glare.
  - **Stylize:** Kuwahara oil, watercolor, hatching, stained glass, mosaic, LEGO/brick, pointillism, woodcut, neon edge glow, emboss, thermal print, risograph, Game Boy 4-color, 1-bit Mac, teletext/PETSCII, LED matrix, cross-stitch.
  - **Voxel / 3D-ish:** voxel extrude (luma→height), isometric cubes, depth-from-luma parallax, 2.5D layer split, SSAO, depth fog, tilt-shift.
  - **Glitch / signal:** RGB shift per band, scanline jitter, block displacement, bit crush, JPEG artifacts, VSync roll/tearing, interlace, NTSC bleed, broken LCD, dead pixels.
  - **Analysis-driven:** optical-flow trails, edge→particles emitter, luma→field, motion-masked FX, band-masked FX (each band drives a region).
- **Modulators:** band follower, envelope/ADSR, LFO, beat-synced step sequencer, random walk, MIDI CC/note, pad axis, slew, math (map, clamp, mix).
- **Composite / utility:** blend (add, screen, multiply, difference), mask ops, crossfade, transform, camera rigs (orbit, dolly, shake), particles→tex splat, geo→tex render, field ops.

### Sandbox: `einklang-lab` CLI

Hauptling workers run in containers with no GPU. The sandbox is a shell CLI, so it works the same for all three vendors.

- `einklang-lab validate [path]`: schema, port types, lint, typecheck, WGSL compile (naga or Tint).
- `einklang-lab render <scene|piece> [--frames --res --fixture]`: headless Chrome with WebGPU on **SwiftShader** (CPU) at low resolution. It writes a PNG contact sheet, a short webm and error logs to `lab/out/` (gitignored). A bare piece is rendered in an auto-made harness scene.
- `einklang-lab gate`: the `gpu` command in `hauptling.json` (`gateGpu: true`).
- `einklang-lab feedback`: builds the vote digest (see Voting).
- `einklang-lab new <kind> <slug>`: scaffolds a piece from a template.
- **Fixtures:** `lab/fixtures/*.feat` are recorded feature-frame streams (bands, RMS, onset, beat phase/BPM, waveform) for 3 tracks: quiet/ambient, techno, dense/busy. Containers never need the audio.

### Gate (merge to main through Hauptling)

- **CPU:** `validate`, unit tests, `npm run typecheck`, plus the existing tests.
- **GPU** (RTX 2070 SUPER): render 8 s at 1080p against all three fixtures. It fails on:
  - runtime or validation errors
  - NaN, all-black or blown-out frames
  - frozen output (frame difference ≈ 0, or no correlation with the audio features)
  - more than the budget: 4 ms per piece or 12 ms per scene
- Contact sheet and webm are kept as test artifacts.

### Voting

- **Owner only.** Votes come from the gallery (👍/👎 plus optional reason tags such as "too busy", "boring" or "great colors") and live from keyboard `+`/`-` on any host or a pad chord on the owner's pad (Select+△ up, Select+✕ down).
- A live vote shows a toast on all hosts. A live 👎 also asks for the next scene at the next boundary, using the current transition.
- **Live list:** every merged scene goes live at once.
  - Score = ups − downs.
  - Rotation weight grows with score, and a 👎 halves it right away.
  - At net ≤ −2 the scene is **retired**: hidden, kept in git, still remixable.
- **Store:** the server appends to `data/votes.jsonl` (gitignored), one line per vote: `{scene, at, vote, tags, live?, tick?, features?}`. Live votes record the musical context.
- **Digest:** `einklang-lab feedback` (run by the delegator before dispatch) writes:
  - `lab/feedback.json`: scores per scene, per piece (credit flows to the pieces a scene uses) and per vendor, plus tag counts and param/piece correlations.
  - `lab/FEEDBACK.md`: a readable top/bottom list, what is liked, and what to avoid.
  - Each scene's `status`.

  It commits these, so agents read the feedback with no network access.

### Agents (via Hauptling)

- `lab/AGENTS.md` holds the contract: piece API, ports, rules, CLI use, gate, ID and author conventions. It is linked from the repo's CLAUDE.md and AGENTS.md, and agy reads AGENTS.md.
- A **`lab` skill for the Hauptling delegator** reads `lab/BACKLOG.md` (unchecked catalog items plus briefs the owner pins) and `lab/FEEDBACK.md`, then spawns a mix of work:
  - new pieces
  - new scenes made from existing pieces
  - remixes of top scenes (`parent` set)
  - fixes to pieces with low scores
- Vendors rotate per task, so the digest can compare Claude, Codex and agy.
- Each task is its own Hauptling worker container and branch, gated as above. Auto-merge follows the delegator's settings.

### Assets import

- A one-time script copies space_sim's own assets into `lab/assets/vox/` (~30 MB, git-tracked), with `lab/assets/index.json` (source path, license `own`):
  - `C:\Users\giant\Desktop\space_sim\assets\vox` (about 11 MB of the owner's own `.vox`: ships, buildings, parts, rooms, furniture, `local`)
  - `assets\agent\ship` (about 20 MB: `.vox`, `recipe.json`, `sheet.png`)
- `third_party/` (947 MB, licenses unknown) is **not** imported. A single file can be added later with its license recorded.

## Phases and tickets

1. **#20 Graph runtime + piece API:** ports, scene JSON, evaluator, render-target pool, modulator bindings, hashing of graph inputs, `lab/api`, Vite globbing.
2. **#21 Port v1 to graph:** radial, tunnel, scope and flow as `core-*` pieces; post / pad FX and the transition node; show graph. Hash parity with today in e2e, then the old pipeline is deleted.
3. **#22 `einklang-lab` CLI + gate:** validate, SwiftShader render, fixtures, GPU gate, `hauptling.json` (`gpu`, `gateGpu`), `new` scaffolds.
4. **#23 Asset import:** the space_sim copy script, `index.json`, a `.vox` loader in `lab/api`, and one voxel generator as the exemplar.
5. **#24 Voting:** gallery buttons and tags, keys and pad chord, server log, toast, live-skip on 👎, rotation weights, retire rule, `feedback` digest.
6. **#25 Agents:** `lab/AGENTS.md`, `lab/BACKLOG.md` seeded from the catalog, the delegator `lab` skill, and a first batch (one generator, one color piece, one effect and one scene per vendor).

## Open

- The exact reason-tag list, and whether tags weight the score.
- How the digest picks up "correlation with likes": first cut is per-piece and per-tag counts, with param correlation later.
- SwiftShader WebGPU speed in a 3-CPU container. If it is too slow, fall back to fewer frames or lower resolution.
