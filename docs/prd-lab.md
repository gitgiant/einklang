# PRD: Einklang Lab (agent-generated pieces, a node-graph runtime, and voting)

Status: agreed 2026-11-26 (grill-me interview). **#20, #21 and #22 built 2026-11-26**; #23–#26 open. Tickets: #20–#26. Stills: `docs/mockups/lab-*.png` (`ONLY=lab-demo,lab-retro npm run mockups`).

### Build notes for #26 (decided while building)

- **Sprites:** one runtime format, `.spr` (`lab/api/sprite.ts`): indexed colour, equal frames, per-frame durations, tags; a texture_2d_array layer per frame. `sprite import` converts PNG grids, Aseprite JSON, GIF, `.vox` z-slices and code-drawn `*.sprite.json` recipes (`lab/assets/sprites/src/`), with node-only PNG/GIF codecs (`scripts/lab/png.ts`). Four code-drawn sheets ship: dancer, sparkle, heart, note.
- **Pieces:** `core-sprite` (single / row / tile, frames per beat, bass bounce, palette swap, outline), `core-sprite-emitter` (closed-form particles born on onsets plus a trickle), `core-text`, `core-swatch` (hex palette from a `text` param). `core-blend` gained mode `over` (alpha-composite; sprites and text render premultiplied on transparent).
- **Fonts:** `.efont` (`lab/api/font.ts`), `font bake`: the code-drawn 5x8 pixel font (bitmap) and MSDF from TrueType (own TTF reader + msdfgen-style edge colouring, with a true-distance fix-up). Shipped: `pixel5x8` (own) and `display-msdf` = Orbitron (OFL-1.1) renamed because Orbitron is a Reserved Font Name; its OFL text is vendored beside it.
- **Lyrics:** `.lrc` next to the track (same name; the file picker accepts it). The loading host sends the lines with `play`; they ride in the file-mode room state; pieces get `ctx.lyric()`. Not hashed. The gallery's demo track has demo lyrics.
- **Style packs:** `lab/styles/<id>.json` (palette, FX chain, post, font, swatch cycle); a scene sets `"style"`. Expanded into plain nodes before compiling (`src/core/graph/style.ts`): the swatch feeds every palette input (replacing the scene's palette edges), FX follow the output, the scene's post keys win, the font applies where a node offers it. Ship: `core-vaporwave`, `core-gameboy`; scenes `claude-sprite-party`, `claude-handheld`. The gate re-renders scenes when their style changes, and pieces when a declared asset changes.
- **`sprite gen`:** refuses unless `EINKLANG_IMAGEGEN=N` (the brief) and a host monthly cap (`~/.einklang/imagegen.json` or `EINKLANG_IMAGEGEN_CONFIG`) allow it; keys from `OPENAI_API_KEY` / `GEMINI_API_KEY`; a ledger (`~/.einklang/imagegen.jsonl`) counts per task and per month. One image with N frames in a row, sliced, background removed, cropped to the union box, downscaled, quantized (palette or 16-colour median cut), vendored with `license: ai-generated`, model and prompt. `--from-png` runs the same pipeline offline. Tested against a fake API only: never called a real one here.
- **Size:** declared assets are inlined, so the engine chunk is ~780 KB now (the MSDF atlas is most of it).

### Build notes for #24 (decided while building)

- **Rotation:** live scenes had no automatic rotation, so (owner's call) `next` (`]`, `>`, R1) and the 👎 skip pick a random other scene weighted 2^score (clamped 1/8..16); `prev` stays in list order. A panel **auto** selector (off, 4, 8, 16 bars) has the server pick by weight on bar boundaries. The protocol keeps `step` ordered and adds `weighted`.
- **Owner:** anyone holding the room token votes; keys on any host, the chord on any pad. Select+△/✕ masks △/✕ FX while Select is held (Select's own blackout still shows).
- **Gallery** posts to `POST /vote` (`GET /scores` for the panel); a static build without the server shows the panel disabled.
- **Tags:** a fixed list in `src/core/votes.ts`; they are counted, they don't change the score. Param correlation is left for later.
- **Retire:** the server drops a scene from the live list the moment it reaches -2 (and brings it back if it climbs). `feedback` writes `status: retired` into the scene file; it never un-retires.

### Build notes for #22 (decided while building)

- **CLI:** `npm run lab -- validate | render <scene|piece> | gate [--all] | new <kind> <vendor-slug> [--driver] | fixtures | feedback | import-space-sim | sprite import | sprite gen | font bake` (`scripts/lab/cli.ts`).
- **Fixtures** are synthetic (`src/core/fixtures.ts`: quiet, techno, dense, plus silence) and generated in code, so no binary files and no audio. A recorded `lab/fixtures/<name>.feat` (4-byte frame count, then the `fileSource` layout) can stand beside them; recording one from an audio file is still open.
- **Render page:** `lab.html` / `src/web/lab.ts`.
  - It renders every tick (so feedback is right) and reads back every 10th for checks.
  - Output: a 12-frame contact sheet, a VP9 webm via WebCodecs + `mediabunny` (devDependency), and `stats.json`. Artifacts go to `lab/out/<id>/<fixture>/` (gitignored).
  - A piece renders in a generated **harness** (`src/core/graph/harness.ts`): image inputs are fed a plasma, palettes a harmony; color pieces paint plasma + bars; signals drive plasma warp and gain. Its cost is measured over a baseline harness without the piece.
- **Browser:** Chrome headless through Vite (`forwardConsole: false`). It falls back to **SwiftShader** (`--use-webgpu-adapter=swiftshader --enable-unsafe-swiftshader`) when there is no GPU, or with `--cpu`. On CPU it renders 640x360, video at 15 fps, and the ms budget isn't enforced. It is about 50x slower: 2 s × 2 fixtures took ~2.5 min here.
- **Checks** (`scripts/lab/checks.ts`, unit-tested):
  - render or shader errors; WGSL errors are reported against the piece's own file and line
  - NaN/Inf in the HDR target
  - black (>80% of frames below luma 0.01)
  - blown out (>50% of frames >90% white)
  - frozen (mean thumbnail change < 0.002)
  - no audio reaction (the same ticks on silence look identical for every fixture)
  - cost over 12 ms per scene or 4 ms per piece

  Black and frozen on `quiet` alone are warnings.
- **Gate:**
  - It gates the pieces and scenes changed against the merge base with main, plus uncommitted and untracked files, and every scene using a changed piece. With nothing changed, or with `--all`, it gates all scenes.
  - Each item renders at 1080p for 8 s per fixture.
  - It writes JUnit (`--junit`) and `lab/out/gate.md`.
  - All 6 scenes take ~2 min on this GPU. Scope only warns on quiet.
- **Lint** (`scripts/lab/lint.ts`): non-core drivers import only `lab/api` and their own folder, and must not use page, network, storage or timer globals. Each piece folder is capped at 2 MB. Core pieces may import `src/core`.
- **Hauptling:**
  - `hauptling.json`: `test` = typecheck + `lab validate` + unit tests with JUnit; `gpu` = `lab gate`; `gateGpu: true`.
  - `hauptling.Dockerfile` adds Chrome stable, Vulkan and fonts. **Not built or tested yet:** this PC's WSL has no Docker or Hauptling. Whether Chrome sees the NVIDIA GPU inside a `--gpus all` container is unproven. Without it the lab falls back to SwiftShader and says the budget wasn't enforced.

### Build notes for #21 (decided while building)

- **The graph is the pipeline.**
  - `src/web/scenes.ts`, `gpu/post.ts` and `gpu/transition.ts` are gone.
  - The v1 scenes are `lab/scenes/{radial,tunnel,scope,flow}.json`. Each is one node of a synced `core-*` driver piece (`src/core/graph/v1.ts` wraps the v1 `SceneDef`). They keep their ids: the `core` vendor may use bare ids.
  - The Engine runs the show graph: scene A/B → `core-transition` (only while one runs) → `core-post` → canvas. Both are ordinary pieces (`lab/pieces/utility/core-transition`, `lab/pieces/effect/core-post`), so a scene can use them too.
- **Per-scene post settings** moved into the scene file (`"post": {decay, bloom, …}`). Pad FX reach every GPU piece as `ctx.pads` and are applied in `core-post`.
- **API additions:**
  - `CpuCtx.raw` (raw feature frames, for sims that replay)
  - `GpuCtx.pads`
  - `GpuInit.budget` (room N / host cap), `GpuInit.compile`, `GpuInit.lib`
  - `GpuInstance.bench | invalidate | status`
  - `lab/api/prims.ts` (`PrimDrawer` display lists, `letterbox`) with `lab/api/prims.wgsl`
- **Hash parity:**
  - The v1 node's hashed `state` is exactly the old v1 state; a unit test compares it with the pinned hashes.
  - The room hash now covers the graph inputs, so its *values* differ from before. e2e: 0 mismatches on every check, all 13 transitions included.
  - Rendered stills match a render of the previous commit, apart from trail-timing noise (scope is pixel-identical).
- **Scene list:** every lab scene now loads on live hosts as well, the room's presets first. Since #24 the server's list is every non-retired lab scene (v1 first), minus those voted to net <= -2.

### Build notes for #20 (decided while building)

- **Code layout:**
  - `lab/api/index.ts` holds the piece API types plus OKLab helpers.
  - `src/core/graph/` holds `types`, `validate` (pieces, scenes, evaluation order) and `eval` (`compile` and `evalCpu`, which covers the CPU half and the hash).
  - `src/web/graph/` holds `registry` (Vite globs), `auto` (auto-shader prelude), `runner` (GPU) and `scene` (the `GpuScene` adapter).
  - `scripts/lab/load.ts` is the node loader for tests and the CLI.
- **Auto-shader pieces:** `"shader": "x.wgsl"` defining `fn shade(uv) -> vec4f`, with no driver.
  - The generated prelude provides `time() aspect() resolution() rms() onset() phase() bar() bpm() band(i) bass() palette(x) oklab_to_linear()`, plus `p_<param>()`, `tex_<input>(uv)` and `prev(uv)` when `"feedback": true`.
  - These pieces have exactly one tex/mask/field output, and their inputs are only tex/mask/field/palette. Signals reach them through param bindings.
- **CPU ports** (signal, trigger, palette, spectrum, wave, camera) come from `cpu()`, a pure function of the tick, audio (`past(ago)` reaches up to 600 ticks back), params and inputs. Modulator and color pieces are CPU only.
- **Bindings** map 0..1 onto `range` (default: the param's min..max) and are clamped to min..max. Int params are rounded.
- **Hash:** scene id hash, version, tick, feature keys 0..28, every resolved param (numbers × 4096 rounded, bools, string hashes), plus `state` from `synced` pieces. It is evaluated at sub = 0; drawing uses sub.
- **Textures:**
  - A pool reuses textures once their last reader has run.
  - Feedback pieces keep their own ping-pong pair.
  - The output port is copied into the scene's HDR target, which is why the post targets gained `COPY_DST`.
  - An unconnected optional image input reads 1×1 black.
  - An unconnected palette is an OKLCh rainbow that follows the pads' palette step.
- **Where lab scenes show:** only in the gallery for now (`new Engine(gpu, cv, { lab: true })`, `?scene=core-demo`). The live list waits for #21 and #24.
- **Starter pieces (vendor `core`):** audio, lfo, follow, harmony, plasma, bars, kaleido, trails, pixelate, blend. Scenes: `core-demo`, `core-retro`.

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
- **Retro / aesthetic** (pieces and ready-made scene packs):
  - **Vaporwave:** slatted sunset sun, neon grid floor, marble bust (.vox/.glb), palm silhouettes, pink/cyan palettes, Win95 windows, kanji overlays, slowed "chopped" time-stretch.
  - **Synthwave / outrun:** chrome text, wireframe mountains, scrolling road, starfield.
  - **VHS:** tracking lines, head-switch noise, tape wrinkle, chroma delay, REC/PLAY OSD with timestamp, pause jitter, rewind scrub, dropouts.
  - **8/16-bit and demoscene:** Mode 7 floor, parallax layers, CGA/EGA/NES/C64 palettes, raster and copper bars, plasma, rotozoom, twister, sine scroller, dot balls, fire.
  - **Other looks:** Y2K / Frutiger Aero (bubbles, glossy blobs, chrome); vector phosphor (Vectrex/arcade beam); PS1 (affine texture wobble, vertex snap, low-res dither, fog); Winamp/Milkdrop-style feedback presets.
- **Text:** bitmap fonts (pixel, C64, DOS), SDF/MSDF fonts, timed lyrics (an `.lrc` file next to the track), BPM/title OSD, kinetic typography (per-letter on onset), marquee and sine scroller, matrix rain, ASCII-art renderer, text as particles, text masks, glitch text, typewriter, MIDI note names. A new `text` param type holds strings.
- **Sprites:**
  - **Import:** PNG sheets with Aseprite JSON, GIF, `.vox` slices.
  - **Sprite node:** an atlas, with frame animation timed to the beat.
  - **Uses:** sprite emitter (sprites as particles), sprite crowd/flock, stamp/tiling, palette-swap shader, outline/drop shadow, pixel-perfect scaling, a dancing sprite rig (beat-timed frames).
- **AI-generated sprites, from two sources:**
  - **Code-drawn (default):** agents write pixel art as code or data, like the space_sim voxel recipes + `sheet.png`. No cost, and it is reproducible.
  - **Image API, opt-in per task:** a brief flag `imagegen: N` caps the images for that task, and a monthly cap lives in host config. `einklang-lab sprite gen "<prompt>" --size 64 --frames 8 --palette <id>` calls an image model (Gemini image or OpenAI gpt-image). The key stays in host config, and the endpoint is on the Hauptling egress allowlist. The tool then downscales, quantizes to the palette, removes the background and packs the sheet. The PNG is vendored with `license: "ai-generated"`, the model name and the prompt.
- **Generative tools** (agent-side `einklang-lab` subcommands that emit assets or data rather than nodes): palette generator, tileset / WFC generator, voxel recipe builder (space_sim recipe style), noise/texture baker, L-system/grammar compiler, SDF scene composer, font/ASCII baker, LUT maker, MIDI pattern → visual score, sprite-sheet packer, **style-pack** bundler (palette + FX chain + fonts as a reusable look that a scene can reference).

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
5. **#26 Sprites + text + style packs:** sprite and atlas import (PNG/Aseprite/GIF), sprite node and emitter, the font baker (bitmap + MSDF), the `text` param type, `.lrc` lyrics, `sprite gen` (image API behind `imagegen: N` and the monthly cap), and style packs.
6. **#24 Voting:** gallery buttons and tags, keys and pad chord, server log, toast, live-skip on 👎, rotation weights, retire rule, `feedback` digest.
7. **#25 Agents:** `lab/AGENTS.md`, `lab/BACKLOG.md` seeded from the catalog, the delegator `lab` skill, and a first batch (one generator, one color piece, one effect and one scene per vendor).

## Open

- The exact reason-tag list, and whether tags weight the score.
- How the digest picks up "correlation with likes": first cut is per-piece and per-tag counts, with param correlation later.
- SwiftShader WebGPU speed in a 3-CPU container. If it is too slow, fall back to fewer frames or lower resolution.
