# Lab agent contract

You are building visuals for Einklang, a music visualizer that runs on WebGPU (no WebGL). You write **pieces** (graph nodes: a manifest, WGSL and maybe a TS driver) and **scenes** (JSON graphs of pieces). The owner votes on scenes live and in the gallery, and the votes decide what stays. Full design: `docs/prd-lab.md`.

Before you pick or shape anything, read `lab/FEEDBACK.md` (what the owner likes and dislikes) and your brief.

## Layout

| Path | What |
|---|---|
| `lab/pieces/<kind>/<id>/` | one piece: `piece.json`, `*.wgsl`, optional `driver.ts`, optional small assets |
| `lab/scenes/<id>.json` | one scene graph |
| `lab/styles/<id>.json` | style packs (palette + FX chain + post + font) a scene can name with `"style"` |
| `lab/api/` | **the only module a piece may import** (`index.ts`: types, `definePiece`, OKLab helpers, `.vox`/sprite/font parsers; `prims.wgsl`) |
| `lab/assets/` | shared assets, each listed in `index.json` with its license |
| `lab/BACKLOG.md` | what to build: pinned briefs and the catalog |
| `lab/FEEDBACK.md` | vote digest (generated; don't edit) |
| `lab/out/` | render artifacts (gitignored) |

Kinds: `generator`, `color`, `effect`, `modulator`, `utility`.

## IDs and authorship

- Piece and scene ids are `<vendor>-<slug>`: lowercase, hyphenated. Vendor is `claude`, `codex` or `agy`. `core-*` belongs to the engine.
- `author: { "vendor": "<vendor>", "model": "<your exact model id>" }` on every piece and scene you create.
- Editing an existing piece in place is allowed (every scene using it picks up the change). Add a `changelog` entry `{ "date": "YYYY-MM-DD", "by": "<vendor>/<model>", "note": "what changed" }`, and keep its params backwards compatible: scenes set them by name.
- A remix is a new scene with `"parent": "<scene id>"`. Never edit another vendor's scene; remix it.
- Don't touch `core-*` pieces, `src/`, `scripts/` or tests unless your brief says so.

## Ports

An edge joins two ports of the same type. Conversions are explicit utility nodes.

| Port | Payload |
|---|---|
| `tex` | HDR image, rgba16f, target resolution |
| `mask` | r16f |
| `field` | 2D vectors, rg16f |
| `particles` | storage buffer, 48 B each: pos.xy vel.xy color.rgba age size |
| `geo` | 3D content drawn through a `camera` (`Geo.encode`) |
| `camera` | view, proj, pos |
| `palette` | up to 8 OKLab stops |
| `signal` | a number per tick (0..1 by convention) |
| `trigger` | event count this tick |
| `spectrum` | 16 log bands |
| `wave` | decimated L/R waveform |

`camera`, `palette`, `signal`, `trigger`, `spectrum` and `wave` are CPU values (from a driver's `cpu()`); the rest are GPU resources.

## `piece.json`

```json
{
  "id": "codex-ripple", "kind": "effect", "name": "Onset ripple",
  "doc": "One sentence: what it shows and what drives it.",
  "ports": { "in": { "in": { "type": "tex" }, "palette": { "type": "palette", "optional": true } },
             "out": { "out": { "type": "tex" } } },
  "params": {
    "amount": { "type": "float", "default": 0.5, "min": 0, "max": 1, "doc": "..." },
    "mode":   { "type": "enum", "default": 0, "options": ["soft", "hard"] }
  },
  "shader": "main.wgsl",
  "budget": { "ms": 0.4, "scales": "res" },
  "tags": ["warp", "glitch"],
  "author": { "vendor": "codex", "model": "..." }
}
```

- Param types: `float`, `int`, `bool`, `enum` (value = index), `color` (`#rrggbb`), `text` (string, driver-only).
- `budget.ms` is your honest cost at 1080p; `scales` is `res`, `n` (particle count) or `none`.
- `feedback: true` (auto-shader only) binds this node's previous output as `prev(uv)`: trails, feedback zooms.
- `synced: true` only for integer, deterministic state returned from `cpu()` as `state`. New pieces normally leave it off: floats and GPU state are fine, only the graph inputs are hashed.
- `assets: [{ "path", "license", "source" }]`: `assets/...` is shared `lab/assets/` (license must match its `index.json`), anything else is in your folder. 2 MB cap per piece, folder included. Procedural first.

## The auto-shader path (most pieces)

Set `"shader": "main.wgsl"` and write one function. The runtime generates the uniforms, the pipeline and this prelude:

```wgsl
fn shade(uv: vec2f) -> vec4f   // you write this; uv (0,0) = top-left; return linear HDR rgb, a = 1

fn p_<param>() -> f32          // every non-text param (color params: -> vec3f)
fn tex_<port>(uv) -> vec4f     // every tex / mask / field input, sampled
fn prev(uv) -> vec4f           // last frame of this node (with "feedback": true)
fn palette(x: f32) -> vec3f    // the palette input (or a default), x 0..1 clamped, OKLab-interpolated
fn aspect() -> f32   fn resolution() -> vec2f   fn time() -> f32   // seconds
fn rms() -> f32   fn onset() -> f32   fn bass() -> f32   fn band(i: i32) -> f32   // 16 bands, 0..1
fn phase() -> f32   fn bar() -> f32   fn bpm() -> f32                             // beat phase 0..1, beat in bar 0..3
fn oklab_to_linear(c: vec3f) -> vec3f
```

`lab/api/prims.wgsl` has SDF and noise helpers (`init.lib('prims.wgsl')` from a driver). `npm run lab -- new <kind> <id>` scaffolds a working starting point.

## Drivers (`driver.ts`)

For CPU outputs (palettes, signals), compute passes, particles, geometry or several passes. Look at `lab/pieces/color/core-harmony/driver.ts` (CPU) and `lab/pieces/generator/claude-vox-ship/` (GPU).

```ts
import { definePiece, oklch } from '../../../api/index.ts';
export default definePiece({
  cpu(ctx) { return { palette: { stops: [...] } }; },     // pure function of (tick, audio, params, inputs)
  gpu(init) { /* build pipelines with init.shader('x.wgsl') */ return { frame(ctx) { /* encode into ctx.out.out */ } }; },
});
```

- `cpu(ctx)` is called every tick and must be **pure**: no state between calls. Use `ctx.time` for closed-form motion, `ctx.past(ago)` for history (up to 600 ticks), `ctx.rand(a, b)` for seeded noise.
- `gpu(init)` returns an instance; GPU-side state (sims, buffers) is fine there.
- Banned (lint fails): imports from anywhere but `lab/api` and your own folder; `document`, `window`, `fetch`, `localStorage`, `setTimeout`, `setInterval`, `navigator`, `eval` and friends.

## Scenes (`lab/scenes/<id>.json`)

```json
{
  "format": 1, "id": "agy-neon-rain", "name": "Neon rain", "version": 1,
  "author": { "vendor": "agy", "model": "..." }, "status": "live", "created": "YYYY-MM-DD",
  "nodes": [
    { "id": "bass", "piece": "core-follow", "params": { "lo": 0, "hi": 2, "gain": 1.4 } },
    { "id": "pal",  "piece": "core-harmony", "params": { "scheme": 4 } },
    { "id": "gen",  "piece": "agy-rain", "bind": { "speed": { "from": "bass.out", "range": [0.2, 2] } } },
    { "id": "fx",   "piece": "core-trails", "params": { "decay": 0.8 } }
  ],
  "edges": [ { "from": "pal.palette", "to": "gen.palette" }, { "from": "gen.out", "to": "fx.in" } ],
  "out": "fx.out",
  "post": { "bloom": 0.5, "threshold": 0.75 }
}
```

- `bind` drives any numeric param from a `signal` (`core-follow.out` band follower, `core-lfo.out`, `core-audio.bass|mid|high|rms|phase`, or your own modulator); the signal's 0..1 maps onto `range` (default the param's min..max).
- `post` keys: `decay`, `zoom`, `rotate`, `bloom`, `threshold`, `exposure`. Optional `"style": "<style id>"`.
- Bump `version` whenever you edit a scene.
- Every non-retired scene goes into the live rotation as soon as it merges. Make it look good on its own for minutes, react visibly to the music, and stay readable on quiet tracks too.

## Check your work

```sh
npm run lab -- validate                          # schema, ports, lint, imports, sizes (fast, no browser)
npm run lab -- render <scene|piece> --fixture all  # contact sheet + webm + stats in lab/out/<id>/<fixture>/
npm run typecheck
```

- Look at the contact sheet PNGs (`lab/out/<id>/<fixture>/sheet.png`) and fix what looks wrong. That is your only way to see your work.
- A bare piece renders in a harness: image inputs get a plasma, palettes a harmony.
- Without a GPU the render falls back to SwiftShader (CPU, slow; budgets aren't enforced). Keep `--seconds` low there.
- **The gate** (`npm run lab -- gate`, run on the GPU via `hauptling test request --gpu`) renders every changed piece and scene 8 s at 1080p against the quiet, techno and dense fixtures and fails on: errors, NaN, all-black or blown-out frames, frozen output, no reaction to the audio, more than **4 ms per piece** or **12 ms per scene**.

## Done means

1. Your pieces and scenes exist with correct ids, authors and docs.
2. `validate` and `typecheck` pass, and the gate passes on the GPU.
3. You looked at the contact sheets and they show what the doc says.
4. You ticked your item in `lab/BACKLOG.md` (`- [x] ... → <your ids>`).
5. Your report names the pieces and scenes, their measured ms, and anything you are unsure about.
