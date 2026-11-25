// 실행: node --test test/core.test.cjs   → test/out/sample-80x140.pdf 도 만들어요.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const C = require('../src/core.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} ≠ ${b} (±${tol})`);
const bounds = (l) => ({
  x0: Math.min(...l.map((p) => p[0])), x1: Math.max(...l.map((p) => p[0])),
  y0: Math.min(...l.map((p) => p[1])), y1: Math.max(...l.map((p) => p[1])),
});
const area = (l) => Math.abs(l.reduce((s, [x, y], i) => { const [a, b] = l[(i + 1) % l.length]; return s + x * b - a * y; }, 0) / 2);

/** 불투명 원 + 반투명 고리 + 구멍 + 작은 점 */
function sampleImage(n) {
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n - 0.5, v = (y + 0.5) / n - 0.5, r = Math.hypot(u, v);
    let a = r < 0.4 ? 255 : r < 0.48 ? 128 : 0;
    if (Math.hypot(u + 0.1, v) < 0.06) a = 0;
    if (Math.hypot(u - 0.47, v - 0.47) < 0.003) a = 255;
    data.set([255 * (u + 0.5), 255 * (v + 0.5), 160, a], (y * n + x) * 4);
  }
  return { w: n, h: n, data };
}
const plate = { w: 80, h: 140 };
const layers = { white: '화이트', cut: '칼선', imageMode: 'merged', mergedName: '이미지' };
const makeDesign = (over = {}) => ({
  id: 'd1',
  images: [{ id: 'i1', x: 7.5, y: 10, w: 65, h: 65, rot: 0, pixels: sampleImage(512) }],
  cut: {
    shape: 'roundrect', margin: 1, radii: { tl: 1, tr: 1, br: 1, bl: 1 }, strokeMm: 0.1, color: { space: 'rgb', v: [1, 0, 0] },
    stick: { on: true, side: 'bottom', pos: 'center', width: 12, toEnd: true, length: 30, endRadius: 3, endStyle: 'round', jointRadius: 1, edgeMargin: 2 },
    ...over.cut,
  },
  white: { mode: 'auto', color: { space: 'cmyk', v: [1, 0, 0, 0] }, sizeOffset: -0.06, opaqueThreshold: 0.96, protectOffset: -0.02, minArea: 0.3, smooth: 1, ...over.white },
});
function run(design, ppm) {
  const g = C.gridForCut(plate, ppm, design.cut);
  const alpha = C.rasterAlpha(design.images, g);
  const cut = C.buildCut(design, plate, g, alpha);
  return { g, alpha, cut, white: C.buildWhite(design, g, alpha, cut.sdf) };
}

test('EDT가 전수 계산과 같아요', () => {
  const w = 23, h = 17, m = new Uint8Array(w * h);
  for (let i = 0; i < 12; i++) m[(i * 7919 + 13) % m.length] = 1;
  const d = C.edt(m, w, h, 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let b = Infinity;
    for (let i = 0; i < m.length; i++) if (m[i]) b = Math.min(b, Math.hypot(x - i % w, y - Math.floor(i / w)));
    near(d[y * w + x], b, 1e-4);
  }
  assert.ok(C.edt(new Uint8Array(9), 3, 3, 1)[0] > 1e9, '씨앗이 없으면 아주 먼 거리');
});

test('marching squares: 원 + 구멍, 안장점', () => {
  const w = 80, h = 80, f = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const r = Math.hypot(x - 40, y - 40); f[y * w + x] = Math.min(30 - r, r - 10); }
  const ar = C.marchingSquares(f, w, h).map(area).sort((a, b) => a - b);
  assert.equal(ar.length, 2);
  near(ar[0], Math.PI * 100, 3); near(ar[1], Math.PI * 900, 5);
  const s = new Float32Array(16).fill(-1); s[5] = s[10] = 1;
  assert.ok(C.marchingSquares(s, 4, 4).length >= 1);
  const s2 = new Float32Array(16).fill(-1); s2[6] = s2[9] = 3;
  assert.equal(C.marchingSquares(s2, 4, 4).length, 1);
});

test('구멍 메우기 / 가장 큰 조각 / 단순화', () => {
  const w = 12, h = 8, m = new Uint8Array(w * h);
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) m[y * w + x] = 1;
  m[3 * w + 3] = 0; m[3 * w + 9] = 1;
  const f = C.fillHoles(m, w, h);
  assert.equal(f[3 * w + 3], 1);
  const k = C.keepLargest(f, w, h);
  assert.equal(k.removed, 1);
  assert.equal(k.mask.reduce((a, b) => a + b), 25);
  const sq = [];
  for (let i = 0; i < 40; i++) sq.push(i < 10 ? [i, 0] : i < 20 ? [10, i - 10] : i < 30 ? [30 - i, 10] : [0, 40 - i]);
  assert.equal(C.simplifyClosed(sq, 0.01).length, 4);
});

test('칼선: 샘플 치수대로 닫힌 외곽선 1개', () => {
  const { cut } = run(makeDesign(), 20);
  assert.equal(cut.loops.length, 1);
  assert.equal(cut.removed, 0);
  const l = cut.loops[0], b = bounds(l);
  near(b.x0, 6.5, 0.03); near(b.x1, 73.5, 0.03); near(b.y0, 9, 0.03); near(b.y1, 138, 0.03);
  const st = bounds(l.filter((p) => p[1] > 90 && p[1] < 136));
  near(st.x0, 34, 0.03); near(st.x1, 46, 0.03);
  // 해석적 넓이: 몸체 + 막대 - 볼록 모서리 + 이음부 오목 모서리
  const q = 1 - Math.PI / 4;
  near(area(l), 67 * 67 + 12 * 62 - 4 * q - 2 * 9 * q + 2 * q, 3, '넓이(mm²)');
  console.log('  칼선 점 수', l.length, '넓이', area(l).toFixed(3));
});

test('칼선: 베지어 곡선', () => {
  const kinds = (c) => [c.segs.filter((x) => x.length === 6).length, c.segs.filter((x) => x.length === 2).length];
  const st = { on: false };
  const d0 = run(makeDesign(), 20);
  assert.deepEqual(kinds(d0.cut.curves[0]), [8, 8], '샘플처럼 곡선 8개, 직선 8개');
  const exact = bounds(d0.cut.loops[0]);
  assert.deepEqual([exact.x0, exact.x1, exact.y0, exact.y1].map((v) => +v.toFixed(9)), [6.5, 73.5, 9, 138]);
  assert.deepEqual(kinds(run(makeDesign({ cut: { shape: 'circle', stick: st } }), 16).cut.curves[0]), [4, 0]);
  for (const [name, over, rot] of [['따라가기', { shape: 'follow', stick: st }, 0], ['따라가기+막대', { shape: 'follow' }, 0], ['원+막대', { shape: 'circle' }, 0], ['회전 따라가기', { shape: 'follow', stick: st }, 17]]) {
    const d = makeDesign({ cut: over });
    Object.assign(d.images[0], { x: 12, y: 12, w: 50, h: 50, rot });
    if (rot) d.images[0].pixels = { w: 2, h: 2, data: new Uint8ClampedArray(16).fill(255) };
    const { cut, g } = run(d, 16.7), c = cut.curves[0], k = kinds(c);
    const f = Float32Array.from(cut.sdf, (v) => -v);
    const dev = C.maxDeviation(cut.loops[0], C.contoursMm(f, g, 0.005)[0]);
    console.log('  ', name, '곡선/직선', k, '최대 오차', dev.toFixed(3));
    assert.equal(cut.curves.length, 1);
    assert.ok(dev <= 0.1, name); assert.ok(k[0] > 0 && k[0] < 25, name + ' 곡선 수');
    // 꺾임: 부드러운 원형 이미지에서는 이어지는 접선이 크게 꺾이지 않아야 해요
    if (name === '따라가기') {
      let p = c.p, prev = null, worst = 0;
      for (const s of [...c.segs, c.segs[0]]) {
        const t0 = [s[0] - p[0], s[1] - p[1]], L = s.length;
        if (prev && Math.hypot(...t0) > 1e-9) worst = Math.max(worst, Math.abs(Math.atan2(prev[0] * t0[1] - prev[1] * t0[0], prev[0] * t0[0] + prev[1] * t0[1])) * 180 / Math.PI);
        prev = L === 2 ? t0 : [s[4] - s[2], s[5] - s[3]]; p = s.slice(-2);
      }
      assert.ok(worst < 3, '접선 꺾임 ' + worst);
    }
  }
});

test('칼선: 모든 모양 × 막대 방향 × 정렬 안 되는 ppm', () => {
  for (const shape of ['rect', 'roundrect', 'circle', 'follow'])
    for (const side of ['bottom', 'top', 'left', 'right'])
      for (const pos of ['start', 'center', 'end']) {
        const d = makeDesign({ cut: { shape } });
        Object.assign(d.images[0], { x: 20, y: 45, w: 40, h: 40, rot: 17 });
        Object.assign(d.cut.stick, { side, pos });
        const { cut } = run(d, 7.3);
        assert.equal(cut.loops.length, 1, `${shape}/${side}/${pos}`);
        const b = bounds(cut.loops[0]);
        const [got, want] = { bottom: [b.y1, 138], top: [b.y0, 2], left: [b.x0, 2], right: [b.x1, 78] }[side];
        near(got, want, 0.12, `${shape}/${side}/${pos} 끝`);
      }
});

test('칼선: 떨어진 조각은 경고용 개수로 알려요', () => {
  const d = makeDesign({ cut: { shape: 'follow', stick: { on: false } } });
  d.images = [{ ...d.images[0], x: 5, y: 10, w: 30, h: 30 }, { ...d.images[0], id: 'i2', x: 45, y: 90, w: 20, h: 20 }];
  const { cut } = run(d, 8);
  assert.equal(cut.loops.length, 1);
  assert.ok(cut.removed >= 1);
});

test('화이트: 크기 조절, 구멍, 작은 조각, 반투명 제외, 칼선 안쪽', () => {
  const R = 0.4 * 65, hr = 0.06 * 65;
  for (const off of [-0.06, 0, 0.5, -0.5]) {
    const { white } = run(makeDesign({ white: { sizeOffset: off, smooth: 0 } }), 20);
    // 0.5mm 키우면 작은 점도 0.3mm²를 넘어 남아요(명세 6.3 순서: 크기 조절 → 조각 제거)
    assert.equal(white.loops.length, off === 0.5 ? 3 : 2, `오프셋 ${off}`);
    const ar = white.loops.map(area).sort((a, b) => b - a);
    near(Math.sqrt(ar[0] / Math.PI), R + off, 0.06, `오프셋 ${off} 바깥 반경`);
    near(Math.sqrt(ar[1] / Math.PI), hr - off, 0.06, `오프셋 ${off} 구멍 반경`);
  }
  const { white, alpha } = run(makeDesign(), 20);
  let bad = 0;
  for (let i = 0; i < alpha.length; i++) if (white.field[i] > 0 && alpha[i] < 0.96) bad++;
  assert.equal(bad, 0, '기본값에서 반투명에 겹친 픽셀');
  const full = run(makeDesign({ white: { mode: 'full', sizeOffset: -0.5 } }), 20);
  near(bounds(full.white.loops[0]).x0, 7, 0.03, '전체 채움도 음수면 줄어요');
  const grow = run(makeDesign({ white: { mode: 'full', sizeOffset: 1 } }), 20);
  near(bounds(grow.white.loops[0]).x0, 6.5, 0.03, '칼선 밖으로 안 나가요');
  assert.equal(run(makeDesign({ white: { mode: 'none' } }), 8).white.loops.length, 0);
});

test('수동 보정, 보호 영역, 검증', () => {
  const W = (ops) => { const d = makeDesign({ white: { ops, smooth: 0 } }); const r = run(d, 16); return { ...r, d, v: C.verify(d, { ...plate, safeMargin: 2 }, r.g, r.alpha, r.cut, r.white) }; };
  const base = W([]);
  assert.equal(base.v.overlap, 0); assert.equal(base.v.thinCount, 0); near(base.v.gap, 0.06, 0.03, '간격');
  assert.equal(base.v.cutOutSafe, false);
  const add = W([{ kind: 'add', r: 1, pts: [[10, 12], [14, 12]] }]);
  assert.equal(add.white.loops.length, 3); assert.ok(add.v.overlap > 1000);
  const thin = W([{ kind: 'add', r: 0.1, pts: [[10, 12], [20, 12]] }]);
  assert.equal(thin.v.thinCount, 1);
  const er = W([{ kind: 'erase', r: 2, pts: [[50, 42]] }]);
  assert.equal(er.white.loops.length, 3);
  const pr = W([{ kind: 'protect-rect', x: 0, y: 0, w: 80, h: 140 }]);
  assert.ok(area(pr.white.loops[0]) > 0); near(pr.v.gap, 0.02, 0.02, '보호 간격');
  const half = C.resizePixels(sampleImage(64), 0.5); assert.equal(half.w, 32);
});

test('보호 영역: 작은 조각을 지우지 않고 다듬지 않아요', () => {
  const n = 400, data = new Uint8ClampedArray(n * n * 4); // 40mm: 0.2mm 폭 2mm 획 두 개(각 0.4mm²)
  const bar = (x0, y0) => { for (let y = y0; y < y0 + 20; y++) for (let x = x0; x < x0 + 2; x++) data[(y * n + x) * 4 + 3] = 255; };
  bar(100, 100); bar(300, 300);
  const go = (ops) => {
    const d = makeDesign({ white: { ops, smooth: 3, minArea: 0.5 } });
    d.images = [{ id: 'i', x: 20, y: 10, w: 40, h: 40, rot: 0, pixels: { w: n, h: n, data } }];
    return run(d, 20).white.loops;
  };
  assert.equal(go([]).length, 0);
  const l = go([{ kind: 'protect-rect', x: 28, y: 18, w: 5, h: 5 }]);
  assert.equal(l.length, 1, '보호한 획만 남아요');
  const b = bounds(l[0]);
  near(b.x1 - b.x0, 0.16, 0.03, '획 폭'); near(b.x0, 30.02, 0.03);
});

test('이미지 행렬과 알파 래스터가 회전/반전에서 일치해요', () => {
  const n = 64, data = new Uint8ClampedArray(n * n * 4); // 왼쪽 위 1/4만 불투명
  for (let y = 0; y < n / 2; y++) for (let x = 0; x < n / 2; x++) data[(y * n + x) * 4 + 3] = 255;
  for (const [rot, flipH, flipV] of [[0, 0, 0], [90, 0, 0], [30, 1, 0], [75, 0, 1], [-40, 1, 1]]) {
    const im = { x: 10, y: 20, w: 40, h: 24, rot, flipH: !!flipH, flipV: !!flipV, pixels: { w: n, h: n, data } };
    const g = C.makeGrid(plate, 10), al = C.rasterAlpha([im], g);
    let s = 0, sx = 0, sy = 0;
    al.forEach((v, i) => { s += v; sx += v * C.toMm(g, i % g.w); sy += v * C.toMm(g, Math.floor(i / g.w)); });
    const [a, b, c, d, e, f] = C.imageMatrix(im, plate.h), k = 72 / 25.4;
    near(sx / s, (a * 0.25 + c * 0.75 + e) / k, 0.1, 'x'); near(sy / s, plate.h - (b * 0.25 + d * 0.75 + f) / k, 0.1, 'y');
  }
});

test('레이어 이름: 빈 이름/중복 처리', () => {
  assert.deepEqual(C.uniqueNames([{ name: ' ', fallback: '화이트' }, { name: 'A', fallback: 'x' }, { name: 'A', fallback: 'y' }]), ['화이트', 'A', 'A 2']);
});

test('PDF: 명세 2장 구조', async () => {
  const d = makeDesign();
  d.images[0].pixels = sampleImage(2048);
  const t0 = performance.now();
  const { cut, white } = run(d, C.pickPpm(plate, 6e6, 20));
  const t1 = performance.now();
  const pdf = await C.buildPdf({ plate, layers, pages: [{ design: d, cutCurves: cut.curves, whiteLoops: white.loops }] });
  console.log(`  계산 ${(t1 - t0).toFixed(0)}ms, PDF ${(performance.now() - t1).toFixed(0)}ms, ${(pdf.length / 1024).toFixed(0)}KB`);
  const out = path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'sample-80x140.pdf'), pdf);

  const txt = Buffer.from(pdf).toString('latin1');
  assert.match(txt, /MediaBox\[0 0 226\.77165 396\.85039\]/);
  const names = [...txt.matchAll(/\/OCG\/Name <FEFF([0-9A-F]+)>/g)].map((m) => Buffer.from(m[1], 'hex').swap16().toString('utf16le'));
  assert.deepEqual(names, ['화이트', '이미지', '칼선']);
  assert.ok(txt.includes('/ColorSpace [/ICCBased '));
  assert.match(txt, /\/SMask \d+ 0 R\/OC \d+ 0 R/);
  // xref 위치 확인
  const xr = +txt.match(/startxref\n(\d+)/)[1];
  const offs = [...txt.slice(xr).matchAll(/(\d{10}) 00000 n/g)].map((m) => +m[1]);
  offs.forEach((o, i) => assert.ok(txt.startsWith(`${i + 1} 0 obj`, o)));
  const cid = txt.match(/\/Contents (\d+)/)[1], at = offs[cid - 1];
  const len = +txt.slice(at).match(/\/Length (\d+)/)[1], st = txt.indexOf('stream\n', at) + 7;
  const cs = zlib.inflateSync(pdf.subarray(st, st + len)).toString();
  assert.deepEqual([...cs.matchAll(/\/OC \/(\w+) BDC/g)].map((m) => m[1]), ['OCW', 'OCI0', 'OCC']);
  assert.match(cs, /1 0 0 0 k\n[\s\S]*\nf\*\n/);
  const c = cs.slice(cs.indexOf('/OCC'));
  assert.match(c, /1 0 0 RG\n0\.28346 w\n/);
  assert.equal((c.match(/ m$/gm) || []).length, 1);
  assert.match(c, /\nh\nS\n/);
});

test('PDF: 여러 페이지 + 이미지별 레이어 + 불투명 이미지', async () => {
  const a = makeDesign({ cut: { shape: 'follow' } }), b = makeDesign();
  b.images[0].id = 'i2';
  const px = { w: 4, h: 4, data: new Uint8ClampedArray(64).fill(255) };
  b.images.push({ id: 'i3', x: 10, y: 12, w: 10, h: 10, rot: 30, flipH: true, pixels: px });
  const pages = [a, b].map((design) => { const r = run(design, 8); return { design, cutCurves: r.cut.curves, whiteLoops: r.white.loops }; });
  const pdf = await C.buildPdf({ plate, pages, layers: { white: '화이트', cut: '칼선', imageMode: 'perImage', imageNames: { i1: '앞', i2: '앞' } } });
  fs.writeFileSync(path.join(__dirname, 'out', 'multi.pdf'), pdf);
  const txt = Buffer.from(pdf).toString('latin1');
  const names = [...txt.matchAll(/\/OCG\/Name <FEFF([0-9A-F]+)>/g)].map((m) => Buffer.from(m[1], 'hex').swap16().toString('utf16le'));
  assert.deepEqual(names, ['화이트', '앞', '앞 2', '이미지3', '칼선']);
  assert.equal((txt.match(/\/Type\/Page\//g) || []).length, 2);
});

test('투명도별 화이트: 단계·포개짐·벡터 전용 PDF', async () => {
  const n = 512, data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data.set([200, 90, 40, x / (n - 1) * 255], (y * n + x) * 4);
  const d = makeDesign({ white: { mode: 'tone', minAlpha: 0.1, toneSteps: 6, sizeOffset: 0 } });
  d.images[0].pixels = { w: n, h: n, data };
  const r = run(d, 10), L = r.white.levels;
  assert.equal(L.length, 6);
  assert.equal(L[5].density, 1);
  const ar = L.map((l) => l.loops.reduce((s, q) => s + area(q), 0));
  for (let i = 1; i < 6; i++) { assert.ok(L[i].density > L[i - 1].density); assert.ok(ar[i] < ar[i - 1]); }
  for (let y = 150; y < 650; y++) for (let x = 120; x < 660; x++) {
    const i = (y + 4) * r.g.w + x; if (r.white.tone[i]) assert.ok(Math.abs(r.white.tone[i] / 100 - r.alpha[i]) < 0.12);
  }
  assert.equal(C.verify(d, plate, r.g, r.alpha, r.cut, r.white).overlap, 0);

  // 선명한 이미지의 가장자리에는 옅은 테두리가 생기지 않아요.
  const hard = makeDesign({ white: { mode: 'tone', minAlpha: 0.1, toneSteps: 6 } });
  const disc = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) disc.set([9, 9, 9, Math.max(0, Math.min(1, 200 - Math.hypot(x - 256, y - 256))) * 255], (y * n + x) * 4);
  hard.images[0].pixels = { w: n, h: n, data: disc };
  for (const ppm of [8, 20]) { const t = run(hard, ppm).white.tone; assert.ok(t.every((v) => v === 0 || v === 100), 'ppm ' + ppm); }

  // 반투명 고리는 가운데 농도로 들어가요.
  const ring = makeDesign({ white: { mode: 'tone', minAlpha: 0.1, toneSteps: 6 } }), rr = run(ring, 10);
  assert.ok([...new Set(rr.white.tone)].some((v) => v >= 40 && v <= 60));

  const pdf = await C.buildPdf({ plate, layers, pages: [{ design: d, cutCurves: r.cut.curves, whiteLevels: L }] });
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'tone.pdf'), pdf);
  const txt = Buffer.from(pdf).toString('latin1');
  const id = +/\/Contents (\d+) 0 R/.exec(txt)[1], at = txt.indexOf(`\n${id} 0 obj`), st = txt.indexOf('stream\n', at) + 7;
  const cs = zlib.inflateSync(pdf.subarray(st, st + +/\/Length (\d+)/.exec(txt.slice(at))[1])).toString();
  const white = cs.slice(cs.indexOf('/OC /OCW BDC'), cs.indexOf('EMC'));
  assert.deepEqual(white.match(/^[\d. ]+ k$/gm), L.map((l) => `${l.density} 0 0 0 k`));
  assert.ok(!/\b(Do|gs|sh|scn|BI)\b/.test(white), '화이트에 이미지·투명도·그라데이션 없음');
  assert.equal((txt.match(/\/Subtype\/Image/g) || []).length, 2, '이미지 + SMask뿐');
  assert.ok(!/\/(ExtGState|Separation|Pattern|Shading)|\/F\s*\(/.test(txt), '외부 참조 없음');
  assert.deepEqual(C.tint({ space: 'rgb', v: [0, 1, 1] }, 0.5).v, [0.5, 1, 1]);
});
