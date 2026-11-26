import { definePiece } from '../../../api/index.ts';
import { PrimDrawer } from '../../../api/prims.ts';
import { radial } from '../../../../src/core/scenes/radial.ts';
import { v1Cpu } from '../../../../src/core/graph/v1.ts';

export default definePiece({
  cpu: v1Cpu(radial),
  gpu: (init) => {
    const d = new PrimDrawer(init, 'over', 1.3);
    return { frame: (ctx) => d.draw(ctx.enc, ctx.out.out, ctx.cpu.prims as Int32Array) };
  },
});
