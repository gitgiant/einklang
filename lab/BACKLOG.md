# Lab backlog

What agents build next. The delegator's `lab` skill reads this and `lab/FEEDBACK.md` before each round. Contract: `lab/AGENTS.md`.

- **Pinned briefs** come first. The owner adds them; the delegator takes them before catalog items.
- **Catalog** items are open until ticked. When you build one, tick it and name what you made: `- [x] Voronoi → codex-voronoi, scene codex-cells`. An item may get several takes from different vendors: tick it on the first, append later ids.
- Ids in a line are hints, not reservations.

## Pinned briefs

(none yet: the owner writes `- [ ] <brief>` here)

## Catalog

### Generators
- [x] Osc scope / Lissajous → core-scope
- [ ] Visual input (webcam, screen, video)
- [x] Particle sim → core-flow (flow-field particles)
- [ ] Physics: rigid bodies
- [x] Physics: cloth → claude-cloth, scene claude-banner
- [ ] Physics: soft body
- [x] Voxel shapes / .vox assets → claude-vox-ship, scene claude-vox-fleet
- [ ] 3D assets (glTF)
- [x] Strange attractors → agy-attractor, scene agy-attractor-bloom
- [x] Reaction-diffusion → claude-reaction, scene claude-coral
- [x] Physarum → claude-physarum, scene claude-slime
- [x] Smoke / fluid → claude-fluid, scene claude-smoke-signals
- [x] Boids → claude-boids, scene claude-murmuration
- [x] N-body → claude-nbody, scene claude-galaxy
- [ ] SPH liquid
- [x] SDF raymarch → claude-raymarch, scene claude-sdf-flight
- [x] Fractals (mandelbox, julia) → claude-julia, scene claude-julia-dive
- [x] L-systems / trees → claude-lsystem, scene claude-grove
- [x] Cellular automata (Life + Lenia) → claude-life, scene claude-lenia
- [x] Spectrum terrain / ridgeline → agy-ridgeline, scene agy-unknown-ridges
- [ ] Voronoi
- [ ] Noise fields
- [x] Text / lyrics → core-text
- [ ] MIDI piano-roll
- [x] Lasers / lightning → agy-lightning, scene agy-storm
- [ ] Shape grammar
- [x] Metaballs → claude-metaballs, scene claude-lava
- [ ] String / wave sim
- [x] Radial spectrum → core-radial
- [x] Tunnel / warp → core-tunnel
- [x] Plasma → core-plasma
- [x] Spectrum bars → core-bars

### Color
- [x] Palette picker (agent chooses stops) → core-swatch
- [x] Color-theory harmonies → core-harmony
- [ ] Image → palette extraction
- [ ] Mood / genre presets
- [ ] Key → hue (circle of fifths)
- [ ] OKLab gradients
- [x] Palette cycling on the beat → claude-cycle, scene claude-cycle-plasma
- [ ] Per-pad color
- [ ] Contrast guard (APCA)
- [x] Blackbody / temperature → agy-blackbody, scene agy-forge
- [ ] LUT grading
- [ ] Duotone / tritone mapping
- [ ] Palettes learned from votes

### Effects: core
- [x] Kaleido → core-kaleido
- [ ] Mirror / tile
- [x] Feedback / trails → core-trails
- [x] Bloom → core-post
- [ ] Chromatic aberration
- [x] Glitch / datamosh → agy-glitch, scene agy-corrupt
- [x] CRT / VHS → claude-crt, scene claude-late-show
- [x] ASCII / dither (Bayer, error diffusion) → agy-ascii, scene agy-terminal
- [x] Halftone → agy-halftone, scene agy-print-run
- [ ] Edge / toon
- [ ] Displacement by field
- [ ] Polar warp
- [ ] Slit-scan
- [ ] Echo / time delay
- [ ] Film grain
- [ ] DOF
- [ ] God rays
- [ ] Lens flare
- [ ] Posterize
- [ ] Scanlines
- [x] Pixelate → core-pixelate
- [ ] Voxelize

### Effects: spatial / warp
- [ ] Fisheye / barrel
- [ ] Twirl
- [ ] Onset ripple
- [ ] Heat haze
- [ ] Liquify by field
- [ ] Droste / recursive zoom
- [ ] Hyperbolic (Poincaré) tiling
- [ ] Tri / hex mosaic
- [ ] Sphere / cylinder wrap
- [ ] Page curl
- [ ] Voronoi shatter
- [x] Pixel sort → agy-pixelsort, scene agy-smear
- [ ] Mesh-grid displace
- [ ] Sine warp

### Effects: time / feedback
- [ ] Motion blur
- [ ] Temporal echo stack
- [x] Zoom feedback (Milkdrop-style) → claude-zoomfeed, scene claude-vortex
- [ ] Rotate feedback
- [ ] Freeze-frame stutter on the beat
- [ ] Reverse buffer scrub
- [ ] Onion skin
- [ ] Time-displacement map
- [ ] Datamosh P-frame smear

### Effects: color / tone
- [ ] Hue rotate on the beat
- [ ] Gradient map
- [ ] Thermal / false color
- [ ] Solarize
- [ ] Levels / curves
- [ ] Tonemap (ACES, AgX)
- [ ] Bleach bypass
- [ ] Split tone
- [ ] Selective color pop
- [ ] Invert by mask
- [ ] Chroma key
- [ ] Quantize to palette

### Effects: optics / light
- [ ] Anamorphic streaks
- [ ] Light leaks
- [ ] Vignette
- [ ] Lens dirt
- [ ] Prism split
- [ ] Caustics
- [ ] Volumetric shafts
- [ ] Halation
- [ ] Star filter
- [ ] Glare

### Effects: stylize
- [ ] Kuwahara oil
- [ ] Watercolor
- [ ] Hatching
- [ ] Stained glass
- [ ] Mosaic
- [ ] LEGO / brick
- [ ] Pointillism
- [ ] Woodcut
- [ ] Neon edge glow
- [ ] Emboss
- [ ] Thermal print
- [ ] Risograph
- [x] Game Boy 4-color → style core-gameboy
- [ ] 1-bit Mac
- [ ] Teletext / PETSCII
- [ ] LED matrix
- [ ] Cross-stitch

### Effects: voxel / 3D-ish
- [ ] Voxel extrude (luma → height)
- [ ] Isometric cubes
- [ ] Depth-from-luma parallax
- [ ] 2.5D layer split
- [ ] SSAO
- [ ] Depth fog
- [ ] Tilt-shift

### Effects: glitch / signal
- [ ] RGB shift per band
- [ ] Scanline jitter
- [ ] Block displacement
- [ ] Bit crush
- [ ] JPEG artifacts
- [ ] VSync roll / tearing
- [ ] Interlace
- [ ] NTSC bleed
- [ ] Broken LCD
- [ ] Dead pixels

### Effects: analysis-driven
- [ ] Optical-flow trails
- [ ] Edge → particles emitter
- [ ] Luma → field
- [ ] Motion-masked FX
- [ ] Band-masked FX (each band drives a region)

### Modulators
- [x] Band follower → core-follow
- [ ] Envelope / ADSR
- [x] LFO → core-lfo
- [ ] Beat-synced step sequencer
- [ ] Random walk
- [ ] MIDI CC / note
- [ ] Pad axis
- [ ] Slew
- [ ] Math (map, clamp, mix)

### Composite / utility
- [x] Blend (add, screen, multiply, difference, over) → core-blend
- [ ] Mask ops
- [x] Crossfade → core-transition
- [ ] Transform
- [ ] Camera rigs (orbit, dolly, shake)
- [ ] Particles → tex splat
- [ ] Geo → tex render
- [ ] Field ops

### Transitions
How the show switches scenes: one folder each in `lab/transitions/<vendor>-<slug>/` (contract: "Transitions" in `lab/AGENTS.md`). Core ones: cut, blend, flash, wipe, iris, dissolve, luma, zoom, glitch, stutter, swirl, melt, audio mask, pixelate.
- [x] Page turn (curl from a corner, the back shaded) → claude-page-turn
- [x] Cube rotate (A and B as two faces) → claude-cube
- [ ] Ripple (rings from the centre carry B in)
- [x] Ink bleed (B spreads like ink in water, noisy edge) → agy-ink
- [x] Shatter (A breaks into seeded shards that fall away) → claude-shatter
- [ ] Slide / push (B pushes A off in a seeded direction)
- [x] Barn doors (A splits and opens) → claude-barn-doors
- [ ] Venetian blinds (slats rotate from A to B)
- [ ] Checker flip (cells flip in a seeded order)
- [ ] Radial clock wipe
- [ ] Heart / shape iris (SDF shapes: heart, star, diamond)
- [x] Film burn (hot spot burns through A, orange edge) → agy-film-burn
- [ ] VHS rewind (tracking lines, wobble, colour bleed)
- [ ] Chromatic split (RGB pull apart and back together on B)
- [ ] Mosaic tiles (tiles turn over one by one)
- [ ] Kaleido spin (both folded into a spinning kaleidoscope at the midpoint)
- [ ] Warp tunnel (A sucked into the centre, B rushes out)
- [x] Beat-strobe cuts (`beat-steps` curve: A/B alternate on the beat, B's share growing) → codex-strobe
- [x] Spectrum bars wipe (B rises as bars of the live spectrum) → codex-spectrum-wipe
- [x] Bass punch zoom (zoom kicks on onsets: `onset` curve) → codex-bass-punch
- [x] Scanline roll (B rolls in like a CRT losing vertical hold) → codex-scanline-roll
- [x] Smoke dissolve (domain-warped noise threshold) → agy-smoke
- [x] Liquid morph (A warps along a flow field into B) → agy-liquid
- [ ] Polar wipe (angle sweep around the centre)
- [ ] Spiral (a spiral arm sweeps B in)

### Retro / aesthetic
- [ ] Vaporwave: slatted sunset sun
- [x] Vaporwave: neon grid floor → codex-grid-floor, codex-outrun
- [ ] Vaporwave: marble bust
- [ ] Vaporwave: palm silhouettes
- [x] Vaporwave: pink/cyan palettes → style core-vaporwave
- [ ] Vaporwave: Win95 windows
- [ ] Vaporwave: kanji overlays
- [ ] Synthwave: chrome text
- [x] Synthwave: wireframe mountains → codex-wire-mountains, codex-night-drive
- [ ] Synthwave: scrolling road
- [x] Synthwave: starfield → codex-starfield, codex-hyperspace
- [ ] VHS: tracking lines, head-switch noise
- [ ] VHS: tape wrinkle, chroma delay
- [ ] VHS: REC/PLAY OSD with timestamp
- [ ] VHS: pause jitter, rewind scrub, dropouts
- [ ] Demoscene: Mode 7 floor
- [ ] Demoscene: parallax layers
- [ ] Demoscene: CGA/EGA/NES/C64 palettes
- [x] Demoscene: raster and copper bars → claude-copper, scene claude-copper-sky
- [x] Demoscene: rotozoom → claude-rotozoom, scene claude-rotozoom-party
- [ ] Demoscene: twister
- [ ] Demoscene: sine scroller
- [ ] Demoscene: dot balls
- [x] Demoscene: fire → claude-fire, scene claude-inferno
- [ ] Y2K / Frutiger Aero (bubbles, glossy blobs, chrome)
- [ ] Vector phosphor (Vectrex / arcade beam)
- [ ] PS1 (affine wobble, vertex snap, low-res dither, fog)
- [ ] Winamp / Milkdrop-style feedback presets

### Text
- [x] Bitmap fonts → pixel5x8
- [x] SDF / MSDF fonts → display-msdf
- [x] Timed lyrics (.lrc) → core-text
- [ ] C64 / DOS bitmap fonts
- [ ] BPM / title OSD
- [ ] Kinetic typography (per letter on onset)
- [ ] Marquee and sine scroller
- [x] Matrix rain → agy-matrix, scene agy-rain-code
- [ ] ASCII-art renderer
- [ ] Text as particles
- [ ] Text masks
- [ ] Glitch text
- [ ] Typewriter
- [ ] MIDI note names

### Sprites
- [x] Sprite node, beat-timed frames → core-sprite
- [x] Sprite emitter → core-sprite-emitter
- [x] Palette swap, outline → core-sprite
- [x] Dancing sprite rig → core-sprite (dancer.spr)
- [ ] Sprite crowd / flock
- [ ] Stamp / tiling
- [ ] Drop shadow
- [ ] Pixel-perfect scaling

### Generative tools (`einklang-lab` subcommands; brief needed, they touch `scripts/`)
- [ ] Palette generator
- [ ] Tileset / WFC generator
- [ ] Voxel recipe builder (space_sim recipe style)
- [ ] Noise / texture baker
- [ ] L-system / grammar compiler
- [ ] SDF scene composer
- [x] Font / ASCII baker → `font bake`
- [ ] LUT maker
- [ ] MIDI pattern → visual score
- [x] Sprite-sheet packer → `sprite import`
- [x] Style-pack bundler → `lab/styles/`
