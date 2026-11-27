// Pixel city: a night skyline on a low-res grid, in design pixels (about 180 rows).

fn hh(a: f32, b: f32) -> f32 {
  return f32(h32(bitcast<u32>(i32(floor(a))), bitcast<u32>(i32(floor(b)))) >> 8u) / 16777216.0;
}
fn hx(c: u32) -> vec3f {
  let s = vec3f(f32((c >> 16u) & 255u), f32((c >> 8u) & 255u), f32(c & 255u)) / 255.0;
  return pow(s, vec3f(2.2));
}
fn spec(x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * 15.0;
  let i = i32(floor(f));
  return mix(band(i), band(i + 1), f - floor(f));
}
fn hats() -> f32 { return (band(11) + band(12) + band(13) + band(14) + band(15)) / 5.0; }
fn neon(x: f32) -> vec3f {
  // pink, cyan, mint, amber, violet around the wheel
  let k = fract(x + p_hue()) * 5.0;
  let i = u32(floor(k)) % 5u;
  var c = array<u32, 5>(0xff3fa4u, 0x2de2ffu, 0x3dff9eu, 0xffb03au, 0xa95bffu);
  return hx(c[i]);
}

// eighth-note glyph, 5 x 6, bit = row * 5 + col
const NOTE = 0xe725184u;
fn note_px(lx: f32, ly: f32) -> bool {
  if (lx < 0.0 || ly < 0.0 || lx > 4.0 || ly > 5.0) { return false; }
  let b = u32(ly) * 5u + u32(lx);
  return ((NOTE >> b) & 1u) == 1u;
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
  let t = time();
  let gy = floor(DH * 0.84);       // street level
  let fl = p_flash();

  // sky: deep navy to a violet city glow, lifted by the loudness; lightning washes it
  let g = clamp(Y / gy, 0.0, 1.0);
  var col = mix(hx(0x070618u), hx(0x5a1f78u), g * g * g) * (0.55 + 0.9 * rms());
  col += hx(0xff3fa4u) * 0.25 * pow(g, 6.0) * (0.3 + bass());
  // stars
  if (hh(X, Y * 7.0 + 3.0) > 0.992 && g < 0.6) { col += vec3f(0.5 + 0.8 * hats()); }
  // moon with two craters
  let mc = vec2f(floor(DW * 0.16), floor(DH * 0.2));
  let md = length(vec2f(X, Y) - mc);
  if (md < 12.0) {
    col = hx(0xf3ecd2u) * (1.0 + 0.5 * bass());
    if (length(vec2f(X, Y) - mc - vec2f(-4.0, -3.0)) < 3.0 || length(vec2f(X, Y) - mc - vec2f(3.0, 4.0)) < 2.0) { col = hx(0xb8ae9au); }
  } else if (md < 15.0) { col += hx(0xf3ecd2u) * 0.08; }
  col = mix(col, hx(0xc8d0ffu) * 1.2, fl * 0.85);
  // the bolt
  if (fl > 0.3 && Y < gy) {
    let seed = floor(t * 1.5);
    let bx = floor(DW * (0.3 + 0.45 * hh(seed, 5.0)));
    let seg = floor(Y / 6.0);
    let off = floor((hh(seg, seed) - 0.5) * 8.0) + floor((hh(seg * 3.0 + 1.0, seed) - 0.5) * 4.0);
    if (abs(X - bx - off) < 1.0 && Y < gy * (0.5 + 0.5 * fl)) { col = vec3f(2.5); }
  }

  // three rows of towers, far to near
  let rate = array<f32, 3>(4.0, 9.0, 16.0);
  let cwid = array<f32, 3>(9.0, 14.0, 21.0);
  let lo = array<f32, 3>(0.38, 0.22, 0.12);
  let hi = array<f32, 3>(0.62, 0.5, 0.36);
  let body = array<u32, 3>(0x221a4au, 0x1a1238u, 0x0e0a1eu);
  for (var L = 0; L < 3; L++) {
    let fL = f32(L);
    let scroll = floor(t * p_speed() * rate[L]);
    let xs = X + scroll + fL * 1000.0;
    let cw = cwid[L];
    let ci = floor(xs / cw);
    let lx = xs - ci * cw;
    let bw = floor(cw * (0.6 + 0.35 * hh(ci, fL)));
    var bh = floor(gy * (lo[L] + (hi[L] - lo[L]) * hh(ci, fL + 7.0)));
    if (L == 1) {
      // the middle row is an equalizer: each tower grows with its band
      let cx = (ci * cw + bw * 0.5 - scroll - fL * 1000.0) / DW;
      bh += floor(gy * 0.32 * spec(cx));
    }
    let top = gy - bh;
    if (lx < bw && Y >= top && Y < gy) {
      var c = hx(body[L]) * (1.0 + 0.6 * fl);
      if (lx < 1.0) { c *= 1.8; }                 // moonlit edge
      if (Y < top + 1.0) { c *= 1.5; }            // roof line
      // windows
      let wx = 3.0 + fL;
      let wy = 4.0 + fL;
      let ix = floor((lx - 1.0) / wx);
      let iy = floor((Y - top - 2.0) / wy);
      let inwin = lx >= 1.0 && lx < bw - 1.0 && Y >= top + 2.0 && (lx - 1.0 - ix * wx) < wx - 1.0 && (Y - top - 2.0 - iy * wy) < wy - 2.0;
      if (inwin) {
        let id = ci * 131.0 + ix * 17.0 + iy * 7.0 + fL * 5000.0;
        let base = select(0.0, 1.0, hh(id, 1.0) < 0.22 + 0.06 * fL);
        let flick = select(0.0, 1.0, hh(id, floor(t * 10.0)) < p_hats() * hats() * 0.95);
        let on = max(base * 0.55, flick);
        let warm = hh(id, 2.0) < 0.7;
        let wc = select(hx(0x6fe8ffu), hx(0xffcf5au), warm);
        c = mix(c * 0.8, wc * (0.7 + 1.0 * on), on) * (1.0 - 0.3 * f32(L == 0));
      }
      // neon sign on the near row, pumping with the bass
      if (L == 2 && hh(ci, 33.0) < 0.5) {
        let sy = top + 4.0 + floor(hh(ci, 34.0) * 6.0);
        if (lx >= bw - 3.0 && lx < bw - 1.0 && Y >= sy && Y < sy + 14.0) {
          let blink = select(1.0, 0.25, (u32(Y - sy) % 4u) == 3u && lx == bw - 2.0);
          c = neon(hh(ci, 35.0)) * (0.35 + 2.2 * bass()) * blink;
        }
      }
      col = c;
    }
    // antennas and their beacons sit above the roof
    if (L > 0 && lx < bw && hh(ci, fL + 21.0) < 0.35) {
      let ax = floor(bw * 0.5);
      if (lx == ax && Y < top && Y >= top - 6.0) { col = hx(0x5a5478u); }
      if (lx == ax && Y == top - 7.0) {
        let on = fract(phase() + hh(ci, 9.0) * 0.5) < 0.3 || bass() > 0.55;
        col = select(hx(0x40080eu), hx(0xff2030u) * 2.0, on);
      }
    }
  }

  // the street: kerb, wet asphalt, lane dashes, cars
  if (Y >= gy) {
    col = hx(0x0c0a18u) * (1.0 + 0.8 * fl);
    if (Y == gy) { col = hx(0x3a3358u); }
    let rd = DH - gy;
    let lane = gy + floor(rd * 0.5);
    let tv = t * 30.0 * p_speed() * (0.6 + rms());
    if (Y == lane && fract((X + tv * 0.5) / 8.0) < 0.5) { col = hx(0x6a6488u); }
    // upper lane: taillights moving left; lower lane: headlights moving right
    let up = Y > gy + 1.0 && Y < lane - 1.0;
    let dn = Y > lane + 1.0 && Y < DH - 1.0;
    if (up || dn) {
      let dir = select(1.0, -1.0, dn);
      let xx = X + dir * tv * 1.6 + select(0.0, 500.0, dn);
      let slot = floor(xx / 36.0);
      let cx = xx - slot * 36.0 - floor(hh(slot, select(3.0, 4.0, dn)) * 18.0);
      if (hh(slot, 6.0) < 0.6 && cx >= 0.0 && cx < 11.0) {
        col = hx(0x2a2244u);
        let front = select((cx < 2.0), (cx > 8.0), dn);
        let ly = select((Y == lane - 3.0), (Y == DH - 3.0), dn);
        if (front && ly) { col = select(hx(0xff1830u) * (1.0 + 2.0 * bass()), hx(0xfff2b0u) * 2.2, dn); }
      }
    }
    // neon reflections on the wet road: shimmering stripes under the signs
    let rs = floor(t * p_speed() * 16.0);
    let rxs = X + rs + 2000.0;
    let rx = floor(rxs / 21.0);
    let rl = rxs - rx * 21.0;
    let rbw = floor(21.0 * (0.6 + 0.35 * hh(rx, 2.0)));
    if (hh(rx, 33.0) < 0.5 && rl >= rbw - 4.0 && rl < rbw && Y > gy + 1.0 && hh(Y, floor(t * 8.0) + rx) < 0.6) {
      col += neon(hh(rx, 35.0)) * 0.3 * (0.3 + 1.5 * bass());
    }
  }

  // slanted rain: one pixel right every two rows
  let u = X + floor(Y * 0.5);
  let rc = floor(u / 4.0);
  if (u - rc * 4.0 < 1.0 && hh(rc, 5.0) < p_rain()) {
    let v = (80.0 + 50.0 * hh(rc, 6.0)) * (0.7 + 0.8 * rms());
    let per = 40.0 + 40.0 * hh(rc, 8.0);
    let yy = Y - t * v + hh(rc, 7.0) * per;
    if (yy - floor(yy / per) * per < 6.0) { col = col * 0.7 + hx(0x8ea2e8u) * (0.25 + 0.45 * hats()); }
  }

  // falling note sprites
  let lw = 22.0;
  let li = floor(X / lw);
  if (hh(li, 9.0) < p_notes()) {
    let nx = li * lw + 4.0 + floor(hh(li, 10.0) * 12.0);
    let fall = 16.0 + 14.0 * hh(li, 11.0);
    let ny = floor((fract(hh(li, 12.0) + t * fall / (gy + 12.0))) * (gy + 12.0)) - 8.0;
    if (note_px(X - nx, Y - ny)) { col = neon(hh(li, 13.0)) * (0.8 + 1.4 * hats() + bass()); }
  }

  return vec4f(col * p_glow(), 1.0);
}
