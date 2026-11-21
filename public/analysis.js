// Feature extraction. Runs on the leader only, so float math here doesn't need to be deterministic:
// everyone renders from the leader's quantized bytes.
import { NB, STRIDE } from './core.js';

export const N = 2048;

export class Analyzer {
  constructor(sr) {
    this.sr = sr;
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.rev = new Uint32Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float64Array(N / 2); this.sin = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) { this.cos[i] = Math.cos((-2 * Math.PI * i) / N); this.sin[i] = Math.sin((-2 * Math.PI * i) / N); }
    // log-spaced band edges 40 Hz .. min(16k, nyquist)
    const lo = 40, hi = Math.min(16000, sr / 2), binHz = sr / N;
    this.edges = [];
    for (let b = 0; b <= NB; b++) this.edges.push(Math.max(1, Math.round((lo * Math.pow(hi / lo, b / NB)) / binHz)));
    for (let b = 1; b <= NB; b++) if (this.edges[b] <= this.edges[b - 1]) this.edges[b] = this.edges[b - 1] + 1;
    this.prev = new Uint8Array(NB);
    this.flux = [];
    this.idx = 0; this.lastOnset = -99;
  }

  fft() {
    const { re, im, cos, sin } = this;
    for (let s = 2; s <= N; s <<= 1) {
      const h = s >> 1, step = N / s;
      for (let i = 0; i < N; i += s)
        for (let j = 0; j < h; j++) {
          const wr = cos[j * step], wi = sin[j * step], a = i + j, b = a + h;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
    }
  }

  // td: N time-domain samples centered on the frame -> Uint8Array(STRIDE)
  frame(td) {
    const out = new Uint8Array(STRIDE), { re, im, rev, win } = this;
    let ss = 0;
    for (let i = 0; i < N; i++) { const v = td[i] || 0; ss += v * v; re[rev[i]] = v * win[i]; im[rev[i]] = 0; }
    this.fft();
    const norm = 1 / (N / 4);
    for (let b = 0; b < NB; b++) {
      let p = 0; const s = this.edges[b], e = this.edges[b + 1];
      for (let k = s; k < e; k++) { const r = re[k] * norm, m = im[k] * norm; p += r * r + m * m; }
      p /= e - s;
      const db = 10 * Math.log10(p + 1e-12) + b * 1.5; // tilt: compensate falling HF energy
      out[b] = Math.max(0, Math.min(255, Math.round(((db + 72) * 255) / 66)));
    }
    const rdb = 20 * Math.log10(Math.sqrt(ss / N) + 1e-9);
    out[16] = Math.max(0, Math.min(255, Math.round(((rdb + 60) * 255) / 60)));
    let fl = 0;
    for (let b = 0; b < NB; b++) { const d = out[b] - this.prev[b]; if (d > 0) fl += d; this.prev[b] = out[b]; }
    const mean = this.flux.length ? this.flux.reduce((a, c) => a + c, 0) / this.flux.length : 0;
    if (fl > mean * 1.5 + 30 && this.idx - this.lastOnset >= 8) { out[17] = 255; this.lastOnset = this.idx; }
    this.flux.push(fl); if (this.flux.length > 30) this.flux.shift();
    this.idx++;
    return out;
  }
}
