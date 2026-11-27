import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// L-system trees. The grammar is rewritten on the CPU (cached per grammar and depth), then a turtle walks the
// string every frame: a pure function of the tick, the audio history and the params (no state between frames).
//   phrase (`bars` bars): a new tree each phrase; its depth comes from how full the spectrum was just before
//     the phrase started, its jitter from the phrase index. The old tree fades and drops its blossoms.
//   growth: segments appear by their distance from the root (all branches at once), driven by time and by the
//     loudness summed since the phrase started, so loud music grows a full tree and silence about half of one.
//   branching angle: the spectral centroid of the last ~1/3 beat (pitch content) opens and closes the branches,
//     a kick flexes them; bass sways the whole tree.
//   beats: each onset sends a glow up the tree from the root and flashes the blossoms at the tips.
// Drawn as instanced tapered capsules and five-petal blossoms, max-blended over a sky gradient.

const GRAMMARS: { axiom: string; rules: Record<string, string>; angle: number; depth: [number, number] }[] = [
  { axiom: 'X', rules: { X: 'F+[[X]-X]-F[-FX]+X', F: 'FF' }, angle: 25, depth: [3, 5] }, // plant
  { axiom: 'F', rules: { F: 'FF+[+F-F-F]-[-F+F+F]' }, angle: 22.5, depth: [2, 3] }, // bush
  { axiom: 'X', rules: { X: 'F[+X][-X]FX', F: 'FF' }, angle: 25.7, depth: [4, 6] }, // tree
  { axiom: 'X', rules: { X: 'F[+X]F[-X]+X', F: 'FF' }, angle: 20, depth: [4, 6] }, // sticks
  { axiom: 'F', rules: { F: 'F[+F]F[-F][F]' }, angle: 20, depth: [2, 4] }, // fan
];
const MAX_INST = 12288, INST_FLOATS = 8, DRAW_BYTES = 48 + 8 * 16, TPB = 28;
const FALL_BEATS = 3;

/** The rewritten string, encoded: 0 = F, 1 = +, 2 = -, 3 = [, 4 = ], 5 = X (the turtle skips X). */
function expand(g: number, depth: number): Uint8Array {
  const enc = (str: string) => Array.from(str, (c) => 'F+-[]X'.indexOf(c));
  const { axiom, rules } = GRAMMARS[g];
  const rule: (number[] | null)[] = ['F', '+', '-', '[', ']', 'X'].map((c) => (rules[c] ? enc(rules[c]) : null));
  let s = enc(axiom);
  for (let i = 0; i < depth; i++) {
    const n: number[] = [];
    for (const c of s) { const r = rule[c]; if (r) for (const x of r) n.push(x); else n.push(c); }
    s = n;
  }
  return Uint8Array.from(s.filter((c) => c !== 5));
}

interface Spec { g: number; depth: number; seed: number; mirror: number }

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('draw.wgsl');
    const bgl = device.createBindGroupLayout({
      label: 'claude-lsystem',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const sky = device.createRenderPipeline({
      label: 'claude-lsystem sky', layout,
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_sky', targets: [{ format: 'rgba16float' }] },
    });
    const max: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'max' };
    const prims = device.createRenderPipeline({
      label: 'claude-lsystem prims', layout,
      vertex: { module: mod, entryPoint: 'vs_prim' },
      fragment: { module: mod, entryPoint: 'fs_prim', targets: [{ format: 'rgba16float', blend: { color: max, alpha: max } }] },
    });
    const drawU = device.createBuffer({ label: 'claude-lsystem u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const instB = device.createBuffer({ label: 'claude-lsystem prims', size: MAX_INST * INST_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: instB } }] });
    const df = new Float32Array(DRAW_BYTES / 4);
    const inst = new Float32Array(MAX_INST * INST_FLOATS);
    const cache = new Map<number, Uint8Array>();
    const str = (g: number, d: number) => {
      const k = g * 16 + d;
      let s = cache.get(k);
      if (!s) { s = expand(g, d); cache.set(k, s); }
      return s;
    };
    // rewrite every grammar at every depth it can use up front: no hitch when a phrase picks a new one
    GRAMMARS.forEach((G, g) => { for (let d = 1; d <= G.depth[1] + 1; d++) str(g, d); });
    // turtle scratch (local coords, step 1): x0 y0 x1 y1, path distance, nesting, tip flag
    const CAP = 8192;
    const sx0 = new Float32Array(CAP), sy0 = new Float32Array(CAP), sx1 = new Float32Array(CAP), sy1 = new Float32Array(CAP);
    const sd = new Uint16Array(CAP), sn = new Uint8Array(CAP), tip = new Uint8Array(CAP), sr = new Float32Array(CAP);
    const stack = new Float32Array(64 * 5);
    let count = 0, segs = 0;

    /** Walk one tree; fills the scratch arrays and returns [D, minX, maxX, maxH]. */
    const walk = (s: Uint8Array, angle: number, sway: number, jitter: number, seed: number, mirror: number, rand: (a: number, b?: number) => number) => {
      let x = 0, y = 0, a = 0, d = 0, nest = 0, last = -1, sp = 0, n = 0, D = 0, minX = 0, maxX = 0, maxH = 0.001;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === 0) {
          if (n >= CAP) break;
          const nx = x + Math.sin(a), ny = y - Math.cos(a);
          sx0[n] = x; sy0[n] = y; sx1[n] = nx; sy1[n] = ny; sd[n] = d; sn[n] = nest; tip[n] = 1; sr[n] = rand(seed, n);
          if (last >= 0) tip[last] = 0;
          last = n++; x = nx; y = ny; d++;
          if (d > D) D = d;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (-y > maxH) maxH = -y;
        } else if (c === 1 || c === 2) {
          const r = rand(seed, 50000 + i) - 0.5;
          a += (c === 1 ? 1 : -1) * mirror * angle * (1 + jitter * r) + sway * (1 + 0.3 * nest);
        } else if (c === 3) {
          if (sp < 64) { stack.set([x, y, a, d + nest * 4096, last], sp * 5); sp++; }
          nest++;
        } else if (c === 4) {
          if (sp > 0) { sp--; x = stack[sp * 5]; y = stack[sp * 5 + 1]; a = stack[sp * 5 + 2]; const dn = stack[sp * 5 + 3]; nest = Math.floor(dn / 4096); d = dn - nest * 4096; last = stack[sp * 5 + 4]; }
        }
      }
      segs = n;
      return [D, minX, maxX, maxH];
    };

    const push = (v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number) => {
      if (count >= MAX_INST) return;
      const o = count++ * INST_FLOATS;
      inst[o] = v0; inst[o + 1] = v1; inst[o + 2] = v2; inst[o + 3] = v3; inst[o + 4] = v4; inst[o + 5] = v5; inst[o + 6] = v6; inst[o + 7] = v7;
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, raw, rand, width, height }) {
        const aspect = width / height;
        const bps = (audio.bpm > 0 ? audio.bpm : 3600 / TPB) / 60;
        const beats = time * bps, phraseBeats = Math.max(1, Math.round(params.bars as number)) * 4;
        const phrase = Math.floor(beats / phraseBeats), tp = beats / phraseBeats - phrase;
        const phraseTicks = (phraseBeats / bps) * 60;
        const startTick = (p: number) => Math.round(p * phraseTicks);
        const N = Math.max(1, Math.min(5, Math.round(params.trees as number)));
        const gsel = params.grammar as number;

        // what the spectrum looked like in the bar before a phrase began: fullness -> depth
        const fullnessAt = (p: number) => {
          const t0 = startTick(p);
          let s = 0, k = 0;
          for (let t = t0 - 112; t < t0; t += 4) { if (t < 0) continue; for (let b = 0; b < 16; b++) s += raw.get(t, b); k += 16; }
          return k ? s / k / 255 : 0;
        };
        const specs = (p: number): Spec[] => {
          const full = Math.min(1, Math.max(0, (fullnessAt(p) - 0.1) / 0.45));
          return Array.from({ length: N }, (_, i) => {
            const g = gsel >= GRAMMARS.length ? Math.floor(rand(p * 7 + i, 1) * GRAMMARS.length) : gsel;
            const [lo, hi] = GRAMMARS[g].depth;
            const depth = Math.max(1, Math.min(hi + 1, lo + Math.round(full * (hi - lo)) + Math.round(params.depth as number)));
            return { g, depth, seed: p * 131 + i * 17, mirror: rand(p * 3 + i, 2) < 0.5 ? -1 : 1 };
          });
        };

        // live audio: pitch centroid over the last ~1/3 beat, kick envelope, bass, energy since the phrase began
        let cs = 0, ws = 0, bass = 0;
        for (let ago = 0; ago < 10; ago++) {
          const a = past(ago);
          for (let b = 0; b < 16; b++) { cs += b * a.bands[b]; ws += a.bands[b]; }
          bass += (a.bands[0] + a.bands[1] + a.bands[2]) / 30;
        }
        const centroid = ws > 0.5 ? cs / ws / 15 : 0.3;
        let kick = 0, kickAgo = 999;
        for (let ago = 0; ago < 40; ago++) if (past(ago).onset) { kick = Math.exp(-ago / 8); kickAgo = ago; break; }
        const t0 = startTick(phrase);
        let energy = 0;
        for (let t = Math.max(0, t0); t <= tick; t += 2) energy += raw.get(t, 16) / 255 * 2;
        const grow = Math.min(1, 0.7 * Math.min(1, tp / 0.8) + 0.6 * energy / (0.22 * phraseTicks));

        const angleMul = (params.angle as number) * Math.max(0.4, 1 + (params.pitch as number) * 1.5 * (centroid - 0.42)) * (1 + 0.25 * kick * (params.flex as number));
        const swayAmt = (params.sway as number) * (0.006 + 0.03 * bass);
        const fall = phrase > 0 ? Math.min(1, (beats - phrase * phraseBeats) / FALL_BEATS) : 1;

        count = 0;
        const slotW = aspect / N;
        const drawTree = (sp: Spec, i: number, g: number, fade: number, dropping: number) => {
          const G = GRAMMARS[sp.g];
          const sway = swayAmt * Math.sin(time * 0.9 + i * 1.7) + swayAmt * 0.4 * Math.sin(time * 2.3 + i);
          const [D, minX, maxX, maxH] = walk(str(sp.g, sp.depth), (G.angle * Math.PI / 180) * angleMul, sway, 0.35, sp.seed, sp.mirror, rand);
          const half = Math.max(-minX, maxX, 0.001);
          const scale = Math.min(0.8 / maxH, (slotW * (N > 1 ? 0.62 : 0.45)) / half);
          const rx = slotW * (i + 0.5), ry = 0.965;
          const span = D + 1.5, front = g * span;
          const waveD = kickAgo < 40 ? (kickAgo / 22) * span : -99, waveA = kick * (params.flash as number);
          const wBase = Math.min(scale * 0.3, 0.011) * (params.width as number);
          const pxmin = 1.1 / height;
          for (let k = 0; k < segs; k++) {
            const reveal = Math.min(1, front - sd[k]);
            if (reveal <= 0) continue;
            const x0 = rx + sx0[k] * scale, y0 = ry + sy0[k] * scale;
            const x1 = x0 + (sx1[k] - sx0[k]) * scale * reveal, y1 = y0 + (sy1[k] - sy0[k]) * scale * reveal;
            const taper = Math.max(0.3, 1 - sd[k] / Math.max(1, D) * 0.7);
            const w0 = Math.max(pxmin, wBase * Math.pow(0.66, sn[k]) * taper);
            const w1 = Math.max(pxmin, w0 * 0.85);
            const growing = reveal < 1 ? 1 : Math.max(0, 1 - (front - sd[k] - 1) * 0.8);
            const wave = Math.max(0, 1 - Math.abs(sd[k] - waveD) / 2.5) * waveA;
            const bright = fade * (0.4 + 0.7 * audio.rms + 1.4 * growing + 1.6 * wave);
            if (fade > 0.02) push(x0, y0, x1, y1, w0, w1, 0.1 + 0.55 * sd[k] / Math.max(1, D), bright);
            if (tip[k]) {
              const open = Math.min(1, Math.max(0, front - sd[k] - 1) * 1.5);
              if (open <= 0) continue;
              const r = Math.min(scale * 0.5, 0.013) * (params.blossom as number) * open * (0.7 + 0.6 * sr[k]) * (1 + 0.45 * kick);
              let bx = rx + sx1[k] * scale, by = ry + sy1[k] * scale, bb = (0.5 + 0.4 * audio.rms + 2.6 * kick * (params.flash as number)) * (0.6 + 0.8 * sr[k]);
              if (dropping < 1) {
                // the old tree drops its blossoms: they fall and drift, fading out
                const f = dropping;
                by += f * f * (0.5 + 0.5 * sr[k]);
                bx += Math.sin(f * 6 + sr[k] * 20) * 0.03 * f;
                bb = (0.6 + 0.8 * sr[k]) * (1 - f) * (0.8 + 1.5 * kick);
                if (by > 1.05) continue;
              }
              push(bx, by, (sr[k] * 7 + time * 0.3) % 6.2832, 0, Math.max(pxmin * 1.5, r), -1, 0.78 + 0.22 * sr[k], bb);
            }
          }
        };

        const now = specs(phrase);
        if (fall < 1) {
          const prev = specs(phrase - 1);
          prev.forEach((sp, i) => drawTree(sp, i, 1, Math.max(0, 1 - fall * 1.6), fall));
        }
        now.forEach((sp, i) => drawTree(sp, i, grow, 1, 1));
        if (count) device.queue.writeBuffer(instB, 0, inst, 0, count * INST_FLOATS);

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.25 + i * 0.12, 0.12, audio.pal + 0.55 + i / 10));
        df.fill(0);
        df.set([aspect, 1 / height, Math.min(8, pal.length), params.glow as number], 0);
        df.set([kick, bass, audio.rms, (beats / 16) * (params.cycle as number)], 4);
        df.set([params.sky as number, 0, 0, 0], 8);
        pal.slice(0, 8).forEach((s, i) => df.set(s, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setBindGroup(0, bg);
        rp.setPipeline(sky); rp.draw(3);
        if (count) { rp.setPipeline(prims); rp.draw(6, count); }
        rp.end();
      },
      dispose: () => { drawU.destroy(); instB.destroy(); },
      status: () => `${count} prims`,
    };
  },
});
