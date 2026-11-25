/* 계산 워커. core.js 뒤에 이어 붙여 Blob으로 실행해요. */
'use strict';
const C = PhotopropCore;
const assets = new Map();
let memo = {}; // 미리보기: 바뀐 단계만 다시 계산
let exportMemo = null;

function withPixels(design, fast) {
  return { ...design, images: design.images.map((im) => ({ ...im, pixels: assets.get(im.asset) })), fast };
}
function pipeline(design, plate, ppm, cache) {
  const d = withPixels(design);
  const g = C.gridForCut(plate, ppm, d.cut);
  const kA = JSON.stringify([plate.w, plate.h, g, design.images.map((i) => [i.asset, i.x, i.y, i.w, i.h, i.rot, i.flipH, i.flipV])]);
  const kC = kA + JSON.stringify([design.cut, plate]);
  const alpha = cache.kA === kA ? cache.alpha : C.rasterAlpha(d.images, g);
  const cut = cache.kC === kC ? cache.cut : C.buildCut(d, plate, g, alpha);
  Object.assign(cache, { kA, alpha, kC, cut });
  return { d, g, alpha, cut, white: C.buildWhite(d, g, alpha, cut.sdf) };
}
const handlers = {
  asset(m) { assets.set(m.id, { w: m.w, h: m.h, data: new Uint8ClampedArray(m.buf) }); return {}; },
  preview({ design, plate, wantCheck }) {
    const r = pipeline(design, plate, C.pickPpm(plate, 1.5e6, 20), memo);
    const out = { g: r.g, cut: r.cut.loops, white: r.white.loops, levels: r.white.levels, removed: r.cut.removed, removedBoxes: r.cut.removedBoxes };
    if (wantCheck) out.check = C.checkRaster(r.d, r.g, r.alpha, r.cut, r.white).buffer;
    return out;
  },
  compute({ designs, plate }) {
    const reports = [];
    exportMemo = { plate, pages: [] };
    for (const design of designs) {
      const r = pipeline(design, plate, C.pickPpm(plate, 6e6, 20), {});
      reports.push({ id: design.id, ...C.verify(r.d, plate, r.g, r.alpha, r.cut, r.white) });
      exportMemo.pages.push({ design: r.d, cutCurves: r.cut.curves, whiteLevels: r.white.levels });
    }
    return { reports };
  },
  async pdf({ layers, jpegs, scale }) {
    const cache = new Map();
    const pages = exportMemo.pages.map((p) => ({
      ...p,
      design: {
        ...p.design,
        images: p.design.images.map((im) => {
          if (!cache.has(im.asset)) {
            cache.set(im.asset, jpegs[im.asset] ? { jpeg: jpegs[im.asset] }
              : { pixels: scale < 1 ? C.resizePixels(im.pixels, scale) : im.pixels });
          }
          const { pixels, ...rest } = im;
          return { ...rest, ...cache.get(im.asset) };
        }),
      },
    }));
    return { bytes: (await C.buildPdf({ plate: exportMemo.plate, layers, pages })).buffer };
  },
};
onmessage = async (e) => {
  const { seq, type, ...m } = e.data;
  try {
    const r = await handlers[type](m);
    postMessage({ seq, ok: true, ...r }, [r.check, r.bytes].filter(Boolean));
  } catch (err) { postMessage({ seq, ok: false, error: String((err && err.message) || err) }); }
};
