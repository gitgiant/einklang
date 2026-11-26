# PRD: Scene transitions

Status: agreed 2026-11-26, **built 2026-11-26**. Ticket: #19. Stills: `docs/mockups/transitions.jpg` (`npm run mockups`, `ONLY=trans-iris,...`).

### Build notes (decided while building)

- `TransSched` also carries `tpb` (the beat length when scheduled), so the beat-stepped effects (stutter, glitch re-rolls) don't drift on a tempo change, like `ticks`.
- The queue lives in the state: `scene.earlier` lists the switches still pending or running when the latest one was queued (at most 8). A pending *cut* is still replaced, as before.
- Pause and resume keep the schedule (tick space is the track position), so a transition freezes. Seek, play, live and stop reset it. A switch requested while paused is a cut on the frozen tick.
- A request without `trans` (old clients, tests) is a cut.

### Status (2026-11-26)

- **Shipped** in `99e7d43`. All 13 effects plus cut, random, panel selectors, pads and keys, gallery auto-cycle and stills.
- **Verified:** unit tests (scheduling, queueing, random, curves, stutter grid, audio mask, pause/seek) and e2e: two hosts run every effect, 0 hash mismatches over ~3100 shared ticks.
- **Since then:** #12 made transition progress follow the sub-tick between ticks on fast displays. Only drawing uses it; the hash still uses whole ticks.
- **Known:** on a narrow window the panel wraps onto another row, and the hosts popup can cover it. Not tuned on a real show yet: effect look, flash strength, glitch band count, melt drip.

## Problem

Scene switches are hard cuts. The server already quantizes them to the beat or bar, but at that boundary one scene vanishes and the next appears. For live visuals the switch is a performance moment. It needs a set of transitions that are synced across every host, follow the tempo, and work from the panel, the keyboard and the pads.

## Goals

- 14 transition effects, chosen per switch, the same frame on every host and for late joiners.
- Length in beats, following the room's tempo (MIDI clock, tap tempo, or the fixed grid).
- No new controls beyond two panel selectors. The pads and keys use the panel's current selection.
- A gallery mode to audition effects without a server.

## Non-goals

- Finishing a transition *on* the downbeat (starting early). Possible later as an option.
- Progress driven by onsets for every effect. Only the audio mask uses onsets.
- Per-scene-pair default transitions.
- Pad buttons dedicated to transitions.

## Behaviour

### Scheduling

- A scene request carries `trans: { type, beats }` (type: an effect id or `random`).
- The server schedules the switch as before: it starts at the next beat or bar boundary (the "on" setting), at least `INPUT_DELAY` ahead.
- The schedule becomes `{ id, prev, at, trans: { type, ticks, seed } }`:
  - `ticks = round(beats * grid.tpb)`, fixed when scheduled, so a tempo change mid-transition doesn't warp it.
  - `seed` is a server-chosen u32.
  - The server resolves `random` to a concrete type: uniform over every effect except `cut`, never the type it used last.
- The transition runs over ticks `[at, at + ticks)`. Before `at` the screen shows `prev`; from `at + ticks` on it shows `id`.
- **Overlap:** a request that arrives while a transition is pending or running is scheduled for the first boundary at or after `at + ticks`. Stepping (`]` pressed several times) keeps working: each step counts from the most recently scheduled scene.
- `cut` (or 0 beats) behaves exactly like today.
- A pause during a transition freezes it like everything else (scene time is frozen). A new timeline (play, seek, live, stop) resets the schedule to the current scene, as today.

### Rendering

- While a transition runs, the Engine evaluates both scenes' states at the current tick ("both live") and renders each into its own HDR target. The flow scene keeps its sim stepping in both roles.
- A **transition pass** mixes the two HDR targets into the scene target, before the post chain. One post chain runs. Its settings (decay, zoom, rotate, bloom, threshold, exposure) interpolate from `prev`'s to `id`'s by the transition's progress.
- The pad FX, views and freeze apply on top, unchanged.
- **Cost:** double scene rendering for the length of the transition.

### Progress curves (per effect)

Progress `p` goes from 0 to 1 over the length. Each effect declares its own curve:

| Effect | What it does | Curve |
|---|---|---|
| cut | instant switch | step at `at` |
| blend | linear crossfade in HDR | smoothstep |
| flash | additive blend plus a white flash | fast in, slow out, flash peaks at p = 0.25 |
| wipe | soft-edged line sweep; direction from the seed | smoothstep |
| iris | a circle opens from the centre | smoothstep |
| dissolve | noise-threshold pixel dissolve; grain from the seed | smoothstep |
| luma | the new scene appears through the old one's brightest areas first | smoothstep |
| zoom | the old scene zooms in and fades; the new one zooms out from small | ease-in-out cubic |
| glitch | horizontal band swap + RGB split; bands from the seed | smoothstep; bands re-rolled every 1/16 beat |
| stutter | hard cuts back and forth, settling on the new scene | stepped on 1/8 beats; the new scene's share of each step grows |
| swirl | twist distortion peaking at the midpoint | ease-in-out cubic |
| melt | trails pushed to near 1.0 so the old scene smears into the new | smoothstep |
| audio mask | the new scene shows where bass/spectrum energy is | smoothstep floor, pushed ahead by onsets; finishes on time at the latest |
| pixelate | both scenes go blocky, swap at the coarsest point, then sharpen | smoothstep |

- Curves are functions of `(tick - at, ticks, grid, features)`, so every host computes them identically.
- The audio mask reads the feature source at each tick it covers, the same way scenes do.

### Effect settings

- **Seed:** wipe direction, dissolve grain and glitch band layout come from the server seed.
- **Centre:** iris, zoom and swirl centre on the active pad's effect centre (`Fx.cx/cy`) when a pad is in use, otherwise the screen centre.

### Controls

- The panel gets two selectors next to **on**: **transition** (14 effects + random) and **length** (cut, ½, 1, 2, 4, 8, 16 beats; default 4). Both are remembered per device.
- Every way of switching sends them: the picker, `<` `>`, `[` `]`, pad L1/R1.

### Gallery

- An auto-cycle mode switches scenes every 2 bars using the selected effect, or rotates through all of them.
- A `t` key and a selector pick the effect. URL params let the mockup script render transition stills, e.g. `trans=iris&at=<s>`.

### Debug and verification

- During a transition, the sync hash covers both scene states plus `(type, ticks, seed, progress)`.
- The debug panel's room section shows the running or pending transition.
- Unit tests:
  - scheduling: boundary start, ticks frozen at schedule time, overlap queueing, random never `cut` and never a repeat, seed present;
  - curves: monotonic where expected, exact endpoints, stutter steps on the grid, the audio mask finishing on time;
  - existing pinned hashes unchanged when no transition is running.
- e2e: two hosts run one transition of each effect, with zero hash mismatches.

## Touch points

- `src/core/protocol.ts`: `SceneSched.trans`, the scene request's `trans`, the effect id list.
- `src/server/room.ts`: `requestScene` (ticks, seed, random, overlap queue).
- `src/core/transitions.ts` (new): effect table, curves, `transitionAt(sched, tick, grid, F)` returning `{ type, p, seed, from, to }`, and the hash mix.
- `src/web/engine.ts`: second scene target, both-scene render, post settings interpolation.
- `src/web/gpu/transition.wgsl` (new) plus a pass in `post.ts` or its own module: one fragment shader that switches on the effect.
- `src/web/main.ts`, `index.html`: the selectors and sending them; the debug section.
- `src/web/gallery.ts`, `scripts/mockups.ts`: auto-cycle mode, stills.

## Open questions

None. Decided in the 2026-11-26 grilling session.
