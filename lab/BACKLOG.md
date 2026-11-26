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
- [ ] Physics: cloth
- [ ] Physics: soft body
- [x] Voxel shapes / .vox assets → claude-vox-ship, scene claude-vox-fleet
- [ ] 3D assets (glTF)
- [ ] Strange attractors
- [x] Reaction-diffusion → claude-reaction, scene claude-coral
- [ ] Physarum
- [ ] Smoke / fluid
- [ ] Boids
- [ ] N-body
- [ ] SPH liquid
- [x] SDF raymarch → claude-raymarch, scene claude-sdf-flight
- [ ] Fractals (mandelbox, julia)
- [ ] L-systems / trees
- [ ] Cellular automata
- [ ] Spectrum terrain / ridgeline
- [ ] Voronoi
- [ ] Noise fields
- [x] Text / lyrics → core-text
- [ ] MIDI piano-roll
- [ ] Lasers / lightning
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
- [ ] Blackbody / temperature
- [ ] LUT grading
- [ ] Duotone / tritone mapping
- [ ] Palettes learned from votes

### Effects: core
- [x] Kaleido → core-kaleido
- [ ] Mirror / tile
- [x] Feedback / trails → core-trails
- [x] Bloom → core-post
- [ ] Chromatic aberration
- [ ] Glitch / datamosh
- [x] CRT / VHS → claude-crt, scene claude-late-show
- [ ] ASCII / dither (Bayer, error diffusion)
- [ ] Halftone
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
- [ ] Pixel sort
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

### Retro / aesthetic
- [ ] Vaporwave: slatted sunset sun
- [ ] Vaporwave: neon grid floor
- [ ] Vaporwave: marble bust
- [ ] Vaporwave: palm silhouettes
- [x] Vaporwave: pink/cyan palettes → style core-vaporwave
- [ ] Vaporwave: Win95 windows
- [ ] Vaporwave: kanji overlays
- [ ] Synthwave: chrome text
- [ ] Synthwave: wireframe mountains
- [ ] Synthwave: scrolling road
- [ ] Synthwave: starfield
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
- [ ] Matrix rain
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
