import { definePiece } from '../../../api/index.ts';
import { PrimDrawer } from '../../../api/prims.ts';
import { scope } from '../../../../src/core/scenes/scope.ts';
import { v1Cpu } from '../../../../src/core/graph/v1.ts';

export default definePiece({
  cpu: v1Cpu(scope),
  gpu: (init) => {
    const d = new PrimDrawer(init, 'add', 1.6);
    return { frame: (ctx) => d.draw(ctx.enc, ctx.out.out, ctx.cpu.prims as Int32Array) };
  },
});
