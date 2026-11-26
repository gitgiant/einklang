// Display list: 8 ints per primitive [op, a, b, c, d, rgb, alpha, width], virtual W x H space.
//   CLEAR  -              fills the frame with rgb
//   CIRCLE (x, y, r)      filled disc
//   RING   (x, y, r)      stroked circle, `width` px
//   LINE   (x0, y0, x1, y1) round-capped segment, `width` px
export const OP_CLEAR = 0, OP_CIRCLE = 1, OP_RING = 2, OP_LINE = 3;
export const PRIM_INTS = 8;

export class PrimList {
  private a: Int32Array;
  n = 0;
  constructor(cap = 1024) { this.a = new Int32Array(cap * PRIM_INTS); }
  push(op: number, a: number, b: number, c: number, d: number, rgb: number, alpha: number, width: number): void {
    if ((this.n + 1) * PRIM_INTS > this.a.length) { const g = new Int32Array(this.a.length * 2); g.set(this.a); this.a = g; }
    const o = this.n++ * PRIM_INTS, x = this.a;
    x[o] = op; x[o + 1] = a; x[o + 2] = b; x[o + 3] = c; x[o + 4] = d; x[o + 5] = rgb; x[o + 6] = alpha; x[o + 7] = width;
  }
  done(): Int32Array { return this.a.slice(0, this.n * PRIM_INTS); }
}
