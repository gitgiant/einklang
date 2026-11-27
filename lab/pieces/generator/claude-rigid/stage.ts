// The knockdown stage: a few structures of boxes and balls on a floor between two walls, built from
// home slots. A kick throws one structure (and anything near it) up and apart; every knocked body is
// "stunned" for a moment, then a pull that grows from the bottom row up floats it back to its slot,
// cancelling gravity, so the stacks rebuild between hits. Hard hits pass the stun on to what they hit.

import { World, box, circle, type Body } from './physics.ts';

export interface Slot { x: number; y: number; a: number; sym: number; group: number; level: number; tone: number }
export interface Kick { x: number; t: number; amp: number }

const G = 6, WALL = 0.9, FLOOR_HALF = 0.5;

/** Home slots and shapes of the stage (floor top at y = 0, walls at +-0.9). */
function layout(): { bodies: Body[]; slots: Slot[] } {
  const bodies: Body[] = [], slots: Slot[] = [];
  const put = (b: Body, group: number, level: number, tone: number, sym: number) => {
    bodies.push(b); slots.push({ x: b.x, y: b.y, a: b.a, sym, group, level, tone });
  };
  // 0: a pyramid of crates
  const h = 0.045, gap = 0.001;
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4 - r; k++) {
    put(box(-0.58 + (k - (3 - r) / 2) * (2 * h + gap), h + r * 2 * h, h, h), 0, r, 0.15 + 0.08 * r, Math.PI / 2);
  }
  // 1: three storeys of pillars and planks, a ball on top
  let y = 0;
  for (let l = 0; l < 3; l++) {
    const ph = 0.075 - l * 0.01, pw = 0.022, kh = 0.02, kw = 0.16 - l * 0.02;
    for (const sx of [-1, 1]) put(box(0.05 + sx * (kw - 0.03), y + ph, pw, ph), 1, l * 2, 0.55, Math.PI);
    put(box(0.05, y + 2 * ph + kh, kw, kh), 1, l * 2 + 1, 0.7, Math.PI);
    y += 2 * ph + 2 * kh;
  }
  put(circle(0.05, y + 0.045, 0.045), 1, 6, 0.9, 0);
  // 2: a tapering column of three blocks with a ball on top
  y = 0;
  for (let l = 0; l < 3; l++) { const s = 0.07 - l * 0.012; put(box(0.65, y + s, s, s), 2, l, 0.35 + 0.1 * l, Math.PI / 2); y += 2 * s; }
  put(circle(0.65, y + 0.04, 0.04), 2, 3, 0.95, 0);
  // 3: a pyramid of balls; 4: a big ball
  const r = 0.042;
  for (let k = 0; k < 3; k++) put(circle(-0.26 + (k - 1) * 2 * r, r, r), 3, 0, 0.8, 0);
  for (let k = 0; k < 2; k++) put(circle(-0.26 + (k - 0.5) * 2 * r, r + 2 * r * 0.866, r), 3, 1, 0.85, 0);
  put(circle(-0.26, r + 4 * r * 0.866, r), 3, 2, 0.9, 0);
  put(circle(0.39, 0.07, 0.07), 4, 0, 0.6, 0);
  return { bodies, slots };
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export class Stage {
  world = new World();
  slots: Slot[] = [];
  /** Indices of the movable bodies (after the four static ones). */
  first = 0;
  stun: number[] = [];
  glow: number[] = [];
  kicks: Kick[] = [];
  t = 0;
  /** 0..1: how hard the pull back to the slots is. */
  restack = 1;

  constructor() { this.reset(); }

  reset(): void {
    this.world = new World();
    this.world.gy = -G;
    this.world.iterations = 10;
    // floor, walls, ceiling: static
    this.world.add(box(0, -FLOOR_HALF, 4, FLOOR_HALF, 0));
    this.world.add(box(-WALL - 0.5, 1, 0.5, 2, 0));
    this.world.add(box(WALL + 0.5, 1, 0.5, 2, 0));
    this.world.add(box(0, 2.2 + 0.5, 4, 0.5, 0));
    this.first = this.world.bodies.length;
    const { bodies, slots } = layout();
    for (const b of bodies) this.world.add(b);
    this.slots = slots;
    this.stun = slots.map(() => -100);
    this.glow = slots.map(() => 0);
    this.kicks = [];
    this.t = 0;
  }

  get count(): number { return this.slots.length; }
  body(i: number): Body { return this.world.bodies[this.first + i]; }
  groups(): number { return 1 + Math.max(...this.slots.map((s) => s.group)); }
  groupX(g: number): number { const xs = this.slots.filter((s) => s.group === g).map((s) => s.x); return xs.reduce((a, b) => a + b, 0) / xs.length; }

  /** How much body i is pulled home now, 0..1. */
  hold(i: number): number {
    return this.restack * smooth((this.t - this.stun[i] - 0.35 - 0.1 * this.slots[i].level) / 0.45);
  }

  /** How built a group is: its bodies' mean hold, 0..1. */
  intact(g: number): number {
    let s = 0, n = 0;
    for (let i = 0; i < this.count; i++) if (this.slots[i].group === g) { s += this.hold(i); n++; }
    return n ? s / n : 0;
  }

  /** The group to knock next: one of the standing ones (by r 0..1), else the most built. */
  pick(r: number): number {
    const n = this.groups(), up = [...Array(n).keys()].filter((g) => this.intact(g) > 0.8);
    if (up.length) return up[Math.min(up.length - 1, Math.floor(r * up.length))];
    let best = 0;
    for (let g = 1; g < n; g++) if (this.intact(g) > this.intact(best)) best = g;
    return best;
  }

  /** A small hop for every body on or near the floor that is held in place (a snare's rattle). */
  rattle(amp: number, jitter: (i: number) => number): void {
    for (let i = 0; i < this.count; i++) {
      const b = this.body(i);
      if (this.hold(i) > 0.9) { b.vy += amp * (0.5 + 0.5 * jitter(i)) / (1 + 2 * this.slots[i].level); b.w += (jitter(i + 99) - 0.5) * amp * 2; }
    }
  }

  /** Knock: everything in `group` and within `reach` of x is stunned and thrown up and away from below x. */
  kick(group: number, x: number, amp: number, spin: (i: number) => number): void {
    const reach = 0.3;
    for (let i = 0; i < this.count; i++) {
      const b = this.body(i);
      const dx = b.x - x, dy = b.y + 0.15;
      const near = Math.abs(dx) < reach;
      if (this.slots[i].group !== group && !near) continue;
      const fall = near ? 1 : 0.55;
      const d = Math.hypot(dx, dy);
      this.stun[i] = this.t;
      this.glow[i] = Math.min(1.5, this.glow[i] + amp * 0.4);
      b.vx += (dx / d) * amp * fall * 0.8;
      b.vy += (dy / d) * amp * fall;
      b.w += spin(i) * amp * 18 * fall;
    }
    this.kicks.push({ x, t: this.t, amp });
    if (this.kicks.length > 8) this.kicks.shift();
  }

  step(dt: number): void {
    const w = this.world, first = this.first;
    this.t += dt;
    const holds = this.slots.map((_, i) => this.hold(i));
    // on the way back a body is a ghost; it turns solid again in its slot
    for (let i = 0; i < this.count; i++) {
      const b = this.body(i), s = this.slots[i];
      let ea = 0;
      if (s.sym > 0) { ea = s.a - b.a; ea -= s.sym * Math.round(ea / s.sym); }
      b.ghost = holds[i] > 0.02 && (Math.hypot(b.x - s.x, b.y - s.y) > 0.012 || Math.abs(ea) > 0.12);
    }
    w.step(dt, (b, k) => {
      const i = k - first;
      if (i < 0) return;
      const R = holds[i], s = this.slots[i];
      if (R <= 0) return;
      // fly home: a damped pull with gravity cancelled, then turn to the nearest equivalent angle
      let ex = (s.x - b.x) * 6, ey = (s.y - b.y) * 6;
      const m = Math.hypot(ex, ey);
      if (m > 3) { ex *= 3 / m; ey *= 3 / m; }
      b.vx += ((ex - b.vx) * 10) * R * dt;
      b.vy += ((ey - b.vy) * 10 + G) * R * dt;
      let ea = 0;
      if (s.sym > 0) { ea = s.a - b.a; ea -= s.sym * Math.round(ea / s.sym); }
      b.w += ((ea * 8 - b.w) * 10) * R * dt;
    });
    // hard hits pass the stun on: a free, fast body that slams into a held one knocks it loose
    for (const [key, P] of w.impulses) {
      const i = Math.floor(key / 4096) - first, j = (key % 4096) - first;
      if (i < 0 || j < 0) continue;
      const bi = this.body(i), bj = this.body(j);
      const fast = (b: Body) => Math.hypot(b.vx, b.vy) > 0.9;
      if (holds[i] < 0.3 && holds[j] > 0.3 && fast(bi) && P * bj.invMass > 0.35) { this.stun[j] = this.t; this.glow[j] = Math.max(this.glow[j], 0.5); }
      if (holds[j] < 0.3 && holds[i] > 0.3 && fast(bj) && P * bi.invMass > 0.35) { this.stun[i] = this.t; this.glow[i] = Math.max(this.glow[i], 0.5); }
    }
    const fade = Math.exp(-dt / 0.3);
    for (let i = 0; i < this.count; i++) {
      this.glow[i] *= fade;
      const b = this.body(i), s = this.slots[i];
      // anything that got out (tunnelled through a wall) drops back in above its slot
      if (Math.abs(b.x) > WALL + 0.2 || b.y < -0.3 || b.y > 2.3 || !Number.isFinite(b.x + b.y + b.a)) {
        b.x = s.x; b.y = s.y + 0.8; b.a = s.a; b.vx = b.vy = b.w = 0;
      }
    }
  }
}
