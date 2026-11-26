// The v1 scenes as synced pieces: their integer state (uniforms + display list) is the piece's
// hashed `state`, unchanged from before the graph, so the pinned scene hashes still hold.
import type { CpuCtx, CpuOut } from '../../../lab/api/index.ts';
import type { SceneDef } from '../scene.ts';

export const v1Cpu = (def: SceneDef) => (ctx: CpuCtx): CpuOut => {
  const s = def.state(ctx.tick, ctx.raw, ctx.sub), p = s.prims ?? new Int32Array(0);
  const state = new Int32Array(s.u.length + p.length);
  state.set(s.u); state.set(p, s.u.length);
  return { state, u: s.u, prims: s.prims };
};
