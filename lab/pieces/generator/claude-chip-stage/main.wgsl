// Chiptune stage on a low-res grid, in design pixels (about 180 rows).

// 4 dance frames, 14 rows of 10 pixels, 2 bits each: 0 empty, 1 head, 2 body/arms, 3 legs
var<private> DANCE: array<u32, 56> = array<u32, 56>(
  0x80502u, 0x81542u, 0x21548u, 0x20508u, 0xaaa0u, 0x2a80u, 0x2a80u, 0x2a80u, 0x3fc0u, 0xf0f0u, 0xc030u, 0x3c03cu, 0x3000cu, 0xf000fu,
  0x500u, 0x1540u, 0x1540u, 0x500u, 0xaaaaau, 0x2a80u, 0x2a80u, 0x2a80u, 0x3fc0u, 0x30c0u, 0x30c0u, 0x30c0u, 0x30c0u, 0xf0f0u,
  0x502u, 0x1542u, 0x1548u, 0x508u, 0xaaa0u, 0x22a80u, 0x82a80u, 0x2a80u, 0x3fc0u, 0x3f0c0u, 0xf00c0u, 0xc0u, 0xc0u, 0xf0u,
  0x80500u, 0x81540u, 0x21540u, 0x20500u, 0xaaa0u, 0x2a88u, 0x2a82u, 0x2a80u, 0x3fc0u, 0x30fcu, 0x300fu, 0x3000u, 0x3000u, 0xf000u
);

fn hh(a: f32, b: f32) -> f32 {
  return f32(h32(bitcast<u32>(i32(floor(a))), bitcast<u32>(i32(floor(b)))) >> 8u) / 16777216.0;
}
fn hx(c: u32) -> vec3f {
  let s = vec3f(f32((c >> 16u) & 255u), f32((c >> 8u) & 255u), f32(c & 255u)) / 255.0;
  return pow(s, vec3f(2.2));
}
fn neon(x: f32) -> vec3f {
  let k = fract(x + p_hue()) * 6.0;
  let i = u32(floor(k)) % 6u;
  var c = array<u32, 6>(0xff004du, 0xffa300u, 0xffec27u, 0x00e436u, 0x29adffu, 0xff77a8u);
  return hx(c[i]);
}
fn beats() -> f32 {
  let b = select(120.0, bpm(), bpm() > 1.0);
  return time() * b / 60.0;
}

// one dancer pixel: 0 none, else 1..3
fn dancer(lx: f32, ly: f32, frame: u32) -> u32 {
  if (lx < 0.0 || ly < 0.0 || lx >= 10.0 || ly >= 14.0) { return 0u; }
  let row = DANCE[frame * 14u + u32(ly)];
  return (row >> (2u * u32(lx))) & 3u;
}

fn shade(uv: vec2f) -> vec4f {
  let H = floor(p_pixels());
  let n = vec2f(max(1.0, floor(H * aspect() + 0.5)), H);
  let k = max(1.0, floor(H / 180.0 + 0.5));
  let pc = floor(uv * n);
  let X = floor(pc.x / k);
  let Y = floor(pc.y / k);
  let DH = floor(H / k);
  let DW = floor(n.x / k);
  let bt = beats();
  let beat = floor(bt);
  let kick = p_kick();
  let stageY = floor(DH * 0.7);       // front edge of the stage
  let cxs = floor(DW * 0.5);

  // back wall
  var col = mix(hx(0x0b0820u), hx(0x1d2b53u), Y / DH) * (0.6 + 0.6 * rms());

  // LED equalizer wall: 16 columns of blocks, green to yellow to red
  let ex0 = floor(DW * 0.12);
  let ex1 = DW - ex0;
  let ey0 = 14.0;
  let ey1 = stageY - 8.0;
  if (X >= ex0 && X < ex1 && Y >= ey0 && Y < ey1) {
    let cw = (ex1 - ex0) / 16.0;
    let ci = floor((X - ex0) / cw);
    let lx = X - ex0 - ci * cw;
    let rows = floor((ey1 - ey0) / 5.0);
    let ri = floor((ey1 - 1.0 - Y) / 5.0);       // 0 = bottom block
    let ly = (ey1 - 1.0 - Y) - ri * 5.0;
    if (lx >= 1.0 && lx < cw - 1.0 && ly < 4.0) {
      let lvl = clamp(band(i32(ci)) * p_eq(), 0.0, 1.0) * rows;
      let f = ri / max(rows - 1.0, 1.0);
      var c = hx(0x00e436u);
      if (f > 0.55) { c = hx(0xffec27u); }
      if (f > 0.8) { c = hx(0xff004du); }
      if (ri < floor(lvl + 0.5)) { col = c * (1.1 + 0.6 * kick); }
      else { col = mix(col, c * 0.05, 0.85); }
    }
  }

  // truss with chasing lamps
  if (Y >= 2.0 && Y < 6.0) { col = hx(0x5f574fu); if ((u32(X) % 6u) < 1u || Y == 2.0 || Y == 5.0) { col = hx(0x83769cu); } }
  let lamp = floor(X / 16.0);
  let lx = X - lamp * 16.0 - 8.0;
  if (Y >= 6.0 && Y < 10.0 && abs(lx) < 2.5) {
    let on = (u32(lamp + beat) % 4u) == 0u || kick > 0.5 || bass() > 0.7;
    col = select(hx(0x2a2244u), neon(lamp * 0.17 + beat * 0.25) * 2.0, on);
  }

  // spotlights from the truss, sweeping, pumping with the bass
  let sl = p_lights() * (0.15 + 0.85 * bass() + 0.5 * kick);
  for (var i = 0; i < 4; i++) {
    let fi = f32(i);
    let ox = DW * (0.2 + 0.2 * fi);
    let ang = sin(time() * (0.7 + 0.23 * fi) + fi * 2.0) * 0.55;
    let d = vec2f(X - ox, Y - 8.0);
    if (d.y > 0.0) {
      let a = atan2(d.x, d.y) - ang;
      let w = 0.09 + 0.03 * bass();
      if (abs(a) < w) {
        let fall = 1.0 - clamp(d.y / (DH * 1.1), 0.0, 1.0);
        col += neon(fi * 0.25 + floor(bt / 4.0) * 0.17) * sl * 0.45 * fall;
      }
    }
  }

  // speaker stacks with pumping woofers
  let sw = floor(DW * 0.1);
  let sx = select(X, DW - 1.0 - X, X > cxs);
  if (sx < sw && Y >= stageY - 62.0 && Y < stageY) {
    col = hx(0x15111fu);
    if (sx < 1.0 || sx >= sw - 1.0) { col = hx(0x3a3358u); }
    let cell = floor((Y - (stageY - 62.0)) / 20.0);
    let cy = stageY - 62.0 + cell * 20.0 + 10.0;
    let r = length(vec2f(sx - sw * 0.5, Y - cy));
    let rr = 5.0 + 3.0 * bass() + 2.0 * kick;
    if (r < rr) { col = select(hx(0x5f574fu), hx(0x0b0820u), r < rr - 1.5); }
    if (r < 2.0) { col = hx(0xc2c3c7u) * (1.0 + bass()); }
  }

  // the stage: lit front edge with footlights, then a disco floor
  if (Y == stageY) { col = hx(0xc2c3c7u) * (0.8 + 0.6 * rms()); }
  if (Y == stageY + 1.0 && (u32(X) % 8u) < 2u) {
    col = neon(floor(X / 8.0) * 0.13 + beat * 0.21) * (0.5 + 1.8 * bass());
  }
  if (Y > stageY + 1.0) {
    let z = (Y - stageY) / (DH - stageY);
    let tw = 8.0 + 14.0 * z;
    let tx = floor((X - cxs) / tw);
    let tz = floor(z * 6.0);
    let even = (u32(tx + 100.0 + tz) % 2u) == 0u;
    col = select(hx(0x0b0820u), hx(0x1d1736u), even);
    let lit = hh(tx * 7.0 + tz, beat) < 0.15 + 0.55 * bass() + 0.3 * kick;
    if (lit) { col = neon(hh(tx, tz) + beat * 0.13) * (0.5 + 0.8 * rms()); }
    // tile edges
    let fx = (X - cxs) / tw - tx;
    if (fx < 1.0 / tw) { col *= 0.5; }
  }

  // dancers: a frame per beat, a jump on the bass
  let nd = i32(p_dancers());
  let fb = floor(bt * p_per_beat());
  for (var i = 0; i < nd; i++) {
    let fi = f32(i);
    let slot = fi - f32(nd - 1) * 0.5;
    let lead = abs(slot) < 0.25;
    let sc = select(2.0, 3.0, lead);
    let dx = floor(cxs + slot * DW * 0.13) - 5.0 * sc;
    let jump = floor((bass() * 6.0 + kick * 4.0) * select(1.0, 1.5, lead) * (0.6 + 0.4 * hh(fi, 3.0)));
    let feet = stageY + 6.0 - jump;
    let dy = feet - 14.0 * sc;
    let fr = u32(fb + fi * select(1.0, 0.0, lead)) % 4u;
    let v = dancer(floor((X - dx) / sc), floor((Y - dy) / sc), fr);
    if (v > 0u) {
      var c = hx(0xffccaau);
      if (v == 2u) { c = neon(fi * 0.21 + 0.6); }
      if (v == 3u) { c = neon(fi * 0.21 + 0.1) * 0.7; }
      col = c * (1.0 + 0.4 * kick);
    } else if (X >= dx - 1.0 && X <= dx + 10.0 * sc && Y >= dy - 1.0 && Y <= feet) {
      // a one-pixel dark outline keeps the sprite readable on the bright wall
      let o = dancer(floor((X + 1.0 - dx) / sc), floor((Y - dy) / sc), fr)
            + dancer(floor((X - 1.0 - dx) / sc), floor((Y - dy) / sc), fr)
            + dancer(floor((X - dx) / sc), floor((Y + 1.0 - dy) / sc), fr)
            + dancer(floor((X - dx) / sc), floor((Y - 1.0 - dy) / sc), fr);
      if (o > 0u) { col = hx(0x0b0820u); }
    }
    // a shadow under each dancer
    if (Y == stageY + 7.0 && abs(X - dx - 5.0 * sc) < 4.0 * sc - jump) { col *= 0.4; }
  }

  return vec4f(col * p_glow(), 1.0);
}
