fn w9_hash(a: u32, b: u32) -> vec4f {
  var h = (a * 0x8da6b343u) ^ (b * 0xd8163841u) ^ 0x9e3779b9u;
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  let x = h ^ (h >> 15u);
  let y = (x ^ (x >> 11u)) * 0x27d4eb2du;
  let z = (y ^ (y >> 15u)) * 0x165667b1u;
  let w = (z ^ (z >> 13u)) * 0x85ebca6bu;
  return vec4f(f32(x >> 8u), f32(y >> 8u), f32(z >> 8u), f32(w >> 8u)) / 16777216.0;
}

fn w9_seg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * t);
}

// Coverage of an axis-aligned box (centre c, half size hs), AA'd over one pixel.
fn w9_box(p: vec2f, c: vec2f, hs: vec2f, px: f32) -> f32 {
  let d = hs - abs(p - c);
  return clamp(min(d.x, d.y) / px + 0.5, 0.0, 1.0);
}

// A kanji-like glyph from six strokes on a 5-row lattice; p in 0..1, px = one pixel in glyph units.
fn w9_glyph(p: vec2f, seed: u32, px: f32) -> f32 {
  var d = 1e3;
  let h0 = w9_hash(seed, 0u);
  let r0 = 0.15 + floor(h0.y * 4.0) * 0.23;
  d = min(d, w9_seg(p, vec2f(0.1, r0), vec2f(0.9, r0)));
  for (var j = 1u; j < 6u; j++) {
    let h = w9_hash(seed, j);
    let r = 0.12 + floor(h.y * 5.0) * 0.19;
    let a0 = 0.1 + h.z * 0.35;
    let a1 = 0.55 + h.w * 0.35;
    var A = vec2f(a0, r);
    var B = vec2f(a1, r);
    if (h.x < 0.4) {
      A = vec2f(a0, r); B = vec2f(a1, r);
    } else if (h.x < 0.8) {
      A = vec2f(r, a0); B = vec2f(r, a1);
    } else if (h.x < 0.92) {
      A = vec2f(r, 0.15); B = vec2f(r - 0.32 + 0.64 * step(0.5, h.z), 0.88);
    } else {
      A = vec2f(r, a0); B = vec2f(r + 0.09, a0 + 0.09);
    }
    d = min(d, w9_seg(p, A, B));
  }
  return clamp((0.06 - d) / px + 0.5, 0.0, 1.0);
}

fn shade(uv: vec2f) -> vec4f {
  let a = aspect();
  let px = 1.0 / resolution().y;
  let P = uv * vec2f(a, 1.0);
  let beats = p_beats();
  let fbeat = fract(beats);
  let hit = exp(-fbeat * 5.0);
  var col = vec3f(0.0);
  var al = 0.0;

  // the glyph column: a new word every bar, flashing on the downbeat and on onsets
  if (p_kanji() > 0.0) {
    let gs = 0.16;
    let bar4 = beats * 0.25;
    let word = bitcast<u32>(i32(floor(bar4)));
    let fl = 1.0 + 1.5 * exp(-fract(bar4) * 6.0) + 0.8 * onset();
    for (var k = 0; k < 5; k++) {
      let o = vec2f(p_side() * a - gs * 0.5, 0.07 + f32(k) * 0.18);
      let lp = (P - o) / gs;
      if (lp.x < 0.0 || lp.x > 1.0 || lp.y < 0.0 || lp.y > 1.0) { continue; }
      let g = w9_glyph(lp, word * 31u + u32(k) * 7u + 11u, px / gs);
      let c = palette(fract(p_tint() + 0.3 + f32(k) * 0.11)) * p_kanji() * p_glow() * fl;
      col = col * (1.0 - g) + c * g;
      al = al * (1.0 - g) + g;
    }
  }

  let n = i32(p_count());
  let L = p_life();
  let gray = mix(vec3f(0.52), palette(0.9), 0.18);
  for (var i = 0; i < n; i++) {
    let fi = f32(i);
    let cyc = (beats + fi * L / f32(n)) / L;
    let ep = bitcast<u32>(i32(floor(cyc)));
    let age = fract(cyc);
    let open = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.95, 1.0, age));
    if (open <= 0.001) { continue; }
    let h = w9_hash(ep, u32(i) + 101u);
    let h2 = w9_hash(ep, u32(i) + 707u);
    let ws = p_size() * (0.75 + 0.5 * h.x);
    let ww = ws * (1.25 + 0.6 * h.y);
    let cx = (0.1 + 0.8 * h.z) * a;
    let cy = 0.18 + 0.6 * h.w - p_bump() * 0.035 * bass() * hit;
    let sc = mix(0.1, 1.0, open);
    let lp = (P - vec2f(cx, cy)) / sc;
    let lpx = px / sc;
    let hs = vec2f(ww, ws) * 0.5;
    let fade = clamp(open * 3.0, 0.0, 1.0);

    // hard drop shadow
    let sh = w9_box(lp, vec2f(0.016, 0.016), hs, lpx) * 0.55 * fade;
    col = col * (1.0 - sh) + palette(0.0) * 0.04 * sh;
    al = al * (1.0 - sh) + sh;

    let cover = w9_box(lp, vec2f(0.0), hs, lpx) * fade;
    if (cover <= 0.0) { continue; }
    let q = lp + hs;
    let b = 0.004;
    var wc = gray;
    if (q.x < b || q.y < b) { wc = vec3f(0.95); }
    if (q.x > ww - b || q.y > ws - b) { wc = vec3f(0.08); }

    // title bar: gradient, fake caption, three buttons
    let th = clamp(ws * 0.12, 0.018, 0.05);
    let ty0 = 2.0 * b;
    if (q.y > ty0 && q.y < ty0 + th && q.x > 2.0 * b && q.x < ww - 2.0 * b) {
      wc = mix(palette(p_tint()), palette(fract(p_tint() + 0.25)), q.x / ww) * 1.15;
      let cs = th * 0.42;
      let cc = vec2f((q.x - 3.0 * b) / cs, (q.y - ty0 - th * 0.29) / cs);
      let ci = vec2i(floor(cc));
      if (cc.x > 0.0 && q.x < ww * 0.5 && ci.y == 0) {
        let lh = w9_hash(bitcast<u32>(ci.x) + ep * 13u, 3u);
        let f = fract(cc);
        if (lh.x > 0.25 && f.x > 0.15 && f.x < 0.75 && f.y > 0.1 && f.y < 0.95) { wc = vec3f(0.95); }
      }
      let bs = th * 0.78;
      for (var k = 0; k < 3; k++) {
        let bc = vec2f(ww - 2.0 * b - bs * 0.5 - f32(k) * (bs + 0.002) - select(0.0, 0.003, k > 0), ty0 + th * 0.5);
        let bb = w9_box(q, bc, vec2f(bs * 0.5), lpx);
        if (bb > 0.5) {
          let r = q - bc;
          wc = gray;
          if (r.x < -bs * 0.5 + b * 0.6 || r.y < -bs * 0.5 + b * 0.6) { wc = vec3f(0.95); }
          if (r.x > bs * 0.5 - b * 0.6 || r.y > bs * 0.5 - b * 0.6) { wc = vec3f(0.1); }
          let m = r / bs;
          var ink = 0.0;
          if (k == 0) { ink = min(w9_seg(m, vec2f(-0.25), vec2f(0.25)), w9_seg(m, vec2f(-0.25, 0.25), vec2f(0.25, -0.25))); }
          else if (k == 1) { ink = min(abs(max(abs(m.x), abs(m.y)) - 0.25), select(1.0, abs(m.y + 0.2), abs(m.x) < 0.25 && m.y < 0.0)); }
          else { ink = w9_seg(m, vec2f(-0.22, 0.22), vec2f(0.22, 0.22)); }
          if (ink < 0.07) { wc = vec3f(0.03); }
        }
      }
    }

    // content
    let c0 = vec2f(3.0 * b, ty0 + th + 2.5 * b);
    let c1 = vec2f(ww - 3.0 * b, ws - 3.0 * b);
    let cw = c1 - c0;
    let cq = q - c0;
    if (cq.x > 0.0 && cq.y > 0.0 && cq.x < cw.x && cq.y < cw.y) {
      let kind = i32(h2.x * 3.0);
      if (kind == 0) {
        // sunken panel with big glyphs
        wc = mix(vec3f(0.92), palette(0.9), 0.25);
        if (cq.x < b || cq.y < b) { wc = vec3f(0.12); }
        let gn = max(1.0, min(3.0, floor(cw.x / (cw.y * 0.9))));
        let gsz = min(cw.y * 0.8, cw.x / gn * 0.85);
        let gx0 = (cw.x - gsz * gn) * 0.5;
        let gl = vec2f((cq.x - gx0) / gsz, (cq.y - (cw.y - gsz) * 0.5) / gsz);
        let gi = floor(gl.x);
        if (gl.x > 0.0 && gi < gn && gl.y > 0.0 && gl.y < 1.0) {
          let g = w9_glyph(vec2f(fract(gl.x), gl.y), ep * 977u + u32(i) * 13u + u32(gi), lpx / gsz);
          let ink = palette(fract(p_tint() + 0.5 + gi * 0.13)) * p_glow() * (0.7 + 0.6 * onset() + 0.4 * hit);
          wc = mix(wc, ink, g);
        }
      } else if (kind == 1) {
        // progress bar filling over the window's life, in Win95 chunks
        let bh = min(cw.y * 0.3, 0.04);
        let by0 = cw.y * 0.55 - bh * 0.5;
        let lh = w9_hash(ep, u32(i) + 55u);
        if (cq.y > cw.y * 0.18 && cq.y < cw.y * 0.18 + bh * 0.4 && cq.x < cw.x * (0.4 + 0.4 * lh.x)) { wc = vec3f(0.05); }
        if (cq.y > by0 && cq.y < by0 + bh) {
          wc = vec3f(0.96);
          if (cq.y < by0 + b * 0.6 || cq.x < b * 0.6) { wc = vec3f(0.15); }
          let chunk = bh * 0.62;
          let ci = floor((cq.x - b) / chunk);
          let fill = floor(age * 1.08 * cw.x / chunk);
          let f = fract((cq.x - b) / chunk);
          if (ci < fill && f < 0.8 && cq.y > by0 + b && cq.y < by0 + bh - b) { wc = palette(p_tint()) * (1.0 + 0.6 * hit); }
        }
      } else {
        // error dialog: red stop sign, a line of text, an OK button
        let ic = vec2f(cw.y * 0.35, cw.y * 0.4);
        let ir = cw.y * 0.22;
        let dc = length(cq - ic);
        if (dc < ir) {
          wc = vec3f(0.85, 0.02, 0.02) * (1.0 + hit);
          let m = (cq - ic) / ir;
          if (min(w9_seg(m, vec2f(-0.45), vec2f(0.45)), w9_seg(m, vec2f(-0.45, 0.45), vec2f(0.45, -0.45))) < 0.13) { wc = vec3f(0.97); }
        }
        let tx = cq.x - cw.y * 0.7;
        let tcell = cw.y * 0.09;
        let tc = vec2f(tx / tcell, (cq.y - cw.y * 0.32) / tcell);
        if (tx > 0.0 && tc.y > 0.0 && tc.y < 1.0 && tx < cw.x * 0.9 - cw.y * 0.7) {
          let lh = w9_hash(bitcast<u32>(i32(floor(tc.x))) + ep * 5u, u32(i) + 9u);
          let f = fract(tc.x);
          if (lh.x > 0.2 && f > 0.15 && f < 0.8) { wc = vec3f(0.05); }
        }
        let okc = vec2f(cw.x * 0.5, cw.y * 0.8);
        let okh = vec2f(cw.y * 0.32, cw.y * 0.11);
        if (w9_box(cq, okc, okh, lpx) > 0.5) {
          let r = cq - okc;
          wc = gray;
          if (r.x < -okh.x + b * 0.6 || r.y < -okh.y + b * 0.6) { wc = vec3f(0.95); }
          if (r.x > okh.x - b * 0.6 || r.y > okh.y - b * 0.6) { wc = vec3f(0.1); }
          if (abs(r.y) < okh.y * 0.35 && abs(r.x) < okh.x * 0.35 && fract(r.x / (okh.y * 0.5)) < 0.6) { wc = vec3f(0.05); }
        }
      }
    }
    col = col * (1.0 - cover) + wc * cover;
    al = al * (1.0 - cover) + cover;
  }
  return vec4f(max(col, vec3f(0.0)), clamp(al, 0.0, 1.0));
}
