// A small 2D rigid-body world in the style of Box2D-lite: boxes and circles, SAT box-box clipping
// with feature ids, arbiters with warm-started accumulated impulses, sequential impulses with
// Baumgarte bias and Coulomb friction. y is up. Bodies with invMass 0 are static.

export interface Body {
  x: number; y: number; a: number; vx: number; vy: number; w: number;
  /** 0 = box (hx, hy half extents), 1 = circle (radius hx). */
  shape: 0 | 1; hx: number; hy: number;
  invMass: number; invI: number; friction: number;
  /** Ghosts only collide with static bodies (bodies flying back to their slot). */
  ghost?: boolean;
}

interface Contact { px: number; py: number; nx: number; ny: number; sep: number; key: number; Pn: number; Pt: number; mn: number; mt: number; bias: number }
interface Arbiter { a: Body; b: Body; contacts: Contact[]; friction: number }

export function box(x: number, y: number, hx: number, hy: number, density = 1, a = 0): Body {
  const m = density * 4 * hx * hy, I = (m * (4 * hx * hx + 4 * hy * hy)) / 12;
  return { x, y, a, vx: 0, vy: 0, w: 0, shape: 0, hx, hy, invMass: density > 0 ? 1 / m : 0, invI: density > 0 ? 1 / I : 0, friction: 0.6 };
}
export function circle(x: number, y: number, r: number, density = 1): Body {
  const m = density * Math.PI * r * r, I = 0.5 * m * r * r;
  return { x, y, a: 0, vx: 0, vy: 0, w: 0, shape: 1, hx: r, hy: r, invMass: density > 0 ? 1 / m : 0, invI: density > 0 ? 1 / I : 0, friction: 0.5 };
}

// ------------------------------------------------------------------ narrow phase

type Out = { px: number; py: number; nx: number; ny: number; sep: number; key: number }[];

// edge ids for feature keys, as in Box2D-lite
const E1 = 1, E2 = 2, E3 = 3, E4 = 4;
interface CV { x: number; y: number; in1: number; out1: number; in2: number; out2: number }

function clip(vin: CV[], nx: number, ny: number, off: number, edge: number): CV[] {
  const out: CV[] = [];
  const d0 = nx * vin[0].x + ny * vin[0].y - off, d1 = nx * vin[1].x + ny * vin[1].y - off;
  if (d0 <= 0) out.push(vin[0]);
  if (d1 <= 0) out.push(vin[1]);
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    const v: CV = { ...(d0 > 0 ? vin[0] : vin[1]), x: vin[0].x + t * (vin[1].x - vin[0].x), y: vin[0].y + t * (vin[1].y - vin[0].y) };
    if (d0 > 0) { v.in1 = edge; v.in2 = 0; } else { v.out1 = edge; v.out2 = 0; }
    out.push(v);
  }
  return out;
}

function incident(hx: number, hy: number, b: Body, nx: number, ny: number): CV[] {
  const c = Math.cos(b.a), s = Math.sin(b.a);
  // the reference normal in the incident box's frame, flipped
  const lx = -(c * nx + s * ny), ly = -(-s * nx + c * ny);
  let v: [number, number, number, number][];
  if (Math.abs(lx) > Math.abs(ly)) {
    v = lx > 0 ? [[hx, -hy, E3, E4], [hx, hy, E4, E1]] : [[-hx, hy, E1, E2], [-hx, -hy, E2, E3]];
  } else {
    v = ly > 0 ? [[hx, hy, E4, E1], [-hx, hy, E1, E2]] : [[-hx, -hy, E2, E3], [hx, -hy, E3, E4]];
  }
  return v.map(([x, y, i2, o2]) => ({ x: b.x + c * x - s * y, y: b.y + s * x + c * y, in1: 0, out1: 0, in2: i2, out2: o2 }));
}

function boxBox(A: Body, B: Body, out: Out): void {
  const ca = Math.cos(A.a), sa = Math.sin(A.a), cb = Math.cos(B.a), sb = Math.sin(B.a);
  const dpx = B.x - A.x, dpy = B.y - A.y;
  const dAx = ca * dpx + sa * dpy, dAy = -sa * dpx + ca * dpy;
  const dBx = cb * dpx + sb * dpy, dBy = -sb * dpx + cb * dpy;
  // C = RotA^T RotB
  const c11 = ca * cb + sa * sb, c12 = -ca * sb + sa * cb, c21 = -sa * cb + ca * sb, c22 = sa * sb + ca * cb;
  const a11 = Math.abs(c11), a12 = Math.abs(c12), a21 = Math.abs(c21), a22 = Math.abs(c22);
  const faX = Math.abs(dAx) - A.hx - (a11 * B.hx + a12 * B.hy), faY = Math.abs(dAy) - A.hy - (a21 * B.hx + a22 * B.hy);
  if (faX > 0 || faY > 0) return;
  const fbX = Math.abs(dBx) - (a11 * A.hx + a21 * A.hy) - B.hx, fbY = Math.abs(dBy) - (a12 * A.hx + a22 * A.hy) - B.hy;
  if (fbX > 0 || fbY > 0) return;
  const rel = 0.95, abs = 0.01;
  let axis = 0, sep = faX, nx = dAx > 0 ? ca : -ca, ny = dAx > 0 ? sa : -sa;
  if (faY > rel * sep + abs * A.hy) { axis = 1; sep = faY; nx = dAy > 0 ? -sa : sa; ny = dAy > 0 ? ca : -ca; }
  if (fbX > rel * sep + abs * B.hx) { axis = 2; sep = fbX; nx = dBx > 0 ? cb : -cb; ny = dBx > 0 ? sb : -sb; }
  if (fbY > rel * sep + abs * B.hy) { axis = 3; sep = fbY; nx = dBy > 0 ? -sb : sb; ny = dBy > 0 ? cb : -cb; }
  let fnx: number, fny: number, front: number, snx: number, sny: number, neg: number, pos: number, negE: number, posE: number, inc: CV[];
  if (axis < 2) {
    const R = A, hx = axis === 0 ? A.hx : A.hy, hs = axis === 0 ? A.hy : A.hx;
    fnx = nx; fny = ny; front = R.x * fnx + R.y * fny + hx;
    [snx, sny] = axis === 0 ? [-sa, ca] : [ca, sa];
    const side = R.x * snx + R.y * sny;
    neg = -side + hs; pos = side + hs;
    [negE, posE] = axis === 0 ? [E3, E1] : [E2, E4];
    inc = incident(B.hx, B.hy, B, fnx, fny);
  } else {
    const R = B, hx = axis === 2 ? B.hx : B.hy, hs = axis === 2 ? B.hy : B.hx;
    fnx = -nx; fny = -ny; front = R.x * fnx + R.y * fny + hx;
    [snx, sny] = axis === 2 ? [-sb, cb] : [cb, sb];
    const side = R.x * snx + R.y * sny;
    neg = -side + hs; pos = side + hs;
    [negE, posE] = axis === 2 ? [E3, E1] : [E2, E4];
    inc = incident(A.hx, A.hy, A, fnx, fny);
  }
  const c1 = clip(inc, -snx, -sny, neg, negE);
  if (c1.length < 2) return;
  const c2 = clip(c1, snx, sny, pos, posE);
  if (c2.length < 2) return;
  for (const v of c2) {
    const s = fnx * v.x + fny * v.y - front;
    if (s > 0) continue;
    const f = axis >= 2 ? [v.in2, v.out2, v.in1, v.out1] : [v.in1, v.out1, v.in2, v.out2];
    out.push({ px: v.x - s * fnx, py: v.y - s * fny, nx, ny, sep: s, key: f[0] | (f[1] << 4) | (f[2] << 8) | (f[3] << 12) });
  }
}

/** Box A against circle B: the normal points from A to B. */
function boxCircle(A: Body, B: Body, out: Out): void {
  const c = Math.cos(A.a), s = Math.sin(A.a), dx = B.x - A.x, dy = B.y - A.y;
  const lx = c * dx + s * dy, ly = -s * dx + c * dy, r = B.hx;
  const qx = Math.max(-A.hx, Math.min(A.hx, lx)), qy = Math.max(-A.hy, Math.min(A.hy, ly));
  let nlx: number, nly: number, sep: number, px: number, py: number;
  if (qx === lx && qy === ly) {
    // centre inside: push out through the nearest face
    const ex = A.hx - Math.abs(lx), ey = A.hy - Math.abs(ly);
    if (ex < ey) { nlx = Math.sign(lx) || 1; nly = 0; sep = -ex - r; px = nlx * A.hx; py = ly; }
    else { nlx = 0; nly = Math.sign(ly) || 1; sep = -ey - r; px = lx; py = nly * A.hy; }
  } else {
    const ddx = lx - qx, ddy = ly - qy, d = Math.hypot(ddx, ddy);
    sep = d - r;
    if (sep > 0) return;
    nlx = ddx / d; nly = ddy / d; px = qx; py = qy;
  }
  out.push({ px: A.x + c * px - s * py, py: A.y + s * px + c * py, nx: c * nlx - s * nly, ny: s * nlx + c * nly, sep, key: 0 });
}

function circleCircle(A: Body, B: Body, out: Out): void {
  const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy), sep = d - A.hx - B.hx;
  if (sep > 0) return;
  const nx = d > 1e-9 ? dx / d : 0, ny = d > 1e-9 ? dy / d : 1;
  out.push({ px: A.x + nx * (A.hx + sep / 2), py: A.y + ny * (A.hx + sep / 2), nx, ny, sep, key: 0 });
}

function collide(A: Body, B: Body, out: Out): void {
  if (A.shape === 0 && B.shape === 0) boxBox(A, B, out);
  else if (A.shape === 0) boxCircle(A, B, out);
  else if (B.shape === 0) { const o: Out = []; boxCircle(B, A, o); for (const k of o) out.push({ ...k, nx: -k.nx, ny: -k.ny }); }
  else circleCircle(A, B, out);
}

const radius = (b: Body) => (b.shape === 1 ? b.hx : Math.hypot(b.hx, b.hy));

// ------------------------------------------------------------------ world

export class World {
  bodies: Body[] = [];
  gx = 0; gy = -9.8; iterations = 10; slop = 0.002; beta = 0.2;
  private arbiters = new Map<number, Arbiter>();
  /** Accumulated normal impulse per touching pair after the last step (key: i * 4096 + j). */
  impulses = new Map<number, number>();

  add(b: Body): number { this.bodies.push(b); return this.bodies.length - 1; }

  step(dt: number, force?: (b: Body, i: number) => void): void {
    const B = this.bodies, n = B.length, inv = 1 / dt, live = new Set<number>(), o: Out = [];
    // broad + narrow phase, updating arbiters (warm starting by feature key)
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = B[i], b = B[j];
      if ((a.invMass === 0 && b.invMass === 0) || (a.ghost && b.invMass) || (b.ghost && a.invMass)) continue;
      const rr = radius(a) + radius(b);
      if (Math.abs(a.x - b.x) > rr || Math.abs(a.y - b.y) > rr) continue;
      o.length = 0;
      collide(a, b, o);
      if (!o.length) continue;
      const key = i * 4096 + j;
      live.add(key);
      const old = this.arbiters.get(key);
      const cs = o.map((k) => {
        const prev = old?.contacts.find((c) => c.key === k.key);
        return { ...k, Pn: prev ? prev.Pn : 0, Pt: prev ? prev.Pt : 0, mn: 0, mt: 0, bias: 0 };
      });
      this.arbiters.set(key, { a, b, contacts: cs, friction: Math.sqrt(a.friction * b.friction) });
    }
    for (const k of this.arbiters.keys()) if (!live.has(k)) this.arbiters.delete(k);
    // forces
    for (let i = 0; i < n; i++) {
      const b = B[i];
      if (b.invMass === 0) continue;
      b.vx += dt * this.gx; b.vy += dt * this.gy;
      force?.(b, i);
    }
    // pre-step
    for (const ar of this.arbiters.values()) {
      const { a, b } = ar;
      for (const c of ar.contacts) {
        const r1x = c.px - a.x, r1y = c.py - a.y, r2x = c.px - b.x, r2y = c.py - b.y;
        const rn1 = r1x * c.nx + r1y * c.ny, rn2 = r2x * c.nx + r2y * c.ny;
        c.mn = 1 / (a.invMass + b.invMass + a.invI * (r1x * r1x + r1y * r1y - rn1 * rn1) + b.invI * (r2x * r2x + r2y * r2y - rn2 * rn2));
        const tx = c.ny, ty = -c.nx, rt1 = r1x * tx + r1y * ty, rt2 = r2x * tx + r2y * ty;
        c.mt = 1 / (a.invMass + b.invMass + a.invI * (r1x * r1x + r1y * r1y - rt1 * rt1) + b.invI * (r2x * r2x + r2y * r2y - rt2 * rt2));
        c.bias = -this.beta * inv * Math.min(0, c.sep + this.slop);
        const Px = c.Pn * c.nx + c.Pt * tx, Py = c.Pn * c.ny + c.Pt * ty;
        a.vx -= a.invMass * Px; a.vy -= a.invMass * Py; a.w -= a.invI * (r1x * Py - r1y * Px);
        b.vx += b.invMass * Px; b.vy += b.invMass * Py; b.w += b.invI * (r2x * Py - r2y * Px);
      }
    }
    // sequential impulses
    for (let it = 0; it < this.iterations; it++) {
      for (const ar of this.arbiters.values()) {
        const { a, b } = ar;
        for (const c of ar.contacts) {
          const r1x = c.px - a.x, r1y = c.py - a.y, r2x = c.px - b.x, r2y = c.py - b.y;
          let dvx = b.vx - b.w * r2y - a.vx + a.w * r1y, dvy = b.vy + b.w * r2x - a.vy - a.w * r1x;
          const vn = dvx * c.nx + dvy * c.ny;
          let dPn = c.mn * (-vn + c.bias);
          const Pn0 = c.Pn;
          c.Pn = Math.max(Pn0 + dPn, 0); dPn = c.Pn - Pn0;
          let Px = dPn * c.nx, Py = dPn * c.ny;
          a.vx -= a.invMass * Px; a.vy -= a.invMass * Py; a.w -= a.invI * (r1x * Py - r1y * Px);
          b.vx += b.invMass * Px; b.vy += b.invMass * Py; b.w += b.invI * (r2x * Py - r2y * Px);
          dvx = b.vx - b.w * r2y - a.vx + a.w * r1y; dvy = b.vy + b.w * r2x - a.vy - a.w * r1x;
          const tx = c.ny, ty = -c.nx, vt = dvx * tx + dvy * ty;
          let dPt = c.mt * -vt;
          const maxPt = ar.friction * c.Pn, Pt0 = c.Pt;
          c.Pt = Math.max(-maxPt, Math.min(maxPt, Pt0 + dPt)); dPt = c.Pt - Pt0;
          Px = dPt * tx; Py = dPt * ty;
          a.vx -= a.invMass * Px; a.vy -= a.invMass * Py; a.w -= a.invI * (r1x * Py - r1y * Px);
          b.vx += b.invMass * Px; b.vy += b.invMass * Py; b.w += b.invI * (r2x * Py - r2y * Px);
        }
      }
    }
    // integrate
    for (const b of B) {
      if (b.invMass === 0) continue;
      b.x += dt * b.vx; b.y += dt * b.vy; b.a += dt * b.w;
    }
    this.impulses.clear();
    for (const [k, ar] of this.arbiters) { let s = 0; for (const c of ar.contacts) s += c.Pn; this.impulses.set(k, s); }
  }
}
