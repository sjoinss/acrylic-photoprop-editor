/* 아크릴 포토프랍 코어: DOM 없이 동작해요. 나중에 단일 HTML 안에 그대로 넣어요.
 * 좌표는 mm(왼쪽 위 원점, y 아래쪽). 래스터 픽셀 중심 = (i + 0.5 - pad) / ppm. */
(function (root) {
  'use strict';
  const INF = 1e20;

  // ---------- 격자 ----------
  /** padMm: 닫기 연산이 격자 가장자리에서 잘리지 않도록 필요한 추가 여백 */
  function makeGrid(plate, ppm, padMm = 0) {
    const pad = Math.max(4, Math.ceil(padMm * ppm) + 4);
    return {
      ppm, pad,
      w: Math.ceil(plate.w * ppm) + pad * 2,
      h: Math.ceil(plate.h * ppm) + pad * 2,
    };
  }
  function pickPpm(plate, maxPixels, maxPpm) {
    return Math.min(maxPpm, Math.sqrt(maxPixels / (plate.w * plate.h)));
  }
  const toMm = (g, i) => (i + 0.5 - g.pad) / g.ppm;

  // ---------- 거리 변환 (Felzenszwalb) ----------
  /** mask에서 값이 target인 가장 가까운 픽셀까지의 거리(px) */
  function edt(mask, w, h, target = 1) {
    const n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n);
    const v = new Int32Array(n), z = new Float64Array(n + 1);
    const sq = new Float64Array(w * h);
    for (let i = 0; i < sq.length; i++) sq[i] = mask[i] === target ? 0 : INF;

    function pass(len) {
      let k = -1;
      for (let q = 0; q < len; q++) {
        if (f[q] >= INF) continue;
        let s = -Infinity;
        while (k >= 0) {
          const p = v[k];
          s = (f[q] + q * q - f[p] - p * p) / (2 * (q - p));
          if (s > z[k]) break;
          k--;
        }
        k++;
        v[k] = q;
        z[k] = k === 0 ? -Infinity : s;
        z[k + 1] = Infinity;
      }
      if (k < 0) { for (let q = 0; q < len; q++) d[q] = INF; return; }
      let j = 0;
      for (let q = 0; q < len; q++) {
        while (z[j + 1] < q) j++;
        const dx = q - v[j];
        d[q] = dx * dx + f[v[j]];
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = sq[y * w + x];
      pass(h);
      for (let y = 0; y < h; y++) sq[y * w + x] = d[y];
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) f[x] = sq[o + x];
      pass(w);
      for (let x = 0; x < w; x++) out[o + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  // ---------- 모폴로지 / SDF ----------
  function dilate(mask, w, h, r) {
    if (r <= 0) return mask.slice();
    const d = edt(mask, w, h, 1), out = new Uint8Array(mask.length);
    for (let i = 0; i < out.length; i++) out[i] = d[i] <= r + 0.5 ? 1 : 0;
    return out;
  }
  function erode(mask, w, h, r) {
    if (r <= 0) return mask.slice();
    const d = edt(mask, w, h, 0), out = new Uint8Array(mask.length);
    for (let i = 0; i < out.length; i++) out[i] = d[i] > r + 0.5 ? 1 : 0;
    return out;
  }
  const closing = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);
  const opening = (m, w, h, r) => dilate(erode(m, w, h, r), w, h, r);
  /** 밖 = 양수, 안 = 음수 (px) */
  function sdf(mask, w, h) {
    const inD = edt(mask, w, h, 0), outD = edt(mask, w, h, 1);
    const out = new Float32Array(mask.length);
    for (let i = 0; i < out.length; i++) out[i] = mask[i] ? -(inD[i] - 0.5) : outD[i] - 0.5;
    return out;
  }

  // ---------- 연결 요소 ----------
  /** 전경(1) 라벨링. 반환: labels(1부터), areas[label] */
  function label(mask, w, h, conn8 = true) {
    const labels = new Int32Array(mask.length), areas = [0];
    const stack = new Int32Array(mask.length);
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || labels[s]) continue;
      const id = areas.length;
      let top = 0, area = 0;
      stack[top++] = s; labels[s] = id;
      while (top) {
        const i = stack[--top]; area++;
        const x = i % w, y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!conn8 && dx && dy)) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && !labels[j]) { labels[j] = id; stack[top++] = j; }
        }
      }
      areas.push(area);
    }
    return { labels, areas };
  }
  /** 지정한 라벨들의 외접 상자(px) */
  function labelBoxes(labels, count, w, ids) {
    const b = Array.from({ length: count }, () => null), want = new Uint8Array(count);
    ids.forEach((i) => { want[i] = 1; });
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (!l || !want[l]) continue;
      const x = i % w, y = (i - x) / w, o = b[l];
      if (!o) b[l] = { x0: x, y0: y, x1: x, y1: y };
      else { if (x < o.x0) o.x0 = x; if (x > o.x1) o.x1 = x; if (y > o.y1) o.y1 = y; }
    }
    return ids.map((i) => b[i]);
  }
  const boxMm = (g, b) => ({ x0: toMm(g, b.x0), y0: toMm(g, b.y0), x1: toMm(g, b.x1), y1: toMm(g, b.y1) });
  function fillHoles(mask, w, h) {
    const out = new Uint8Array(mask.length).fill(1);
    const stack = new Int32Array(mask.length);
    let top = 0;
    const visit = (i) => { if (!mask[i] && out[i]) { out[i] = 0; stack[top++] = i; } };
    for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
    while (top) {
      const i = stack[--top], x = i % w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i + w < mask.length) visit(i + w);
    }
    return out;
  }
  /** 4-연결로 가장 큰 조각만 남겨요(대각선 한 점으로만 이어진 조각은 별개). */
  function keepLargest(mask, w, h) {
    const { labels, areas } = label(mask, w, h, false);
    let best = 0;
    for (let i = 1; i < areas.length; i++) if (areas[i] > areas[best]) best = i;
    const out = new Uint8Array(mask.length);
    if (best) for (let i = 0; i < out.length; i++) out[i] = labels[i] === best ? 1 : 0;
    const rest = [];
    for (let i = 1; i < areas.length; i++) if (i !== best) rest.push(i);
    return { mask: out, removed: rest.length, boxes: rest.length ? labelBoxes(labels, areas.length, w, rest) : [] };
  }

  // ---------- 박스 블러 ----------
  function boxBlur(src, w, h, r) {
    if (r < 1) return src.slice();
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    const n = 2 * r + 1;
    const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
    const line = (from, to, o, step, len) => {
      let s = 0;
      for (let k = -r; k <= r; k++) s += from[o + clamp(k, len - 1) * step];
      for (let i = 0; i < len; i++) {
        to[o + i * step] = s / n;
        s += from[o + clamp(i + r + 1, len - 1) * step] - from[o + clamp(i - r, len - 1) * step];
      }
    };
    for (let y = 0; y < h; y++) line(src, tmp, y * w, 1, w);
    for (let x = 0; x < w; x++) line(tmp, out, x, w, h);
    return out;
  }

  // ---------- Marching squares ----------
  /** field > 0 이 안쪽. 닫힌 루프(픽셀 중심 좌표) 배열을 돌려줘요. */
  function marchingSquares(field, w, h) {
    const val = (x, y) => (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1)
      ? Math.min(field[y * w + x], -1e-3) : field[y * w + x];
    const next = new Int32Array(2 * w * h).fill(-1);
    const starts = [];
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const a = val(x, y), b = val(x + 1, y), c = val(x + 1, y + 1), d = val(x, y + 1);
      const code = (a > 0 ? 8 : 0) | (b > 0 ? 4 : 0) | (c > 0 ? 2 : 0) | (d > 0 ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = 2 * (y * w + x), B = T + 2 * w, L = T + 1, R = T + 3;
      const seg = (s, e) => { next[s] = e; starts.push(s); };
      const joined = () => a + b + c + d > 0;
      switch (code) { // 진행 방향의 왼쪽이 안쪽
        case 8: seg(L, T); break;
        case 4: seg(T, R); break;
        case 2: seg(R, B); break;
        case 1: seg(B, L); break;
        case 12: seg(L, R); break;
        case 6: seg(T, B); break;
        case 3: seg(R, L); break;
        case 9: seg(B, T); break;
        case 7: seg(T, L); break;
        case 11: seg(R, T); break;
        case 13: seg(B, R); break;
        case 14: seg(L, B); break;
        case 10: if (joined()) { seg(R, T); seg(L, B); } else { seg(L, T); seg(R, B); } break;
        case 5: if (joined()) { seg(T, L); seg(B, R); } else { seg(T, R); seg(B, L); } break;
      }
    }
    const point = (e) => {
      const i = e >> 1, x = i % w, y = (i - x) / w, v0 = val(x, y);
      if (e & 1) { const v1 = val(x, y + 1); return [x, y + v0 / (v0 - v1)]; }
      const v1 = val(x + 1, y); return [x + v0 / (v0 - v1), y];
    };
    const loops = [];
    for (const s of starts) {
      if (next[s] < 0) continue;
      const loop = [];
      let e = s;
      while (next[e] >= 0) { loop.push(point(e)); const n = next[e]; next[e] = -1; e = n; }
      if (e !== s) throw new Error('윤곽선이 닫히지 않았어요');
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  // ---------- Douglas–Peucker (닫힌 루프) ----------
  function simplifyClosed(pts, tol) {
    const n = pts.length;
    if (n < 4) return pts.slice();
    const far = (from) => {
      let best = from, bd = -1;
      for (let i = 0; i < n; i++) {
        const d = (pts[i][0] - pts[from][0]) ** 2 + (pts[i][1] - pts[from][1]) ** 2;
        if (d > bd) { bd = d; best = i; }
      }
      return best;
    };
    // 두 번 탐색해 근사 지름의 양 끝점에서 분할
    const i0 = far(0), j0 = far(i0);
    const s = Math.min(i0, j0), m = Math.max(i0, j0) - s;
    const p = []; // s에서 시작하도록 회전 + 시작점 반복
    for (let i = 0; i <= n; i++) p.push(pts[(s + i) % n]);
    const keep = new Uint8Array(n + 1);
    keep[0] = keep[m] = keep[n] = 1;
    const stack = [[0, m], [m, n]], t2 = tol * tol;
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = p[a][0], ay = p[a][1], dx = p[b][0] - ax, dy = p[b][1] - ay;
      const l2 = dx * dx + dy * dy;
      let best = -1, bd = t2;
      for (let i = a + 1; i < b; i++) {
        const px = p[i][0] - ax, py = p[i][1] - ay;
        let t = l2 ? (px * dx + py * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
        if (d > bd) { bd = d; best = i; }
      }
      if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i]);
    return out;
  }
  function contoursMm(field, g, tolMm) {
    return marchingSquares(field, g.w, g.h)
      .map((l) => simplifyClosed(l.map(([x, y]) => [toMm(g, x), toMm(g, y)]), tolMm))
      .filter((l) => l.length >= 3);
  }

  // ---------- 이미지 ----------
  /** 회전 후 외접 상자 */
  function imageAABB(im) {
    const a = (im.rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const hw = (im.w * c + im.h * s) / 2, hh = (im.w * s + im.h * c) / 2;
    const cx = im.x + im.w / 2, cy = im.y + im.h / 2;
    return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
  }
  function unionBox(boxes) {
    return boxes.reduce((u, b) => ({
      x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0),
      x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1),
    }));
  }
  /** images[].pixels = {w,h,data(RGBA)}. 합성 알파(0~1)를 돌려줘요. 슈퍼샘플링 + 최근접. */
  function rasterAlpha(images, g) {
    const out = new Float32Array(g.w * g.h);
    for (const im of images) {
      const px = im.pixels, a = (im.rot || 0) * Math.PI / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      const cx = im.x + im.w / 2, cy = im.y + im.h / 2, box = imageAABB(im);
      const ss = Math.max(2, Math.min(4, Math.ceil(Math.max(px.w / im.w, px.h / im.h) / g.ppm)));
      const lo = (mm) => Math.max(0, Math.floor(mm * g.ppm + g.pad) - 1);
      const x1 = Math.min(g.w, Math.ceil(box.x1 * g.ppm + g.pad) + 1);
      const y1 = Math.min(g.h, Math.ceil(box.y1 * g.ppm + g.pad) + 1);
      for (let y = lo(box.y0); y < y1; y++) for (let x = lo(box.x0); x < x1; x++) {
        let sum = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
          const dx = (x + (sx + 0.5) / ss - g.pad) / g.ppm - cx;
          const dy = (y + (sy + 0.5) / ss - g.pad) / g.ppm - cy;
          let u = (dx * cos + dy * sin) / im.w, v = (-dx * sin + dy * cos) / im.h;
          if (im.flipH) u = -u;
          if (im.flipV) v = -v;
          const ix = Math.floor((u + 0.5) * px.w), iy = Math.floor((v + 0.5) * px.h);
          if (ix >= 0 && iy >= 0 && ix < px.w && iy < px.h) sum += px.data[(iy * px.w + ix) * 4 + 3];
        }
        const al = sum / (255 * ss * ss), i = y * g.w + x;
        out[i] = 1 - (1 - out[i]) * (1 - al);
      }
    }
    return out;
  }

  // ---------- 칼선 ----------
  /** 모서리별 반경 사각형을 마스크에 합쳐요. */
  function paintRoundRect(mask, g, b, r) {
    const max = Math.min(b.x1 - b.x0, b.y1 - b.y0) / 2;
    const R = (v) => Math.max(0, Math.min(v || 0, max));
    const tl = R(r.tl), tr = R(r.tr), br = R(r.br), bl = R(r.bl);
    for (let y = 0; y < g.h; y++) {
      const my = toMm(g, y);
      if (my < b.y0 || my > b.y1) continue;
      for (let x = 0; x < g.w; x++) {
        const mx = toMm(g, x);
        if (mx < b.x0 || mx > b.x1) continue;
        const left = mx - b.x0, right = b.x1 - mx, top = my - b.y0, bot = b.y1 - my;
        const cut = (rad, p, q) => p < rad && q < rad && (rad - p) ** 2 + (rad - q) ** 2 > rad * rad;
        if (cut(tl, left, top) || cut(tr, right, top) || cut(br, right, bot) || cut(bl, left, bot)) continue;
        mask[y * g.w + x] = 1;
      }
    }
  }
  function maskBox(mask, g) {
    let x0 = g.w, y0 = g.h, x1 = -1, y1 = -1;
    for (let i = 0; i < mask.length; i++) if (mask[i]) {
      const x = i % g.w, y = (i - x) / g.w;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    return { x0: (x0 - g.pad) / g.ppm, y0: (y0 - g.pad) / g.ppm, x1: (x1 + 1 - g.pad) / g.ppm, y1: (y1 + 1 - g.pad) / g.ppm };
  }
  function stickRect(st, body, plate) {
    const horiz = st.side === 'left' || st.side === 'right';
    const lo = horiz ? body.y0 : body.x0, hi = horiz ? body.y1 : body.x1;
    const half = st.width / 2;
    const c = st.pos === 'start' ? lo + half : st.pos === 'end' ? hi - half : (lo + hi) / 2;
    const er = st.endStyle === 'square' ? 0 : Math.min(st.endRadius, half);
    const em = st.edgeMargin, len = st.length;
    const mx = (body.x0 + body.x1) / 2, my = (body.y0 + body.y1) / 2;
    switch (st.side) {
      case 'top': return { box: { x0: c - half, x1: c + half, y0: st.toEnd ? em : body.y0 - len, y1: my }, r: { tl: er, tr: er } };
      case 'left': return { box: { y0: c - half, y1: c + half, x0: st.toEnd ? em : body.x0 - len, x1: mx }, r: { tl: er, bl: er } };
      case 'right': return { box: { y0: c - half, y1: c + half, x1: st.toEnd ? plate.w - em : body.x1 + len, x0: mx }, r: { tr: er, br: er } };
      default: return { box: { x0: c - half, x1: c + half, y1: st.toEnd ? plate.h - em : body.y1 + len, y0: my }, r: { bl: er, br: er } };
    }
  }
  const gridForCut = (plate, ppm, cut) =>
    makeGrid(plate, ppm, cut.stick && cut.stick.on ? cut.stick.jointRadius : 0);

  /** 반환: { mask, sdf, loops(mm), removed } */
  function buildCut(design, plate, g, alpha) {
    const cut = design.cut, { w, h } = g;
    let exact = null;
    let mask = new Uint8Array(w * h);
    if (!design.images.length) return { mask, sdf: sdf(mask, w, h), loops: [], curves: [], removed: 0, removedBoxes: [] };
    if (cut.shape === 'follow') {
      for (let i = 0; i < mask.length; i++) mask[i] = alpha[i] >= 0.08 ? 1 : 0;
      mask = dilate(mask, w, h, cut.margin * g.ppm);
    } else {
      const b = unionBox(design.images.map(imageAABB)), m = cut.margin;
      const box = { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m };
      if (cut.shape === 'circle') {
        const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
        const rx = (box.x1 - box.x0) / 2, ry = (box.y1 - box.y0) / 2;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
          if (((toMm(g, x) - cx) / rx) ** 2 + ((toMm(g, y) - cy) / ry) ** 2 <= 1) mask[y * w + x] = 1;
        if (!cut.stick || !cut.stick.on) exact = ellipseCurve(box);
      } else {
        const min = (v) => Math.max(0.5, v || 0);
        const r = cut.shape === 'rect' ? { tl: 0.5, tr: 0.5, br: 0.5, bl: 0.5 }
          : { tl: min(cut.radii.tl), tr: min(cut.radii.tr), br: min(cut.radii.br), bl: min(cut.radii.bl) };
        paintRoundRect(mask, g, box, r);
        exact = analyticCut(box, r, cut.stick, plate);
      }
    }
    const body = maskBox(mask, g), st = cut.stick;
    if (st && st.on && body) {
      const s = stickRect(st, body, plate);
      paintRoundRect(mask, g, s.box, s.r);
      if (st.jointRadius > 0) mask = closing(mask, w, h, st.jointRadius * g.ppm);
    }
    if (cut.shape === 'follow') mask = opening(mask, w, h, Math.max(0.5, cut.radii.tl) * g.ppm);
    const kept = keepLargest(fillHoles(mask, w, h), w, h);
    // 이진 마스크 계단을 줄여요. 직선의 거리장은 선형이라 직선 위치는 변하지 않아요.
    const raw = sdf(kept.mask, w, h);
    const s = boxBlur(boxBlur(raw, w, h, 1), w, h, 1);
    const inner = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) inner[i] = -s[i];
    const mmLoops = (f) => marchingSquares(f, w, h).map((l) => l.map(([x, y]) => [toMm(g, x), toMm(g, y)]));
    const raw1 = mmLoops(inner);
    // 곡선 맞추기용: 거리장을 조금 더 흐려 계단 노이즈를 없애요(반경 1mm 모서리에서 이동량 약 0.01mm).
    const soft = exact ? raw1 : mmLoops(boxBlur(boxBlur(inner, w, h, 2), w, h, 2));
    const curves = raw1.map((l) => cutCurve(l, exact, g.ppm, soft.length === raw1.length && raw1.length === 1 ? soft[0] : l));
    return { mask: kept.mask, sdf: s, curves, loops: curves.map(flattenCurve), removed: kept.removed, removedBoxes: kept.boxes.map((b) => boxMm(g, b)) };
  }

  // ---------- 칼선 곡선(베지어) ----------
  // 곡선 1개 = { p: [x, y], segs: [[x, y] | [x1, y1, x2, y2, x, y], ...] } (닫힘, 마지막 점 = p)
  const KAPPA = 0.5522847498;
  const segEnd = (s) => s.slice(-2);
  function flattenCurve(cv) {
    const out = [cv.p.slice()];
    let p = cv.p;
    for (const s of cv.segs) {
      if (s.length === 2) out.push(s.slice());
      else {
        const len = Math.hypot(s[0] - p[0], s[1] - p[1]) + Math.hypot(s[2] - s[0], s[3] - s[1]) + Math.hypot(s[4] - s[2], s[5] - s[3]);
        const n = Math.max(8, Math.min(400, Math.ceil(len / 0.1)));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          out.push([0, 1].map((k) => u * u * u * p[k] + 3 * u * u * t * s[k] + 3 * u * t * t * s[2 + k] + t * t * t * s[4 + k]));
        }
      }
      p = segEnd(s);
    }
    out.pop(); // 시작점과 같은 점
    return out;
  }
  /** 축에 나란한 꼭짓점 + 반경 → 직선과 모서리 곡선 */
  function roundedPolygon(v) {
    const n = v.length, segs = [];
    const dir = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
    let start = null;
    for (let i = 0; i < n; i++) {
      const [x, y, r] = v[i], a = dir(v[(i + n - 1) % n], v[i]), b = dir(v[i], v[(i + 1) % n]);
      const s = [x - a[0] * r, y - a[1] * r], e = [x + b[0] * r, y + b[1] * r], k = r * (1 - KAPPA);
      if (!start) start = s; else segs.push(s);
      if (r > 0) segs.push([x - a[0] * k, y - a[1] * k, x + b[0] * k, y + b[1] * k, ...e]);
    }
    segs.push(start.slice());
    return { p: start, segs };
  }
  /** 치수에서 바로 구할 수 있는 모양이면 정확한 곡선, 아니면 null */
  function analyticCut(box, r, st, plate) {
    const max = Math.min(box.x1 - box.x0, box.y1 - box.y0) / 2, R = (v) => Math.min(v, max);
    // 꼭짓점 순서: 왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래
    const c = [[box.x0, box.y0, R(r.tl)], [box.x1, box.y0, R(r.tr)], [box.x1, box.y1, R(r.br)], [box.x0, box.y1, R(r.bl)]];
    if (!st || !st.on) return roundedPolygon(c);
    const s = stickRect(st, box, plate), b = s.box, j = st.jointRadius;
    const er = st.endStyle === 'square' ? 0 : Math.min(st.endRadius, st.width / 2);
    const side = { top: 0, right: 1, bottom: 2, left: 3 }[st.side];
    const bodyEdge = { top: box.y0, right: box.x1, bottom: box.y1, left: box.x0 }[st.side];
    const tip = { top: b.y0, right: b.x1, bottom: b.y1, left: b.x0 }[st.side];
    const horiz = side % 2 === 1, sign = side === 0 || side === 3 ? -1 : 1;
    const lo = horiz ? b.y0 : b.x0, hi = horiz ? b.y1 : b.x1;
    const A = c[side], B = c[(side + 1) % 4], ax = horiz ? 1 : 0;
    const fwd = B[ax] > A[ax], first = fwd ? lo : hi, second = fwd ? hi : lo;
    // 이음부·모서리·끝 곡선이 서로 겹치지 않을 때만
    if ((tip - bodyEdge) * sign < j + er + 1e-6) return null;
    if (Math.abs(first - A[ax]) < A[2] + j + 1e-6 || Math.abs(B[ax] - second) < B[2] + j + 1e-6) return null;
    if (lo < Math.min(A[ax], B[ax]) || hi > Math.max(A[ax], B[ax])) return null;
    const pt = (along, across, rad) => (horiz ? [across, along, rad] : [along, across, rad]);
    c.splice(side + 1, 0, pt(first, bodyEdge, j), pt(first, tip, er), pt(second, tip, er), pt(second, bodyEdge, j));
    return roundedPolygon(c);
  }
  function ellipseCurve(b) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, rx = (b.x1 - b.x0) / 2, ry = (b.y1 - b.y0) / 2, kx = rx * KAPPA, ky = ry * KAPPA;
    return { p: [cx, b.y0], segs: [
      [cx + kx, b.y0, b.x1, cy - ky, b.x1, cy], [b.x1, cy + ky, cx + kx, b.y1, cx, b.y1],
      [cx - kx, b.y1, b.x0, cy + ky, b.x0, cy], [b.x0, cy - ky, cx - kx, b.y0, cx, b.y0]] };
  }
  /** 점열에 3차 베지어를 맞춰요(Schneider). t0/t1은 양 끝에서 안쪽을 향하는 단위 접선. */
  function fitBezier(pts, t0, t1, tol, win) {
    const out = [], stack = [[0, pts.length - 1, t0, t1]];
    const bez = (p0, c, p3, t) => { const u = 1 - t; return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c[k] + 3 * u * t * t * c[2 + k] + t * t * t * p3[k]); };
    while (stack.length) {
      const [a, b, ta, tb] = stack.pop(), p0 = pts[a], p3 = pts[b];
      if (b - a < 2) { out.push([p3[0], p3[1]]); continue; }
      const U = [0];
      for (let i = a + 1; i <= b; i++) U.push(U[U.length - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = U[U.length - 1], chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
      for (let i = 0; i < U.length; i++) U[i] /= total;
      let c, err, at;
      for (let iter = 0; iter < 6; iter++) {
        let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
        for (let i = 0; i < U.length; i++) {
          const t = U[i], u = 1 - t, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b03 = u * u * u + b1, b33 = t * t * t + b2;
          const dx = pts[a + i][0] - p0[0] * b03 - p3[0] * b33, dy = pts[a + i][1] - p0[1] * b03 - p3[1] * b33;
          c00 += b1 * b1; c01 += b1 * b2 * (ta[0] * tb[0] + ta[1] * tb[1]); c11 += b2 * b2;
          x0 += b1 * (ta[0] * dx + ta[1] * dy); x1 += b2 * (tb[0] * dx + tb[1] * dy);
        }
        const det = c00 * c11 - c01 * c01;
        let l = (x0 * c11 - x1 * c01) / det, r = (c00 * x1 - c01 * x0) / det;
        if (!(l > 1e-4 * chord && r > 1e-4 * chord && l < total && r < total)) l = r = total / 3;
        c = [p0[0] + ta[0] * l, p0[1] + ta[1] * l, p3[0] + tb[0] * r, p3[1] + tb[1] * r];
        err = 0; at = (a + b) >> 1;
        for (let i = 1; i < U.length - 1; i++) {
          const q = bez(p0, c, p3, U[i]), e = Math.hypot(q[0] - pts[a + i][0], q[1] - pts[a + i][1]);
          if (e > err) { err = e; at = a + i; }
        }
        if (err <= tol) break;
        for (let i = 1; i < U.length - 1; i++) { // 매개변수 보정(Newton)
          const t = U[i], u = 1 - t, q = bez(p0, c, p3, t), P = pts[a + i];
          let f = 0, g = 0;
          for (let k = 0; k < 2; k++) {
            const d1 = 3 * (u * u * (c[k] - p0[k]) + 2 * u * t * (c[2 + k] - c[k]) + t * t * (p3[k] - c[2 + k]));
            const d2 = 6 * (u * (c[2 + k] - 2 * c[k] + p0[k]) + t * (p3[k] - 2 * c[2 + k] + c[k]));
            f += (q[k] - P[k]) * d1; g += d1 * d1 + (q[k] - P[k]) * d2;
          }
          if (g) U[i] = Math.max(0, Math.min(1, t - f / g));
        }
      }
      if (err <= tol) { out.push([...c, p3[0], p3[1]]); continue; }
      at = Math.max(a + 1, Math.min(b - 1, at));
      const w = Math.min(win, at - a, b - at), m = tangent(pts[at - w], pts[at + w]);
      stack.push([at, b, m, tb], [a, at, ta, [-m[0], -m[1]]]);
    }
    return out;
  }
  function tangent(a, b) { const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; }
  /** 촘촘한 윤곽선 → 직선 + 베지어 */
  function fitCurve(dense, ppm) {
    // 이진 마스크 윤곽의 흔들림(약 1px)은 따라가지 않도록 해상도에 맞춘 허용 오차
    const tol = Math.max(0.06, 1 / ppm), win = Math.max(6, Math.round(1.0 * ppm));
    const n = dense.length, corner = simplifyClosed(dense, 0.03);
    const idx = new Map(dense.map((p, i) => [p, i])), lines = [];
    for (let i = 0; i < corner.length; i++) {
      const a = corner[i], b = corner[(i + 1) % corner.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 6) lines.push([idx.get(a), idx.get(b)]);
    }
    const P = dense.map((p) => p.slice());
    for (const [a, b] of lines) for (const k of [0, 1]) if (Math.abs(P[a][k] - P[b][k]) < 0.012) P[a][k] = P[b][k] = (P[a][k] + P[b][k]) / 2;
    const run = (a, b) => { const r = [P[a]]; for (let i = a; i !== b;) { i = (i + 1) % n; r.push(P[i]); } return r; };
    const neg = (v) => [-v[0], -v[1]], mid = (i) => tangent(dense[(i + n - win) % n], dense[(i + win) % n]);
    const segs = [];
    if (!lines.length) {
      const h = n >> 1, t0 = mid(0), t1 = mid(h);
      segs.push(...fitBezier(run(0, h), t0, neg(t1), tol, win), ...fitBezier(run(h, 0), t1, neg(t0), tol, win));
      return { p: P[0].slice(), segs };
    }
    lines.forEach(([a, b], i) => {
      const [c, d] = lines[(i + 1) % lines.length];
      segs.push(P[b].slice());
      if (b !== c) segs.push(...fitBezier(run(b, c), tangent(P[a], P[b]), neg(tangent(P[c], P[d])), tol, win));
    });
    return { p: P[lines[0][0]].slice(), segs };
  }
  /** 두 닫힌 점열의 최대 거리(양방향, 촘촘하다고 가정한 쪽의 점 → 상대 선분) */
  function maxDeviation(a, b) {
    const one = (u, v) => {
      let worst = 0;
      for (const [x, y] of u) {
        let best = Infinity;
        for (let i = 0; i < v.length && best > 1e-6; i++) {
          const p = v[i], q = v[i + 1 === v.length ? 0 : i + 1], dx = q[0] - p[0], dy = q[1] - p[1], l = dx * dx + dy * dy;
          let t = l ? ((x - p[0]) * dx + (y - p[1]) * dy) / l : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = (x - p[0] - t * dx) ** 2 + (y - p[1] - t * dy) ** 2;
          if (d < best) best = d;
        }
        if (best > worst) worst = best;
      }
      return Math.sqrt(worst);
    };
    return Math.max(one(a, b), one(b, a));
  }
  const polyCurve = (l) => ({ p: l[0].slice(), segs: [...l.slice(1), l[0]].map((q) => q.slice()) });
  /** dense: 마스크에서 뽑은 윤곽선. 곡선이 여기서 tol보다 벗어나면 다음 방법을 써요. */
  function cutCurve(dense, exact, ppm, soft = dense) {
    const simple = simplifyClosed(dense, 0.01);
    if (exact && maxDeviation(flattenCurve(exact), simple) <= Math.max(0.06, 1.5 / ppm)) return exact;
    const fit = fitCurve(soft, ppm);
    return maxDeviation(flattenCurve(fit), simple) <= Math.max(0.08, 1.6 / ppm) ? fit : polyCurve(simple);
  }

  // ---------- 화이트 ----------
  /** 보정 1건의 부호 거리(px, 안쪽 양수)를 영향 범위에서만 fn(i, v)로 넘겨요. */
  function eachOpPixel(op, g, fn) {
    const rect = op.kind === 'protect-rect';
    const xs = rect ? [op.x, op.x + op.w] : op.pts.map((p) => p[0]), ys = rect ? [op.y, op.y + op.h] : op.pts.map((p) => p[1]);
    const m = (rect ? 0 : op.r) + 2 / g.ppm;
    const lo = (v) => Math.max(0, Math.floor((v - m) * g.ppm + g.pad)), hi = (v, n) => Math.min(n, Math.ceil((v + m) * g.ppm + g.pad));
    const X0 = lo(Math.min(...xs)), X1 = hi(Math.max(...xs), g.w), Y0 = lo(Math.min(...ys)), Y1 = hi(Math.max(...ys), g.h);
    const W = X1 - X0, H = Y1 - Y0;
    if (W <= 0 || H <= 0) return;
    if (rect) {
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
        const mx = toMm(g, x), my = toMm(g, y);
        fn(y * g.w + x, Math.min(mx - xs[0], xs[1] - mx, my - ys[0], ys[1] - my) * g.ppm);
      }
      return;
    }
    const best = new Float32Array(W * H).fill(-1e6);
    for (let k = 0; k < op.pts.length; k++) {
      const [ax, ay] = op.pts[Math.max(0, k - 1)], [bx, by] = op.pts[k];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const sx0 = Math.max(X0, lo(Math.min(ax, bx))), sx1 = Math.min(X1, hi(Math.max(ax, bx), g.w));
      const sy0 = Math.max(Y0, lo(Math.min(ay, by))), sy1 = Math.min(Y1, hi(Math.max(ay, by), g.h));
      for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
        const px = toMm(g, x) - ax, py = toMm(g, y) - ay;
        const t = l2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / l2)) : 0;
        const v = (op.r - Math.hypot(px - t * dx, py - t * dy)) * g.ppm, j = (y - Y0) * W + x - X0;
        if (v > best[j]) best[j] = v;
      }
    }
    for (let j = 0; j < best.length; j++) if (best[j] > -1e5) fn((Y0 + Math.floor(j / W)) * g.w + X0 + (j % W), best[j]);
  }

  /** 화이트가 들어갈 수 있는 가장 낮은 알파 */
  const whiteMin = (wh) => (wh.mode === 'tone' ? Math.min(wh.minAlpha, wh.opaqueThreshold - 0.01) : wh.opaqueThreshold) - 1e-6;

  /** 농도 단계: 아래(옅음)부터. 마지막은 불투명 = 100% */
  function toneSteps(wh) {
    const n = Math.max(2, Math.min(10, Math.round(wh.toneSteps))), lo = whiteMin(wh) + 1e-6, hi = wh.opaqueThreshold;
    const at = (k) => lo + (hi - lo) * k / (n - 1);
    return Array.from({ length: n }, (_, k) => ({
      min: at(k) - 1e-6, density: k === n - 1 ? 1 : Math.max(1, Math.round((at(k) + at(k + 1)) * 50)) / 100,
    }));
  }

  /** 단계별 마스크. 불투명 경계의 가는 안티에일리어싱 테두리는 옅은 화이트로 만들지 않아요. */
  function toneMasks(wh, g, alpha, steps) {
    const { w, h, ppm } = g, N = w * h, thr = wh.opaqueThreshold - 1e-6, lo = steps[0].min;
    const semi = new Uint8Array(N);
    for (let i = 0; i < N; i++) semi[i] = alpha[i] >= lo && alpha[i] < thr ? 1 : 0;
    const r = Math.max(1, 0.15 * ppm), core = opening(semi, w, h, r), near = dilate(core, w, h, r + 1);
    const soft = boxBlur(alpha, w, h, Math.max(1, Math.round(0.1 * ppm))); // 잡티로 경로가 잘게 부서지지 않게
    return steps.map((st, k) => {
      const m = new Uint8Array(N), top = k === steps.length - 1;
      for (let i = 0; i < N; i++) m[i] = alpha[i] >= thr || (!top && semi[i] && near[i] && (k === 0 || soft[i] >= st.min)) ? 1 : 0;
      return m;
    });
  }

  /**
   * 반환: { field, loops(mm), tone, levels: [{ density, loops }] }
   * levels는 옅은 것부터이고 위 단계가 아래 단계 안에 포개져요. 순서대로 불투명하게 칠하면 이음새가 생기지 않아요.
   * field·loops는 가장 넓은 단계, tone은 픽셀별 농도(0~100)예요.
   */
  function buildWhite(design, g, alpha, cutSdf) {
    const wh = design.white, { w, h, ppm } = g, N = w * h, ops = wh.ops || [];
    const tone = new Uint8Array(N);
    if (wh.mode === 'none') return { field: new Float32Array(N).fill(-1), loops: [], tone, levels: [] };
    const protect = new Uint8Array(N);
    if (wh.mode !== 'full') for (const op of ops) if (op.kind.startsWith('protect')) eachOpPixel(op, g, (i, v) => { if (v > 0) protect[i] = 1; });

    const fromMask = (mask) => {
      const F = new Float32Array(N), s = sdf(mask, w, h);
      for (let i = 0; i < N; i++) F[i] = -s[i] + (protect[i] ? wh.protectOffset : wh.sizeOffset) * ppm;
      const bin = new Uint8Array(N);
      for (let i = 0; i < N; i++) bin[i] = F[i] > 0 ? 1 : 0;
      const { labels, areas } = label(bin, w, h, true), min = wh.minArea * ppm * ppm;
      // 보호 영역에 닿은 조각(얇은 글씨 획 등)은 작아도 지우지 않아요.
      const keep = new Uint8Array(areas.length);
      for (let i = 0; i < N; i++) if (bin[i] && protect[i]) keep[labels[i]] = 1;
      for (let i = 0; i < N; i++) if (bin[i] && !keep[labels[i]] && areas[labels[i]] < min) F[i] = -1;
      if (wh.smooth > 0) {
        const bl = boxBlur(F, w, h, Math.round(wh.smooth));
        for (let i = 0; i < N; i++) if (!protect[i]) F[i] = Math.min(bl[i], F[i]);
      }
      return F;
    };
    const finish = (F, density) => {
      for (const op of ops) {
        if (op.kind === 'add') eachOpPixel(op, g, (i, v) => { if (v > F[i]) F[i] = v; });
        else if (op.kind === 'erase') eachOpPixel(op, g, (i, v) => { if (-v < F[i]) F[i] = -v; });
      }
      for (let i = 0; i < N; i++) {
        F[i] = Math.min(F[i], -cutSdf[i]);
        if (F[i] > 0) tone[i] = Math.round(density * 100);
      }
      return { F, level: { density, loops: contoursMm(F, g, 0.015) } };
    };

    const out = [];
    if (wh.mode === 'full') {
      const F = new Float32Array(N);
      for (let i = 0; i < N; i++) F[i] = -cutSdf[i] + wh.sizeOffset * ppm; // 음수 = 줄이기
      out.push(finish(F, 1));
    } else if (wh.mode === 'tone') {
      const steps = toneSteps(wh);
      let field = null;
      toneMasks(wh, g, alpha, steps).forEach((m, k) => {
        const r = finish(fromMask(m), steps[k].density);
        field = field || r.F;
        out.push({ F: null, level: r.level });
      });
      out[0].F = field;
    } else {
      const opaque = new Uint8Array(N);
      for (let i = 0; i < N; i++) opaque[i] = alpha[i] >= wh.opaqueThreshold - 1e-6 ? 1 : 0;
      out.push(finish(fromMask(opaque), 1));
    }
    return { field: out[0].F, loops: out[0].level.loops, tone, levels: out.map((o) => o.level).filter((l) => l.loops.length) };
  }

  // ---------- 검증 ----------
  function verify(design, plate, g, alpha, cut, white) {
    const { w, h, ppm } = g, N = w * h, thr = whiteMin(design.white), F = white.field;
    let overlap = 0;
    const bin = new Uint8Array(N), opq = new Uint8Array(N), over = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      opq[i] = alpha[i] >= thr ? 1 : 0;
      bin[i] = F[i] > 0 ? 1 : 0;
      if (bin[i] && !opq[i]) { overlap++; over[i] = 1; }
    }
    const top = (mask, minPx) => {
      const { labels, areas } = label(mask, w, h, true), ids = [];
      for (let i = 1; i < areas.length; i++) if (areas[i] >= minPx) ids.push(i);
      ids.sort((a, b) => areas[b] - areas[a]);
      return { count: ids.length, boxes: labelBoxes(labels, areas.length, w, ids.slice(0, 50)).map((b) => boxMm(g, b)) };
    };
    const overBoxes = overlap ? top(over, 1).boxes : [];
    // 불투명 경계까지의 간격: 화이트 윤곽 점에서 거리장을 보간해 최솟값을 써요(음수 = 겹침).
    let gap = null;
    if (white.loops.length) {
      const s = sdf(opq, w, h);
      gap = Infinity;
      for (const l of white.loops) for (const [mx, my] of l) {
        const fx = mx * ppm + g.pad - 0.5, fy = my * ppm + g.pad - 0.5;
        const x = Math.max(0, Math.min(w - 2, Math.floor(fx))), y = Math.max(0, Math.min(h - 2, Math.floor(fy)));
        const u = fx - x, v = fy - y, i = y * w + x;
        const d = (s[i] * (1 - u) + s[i + 1] * u) * (1 - v) + (s[i + w] * (1 - u) + s[i + w + 1] * u) * v;
        if (-d < gap) gap = -d;
      }
      gap /= ppm;
    }
    const op = opening(bin, w, h, 0.15 * ppm), thin = new Uint8Array(N);
    for (let i = 0; i < N; i++) thin[i] = bin[i] && !op[i] ? 1 : 0;
    const thinR = top(thin, 0.02 * ppm * ppm); // 모서리에서 깎인 자잘한 픽셀은 무시
    const lb = (cut.loops[0] || []).reduce((b, [x, y]) => ({ x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const out = (b, m) => b.x0 < m - 0.06 || b.y0 < m - 0.06 || b.x1 > plate.w - m + 0.06 || b.y1 > plate.h - m + 0.06;
    return {
      overlap, overBoxes, gap, thinCount: thinR.count, thinBoxes: thinR.boxes, hasWhite: white.loops.length > 0,
      cutCount: cut.loops.length, removed: cut.removed, removedBoxes: cut.removedBoxes,
      cutOutPlate: out(lb, 0), cutOutSafe: out(lb, plate.safeMargin || 0),
      imagesOut: design.images.filter((im) => out(imageAABB(im), plate.safeMargin || 0)).map((im) => im.name || im.id),
    };
  }
  /** '화이트 확인' 화면용 RGBA */
  function checkRaster(design, g, alpha, cut, white) {
    const out = new Uint8ClampedArray(g.w * g.h * 4), thr = design.white.opaqueThreshold - 1e-6, lo = whiteMin(design.white);
    const gray = (t) => { const v = Math.round(70 + 185 * t / 100); return (v << 16) | (v << 8) | v; };
    for (let i = 0; i < alpha.length; i++) {
      let c = 0x000000;
      if (white.field[i] > 0) c = alpha[i] >= lo ? gray(white.tone[i]) : 0xff2fb3;
      else if (alpha[i] >= thr) c = 0x7a8594;
      else if (alpha[i] > 0.02) c = 0xffd84d;
      out[i * 4] = c >> 16; out[i * 4 + 1] = (c >> 8) & 255; out[i * 4 + 2] = c & 255; out[i * 4 + 3] = 255;
    }
    return out;
  }
  /** 알파를 고려한 면적 평균 축소 */
  function resizePixels(px, scale) {
    const w = Math.max(1, Math.round(px.w * scale)), h = Math.max(1, Math.round(px.h * scale));
    if (w >= px.w && h >= px.h) return px;
    const data = new Uint8ClampedArray(w * h * 4), kx = px.w / w, ky = px.h / h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const y0 = Math.floor(y * ky), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ky));
      const x0 = Math.floor(x * kx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * kx));
      let r = 0, gr = 0, b = 0, a = 0;
      for (let v = y0; v < y1; v++) for (let u = x0; u < x1; u++) {
        const i = (v * px.w + u) * 4, al = px.data[i + 3];
        r += px.data[i] * al; gr += px.data[i + 1] * al; b += px.data[i + 2] * al; a += al;
      }
      const o = (y * w + x) * 4;
      if (a) { data[o] = r / a; data[o + 1] = gr / a; data[o + 2] = b / a; data[o + 3] = a / ((y1 - y0) * (x1 - x0)); }
    }
    return { w, h, data };
  }

  // ---------- PDF ----------
  const K = 72 / 25.4;
  const fmt = (n) => {
    const s = n.toFixed(5).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  };
  function hexName(str) {
    let s = 'FEFF';
    for (let i = 0; i < str.length; i++) s += str.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    return '<' + s + '>';
  }
  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') throw new Error('이 브라우저는 PDF 압축을 지원하지 않아요. 최신 브라우저를 사용해 주세요.');
    const st = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(st).arrayBuffer());
  }
  /** PNG 예측기 Up */
  function pngUp(data, w, h, ch) {
    const row = w * ch, out = new Uint8Array((row + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (row + 1);
      out[o] = 2;
      for (let x = 0; x < row; x++) {
        const i = y * row + x;
        out[o + 1 + x] = data[i] - (y ? data[i - row] : 0);
      }
    }
    return out;
  }
  const colorOp = (c, stroke) => c.v.map(fmt).join(' ') + ' ' +
    (c.space === 'cmyk' ? (stroke ? 'K' : 'k') : (stroke ? 'RG' : 'rg'));
  /** 화이트 농도: 투명도를 쓰지 않고 색 값만 종이색 쪽으로 옅게 */
  const tint = (c, d) => ({ space: c.space, v: c.v.map((v) => (c.space === 'cmyk' ? v * d : 1 - (1 - v) * d)) });
  function pathOps(loops, plateH) {
    const out = [];
    for (const l of loops) {
      l.forEach(([x, y], i) => out.push(fmt(x * K) + ' ' + fmt((plateH - y) * K) + (i ? ' l' : ' m')));
      out.push('h');
    }
    return out.join('\n');
  }
  function imageMatrix(im, plateH) {
    const a = (im.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const W = im.w * K * (im.flipH ? -1 : 1), H = im.h * K * (im.flipV ? -1 : 1);
    const cx = (im.x + im.w / 2) * K, cy = (plateH - im.y - im.h / 2) * K;
    // 화면 시계방향 회전 = PDF(y 위쪽)에서 -a
    const A = W * c, B = -W * s, C = H * s, D = H * c;
    return [A, B, C, D, cx - (A + C) / 2, cy - (B + D) / 2];
  }
  /** 표준 sRGB(IEC 61966-2.1) 값으로 만든 ICC v2 프로파일 */
  function srgbIcc() {
    const ascii = (t) => Array.from(t, (c) => c.charCodeAt(0));
    const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const s15 = (v) => u32(Math.round(v * 65536));
    const xyz = (...v) => [...ascii('XYZ '), 0, 0, 0, 0, ...v.flatMap(s15)];
    const name = 'sRGB IEC61966-2.1';
    const desc = [...ascii('desc'), 0, 0, 0, 0, ...u32(name.length + 1), ...ascii(name), 0, ...Array(4 + 4 + 2 + 1 + 67).fill(0)];
    const n = 1024, curve = [...ascii('curv'), 0, 0, 0, 0, ...u32(n)];
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1), y = Math.round((x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4) * 65535);
      curve.push(y >> 8, y & 255);
    }
    const data = { desc, cprt: [...ascii('text'), 0, 0, 0, 0, ...ascii('Public Domain'), 0], wtpt: xyz(0.9505, 1, 1.0891),
      rXYZ: xyz(0.43607, 0.22249, 0.01392), gXYZ: xyz(0.38515, 0.71687, 0.09708), bXYZ: xyz(0.14307, 0.06061, 0.7141), rTRC: curve };
    const tags = [...Object.keys(data), 'gTRC', 'bTRC'], at = {};
    const body = [], base = 128 + 4 + tags.length * 12;
    for (const [k, v] of Object.entries(data)) { at[k] = [base + body.length, v.length]; body.push(...v); while (body.length % 4) body.push(0); }
    at.gTRC = at.bTRC = at.rTRC;
    const head = [...u32(base + body.length), 0, 0, 0, 0, 2, 0x10, 0, 0, ...ascii('mntrRGB XYZ '), 0x07, 0xd0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0,
      ...ascii('acsp'), ...Array(28).fill(0), ...s15(0.9642), ...s15(1), ...s15(0.8249)];
    while (head.length < 128) head.push(0);
    return new Uint8Array([...head, ...u32(tags.length), ...tags.flatMap((t) => [...ascii(t), ...u32(at[t][0]), ...u32(at[t][1])]), ...body]);
  }
  /** 빈 이름은 기본값, 중복은 번호 */
  function uniqueNames(list) {
    const used = new Set();
    return list.map(({ name, fallback }) => {
      const base = (name || '').trim() || fallback;
      let n = base, i = 2;
      while (used.has(n)) n = base + ' ' + i++;
      used.add(n);
      return n;
    });
  }

  function curveOps(curves, plateH) {
    const xy = (s) => s.map((v, i) => fmt((i % 2 ? plateH - v : v) * K)).join(' ');
    return curves.map((c) => [xy(c.p) + ' m', ...c.segs.slice(0, -1).map((s) => xy(s) + (s.length === 2 ? ' l' : ' c')),
      ...(c.segs[c.segs.length - 1].length === 6 ? [xy(c.segs[c.segs.length - 1]) + ' c'] : []), 'h'].join('\n')).join('\n');
  }

  /** pages: [{ design, cutCurves, whiteLoops | whiteLevels }], design.images[].pixels 또는 .jpeg({w,h,bytes}) */
  async function buildPdf({ plate, layers, pages }) {
    const enc = new TextEncoder(), objs = [null];
    const alloc = () => objs.push(null) - 1;
    const put = (id, dict, stream) => { objs[id] = { dict, stream }; };
    const add = (dict, stream) => { const id = alloc(); put(id, dict, stream); return id; };

    const imgs = pages.flatMap((p) => p.design.images);
    const merged = layers.imageMode === 'merged';
    const names = uniqueNames([
      { name: layers.white, fallback: '화이트' },
      ...(merged ? [{ name: layers.mergedName, fallback: '이미지' }]
        : imgs.map((im, i) => ({ name: (layers.imageNames || {})[im.id], fallback: '이미지' + (i + 1) }))),
      { name: layers.cut, fallback: '칼선' },
    ]);
    const catalog = alloc(), tree = alloc();
    const ocgs = names.map((n) => add(`<</Type/OCG/Name ${hexName(n)}/Intent/View/Usage<</CreatorInfo<</Creator(PhotopropEditor)/Subtype/Artwork>>>>>>`));
    const whiteOc = ocgs[0], cutOc = ocgs[ocgs.length - 1];

    const icc = imgs.length ? add('<</N 3/Alternate/DeviceRGB/Filter/FlateDecode>>', await deflate(srgbIcc())) : 0;
    const kids = [], cache = new Map();
    // 같은 원본이 여러 레이어에 쓰이면 픽셀을 한 번만 넣고, 레이어 연결은 BDC로만 해요.
    const ocUse = new Map();
    imgs.forEach((im, i) => {
      const k = im.jpeg || im.pixels;
      ocUse.set(k, (ocUse.get(k) || new Set()).add(merged ? ocgs[1] : ocgs[1 + i]));
    });
    let n = 0;
    for (const { design, cutCurves, whiteLoops, whiteLevels } of pages) {
      const props = new Map([['OCW', whiteOc], ['OCC', cutOc]]), xobjs = [];
      let cs = '';
      // 화이트는 농도 단계가 있어도 이미지·투명도·별색 없이 벡터 면만 써요(포함할 외부 자원이 없음).
      const levels = (whiteLevels || [{ density: 1, loops: whiteLoops }]).filter((l) => l.loops.length);
      if (levels.length) cs += `/OC /OCW BDC\nq\n${levels.map((l) => `${colorOp(tint(design.white.color, l.density), false)}\n${pathOps(l.loops, plate.h)}\nf*\n`).join('')}Q\nEMC\n`;
      for (const im of design.images) {
        const oc = merged ? ocgs[1] : ocgs[1 + n], key = 'OCI' + (merged ? 0 : n), name = 'Im' + n;
        n++;
        props.set(key, oc);
        const src = im.jpeg || im.pixels, ck = src;
        let enced = cache.get(ck);
        if (!enced) { enced = await encodeImage(im, `[/ICCBased ${icc} 0 R]`); cache.set(ck, enced); }
        if (enced.smaskDict && !enced.smaskId) enced.smaskId = add(enced.smaskDict, enced.smask);
        if (!enced.id) enced.id = add(enced.dict + (enced.smaskId ? `/SMask ${enced.smaskId} 0 R` : '') + (ocUse.get(ck).size === 1 ? `/OC ${oc} 0 R` : '') + '>>', enced.bytes);
        xobjs.push([name, enced.id]);
        cs += `/OC /${key} BDC\nq\n${imageMatrix(im, plate.h).map(fmt).join(' ')} cm\n/${name} Do\nQ\nEMC\n`;
      }
      if (cutCurves.length) cs += `/OC /OCC BDC\nq\n${colorOp(design.cut.color, true)}\n${fmt(design.cut.strokeMm * K)} w\n${curveOps(cutCurves, plate.h)}\nS\nQ\nEMC\n`;
      const content = add('<</Filter/FlateDecode>>', await deflate(enc.encode(cs)));
      kids.push(add(`<</Type/Page/Parent ${tree} 0 R/MediaBox[0 0 ${fmt(plate.w * K)} ${fmt(plate.h * K)}]/Contents ${content} 0 R/Resources<<` +
        `/Properties<<${[...props].map(([k, v]) => `/${k} ${v} 0 R`).join('')}>>` +
        `/XObject<<${xobjs.map(([k, v]) => `/${k} ${v} 0 R`).join('')}>>>>>>`));
    }
    const refs = ocgs.map((i) => i + ' 0 R').join(' ');
    put(tree, `<</Type/Pages/Count ${kids.length}/Kids[${kids.map((i) => i + ' 0 R').join(' ')}]>>`);
    put(catalog, `<</Type/Catalog/Pages ${tree} 0 R/OCProperties<</OCGs[${refs}]/D<</Order[${refs}]/ON[${refs}]/OFF[]>>>>>>`);
    const info = add(`<</Title ${hexName(`포토프랍 ${plate.w}x${plate.h} 이미지+화이트+칼선`)}>>`);

    const parts = [], offsets = [0];
    let pos = 0;
    const write = (b) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); pos += u.length; };
    write('%PDF-1.7\n%');
    write(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 10]));
    for (let i = 1; i < objs.length; i++) {
      offsets[i] = pos;
      const { dict, stream } = objs[i];
      if (stream) {
        write(`${i} 0 obj\n${dict.slice(0, -2)}/Length ${stream.length}>>\nstream\n`);
        write(stream);
        write('\nendstream\nendobj\n');
      } else write(`${i} 0 obj\n${dict}\nendobj\n`);
    }
    const xref = pos;
    write(`xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
    write(`trailer\n<</Size ${objs.length}/Root ${catalog} 0 R/Info ${info} 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(pos);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  async function encodeImage(im, rgbSpace) {
    const head = (w, h, cs) => `<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}/ColorSpace ${cs}/BitsPerComponent 8`;
    if (im.jpeg) return { dict: head(im.jpeg.w, im.jpeg.h, rgbSpace) + '/Filter/DCTDecode', bytes: im.jpeg.bytes };
    const { w, h, data } = im.pixels;
    const flate = (ch) => `/Filter/FlateDecode/DecodeParms<</Predictor 15/Colors ${ch}/BitsPerComponent 8/Columns ${w}>>`;
    const rgb = new Uint8Array(w * h * 3), al = new Uint8Array(w * h);
    let opaque = true;
    for (let i = 0; i < al.length; i++) {
      rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2];
      al[i] = data[i * 4 + 3];
      if (al[i] < 255) opaque = false;
    }
    const r = { dict: head(w, h, rgbSpace) + flate(3), bytes: await deflate(pngUp(rgb, w, h, 3)) };
    if (!opaque) {
      r.smaskDict = head(w, h, '/DeviceGray') + flate(1) + '>>';
      r.smask = await deflate(pngUp(al, w, h, 1));
    }
    return r;
  }

  const api = {
    makeGrid, gridForCut, pickPpm, toMm, edt, dilate, erode, closing, opening, sdf, label, fillHoles, keepLargest,
    boxBlur, marchingSquares, simplifyClosed, contoursMm, imageAABB, unionBox, rasterAlpha, stickRect,
    flattenCurve, maxDeviation, buildCut, buildWhite, toneSteps, tint, verify, checkRaster, resizePixels, buildPdf, imageMatrix, srgbIcc, uniqueNames, pngUp, deflate,
  };
  root.PhotopropCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
