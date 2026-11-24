(() => {
  'use strict';
  const C = PhotopropCore;
  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const round = (v, n = 2) => +v.toFixed(n);

  /** 사용자 입력은 항상 텍스트 노드로만 넣어요(innerHTML 사용 안 함). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (['value', 'checked', 'disabled', 'hidden'].includes(k)) el[k] = v;
      else el.setAttribute(k, v);
    }
    el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
    return el;
  }

  // ---------- 상태 ----------
  const newDesign = () => ({
    id: uid('d'), images: [],
    autoAlign: { on: true, mode: 'row', gap: 3, cross: 'center' },
    cut: {
      shape: 'roundrect', margin: 1, radii: { tl: 1, tr: 1, br: 1, bl: 1 }, radiiLinked: true, strokeMm: 0.1,
      color: { space: 'rgb', v: [1, 0, 0] },
      stick: { on: false, side: 'bottom', pos: 'center', width: 12, toEnd: true, length: 30, endRadius: 3, endStyle: 'round', jointRadius: 1, edgeMargin: 2 },
    },
    white: { mode: 'auto', color: { space: 'cmyk', v: [1, 0, 0, 0] }, sizeOffset: -0.06, opaqueThreshold: 0.96, protectOffset: -0.02, minArea: 0.3, smooth: 1, ops: [] },
  });
  let P = {
    version: 1, plate: { w: 80, h: 140, gridStep: 5, snap: true, safeMargin: 2 }, designs: [newDesign()],
    layers: { white: '화이트', cut: '칼선', imageMode: 'perImage', imageNames: {}, mergedName: '이미지' },
  };
  const assets = new Map(); // id → {w,h,opaque,canvas,src}
  const ui = { d: 0, sel: new Set(), tool: 'move', brush: 2, view: 'final', tab: 'image', base: 'plate', zoom: 0, panX: 0, panY: 0, rx: 10, ry: -28, bg: '#D9E2EC', markers: [], guides: [] };
  const D = () => P.designs[ui.d];
  const selected = () => D().images.filter((i) => ui.sel.has(i.id));
  const one = () => selected()[0] || null;
  let dirty = false, result = null, dragging = false;

  // ---------- 되돌리기 ----------
  let undoStack = [], redoStack = [], last = JSON.stringify(P);
  function commit() {
    if (D().autoAlign.on) autoAlign();
    const now = JSON.stringify(P);
    if (now !== last) {
      undoStack.push(last); if (undoStack.length > 100) undoStack.shift();
      redoStack = []; last = now; dirty = true;
      ui.markers = [];
    }
    refresh();
  }
  function travel(from, to, word) {
    if (!from.length) return;
    to.push(last); last = from.pop(); P = JSON.parse(last);
    ui.d = Math.min(ui.d, P.designs.length - 1); pruneSel(); ui.markers = [];
    say(word); refresh();
  }
  const undo = () => travel(undoStack, redoStack, '되돌렸어요');
  const redo = () => travel(redoStack, undoStack, '다시 실행했어요');
  function pruneSel() { const ids = new Set(D().images.map((i) => i.id)); ui.sel = new Set([...ui.sel].filter((i) => ids.has(i))); }

  // ---------- 알림 ----------
  const say = (t) => { $('live').textContent = ''; requestAnimationFrame(() => { $('live').textContent = t; }); };
  let toastTimer;
  function toast(text, bad, retry) {
    clearTimeout(toastTimer);
    const close = () => $('toasts').replaceChildren();
    $('toasts').replaceChildren(h('div', { class: 'toast' + (bad ? ' bad' : '') }, text,
      retry ? h('button', { onclick: () => { close(); retry(); } }, '다시 시도') : null,
      h('button', { onclick: close }, '닫기')));
    toastTimer = setTimeout(close, bad ? 12000 : 6000);
  }

  // ---------- 워커 ----------
  const pending = new Map();
  let seq = 0, worker;
  function startWorker() {
    const src = $('core').textContent + '\n' + $('worker').textContent;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const p = pending.get(e.data.seq); pending.delete(e.data.seq);
      if (p) e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error));
    };
    worker.onerror = (e) => { for (const p of pending.values()) p.rej(new Error(e.message || '계산 오류')); pending.clear(); };
  }
  function call(type, msg, transfer) {
    return new Promise((res, rej) => { const s = ++seq; pending.set(s, { res, rej }); worker.postMessage({ seq: s, type, ...msg }, transfer || []); });
  }
  let timer = 0, running = false, again = false, gen = 0;
  function schedule() { gen++; result = null; clearTimeout(timer); timer = setTimeout(compute, 120); busy(); }
  let busyN = 0;
  function busy() {
    const on = D().images.length > 0 && (!result || busyN > 0);
    if ($('busy').hidden === on) { $('busy').hidden = !on; if (on) say('계산 중…'); }
  }
  async function compute() {
    if (dragging) return;
    if (running) { again = true; return; }
    if (!D().images.length) { busy(); draw(); return; }
    running = true; again = false;
    const my = gen;
    try {
      const r = await call('preview', { design: D(), plate: P.plate, wantCheck: ui.view === 'check' });
      if (my === gen && !dragging) {
        result = r;
        r.cutPath = toPath(r.cut); r.whitePath = toPath(r.white);
        if (r.check) {
          r.checkCv = h('canvas', { width: r.g.w, height: r.g.h });
          r.checkCv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.check), r.g.w, r.g.h), 0, 0);
        }
        if (ui.view === '3d') build3d();
      }
    } catch (e) { if (my === gen) { result = { cut: [], white: [], removed: 0, removedBoxes: [], cutPath: new Path2D(), whitePath: new Path2D() }; toast('✕ 계산하지 못했어요: ' + e.message, true, schedule); } }
    running = false;
    busy(); draw(); renderStatus();
    if (again || my !== gen) compute();
  }
  function toPath(loops) {
    const p = new Path2D();
    for (const l of loops) { l.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); }
    return p;
  }

  // ---------- 이미지 올리기 ----------
  const MAX_PX = 36e6;
  async function decode(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    let w = img.naturalWidth, ht = img.naturalHeight, shrunk = false;
    if (!w || !ht) throw new Error('이미지 크기를 알 수 없어요');
    if (w * ht > MAX_PX) { const s = Math.sqrt(MAX_PX / (w * ht)); w = Math.floor(w * s); ht = Math.floor(ht * s); shrunk = true; }
    const canvas = h('canvas', { width: w, height: ht }), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, ht); // EXIF 방향이 반영된 픽셀을 써요
    const px = ctx.getImageData(0, 0, w, ht).data;
    let opaque = true;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { opaque = false; break; }
    // 화면용은 줄인 사본(끌 때 부드럽게)
    const k = Math.min(1, 1400 / Math.max(w, ht));
    let view = canvas;
    if (k < 1) {
      view = h('canvas', { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(ht * k)) });
      const c = view.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(canvas, 0, 0, view.width, view.height);
    }
    return { w, h: ht, opaque, full: canvas, view, src, px, shrunk };
  }
  async function addAsset(src) {
    for (const [id, a] of assets) if (a.src === src) return id;
    const a = await decode(src), id = uid('a'), buf = a.px.buffer;
    delete a.px;
    await call('asset', { id, w: a.w, h: a.h, buf }, [buf]);
    assets.set(id, a);
    return id;
  }
  const readFile = (f, as) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('파일을 읽지 못했어요')); r[as](f); });
  async function addFiles(files) {
    files = [...files];
    if (!files.length) return;
    const ok = files.filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    const bad = files.length - ok.length, d = D(), fail = [];
    busyN++; busy();
    const total = d.images.length + ok.length;
    const maxSide = Math.min(P.plate.w, P.plate.h) * 0.8125;
    const side = d.images.length ? Math.max(10, maxSide / Math.max(2, total)) : Math.max(10, (maxSide - 3 * (total - 1)) / Math.max(1, total));
    const added = [];
    let shrunk = false;
    for (const f of ok) {
      try {
        const id = await addAsset(await readFile(f, 'readAsDataURL')), a = assets.get(id);
        shrunk = shrunk || a.shrunk;
        const k = side / Math.max(a.w, a.h), w = round(a.w * k), hh = round(a.h * k), n = added.length * 3;
        const im = { id: uid('i'), asset: id, name: f.name.replace(/\.[^.]+$/, ''), x: round((P.plate.w - w) / 2 + n), y: round((P.plate.h - hh) / 2 + n), w, h: hh, rot: 0, flipH: false, flipV: false, lockRatio: true };
        d.images.push(im); added.push(im.id);
      } catch { fail.push(f.name); }
    }
    busyN--;
    if (added.length) { ui.sel = new Set([added[added.length - 1]]); ui.tab = 'image'; }
    commit();
    if (bad) toast('✕ PNG, JPG, WebP 파일만 올릴 수 있어요. 파일 형식을 확인해 주세요.', true);
    else if (fail.length) toast('✕ 열지 못한 이미지: ' + fail.join(', ') + '. 손상되지 않았는지 확인해 주세요.', true);
    else if (shrunk) toast('아주 큰 이미지는 3600만 화소로 줄여서 올렸어요.');
    else if (added.length) say(`이미지 ${added.length}개를 올렸어요`);
  }

  // ---------- 정렬 ----------
  const box = (im) => C.imageAABB(im);
  function moveTo(im, x0, y0) {
    const b = box(im);
    if (x0 !== null) im.x = round(im.x + x0 - b.x0, 4);
    if (y0 !== null) im.y = round(im.y + y0 - b.y0, 4);
  }
  const size = (im) => { const b = box(im); return { w: b.x1 - b.x0, h: b.y1 - b.y0 }; };
  function autoAlign() {
    const d = D(), a = d.autoAlign, ims = d.images, n = ims.length;
    if (!n) return;
    const cols = a.mode === 'row' ? n : a.mode === 'column' ? 1 : Math.max(1, Math.min(n, P.plate.w >= P.plate.h ? Math.ceil(Math.sqrt(n)) : Math.floor(Math.sqrt(n)) || 1));
    const rows = Math.ceil(n / cols), S = ims.map(size);
    const cw = Array(cols).fill(0), rh = Array(rows).fill(0);
    S.forEach((s, i) => { cw[i % cols] = Math.max(cw[i % cols], s.w); const r = Math.floor(i / cols); rh[r] = Math.max(rh[r], s.h); });
    const sum = (v) => v.reduce((x, y) => x + y, 0) + a.gap * (v.length - 1);
    const at = (v, i, off) => off + v.slice(0, i).reduce((x, y) => x + y + a.gap, 0);
    const ox = (P.plate.w - sum(cw)) / 2, oy = (P.plate.h - sum(rh)) / 2;
    const f = a.cross === 'start' ? 0 : a.cross === 'end' ? 1 : 0.5;
    ims.forEach((im, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const fx = a.mode === 'column' ? f : 0.5, fy = a.mode === 'column' ? 0.5 : f;
      moveTo(im, at(cw, c, ox) + (cw[c] - S[i].w) * fx, at(rh, r, oy) + (rh[r] - S[i].h) * fy);
    });
  }
  function alignOnce(how) {
    const ims = selected(), ref = ui.base === 'plate' ? { x0: 0, y0: 0, x1: P.plate.w, y1: P.plate.h } : C.unionBox(ims.map(box));
    for (const im of ims) {
      const s = size(im);
      const X = { left: ref.x0, center: (ref.x0 + ref.x1 - s.w) / 2, right: ref.x1 - s.w }[how];
      const Y = { top: ref.y0, middle: (ref.y0 + ref.y1 - s.h) / 2, bottom: ref.y1 - s.h }[how];
      moveTo(im, X ?? null, Y ?? null);
    }
    commit();
  }
  function distribute(axis) {
    const x = axis === 'x', k0 = x ? 'x0' : 'y0', k1 = x ? 'x1' : 'y1';
    const ims = selected().sort((a, b) => box(a)[k0] - box(b)[k0]);
    const tot = ims.reduce((s, im) => s + box(im)[k1] - box(im)[k0], 0);
    const lo = ui.base === 'plate' ? 0 : box(ims[0])[k0];
    const hi = ui.base === 'plate' ? (x ? P.plate.w : P.plate.h) : Math.max(...ims.map((i) => box(i)[k1]));
    const gap = ui.base === 'plate' ? (hi - lo - tot) / (ims.length + 1) : (hi - lo - tot) / (ims.length - 1);
    let p = lo + (ui.base === 'plate' ? gap : 0);
    for (const im of ims) { const b = box(im); moveTo(im, x ? p : null, x ? null : p); p += b[k1] - b[k0] + gap; }
    commit();
  }
  function fitAll() {
    const ims = D().images, m = P.plate.safeMargin + D().cut.margin + 0.2, b = C.unionBox(ims.map(box));
    const gapX = D().autoAlign.on ? D().autoAlign.gap : 0; // 간격은 고정이므로 여유 있게 뺍니다
    const n = ims.length - 1, W = P.plate.w - 2 * m, H = P.plate.h - 2 * m;
    const k = Math.min((W - (D().autoAlign.mode === 'row' ? gapX * n : 0)) / (b.x1 - b.x0 - (D().autoAlign.mode === 'row' ? gapX * n : 0)),
      (H - (D().autoAlign.mode === 'column' ? gapX * n : 0)) / (b.y1 - b.y0 - (D().autoAlign.mode === 'column' ? gapX * n : 0)));
    if (!(k > 0) || !isFinite(k)) { toast('✕ 간격이 너무 넓어서 맞출 수 없어요. 이미지 간격을 줄여 주세요.', true); return; }
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    for (const im of ims) {
      const ix = im.x + im.w / 2, iy = im.y + im.h / 2;
      im.w = Math.floor(im.w * k * 100) / 100; im.h = Math.floor(im.h * k * 100) / 100;
      im.x = P.plate.w / 2 + (ix - cx) * k - im.w / 2; im.y = P.plate.h / 2 + (iy - cy) * k - im.h / 2;
    }
    commit();
  }
  const dpi = (im) => { const a = assets.get(im.asset); return Math.min(a.w / im.w, a.h / im.h) * 25.4; };

  // ---------- 색 ----------
  function toRgb(c) { return c.space === 'rgb' ? c.v : [0, 1, 2].map((i) => (1 - c.v[i]) * (1 - c.v[3])); }
  const hex = (c) => '#' + toRgb(c).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  const fromHex = (s) => [1, 3, 5].map((i) => round(parseInt(s.slice(i, i + 2), 16) / 255, 4));
  function rgbToCmyk([r, g, b]) { const k = 1 - Math.max(r, g, b); return k >= 1 ? [0, 0, 0, 1] : [r, g, b].map((v) => round((1 - v - k) / (1 - k), 4)).concat(round(k, 4)); }
  function setSpace(c, s) { if (c.space === s) return; const v = toRgb(c); c.space = s; c.v = s === 'rgb' ? v.map((x) => round(x, 4)) : rgbToCmyk(v); }

  // ---------- 패널 구성 요소 ----------
  function num(label, get, set, o = {}) {
    const inp = h('input', { type: 'number', inputmode: 'decimal', step: o.step || 'any', min: o.min, max: o.max, value: round(get(), o.digits ?? 2), disabled: o.disabled, 'data-k': o.key || label });
    inp.addEventListener('change', () => {
      let v = parseFloat(inp.value);
      if (!isFinite(v)) { inp.value = round(get()); toast(`✕ ${label}: 숫자를 입력해 주세요.`, true); return; }
      v = clamp(v, o.min ?? -1e4, o.max ?? 1e4);
      set(v); commit();
    });
    return h('label', { class: 'fld' }, label, inp);
  }
  function range(label, get, set, o) {
    const show = o.show || ((v) => `${v} mm`), b = h('b', {}, show(get()));
    const inp = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: get(), disabled: o.disabled, 'data-k': label });
    inp.addEventListener('input', () => { set(+inp.value); b.textContent = show(get()); inp.setAttribute('aria-valuetext', show(get())); schedule(); draw(); });
    inp.addEventListener('change', commit);
    inp.setAttribute('aria-valuetext', show(get()));
    return h('label', { class: 'fld' }, h('span', {}, label + ' ', b), inp);
  }
  const btn = (label, fn, o = {}) => h('button', { class: 'btn ' + (o.class || ''), onclick: fn, disabled: o.disabled, 'aria-pressed': o.pressed === undefined ? undefined : String(!!o.pressed), 'data-k': o.key || label }, label);
  const check = (label, get, set, o = {}) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: get(), disabled: o.disabled, 'data-k': label, onchange: (e) => { set(e.target.checked); commit(); } }), label);
  function seg(label, opts, get, set, o = {}) {
    return h('div', { class: 'seg' + (o.two ? ' two' : ''), role: 'group', 'aria-label': label }, opts.map(([v, t]) =>
      h('button', { 'aria-pressed': String(get() === v), disabled: o.disabled, 'data-k': label + v, onclick: () => { set(v); o.local ? refresh() : commit(); } }, t)));
  }
  function select(label, opts, get, set, o = {}) {
    const s = h('select', { disabled: o.disabled, 'data-k': label, onchange: (e) => { set(opts[e.target.selectedIndex][0]); commit(); } },
      opts.map(([, t]) => h('option', {}, t)));
    s.selectedIndex = opts.findIndex(([v]) => v === get());
    return h('label', { class: 'fld' }, label, s);
  }
  function text(label, get, set, fallback) {
    return h('label', { class: 'fld' }, label, h('input', { type: 'text', maxlength: 60, value: get(), 'data-k': label, onchange: (e) => { set(e.target.value.trim() || fallback); commit(); } }));
  }
  const sec = (t, l = 2) => h('h' + l, { class: 'sec' }, t);
  const help = (t) => h('p', { class: 'help' }, t);
  function color(label, c, hint) {
    const b = h('b', {}, hex(c));
    const pick = h('input', { type: 'color', value: hex(c).toLowerCase(), 'data-k': label });
    pick.addEventListener('input', () => { const v = fromHex(pick.value); c.v = c.space === 'rgb' ? v : rgbToCmyk(v); b.textContent = hex(c); draw(); });
    pick.addEventListener('change', commit);
    const chan = c.space === 'rgb' ? ['R', 'G', 'B'] : ['C', 'M', 'Y', 'K'], k = c.space === 'rgb' ? 255 : 100;
    return [
      h('label', { class: 'fld' }, label, h('span', { class: 'row' }, pick, b, h('span', { class: 'help' }, hint))),
      seg(label + ' 방식', [['cmyk', 'CMYK'], ['rgb', 'RGB']], () => c.space, (v) => setSpace(c, v)),
      h('div', { class: 'g4' }, chan.map((n, i) => num(n, () => c.v[i] * k, (v) => { c.v[i] = v / k; }, { min: 0, max: k, digits: 1, key: label + n }))),
    ];
  }

  // ---------- 패널 ----------
  function panelImage() {
    const d = D(), im = one(), a = d.autoAlign, multi = selected().length, none = !multi;
    const out = [sec(`이미지 목록 (${d.images.length})`)];
    if (!d.images.length) out.push(help('아직 이미지가 없어요. 이미지를 올려 주세요.'));
    out.push(h('ul', { class: 'list' }, d.images.map((m, i) => {
      const on = ui.sel.has(m.id);
      return h('li', {},
        h('label', {}, h('input', { type: 'checkbox', checked: on, 'aria-label': `${m.name} 함께 선택`, 'data-k': 'c' + m.id, onchange: (e) => { e.target.checked ? ui.sel.add(m.id) : ui.sel.delete(m.id); refresh(); } })),
        h('button', { class: 'btn', 'aria-pressed': String(on), 'data-k': 'b' + m.id, onclick: (e) => pick(m.id, e.shiftKey || e.ctrlKey) }, `${i + 1}. ${m.name} · ${round(m.w, 1)}×${round(m.h, 1)} mm${on ? ' · 선택됨' : ''}`));
    })));
    out.push(h('div', { class: 'g2' },
      btn('+ 이미지 추가', () => $('fImg').click()),
      btn('선택 삭제', removeSel, { class: 'danger', disabled: none }),
      btn('한 칸 앞으로', () => order(1), { disabled: multi !== 1 }), btn('한 칸 뒤로', () => order(-1), { disabled: multi !== 1 }),
      btn('복제', duplicate, { disabled: none }), btn('전체를 판에 맞추기', fitAll, { disabled: !d.images.length })));
    out.push(sec('선택한 이미지'));
    if (!im || multi > 1) out.push(help(none ? '목록이나 미리보기에서 이미지를 선택해 주세요.' : `${multi}개를 선택했어요. 크기와 위치는 하나만 선택했을 때 바꿀 수 있어요.`));
    const off = !im || multi > 1, V = im || { x: 0, y: 0, w: 0, h: 0, rot: 0 };
    const locked = off || a.on;
    if (!off) {
      const resize = (k, o) => (v) => {
        const r = im[o] / im[k], cx = im.x + im.w / 2, cy = im.y + im.h / 2;
        im[k] = v; if (im.lockRatio) im[o] = round(v * r);
        im.x = round(cx - im.w / 2); im.y = round(cy - im.h / 2);
      };
      out.push(h('div', { class: 'g2' },
        num('X (mm)', () => V.x, (v) => { im.x = v; }, { disabled: locked }), num('Y (mm)', () => V.y, (v) => { im.y = v; }, { disabled: locked }),
        num('폭 (mm)', () => V.w, resize('w', 'h'), { min: 1, max: 400 }), num('높이 (mm)', () => V.h, resize('h', 'w'), { min: 1, max: 400 }),
        num('회전 (°)', () => V.rot, (v) => { im.rot = ((v % 360) + 360) % 360; }), btn('90° 회전', () => { im.rot = (im.rot + 90) % 360; commit(); })));
      if (a.on) out.push(help('자동 정렬이 켜져 있어 위치는 자동으로 정해져요. 직접 옮기려면 아래에서 꺼 주세요.'));
      const q = Math.round(dpi(im));
      out.push(q < 150 ? h('p', { class: 'warntext' }, `⚠ 해상도 ${q}dpi: 150dpi보다 낮아 흐리게 인쇄될 수 있어요. 더 큰 이미지를 쓰거나 크기를 줄여 주세요.`) : help(`실효 해상도 ${q}dpi`));
      out.push(check('비율 고정', () => im.lockRatio, (v) => { im.lockRatio = v; }));
    }
    out.push(h('div', { class: 'g2' },
      btn('좌우 반전', () => { selected().forEach((m) => { m.flipH = !m.flipH; }); commit(); }, { pressed: im && im.flipH, disabled: none }),
      btn('상하 반전', () => { selected().forEach((m) => { m.flipV = !m.flipV; }); commit(); }, { pressed: im && im.flipV, disabled: none })));
    out.push(sec('정렬'), check('이미지 자동 정렬 사용', () => a.on, (v) => { a.on = v; }),
      help('끄면 이미지를 자유롭게 놓을 수 있어요. 켜면 아래 규칙대로 자동으로 맞춰져요.'),
      seg('나열 방식', [['row', '가로로'], ['column', '세로로'], ['grid', '격자']], () => a.mode, (v) => { a.mode = v; }, { disabled: !a.on }),
      h('div', { class: 'g2' }, num('이미지 간격 (mm)', () => a.gap, (v) => { a.gap = v; }, { min: 0, max: 100, disabled: !a.on }),
        select('맞춤', a.mode === 'column' ? [['start', '왼쪽'], ['center', '가운데'], ['end', '오른쪽']] : [['start', '위'], ['center', '가운데'], ['end', '아래']], () => a.cross, (v) => { a.cross = v; }, { disabled: !a.on })),
      sec('한 번만 맞추기', 3));
    const need = ui.base === 'sel' ? 2 : 1, dis = a.on || multi < need, dis2 = a.on || multi < (ui.base === 'sel' ? 3 : 2);
    if (a.on) out.push(help('자동 정렬을 끄면 쓸 수 있어요.'));
    else if (multi < need) out.push(help(ui.base === 'sel' ? '이미지를 2개 이상 선택해 주세요.' : '이미지를 선택해 주세요.'));
    out.push(seg('기준', [['plate', '판 기준'], ['sel', '선택한 이미지끼리']], () => ui.base, (v) => { ui.base = v; }, { local: true, disabled: a.on }),
      h('div', { class: 'g3' }, [['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽'], ['top', '위'], ['middle', '중간'], ['bottom', '아래']].map(([k, t]) => btn(t, () => alignOnce(k), { disabled: dis, key: 'al' + k }))),
      h('div', { class: 'g2' }, btn('가로 간격 균등', () => distribute('x'), { disabled: dis2 }), btn('세로 간격 균등', () => distribute('y'), { disabled: dis2 })));
    return out;
  }
  function panelCut() {
    const c = D().cut, s = c.stick, off = !s.on, follow = c.shape === 'follow';
    const out = [sec('칼선'),
      seg('칼선 모양', [['rect', '사각형'], ['roundrect', '둥근 사각형'], ['circle', '원'], ['follow', '이미지 따라가기']], () => c.shape, (v) => { c.shape = v; }, { two: true })];
    if (c.shape === 'circle') out.push(help('전체 이미지 상자 안에 들어가는 타원이에요. 네모난 이미지는 모서리가 잘릴 수 있으니 여유를 늘려 주세요.'));
    out.push(...color('칼선 색상 (PDF 안의 선 색)', c.color, '기본: 빨강'), help('칼선 색도 인쇄소 기준에 맞게 바꿀 수 있어요.'),
      num('선 굵기 (mm)', () => c.strokeMm, (v) => { c.strokeMm = v; }, { min: 0.01, max: 2, step: 0.05 }),
      range('여유: 이미지와의 간격', () => c.margin, (v) => { c.margin = v; }, { min: 0, max: 10, step: 0.1 }));
    const r = c.radii, all = (v) => { r.tl = r.tr = r.br = r.bl = v; };
    if (follow) out.push(sec('모서리 둥글기 (mm)'), num('볼록 모서리 최소 반경', () => r.tl, all, { min: 0.5, max: 20 }));
    else if (c.shape === 'roundrect') {
      const one4 = (k, t) => num(t, () => r[k], (v) => { c.radiiLinked ? all(v) : (r[k] = v); }, { min: 0.5, max: 100 });
      out.push(sec('모서리 둥글기 (mm)'), check('네 모서리를 같이 조절', () => c.radiiLinked, (v) => { c.radiiLinked = v; if (v) all(r.tl); }),
        h('div', { class: 'g2' }, one4('tl', '왼쪽 위'), one4('tr', '오른쪽 위'), one4('bl', '왼쪽 아래'), one4('br', '오른쪽 아래')), help('0.5mm 아래로는 내려가지 않아요(날카로운 모서리 방지).'));
    }
    const horiz = s.side === 'left' || s.side === 'right';
    out.push(sec('막대 (손잡이)'), check('막대 사용', () => s.on, (v) => { s.on = v; }));
    if (off) out.push(help('꺼져 있어요. 켜면 아래 설정이 활성화되고, 막대와 몸체가 하나의 칼선으로 합쳐져요.'));
    else if (D().autoAlign.on && s.toEnd) out.push(help('막대를 길게 하려면 이미지 탭에서 자동 정렬을 끄고 이미지를 반대쪽으로 옮겨 주세요.'));
    out.push(h('div', { class: 'g2' }, select('방향', [['bottom', '아래'], ['top', '위'], ['left', '왼쪽'], ['right', '오른쪽']], () => s.side, (v) => { s.side = v; }, { disabled: off }),
      num('폭 (mm)', () => s.width, (v) => { s.width = v; }, { min: 1, max: 100, disabled: off, key: 'sw' })),
      seg('막대 위치', [['center', '가운데'], ['start', horiz ? '위' : '왼쪽'], ['end', horiz ? '아래' : '오른쪽']], () => s.pos, (v) => { s.pos = v; }, { disabled: off }),
      check('길이: 남은 공간 끝까지', () => s.toEnd, (v) => { s.toEnd = v; }, { disabled: off }),
      h('div', { class: 'g2' }, num('길이 (mm)', () => s.length, (v) => { s.length = v; }, { min: 1, max: 270, disabled: off || s.toEnd }),
        num('판 끝 여백 (mm)', () => s.edgeMargin, (v) => { s.edgeMargin = v; }, { min: 0, max: 50, disabled: off || !s.toEnd })),
      seg('끝 모양', [['round', '둥글게'], ['square', '각지게']], () => s.endStyle, (v) => { s.endStyle = v; }, { disabled: off }),
      h('div', { class: 'g2' }, num('끝 둥글기 (mm)', () => s.endRadius, (v) => { s.endRadius = v; }, { min: 0, max: 50, disabled: off || s.endStyle === 'square' }),
        num('이음부 둥글기 (mm)', () => s.jointRadius, (v) => { s.jointRadius = v; }, { min: 0, max: 20, disabled: off })));
    return out;
  }
  function panelWhite() {
    const w = D().white, auto = w.mode === 'auto', none = w.mode === 'none';
    const sm = ['없음', '보통', '부드럽게', '아주 부드럽게'];
    const prot = w.ops.filter((o) => o.kind.startsWith('protect')).length, man = w.ops.length - prot;
    const out = [sec('화이트 만들기'),
      seg('화이트 방식', [['none', '없음'], ['full', '전체 채움'], ['auto', '자동']], () => w.mode, (v) => { w.mode = v; })];
    if (none) out.push(help('화이트를 만들지 않아요. 아래 설정은 전체 채움이나 자동에서 쓸 수 있어요.'));
    out.push(...color('화이트 색상 (PDF 안의 색)', w.color, '기본: C100'),
      help('인쇄소마다 화이트로 읽는 색이 달라서 자유롭게 바꿀 수 있어요. 올댓프린팅 기본값은 C100이에요.'),
      btn('기본값(C100)으로 되돌리기', () => { w.color = { space: 'cmyk', v: [1, 0, 0, 0] }; commit(); }),
      range('화이트 크기 조절', () => w.sizeOffset, (v) => { w.sizeOffset = round(v); }, { min: -1, max: 1, step: 0.01, disabled: none }), help('마이너스는 줄이기, 플러스는 키우기예요.'),
      range('불투명 기준', () => Math.round(w.opaqueThreshold * 100), (v) => { w.opaqueThreshold = v / 100; }, { min: 50, max: 100, step: 1, show: (v) => v + ' %', disabled: !auto }), help('불투명도가 이 값 이상인 부분만 화이트가 돼요.'),
      range('보호 영역 크기 조절', () => w.protectOffset, (v) => { w.protectOffset = round(v); }, { min: -1, max: 1, step: 0.01, disabled: !auto }),
      num('작은 조각 제거 (mm² 미만)', () => w.minArea, (v) => { w.minArea = v; }, { min: 0, max: 100, disabled: !auto }),
      range('가장자리 다듬기', () => w.smooth, (v) => { w.smooth = v; }, { min: 0, max: 3, step: 1, show: (v) => sm[v], disabled: !auto }),
      sec('얇은 글씨·선 보호', 3), help(`보호 영역 ${prot}개. 이 안에서는 보호 영역 크기 조절 값을 써요.`),
      h('div', { class: 'g2' }, btn('붓으로 보호 지정', () => setTool('protect-brush'), { pressed: ui.tool === 'protect-brush', disabled: !auto }), btn('사각형으로 지정', () => setTool('protect-rect'), { pressed: ui.tool === 'protect-rect', disabled: !auto })),
      btn('보호 영역 모두 지우기', () => { w.ops = w.ops.filter((o) => !o.kind.startsWith('protect')); commit(); }, { class: 'danger', disabled: !prot }),
      sec('수동 보정', 3), help(`화이트 추가·지움 ${man}개. 넓은 화면의 왼쪽 도구에서 칠할 수 있어요.`),
      btn('수동 보정 모두 지우기', () => { w.ops = w.ops.filter((o) => o.kind.startsWith('protect')); commit(); }, { class: 'danger', disabled: !man }));
    return out;
  }
  const defName = (id) => { let n = 0; for (const d of P.designs) for (const im of d.images) { n++; if (im.id === id) return '이미지' + n; } return '이미지'; };
  function layerNames() {
    const L = P.layers;
    return { ...L, imageNames: Object.fromEntries(P.designs.flatMap((d) => d.images).map((im) => [im.id, L.imageNames[im.id] || defName(im.id)])) };
  }
  function panelOut() {
    const L = P.layers, pl = P.plate, land = pl.w > pl.h, long = Math.max(pl.w, pl.h), short = Math.min(pl.w, pl.h);
    const set = (l, s, ld) => { pl.w = ld ? l : s; pl.h = ld ? s : l; ui.zoom = 0; P.designs.forEach((d, i) => { if (d.autoAlign.on) { const k = ui.d; ui.d = i; autoAlign(); ui.d = k; } }); };
    const names = P.designs.flatMap((d) => d.images);
    return [sec('PDF 레이어 이름'), help('일러스트레이터에서 PDF를 열었을 때 레이어 이름으로 보여요. 비우면 기본 이름, 겹치면 번호가 붙어요.'),
      text('화이트 레이어', () => L.white, (v) => { L.white = v; }, '화이트'), text('칼선 레이어', () => L.cut, (v) => { L.cut = v; }, '칼선'),
      seg('이미지 레이어 방식', [['perImage', '이미지마다 따로'], ['merged', '하나로 합치기']], () => L.imageMode, (v) => { L.imageMode = v; }),
      ...(L.imageMode === 'merged' ? [text('이미지 레이어', () => L.mergedName, (v) => { L.mergedName = v; }, '이미지')]
        : names.map((im, i) => text(`이미지 ${i + 1} 레이어 (${im.name})`, () => L.imageNames[im.id] || defName(im.id), (v) => { L.imageNames[im.id] = v; }, defName(im.id)))),
      help('쌓이는 순서(아래→위): 화이트, 이미지, 칼선'),
      sec('판'),
      h('div', { class: 'g2' }, select('긴 변 (mm)', [100, 140, 200, 230, 270].map((v) => [v, String(v)]), () => long, (v) => set(v, short, land)), select('짧은 변 (mm)', [50, 80].map((v) => [v, String(v)]), () => short, (v) => set(long, v, land))),
      seg('방향', [['p', '세로'], ['l', '가로']], () => (land ? 'l' : 'p'), (v) => set(long, short, v === 'l')),
      h('div', { class: 'g2' }, select('격자 간격', [1, 5, 10].map((v) => [v, v + ' mm']), () => pl.gridStep, (v) => { pl.gridStep = v; }), num('안전 여백 (mm)', () => pl.safeMargin, (v) => { pl.safeMargin = v; }, { min: 0, max: 20 })),
      check('격자·판 가장자리에 맞춤(스냅)', () => pl.snap, (v) => { pl.snap = v; })];
  }
  const TABS = [['image', '이미지', panelImage], ['cut', '칼선·막대', panelCut], ['white', '화이트', panelWhite], ['out', '출력', panelOut]];
  const VIEWS = [['final', '완성'], ['3d', '3D 미리보기'], ['white', '화이트만'], ['cut', '칼선만'], ['check', '화이트 확인']];

  function tablist(el, items, cur, fn) {
    const focus = el.contains(document.activeElement);
    el.replaceChildren(...items.map(([k, t], i) => h('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(k === cur), tabindex: k === cur ? 0 : -1, onclick: () => fn(k),
      onkeydown: (e) => { const dx = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (dx) { e.preventDefault(); fn(items[(i + dx + items.length) % items.length][0]); el.querySelector('[aria-selected=true]').focus(); } },
    }, t)));
    if (focus) el.querySelector('[aria-selected=true]').focus();
  }
  function renderPanel() {
    const el = $('panel'), act = document.activeElement, key = el.contains(act) ? act.dataset.k : null, top = el.scrollTop, same = el.dataset.tab === ui.tab;
    tablist($('ptabs'), TABS, ui.tab, (k) => { ui.tab = k; renderPanel(); });
    el.replaceChildren(...TABS.find((t) => t[0] === ui.tab)[2]());
    el.dataset.tab = ui.tab;
    el.setAttribute('aria-label', TABS.find((t) => t[0] === ui.tab)[1]);
    el.scrollTop = same ? top : 0;
    if (key) { const t = [...el.querySelectorAll('[data-k]')].find((x) => x.dataset.k === key); if (t && !t.disabled) t.focus({ preventScroll: true }); }
  }
  const ICON = { move: 'M5 3l14 8-6 2-2 6z', add: 'M4 20l4-1 11-11-3-3L5 16zM13 6l3 3', erase: 'M3 17l8-12 9 6-8 9H6zM9 20h11', 'protect-brush': 'M20 12a8 8 0 11-16 0 8 8 0 0116 0', 'protect-rect': 'M4 5h16v14H4z' };
  const TOOLS = [['move', '이동'], ['add', '화이트 추가'], ['erase', '화이트 지움'], ['protect-brush', '보호 붓'], ['protect-rect', '보호 영역']];
  function svg(d, dash) {
    const ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
    for (const [k, v] of Object.entries({ width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': 'true' })) s.setAttribute(k, v);
    if (dash) s.setAttribute('stroke-dasharray', '3 2');
    p.setAttribute('d', d); s.append(p); return s;
  }
  function renderTools() {
    const act = document.activeElement, key = $('tools').contains(act) ? act.dataset.k : null;
    const usable = (k) => k === 'move' || (D().white.mode === 'auto' || (D().white.mode === 'full' && !k.startsWith('protect')));
    if (!usable(ui.tool)) ui.tool = 'move';
    $('tools').replaceChildren(...TOOLS.map(([k, t]) => h('button', { class: 'tool', 'aria-pressed': String(ui.tool === k), disabled: !usable(k), 'data-k': k, title: usable(k) ? t : '화이트 방식이 맞을 때 쓸 수 있어요', onclick: () => setTool(k) }, svg(ICON[k], k.startsWith('protect')), t)),
      h('label', { class: 'fld' }, '붓 크기(mm)', h('input', { type: 'number', min: 0.1, max: 30, step: 0.1, value: ui.brush, 'data-k': 'brush', onchange: (e) => { ui.brush = clamp(parseFloat(e.target.value) || 2, 0.1, 30); e.target.value = ui.brush; draw(); } })),
      h('button', { class: 'tool', disabled: !undoStack.length, 'data-k': 'undo', onclick: undo, title: 'Ctrl+Z' }, svg('M9 7L4 12l5 5M4 12h11a5 5 0 010 10'), '되돌리기'),
      h('button', { class: 'tool', disabled: !redoStack.length, 'data-k': 'redo', onclick: redo, title: 'Ctrl+Shift+Z' }, svg('M15 7l5 5-5 5M20 12H9a5 5 0 000 10'), '다시 실행'));
    if (key) { const t = $('tools').querySelector(`[data-k="${key}"]`); if (t) t.focus(); }
  }
  function setTool(k) {
    ui.tool = k;
    if (k !== 'move' && ['3d', 'cut'].includes(ui.view)) setView('white');
    say(TOOLS.find((t) => t[0] === k)[1] + ' 도구'); renderTools(); renderPanel(); draw();
  }
  function setView(v) {
    ui.view = v;
    tablist($('views'), VIEWS, v, setView);
    $('legend').hidden = v !== 'check';
    $('v3d').hidden = v !== '3d';
    $('cv').hidden = v === '3d';
    if (v === '3d') { build3d(); }
    if (v === 'check' && result && !result.checkCv) schedule();
    draw();
  }
  function renderDesigns() {
    $('designs').replaceChildren(...P.designs.map((d, i) => h('button', { class: 'tab', 'aria-current': i === ui.d ? 'page' : undefined, onclick: () => { ui.d = i; ui.sel.clear(); ui.markers = []; refresh(); } }, '디자인 ' + (i + 1))),
      h('button', { class: 'btn', onclick: () => { const d = newDesign(), c = clone(D()); d.autoAlign = c.autoAlign; d.cut = c.cut; d.white = { ...c.white, ops: [] }; P.designs.push(d); ui.d = P.designs.length - 1; ui.sel.clear(); commit(); } }, '+ 디자인 추가'),
      P.designs.length > 1 ? h('button', { class: 'btn danger', onclick: () => { P.designs.splice(ui.d, 1); ui.d = Math.max(0, ui.d - 1); ui.sel.clear(); commit(); toast('디자인을 삭제했어요. 되돌리기(Ctrl+Z)로 되살릴 수 있어요.'); } }, `디자인 ${ui.d + 1} 삭제`) : '');
  }
  function warnings() {
    const d = D(), m = P.plate.safeMargin, w = [];
    const outs = d.images.filter((im) => { const b = box(im); return b.x0 < m - 0.01 || b.y0 < m - 0.01 || b.x1 > P.plate.w - m + 0.01 || b.y1 > P.plate.h - m + 0.01; });
    if (outs.length) w.push(`안전 여백 밖으로 나간 이미지: ${outs.map((i) => i.name).join(', ')}`);
    if (result && result.removed) w.push(`칼선이 여러 조각이라 ${result.removed}개를 뺐어요. 칼선 여유나 이음 반경을 늘려 보세요`);
    if (result && result.cut.some((l) => l.some(([x, y]) => x < -0.05 || y < -0.05 || x > P.plate.w + 0.05 || y > P.plate.h + 0.05))) w.push('칼선이 판 밖으로 나갔어요');
    const low = d.images.filter((im) => dpi(im) < 150);
    if (low.length) w.push(`해상도 150dpi 미만: ${low.map((i) => i.name).join(', ')}`);
    return w;
  }
  function renderStatus() {
    const s = selected(), w = D().images.length ? warnings() : [];
    $('selinfo').textContent = !s.length ? '선택 없음' : s.length > 1 ? `선택: ${s.length}개` : `선택: ${s[0].name} · X ${s[0].x.toFixed(1)} · Y ${s[0].y.toFixed(1)} mm`;
    const el = $('warn');
    el.hidden = !w.length;
    if (w.length) el.replaceChildren(svg('M12 3l10 18H2zM12 10v5M12 18v.5'), h('b', {}, `경고 ${w.length}`), h('span', {}, w[0]));
    el.title = w.join('\n');
    $('sub').textContent = `올댓프린팅 규격 · 1:1 mm · ${P.plate.w}×${P.plate.h} mm`;
  }
  function refresh() {
    pruneSel(); renderDesigns(); renderTools(); renderPanel();
    $('empty').hidden = D().images.length > 0;
    const any = P.designs.some((d) => d.images.length);
    $('check').disabled = !any; $('export').disabled = !any || working;
    schedule(); renderStatus(); draw();
  }

  // ---------- 이미지 조작 ----------
  function pick(id, add) { if (add) ui.sel.has(id) ? ui.sel.delete(id) : ui.sel.add(id); else ui.sel = new Set([id]); renderPanel(); renderStatus(); draw(); }
  function removeSel() { const n = selected().length; if (!n) return; D().images = D().images.filter((i) => !ui.sel.has(i.id)); ui.sel.clear(); commit(); toast(`이미지 ${n}개를 삭제했어요. 되돌리기(Ctrl+Z)로 되살릴 수 있어요.`); }
  function duplicate() { const c = selected().map((m) => ({ ...clone(m), id: uid('i'), x: m.x + 5, y: m.y + 5, name: m.name + ' 복사' })); D().images.push(...c); ui.sel = new Set(c.map((m) => m.id)); commit(); }
  function order(dir) { const a = D().images, i = a.indexOf(one()), j = i + dir; if (j < 0 || j >= a.length) { say('더 옮길 수 없어요'); return; } [a[i], a[j]] = [a[j], a[i]]; commit(); }

  // ---------- 스테이지 ----------
  const cv = $('cv'), ctx = cv.getContext('2d'), RUL = 28;
  let W = 0, H = 0, dpr = 1, stroke = null, cursor = null, rafId = 0;
  function fit() {
    const small = H < 420, aw = Math.max(40, W - RUL - (small ? 16 : 48)), ah = Math.max(40, H - RUL - (small ? 16 : 72));
    ui.zoom = Math.min(aw / P.plate.w, ah / P.plate.h);
    ui.panX = RUL + (W - RUL - P.plate.w * ui.zoom) / 2; ui.panY = RUL + (H - RUL - P.plate.h * ui.zoom) / 2;
  }
  let fitZoom = 1;
  const toMmPt = (x, y) => [(x - ui.panX) / ui.zoom, (y - ui.panY) / ui.zoom];
  function zoomAt(f, x = W / 2, y = H / 2) {
    const z = clamp(ui.zoom * f, 0.5, 200), k = z / ui.zoom;
    ui.panX = x - (x - ui.panX) * k; ui.panY = y - (y - ui.panY) * k; ui.zoom = z; ui.manual = true; draw();
  }
  function resizeCv() {
    const r = $('stage').getBoundingClientRect();
    if (!r.width) return;
    W = r.width; H = r.height; dpr = Math.min(3, devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    if (!ui.manual) ui.zoom = 0;
    paint();
    if (ui.view === '3d') size3d();
  }
  new ResizeObserver(resizeCv).observe($('stage'));
  function draw() { if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; paint(); }); }
  function drawImages(c, ims) {
    for (const im of ims) {
      const a = assets.get(im.asset);
      if (!a) continue;
      c.save();
      c.translate(im.x + im.w / 2, im.y + im.h / 2); c.rotate(im.rot * Math.PI / 180); c.scale(im.flipH ? -1 : 1, im.flipV ? -1 : 1);
      c.imageSmoothingQuality = 'high';
      c.drawImage(a.view, -im.w / 2, -im.h / 2, im.w, im.h);
      c.restore();
    }
  }
  let checker;
  function paint() {
    if (!W) return;
    if (!ui.zoom) { fit(); fitZoom = ui.zoom; ui.manual = false; }
    $('zval').textContent = Math.round(ui.zoom / fitZoom * 100) + '%';
    if (ui.view === '3d') return;
    const z = ui.zoom, px = 1 / z, d = D(), pl = P.plate, r = result;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ui.panX, dpr * ui.panY);
    ctx.lineJoin = 'round';
    if (!checker) {
      const t = h('canvas', { width: 24, height: 24 }), c = t.getContext('2d');
      c.fillStyle = '#EEF0F3'; c.fillRect(0, 0, 24, 24); c.fillStyle = '#DDE1E7'; c.fillRect(0, 0, 12, 12); c.fillRect(12, 12, 12, 12);
      checker = ctx.createPattern(t, 'repeat');
    }
    const V = ui.view;
    if (V === 'final') { checker.setTransform(new DOMMatrix().scale(px)); ctx.fillStyle = checker; } else ctx.fillStyle = { white: '#3A3F47', cut: '#fff', check: '#14171B' }[V];
    ctx.fillRect(0, 0, pl.w, pl.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, pl.w, pl.h); ctx.clip();
    if (V === 'check' && r && r.checkCv && !dragging) {
      ctx.imageSmoothingEnabled = r.g.ppm * 2 > z;
      ctx.drawImage(r.checkCv, -r.g.pad / r.g.ppm, -r.g.pad / r.g.ppm, r.g.w / r.g.ppm, r.g.h / r.g.ppm);
      ctx.imageSmoothingEnabled = true;
    }
    ctx.restore();
    if (V === 'final') {
      if (P.plate.snap && pl.gridStep * z > 8) {
        ctx.strokeStyle = 'rgba(75,85,99,.13)'; ctx.lineWidth = px; ctx.beginPath();
        for (let x = pl.gridStep; x < pl.w; x += pl.gridStep) { ctx.moveTo(x, 0); ctx.lineTo(x, pl.h); }
        for (let y = pl.gridStep; y < pl.h; y += pl.gridStep) { ctx.moveTo(0, y); ctx.lineTo(pl.w, y); }
        ctx.stroke();
      }
      if (r) {
        ctx.fillStyle = 'rgba(191,217,242,.4)'; ctx.fill(r.cutPath);
        ctx.fillStyle = '#fff'; ctx.fill(r.whitePath, 'evenodd');
        ctx.globalAlpha = 0.25; drawImages(ctx, d.images); ctx.globalAlpha = 1;
        ctx.save(); ctx.clip(r.cutPath); ctx.fillStyle = '#fff';
        drawImages(ctx, d.images); ctx.restore();
      } else drawImages(ctx, d.images);
    }
    if (V === 'white' && r) {
      ctx.fillStyle = '#23272D'; ctx.fill(r.cutPath); ctx.strokeStyle = '#9AA3AF'; ctx.lineWidth = px; ctx.stroke(r.cutPath);
      ctx.fillStyle = hex(d.white.color); ctx.fill(r.whitePath, 'evenodd');
    }
    if (V === 'white' || V === 'check' || ui.tool.startsWith('protect')) drawProtect(d);
    if (r && V !== 'white') { ctx.strokeStyle = hex(d.cut.color); ctx.lineWidth = Math.max(d.cut.strokeMm, 1.5 * px); ctx.stroke(r.cutPath); }
    if (dragging && V !== 'final') { ctx.globalAlpha = 0.7; drawImages(ctx, d.images); ctx.globalAlpha = 1; }
    if (V === 'final') {
      const m = pl.safeMargin;
      ctx.strokeStyle = '#4B5563'; ctx.lineWidth = px; ctx.setLineDash([5 * px, 4 * px]); ctx.strokeRect(m, m, pl.w - 2 * m, pl.h - 2 * m); ctx.setLineDash([]);
    }
    if (ui.tool === 'move' && (V === 'final' || dragging)) for (const im of selected()) drawSel(im, px);
    ctx.strokeStyle = '#B3005E'; ctx.lineWidth = px;
    for (const g of ui.guides) { ctx.beginPath(); if (g.x !== undefined) { ctx.moveTo(g.x, 0); ctx.lineTo(g.x, pl.h); } else { ctx.moveTo(0, g.y); ctx.lineTo(pl.w, g.y); } ctx.stroke(); }
    if (r && r.removedBoxes && V !== '3d') markers(r.removedBoxes, px, '빠진 조각 ');
    markers(ui.markers, px, '');
    if (stroke) {
      ctx.strokeStyle = { add: 'rgba(31,79,216,.6)', erase: 'rgba(179,38,30,.6)' }[stroke.kind] || 'rgba(242,163,58,.6)';
      if (stroke.kind === 'protect-rect') { ctx.lineWidth = 2 * px; ctx.strokeRect(stroke.x, stroke.y, stroke.w, stroke.h); }
      else { ctx.lineCap = 'round'; ctx.lineWidth = stroke.r * 2; ctx.beginPath(); stroke.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (stroke.pts.length === 1) ctx.lineTo(stroke.pts[0][0] + 1e-4, stroke.pts[0][1]); ctx.stroke(); ctx.lineCap = 'butt'; }
    }
    if (cursor && ui.tool !== 'move' && ui.tool !== 'protect-rect') {
      ctx.lineWidth = px; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(cursor[0], cursor[1], ui.brush / 2 + px, 0, 7); ctx.stroke();
      ctx.strokeStyle = '#1B1F24'; ctx.beginPath(); ctx.arc(cursor[0], cursor[1], ui.brush / 2, 0, 7); ctx.stroke();
    }
    rulers();
    cv.setAttribute('aria-label', `${VIEWS.find((v) => v[0] === V)[1]} 미리보기: 이미지 ${d.images.length}개, 막대 ${d.cut.stick.on ? '있음' : '없음'}. 화살표 키로 선택한 이미지를 옮겨요.`);
  }
  function drawProtect(d) {
    const px = 1 / ui.zoom;
    for (const o of d.white.ops) {
      if (!o.kind.startsWith('protect')) continue;
      ctx.strokeStyle = '#F2A33A'; ctx.lineWidth = 1.5 * px; ctx.setLineDash([5 * px, 3 * px]);
      let x, y;
      if (o.kind === 'protect-rect') { ctx.strokeRect(o.x, o.y, o.w, o.h); x = o.x; y = o.y; } else {
        ctx.setLineDash([]); ctx.strokeStyle = 'rgba(242,163,58,.45)'; ctx.lineCap = 'round'; ctx.lineWidth = o.r * 2; ctx.beginPath();
        o.pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); if (o.pts.length === 1) ctx.lineTo(o.pts[0][0] + 1e-4, o.pts[0][1]);
        ctx.stroke(); ctx.lineCap = 'butt'; [x, y] = o.pts[0]; y -= o.r;
      }
      ctx.setLineDash([]); label('보호 영역', x, y, px);
    }
  }
  function label(t, x, y, px) {
    ctx.save(); ctx.translate(x, y); ctx.scale(px, px); ctx.font = '12px system-ui,sans-serif';
    const w = ctx.measureText(t).width; ctx.fillStyle = '#1B1F24'; ctx.fillRect(0, -20, w + 10, 18); ctx.fillStyle = '#fff'; ctx.fillText(t, 5, -7); ctx.restore();
  }
  function markers(list, px, pre) {
    list.forEach((b, i) => {
      const m = 6 * px;
      for (const [c, w] of [['#fff', 4], ['#B3261E', 2]]) { ctx.strokeStyle = c; ctx.lineWidth = w * px; ctx.strokeRect(b.x0 - m, b.y0 - m, b.x1 - b.x0 + 2 * m, b.y1 - b.y0 + 2 * m); }
      label(pre + (i + 1), b.x0 - m, b.y0 - m, px);
    });
  }
  function handles(im) {
    const a = im.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), cx = im.x + im.w / 2, cy = im.y + im.h / 2;
    const at = (u, v) => [cx + u * c - v * s, cy + u * s + v * c];
    return { corners: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ sx, sy, p: at(sx * im.w / 2, sy * im.h / 2) })), rot: at(0, -im.h / 2 - 26 / ui.zoom), top: at(0, -im.h / 2) };
  }
  function drawSel(im, px) {
    const k = handles(im);
    ctx.strokeStyle = '#1F4FD8'; ctx.lineWidth = 2 * px; ctx.setLineDash([5 * px, 3 * px]); ctx.beginPath();
    k.corners.forEach((c, i) => (i ? ctx.lineTo(...c.p) : ctx.moveTo(...c.p))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    if (selected().length !== 1) return;
    ctx.beginPath(); ctx.moveTo(...k.top); ctx.lineTo(...k.rot); ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const c of k.corners) { ctx.beginPath(); ctx.rect(c.p[0] - 5 * px, c.p[1] - 5 * px, 10 * px, 10 * px); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(k.rot[0], k.rot[1], 6 * px, 0, 7); ctx.fill(); ctx.stroke();
  }
  function rulers() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const z = ui.zoom, step = [1, 2, 5, 10, 20, 50, 100].find((s) => s * z >= 34) || 100;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, RUL); ctx.fillRect(0, 0, RUL, H);
    ctx.fillStyle = '#4B5563'; ctx.strokeStyle = '#6B7280'; ctx.lineWidth = 1; ctx.font = '11px system-ui,sans-serif'; ctx.beginPath();
    ctx.moveTo(RUL, RUL - 0.5); ctx.lineTo(W, RUL - 0.5); ctx.moveTo(RUL - 0.5, RUL); ctx.lineTo(RUL - 0.5, H);
    for (let v = 0; v <= P.plate.w; v += step) { const x = Math.round(ui.panX + v * z) + 0.5; if (x < RUL || x > W) continue; ctx.moveTo(x, 12); ctx.lineTo(x, RUL); ctx.fillText(v, x + 3, 14); }
    for (let v = 0; v <= P.plate.h; v += step) { const y = Math.round(ui.panY + v * z) + 0.5; if (y < RUL || y > H) continue; ctx.moveTo(16, y); ctx.lineTo(RUL, y); ctx.fillText(v, 2, y + 12); }
    ctx.stroke(); ctx.fillText('mm', 5, 17);
  }

  // ---------- 포인터 ----------
  const ptrs = new Map();
  let act = null, pinch = null;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function hit(im, [x, y]) {
    const a = -im.rot * Math.PI / 180, dx = x - im.x - im.w / 2, dy = y - im.y - im.h / 2;
    return Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= im.w / 2 && Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= im.h / 2;
  }
  cv.addEventListener('pointerdown', (e) => {
    cv.focus({ preventScroll: true });
    cv.setPointerCapture(e.pointerId);
    const s = pos(e), p = toMmPt(...s);
    ptrs.set(e.pointerId, s);
    if (ptrs.size === 2) { cancelAct(); const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }; return; }
    if (ptrs.size > 2 || e.button === 2) return;
    if (e.button === 1 || spaceDown) { e.preventDefault(); act = { t: 'pan', s }; return; }
    if (ui.tool !== 'move') {
      if (!D().images.length) return;
      stroke = ui.tool === 'protect-rect' ? { kind: 'protect-rect', x: p[0], y: p[1], w: 0, h: 0 } : { kind: ui.tool, r: ui.brush / 2, pts: [p] };
      act = { t: 'stroke', p }; draw(); return;
    }
    const tol = (e.pointerType === 'mouse' ? 10 : 22) / ui.zoom, im = selected().length === 1 && ui.view === 'final' ? one() : null;
    if (im) {
      const k = handles(im), near = (q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol;
      if (near(k.rot)) { act = { t: 'rot', im, o: clone(im) }; return; }
      const c = k.corners.find((q) => near(q.p));
      if (c) { const opp = k.corners.find((q) => q.sx === -c.sx && q.sy === -c.sy).p; act = { t: 'size', im, o: clone(im), c, opp }; return; }
    }
    const top = [...D().images].reverse().find((m) => hit(m, p));
    if (!top) { if (!e.shiftKey && ui.sel.size) { ui.sel.clear(); renderPanel(); renderStatus(); } act = { t: 'pan', s }; draw(); return; }
    if (e.shiftKey || e.ctrlKey) { pick(top.id, true); return; }
    if (!ui.sel.has(top.id)) pick(top.id);
    act = { t: 'move', p, o: selected().map((m) => [m, m.x, m.y]), b: C.unionBox(selected().map(box)) };
  });
  cv.addEventListener('pointermove', (e) => {
    const s = pos(e), p = toMmPt(...s);
    cursor = e.pointerType === 'touch' ? null : p;
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, s);
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
      ui.panX += x - pinch.x; ui.panY += y - pinch.y; zoomAt(d / pinch.d, x, y); pinch = { d, x, y }; return;
    }
    if (!act) { if (ui.tool !== 'move') draw(); else cv.style.cursor = D().images.some((m) => hit(m, p)) ? 'move' : 'default'; return; }
    if (act.t === 'pan') { ui.panX += s[0] - act.s[0]; ui.panY += s[1] - act.s[1]; act.s = s; ui.manual = true; draw(); return; }
    if (act.t === 'stroke') {
      if (stroke.kind === 'protect-rect') Object.assign(stroke, { x: Math.min(p[0], act.p[0]), y: Math.min(p[1], act.p[1]), w: Math.abs(p[0] - act.p[0]), h: Math.abs(p[1] - act.p[1]) });
      else { const l = stroke.pts[stroke.pts.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) > Math.max(0.05, 1.5 / ui.zoom)) stroke.pts.push([round(p[0], 3), round(p[1], 3)]); }
      draw(); return;
    }
    if (act.t === 'move') {
      let dx = p[0] - act.p[0], dy = p[1] - act.p[1];
      if (!dragging) {
        if (Math.hypot(dx, dy) * ui.zoom < 4) return;
        if (D().autoAlign.on) { act = null; toast('자동 정렬이 켜져 있어요. 직접 옮기려면 이미지 탭에서 꺼 주세요.'); return; }
      }
      startDrag();
      [dx, dy] = e.altKey ? ((ui.guides = []), [dx, dy]) : snapMove(act.b, dx, dy);
      for (const [m, x, y] of act.o) { m.x = round(x + dx, 3); m.y = round(y + dy, 3); }
    } else if (act.t === 'rot') {
      startDrag();
      const o = act.o, a = Math.atan2(p[0] - o.x - o.w / 2, -(p[1] - o.y - o.h / 2)) * 180 / Math.PI;
      const q = Math.round(a / 15) * 15;
      act.im.rot = round(((Math.abs(a - q) < 3 && !e.altKey ? q : a) % 360 + 360) % 360, 1);
    } else if (act.t === 'size') {
      startDrag();
      const { im, o, c, opp } = act, a = im.rot * Math.PI / 180;
      let q = p;
      if (P.plate.snap && im.rot === 0 && !e.altKey) { const t = 6 / ui.zoom, g = P.plate.gridStep; q = p.map((v) => { const n = Math.round(v / g) * g; return Math.abs(n - v) < t ? n : v; }); }
      const vx = q[0] - opp[0], vy = q[1] - opp[1];
      let w = Math.max(1, (vx * Math.cos(a) + vy * Math.sin(a)) * c.sx), hh = Math.max(1, (-vx * Math.sin(a) + vy * Math.cos(a)) * c.sy);
      if (im.lockRatio) { const k = Math.max(w / o.w, hh / o.h, 1 / Math.min(o.w, o.h)); w = o.w * k; hh = o.h * k; }
      const ux = c.sx * w / 2, uy = c.sy * hh / 2, cx = opp[0] + ux * Math.cos(a) - uy * Math.sin(a), cy = opp[1] + ux * Math.sin(a) + uy * Math.cos(a);
      Object.assign(im, { w: round(w), h: round(hh), x: round(cx - w / 2, 3), y: round(cy - hh / 2, 3) });
    }
    renderStatus(); draw();
  });
  function startDrag() { if (!dragging) { dragging = true; gen++; result = null; } }
  function snapMove(b, dx, dy) {
    ui.guides = [];
    if (!P.plate.snap) return [dx, dy];
    const t = 6 / ui.zoom, m = P.plate.safeMargin, g = P.plate.gridStep;
    const axis = (lo, hi, dv, L, key) => {
      let best = null;
      for (const e of [lo, (lo + hi) / 2, hi]) for (const c of e === (lo + hi) / 2 ? [L / 2] : [0, m, L / 2, L - m, L]) { const q = c - (e + dv); if (Math.abs(q) < t && (!best || Math.abs(q) < Math.abs(best.q))) best = { q, c }; }
      if (best) { ui.guides.push({ [key]: best.c }); return dv + best.q; }
      const q = Math.round((lo + dv) / g) * g - (lo + dv);
      return Math.abs(q) < t / 2 ? dv + q : dv;
    };
    return [axis(b.x0, b.x1, dx, P.plate.w, 'x'), axis(b.y0, b.y1, dy, P.plate.h, 'y')];
  }
  function cancelAct() {
    if (act && dragging) { P = JSON.parse(last); pruneSel(); }
    stroke = null; act = null; dragging = false; ui.guides = []; refresh();
  }
  function endPtr(e) {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!act) return;
    if (e.type === 'pointercancel') { cancelAct(); return; }
    const t = act.t; act = null; ui.guides = [];
    if (t === 'stroke') {
      const s = stroke; stroke = null;
      if (s.kind !== 'protect-rect' || (s.w > 0.2 && s.h > 0.2)) { D().white.ops.push(s); commit(); } else draw();
      return;
    }
    if (dragging) { dragging = false; commit(); }
  }
  cv.addEventListener('pointerup', endPtr);
  cv.addEventListener('pointercancel', endPtr);
  cv.addEventListener('pointerleave', () => { cursor = null; draw(); });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-clamp(e.deltaY, -200, 200) * 0.002), ...pos(e)); }, { passive: false });
  let spaceDown = false, keyTimer;
  cv.addEventListener('keydown', (e) => {
    if (e.key === ' ') { spaceDown = true; e.preventDefault(); }
    const v = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (v && selected().length) {
      e.preventDefault();
      if (D().autoAlign.on) { say('자동 정렬이 켜져 있어 옮길 수 없어요'); return; }
      const k = e.shiftKey ? 5 : e.altKey ? 0.1 : 1;
      selected().forEach((m) => { m.x = round(m.x + v[0] * k, 3); m.y = round(m.y + v[1] * k, 3); });
      renderStatus(); draw(); clearTimeout(keyTimer); keyTimer = setTimeout(commit, 250);
    } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSel(); }
    else if (e.key === '+' || e.key === '=') zoomAt(1.25);
    else if (e.key === '-') zoomAt(0.8);
    else if (e.key === 'Escape') { if (act) cancelAct(); else if (ui.tool !== 'move') setTool('move'); else { ui.sel.clear(); refresh(); } }
  });
  addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });
  addEventListener('blur', () => { spaceDown = false; });
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || $('report').open) return;
    const k = e.key.toLowerCase(), t = e.target;
    if (t.matches && t.matches('input[type=text],input[type=number]') && (k === 'z' || k === 'y')) return;
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); } else if (k === 'y') { e.preventDefault(); redo(); } else if (k === 's') { e.preventDefault(); saveJson(); }
  });

  // ---------- 3D ----------
  let slab, scene, ctl;
  const BGS = [['#D9E2EC', '연한 파랑'], ['#F3EBDD', '연한 베이지'], ['#2B3038', '짙은 회색']];
  function build3d() {
    const v = $('v3d');
    if (!scene) {
      slab = h('div', { class: 'slab' });
      scene = h('div', { class: 'scene', tabindex: 0, role: 'img', 'aria-label': '3D 미리보기: 두께 3mm 아크릴. 끌거나 화살표 키로 회전해요.' }, slab);
      ctl = h('div', { class: 'ctl3d' });
      v.append(scene, ctl);
      let s = null;
      scene.addEventListener('pointerdown', (e) => { s = [e.clientX, e.clientY, ui.rx, ui.ry]; scene.setPointerCapture(e.pointerId); });
      scene.addEventListener('pointermove', (e) => { if (s) { ui.ry = s[3] + (e.clientX - s[0]) * 0.5; ui.rx = clamp(s[2] - (e.clientY - s[1]) * 0.5, -85, 85); turn(); } });
      const end = () => { if (s) { s = null; ctl3d(); } };
      scene.addEventListener('pointerup', end); scene.addEventListener('pointercancel', end);
      scene.addEventListener('keydown', (e) => { const d = { ArrowLeft: [0, -6], ArrowRight: [0, 6], ArrowUp: [6, 0], ArrowDown: [-6, 0] }[e.key]; if (d) { e.preventDefault(); ui.rx = clamp(ui.rx + d[0], -85, 85); ui.ry += d[1]; turn(); ctl3d(); } });
    }
    const R = 8, w = P.plate.w * R, hh = P.plate.h * R, layers = 13, r = result;
    const layer = (fn) => { const c = h('canvas', { width: w, height: hh, 'aria-hidden': 'true' }), x = c.getContext('2d'); x.scale(R, R); if (r) fn(x); return c; };
    const cs = [];
    const d = D();
    for (let i = 0; i < layers; i++) {
      const first = i === 0, lastL = i === layers - 1;
      const c = layer((x) => {
        if (lastL) { x.fillStyle = 'rgba(225,238,250,.16)'; x.fill(r.cutPath); x.save(); x.clip(r.cutPath); x.fillStyle = '#fff'; x.fill(r.whitePath, 'evenodd'); drawImages(x, d.images); x.restore(); }
        else if (first) { x.fillStyle = 'rgba(191,217,242,.30)'; x.fill(r.cutPath); }
        x.strokeStyle = first || lastL ? 'rgba(255,255,255,.9)' : 'rgba(110,152,196,.30)'; x.lineWidth = first || lastL ? 0.4 : 0.7; x.save(); x.clip(r.cutPath); x.stroke(r.cutPath); x.restore();
      });
      c.dataset.z = i / (layers - 1) - 0.5;
      cs.push(c);
    }
    slab.replaceChildren(...cs);
    ctl3d(); size3d();
  }
  function size3d() {
    if (!scene) return;
    const k = Math.min((scene.clientWidth - 60) / P.plate.w, (scene.clientHeight - 40) / P.plate.h) * 0.85;
    if (!(k > 0)) return;
    slab.style.width = P.plate.w * k + 'px'; slab.style.height = P.plate.h * k + 'px';
    for (const c of slab.children) c.style.transform = `translateZ(${c.dataset.z * 3 * k}px)`;
    turn();
  }
  function turn() { slab.style.transform = `rotateX(${ui.rx}deg) rotateY(${ui.ry}deg)`; scene.style.background = ui.bg; }
  function ctl3d() {
    const foc = ctl.contains(document.activeElement) && document.activeElement.dataset.k;
    const b = (t, k, v) => btn(t, () => { ui[k] = v; turn(); ctl3d(); }, { pressed: ui[k] === v });
    ctl.replaceChildren(
      h('div', { role: 'group', 'aria-label': '좌우 회전' }, b('왼쪽에서', 'ry', 28), b('정면', 'ry', 0), b('오른쪽에서', 'ry', -28)),
      h('div', { role: 'group', 'aria-label': '상하 회전' }, b('위에서', 'rx', -28), b('수평', 'rx', 0), b('아래에서', 'rx', 28)),
      h('label', { class: 'row help' }, '배경 색 직접 선택', h('input', { type: 'color', value: ui.bg.toLowerCase(), 'data-k': 'bg', oninput: (e) => { ui.bg = e.target.value.toUpperCase(); turn(); }, onchange: ctl3d })),
      h('div', { role: 'group', 'aria-label': '추천 배경 색' }, h('span', { class: 'help' }, '추천 배경'), BGS.map(([c, n]) => h('button', { class: 'swatch', 'aria-label': n + ' 배경', title: n, 'data-k': c, 'aria-pressed': String(ui.bg === c), style: 'background:' + c, onclick: () => { ui.bg = c; turn(); ctl3d(); } }))),
      h('span', { class: 'help' }, '두께 3 mm · 끌어서 회전'));
    if (foc) { const t = [...ctl.querySelectorAll('[data-k]')].find((x) => x.dataset.k === foc); if (t) t.focus(); }
  }

  // ---------- 저장 / 불러오기 ----------
  function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  function saveJson() {
    const out = clone(P);
    for (const d of out.designs) for (const im of d.images) { im.src = assets.get(im.asset).src; delete im.asset; }
    download(new Blob([JSON.stringify(out)], { type: 'application/json' }), `포토프랍 작업 ${P.plate.w}x${P.plate.h}.json`);
    dirty = false; toast('✓ 작업을 저장했어요');
  }
  /** 기본값 구조에 있는 키만, 같은 형식일 때만 받아들여요. */
  function merge(base, inc) {
    if (Array.isArray(base)) return Array.isArray(inc) ? inc : base;
    if (base && typeof base === 'object') { const o = {}; for (const k of Object.keys(base)) o[k] = merge(base[k], inc ? inc[k] : undefined); return o; }
    return typeof inc === typeof base && (typeof inc !== 'number' || isFinite(inc)) ? inc : base;
  }
  const fin = (...v) => v.every((x) => typeof x === 'number' && isFinite(x));
  function cleanColor(c, def) { const n = c.space === 'rgb' ? 3 : 4; return ['rgb', 'cmyk'].includes(c.space) && c.v.length === n && fin(...c.v) ? { space: c.space, v: c.v.map((x) => clamp(x, 0, 1)) } : def; }
  async function loadJson(file) {
    try {
      const j = JSON.parse(await readFile(file, 'readAsText'));
      if (j.version !== 1 || !j.plate || !Array.isArray(j.designs) || !j.designs.length) throw new Error('이 에디터의 작업 파일이 아니에요');
      busyN++; $('busy').hidden = false;
      const N = { version: 1, plate: merge(P.plate, j.plate), designs: [], layers: merge({ white: '화이트', cut: '칼선', imageMode: 'perImage', mergedName: '이미지' }, j.layers) };
      const long = Math.max(N.plate.w, N.plate.h), short = Math.min(N.plate.w, N.plate.h);
      if (![100, 140, 200, 230, 270].includes(long) || ![50, 80].includes(short)) throw new Error('지원하지 않는 판 크기예요');
      N.layers.imageNames = {};
      const seen = new Set(), freshId = (id, p) => { const r = typeof id === 'string' && id && !seen.has(id) ? id : uid(p); seen.add(r); return r; };
      for (const jd of j.designs) {
        const base = newDesign(), d = merge(base, { ...jd, images: [] });
        d.id = freshId(jd.id, 'd');
        d.cut.color = cleanColor(d.cut.color, base.cut.color); d.white.color = cleanColor(d.white.color, base.white.color);
        d.white.ops = d.white.ops.filter((o) => o && (o.kind === 'protect-rect' ? fin(o.x, o.y, o.w, o.h) : ['add', 'erase', 'protect-brush'].includes(o.kind) && fin(o.r) && Array.isArray(o.pts) && o.pts.length && o.pts.every((p) => Array.isArray(p) && fin(p[0], p[1]))));
        for (const ji of jd.images || []) {
          if (typeof ji.src !== 'string' || !/^data:image\/(png|jpeg|webp);/.test(ji.src)) throw new Error('이미지 데이터가 없거나 형식이 달라요');
          if (!fin(ji.x, ji.y, ji.w, ji.h) || ji.w <= 0 || ji.h <= 0) throw new Error('이미지 크기 정보가 잘못됐어요');
          const im = merge({ name: '이미지', x: 0, y: 0, w: 1, h: 1, rot: 0, flipH: false, flipV: false, lockRatio: true }, ji);
          im.id = freshId(ji.id, 'i'); im.asset = await addAsset(ji.src);
          const nm = j.layers && j.layers.imageNames && j.layers.imageNames[ji.id];
          if (typeof nm === 'string' && nm.trim()) N.layers.imageNames[im.id] = nm;
          d.images.push(im);
        }
        N.designs.push(d);
      }
      P = N; ui.d = 0; ui.sel.clear(); ui.zoom = 0;
      undoStack = []; redoStack = []; last = JSON.stringify(P); dirty = false; ui.markers = [];
      busyN--; refresh(); toast('✓ 작업을 불러왔어요');
    } catch (e) { busyN = 0; busy(); toast('✕ 작업을 불러오지 못했어요: ' + e.message, true, () => $('fJson').click()); }
  }

  // ---------- 내보내기 / 검증 ----------
  const LIMIT = 9.5 * 1024 * 1024;
  let working = false, pdfOut = null;
  const fsize = (n) => (n < 104858 ? Math.ceil(n / 1024) + 'KB' : (n / 1048576).toFixed(1) + 'MB');
  const toBlob = (c, t, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('이미지를 변환하지 못했어요'))), t, q));
  async function makePdf(designs) {
    const used = new Set(designs.flatMap((d) => d.images.map((i) => i.asset)));
    let scale = 1, bytes, tries = 0;
    for (;;) {
      const jpegs = {};
      for (const id of used) {
        const a = assets.get(id);
        if (!a.opaque) continue;
        let c = a.full;
        if (scale < 1) { c = h('canvas', { width: Math.max(1, Math.round(a.w * scale)), height: Math.max(1, Math.round(a.h * scale)) }); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(a.full, 0, 0, c.width, c.height); }
        jpegs[id] = { w: c.width, h: c.height, bytes: new Uint8Array(await (await toBlob(c, 'image/jpeg', 0.95)).arrayBuffer()) };
      }
      bytes = (await call('pdf', { layers: layerNames(), jpegs, scale })).bytes;
      if (bytes.byteLength <= LIMIT || tries >= 3) break;
      tries++; scale *= Math.sqrt(LIMIT / bytes.byteLength) * 0.97;
    }
    return { bytes, scale };
  }
  async function run(force) {
    if (working) return;
    if (typeof CompressionStream === 'undefined') { toast('✕ 이 브라우저는 PDF 압축을 지원하지 않아요. 최신 Chrome, Edge, Safari, Firefox를 사용해 주세요.', true); return; }
    const designs = P.designs.filter((d) => d.images.length);
    if (!designs.length) return;
    working = true;
    const b = $(force ? 'check' : 'export'); b.setAttribute('aria-busy', 'true'); $('check').disabled = $('export').disabled = true;
    say('PDF를 만드는 중이에요');
    try {
      const snap = clone(designs);
      const { reports } = await call('compute', { designs: snap, plate: clone(P.plate) });
      const { bytes, scale } = await makePdf(snap);
      pdfOut = { bytes, name: `포토프랍_${P.plate.w}x${P.plate.h}.pdf` };
      const rows = buildRows(reports, designs, bytes.byteLength, scale);
      if (!force && rows.every((r) => r.s === 'ok')) savePdf(); else showReport(rows);
    } catch (e) { toast('✕ PDF를 만들지 못했어요: ' + e.message, true, () => run(force)); }
    working = false; b.removeAttribute('aria-busy');
    const any = P.designs.some((d) => d.images.length); $('check').disabled = $('export').disabled = !any;
  }
  function savePdf() {
    download(new Blob([pdfOut.bytes], { type: 'application/pdf' }), pdfOut.name);
    toast(`✓ PDF를 저장했어요 (${fsize(pdfOut.bytes.byteLength)})`);
  }
  function buildRows(reports, designs, len, scale) {
    const rows = [], many = P.designs.length > 1;
    reports.forEach((r, k) => {
      const d = designs[k], idx = P.designs.indexOf(d), pre = many ? `디자인 ${idx + 1}: ` : '';
      const add = (s, t, sub, boxes, view) => rows.push({ s, t: pre + t, sub, boxes, view, idx });
      if (r.cutCount === 1) add('ok', '칼선이 닫힌 외곽선 1개예요', d.cut.stick.on ? '막대와 몸체가 하나로 합쳐졌어요' : '막대 없음');
      else add('err', `칼선 외곽선이 ${r.cutCount}개예요(1개여야 해요)`, '이미지 크기나 칼선 여유를 늘려 주세요.');
      if (r.removed) add('warn', `칼선에서 떨어진 조각 ${r.removed}개를 뺐어요`, '칼선 이음 반경이나 여유를 늘려 보세요.', r.removedBoxes, 'final');
      if (r.cutOutPlate) add('err', '칼선이 판 밖으로 나갔어요', '이미지를 안쪽으로 옮기거나 크기·여유를 줄여 주세요.');
      else if (r.cutOutSafe) add('warn', `칼선이 안전 여백 ${P.plate.safeMargin}mm 밖이에요`, '잘릴 때 어긋날 수 있어요.');
      if (r.imagesOut.length) add('warn', `안전 여백 밖으로 나간 이미지: ${r.imagesOut.join(', ')}`, '이미지를 안쪽으로 옮기거나 크기를 줄여 주세요.');
      else if (!r.cutOutPlate && !r.cutOutSafe) add('ok', `판 크기 ${P.plate.w}×${P.plate.h} mm, 1:1 실제 크기`, `이미지와 칼선이 안전 여백 ${P.plate.safeMargin}mm 안쪽에 있어요`);
      if (!r.hasWhite) add('warn', '화이트가 없어요', d.white.mode === 'none' ? '화이트 방식이 "없음"이에요.' : '불투명한 부분이 없어요. 불투명 기준을 낮춰 보세요.');
      else {
        if (r.overlap) add('warn', `화이트가 반투명·투명 부분에 겹친 픽셀 ${r.overlap.toLocaleString()}개`, d.white.mode === 'full' ? '전체 채움이라 의도한 결과면 괜찮아요.' : '화이트 크기를 줄이거나 추가로 칠한 곳을 확인해 주세요.', r.overBoxes, 'check');
        else add('ok', '화이트가 반투명·투명 부분에 겹친 픽셀 0개');
        if (d.white.mode === 'auto') add(r.gap >= 0 ? 'ok' : 'warn', `불투명 경계에서 화이트까지 최소 간격 ${r.gap.toFixed(2)} mm`, r.gap < 0 ? '화이트가 불투명 경계를 넘었어요.' : null);
        if (r.thinCount) add('warn', `0.3mm 미만으로 가는 화이트 ${r.thinCount}곳`, '인쇄가 안 될 수 있어요. 해당 부분을 보호 영역으로 지정하거나 줄이기를 낮춰 보세요.', r.thinBoxes, 'white');
        else add('ok', '0.3mm 미만으로 가는 화이트가 없어요');
      }
      const low = d.images.filter((im) => dpi(im) * scale < 150);
      if (low.length) add('warn', `해상도 150dpi 미만: ${low.map((i) => `${i.name}(${Math.round(dpi(i) * scale)}dpi)`).join(', ')}`, '흐리게 인쇄될 수 있어요.');
    });
    const mb = fsize(len);
    if (len > 10 * 1048576) rows.push({ s: 'err', t: `파일 용량 ${mb} (한도 10 MB 초과)`, sub: '이미지 수나 해상도를 줄여 주세요.' });
    else if (scale < 1) rows.push({ s: 'warn', t: `파일 용량 ${mb} (한도 10 MB)`, sub: `용량을 맞추려고 이미지 해상도를 ${Math.round(scale * 100)}%로 낮췄어요.` });
    else rows.push({ s: 'ok', t: `파일 용량 ${mb} (한도 10 MB)`, sub: '이미지는 원본 해상도 그대로 들어가요' });
    return rows;
  }
  function showReport(rows) {
    const dlg = $('report'), nE = rows.filter((r) => r.s === 'err').length, nW = rows.filter((r) => r.s === 'warn').length;
    const L = P.layers, imgs = P.designs.flatMap((d) => d.images), ln = layerNames();
    const names = C.uniqueNames([{ name: L.white, fallback: '화이트' }, ...(L.imageMode === 'merged' ? [{ name: L.mergedName, fallback: '이미지' }] : imgs.map((im) => ({ name: ln.imageNames[im.id], fallback: '이미지' }))), { name: L.cut, fallback: '칼선' }]);
    const empty = P.designs.filter((d) => !d.images.length).length;
    const T = { ok: '통과', warn: '경고', err: '오류' };
    dlg.replaceChildren(h('h2', { id: 'repT' }, '내보내기 전 검증'),
      h('p', { class: 'help' }, `${P.plate.w}×${P.plate.h} mm · ${P.designs.length - empty}페이지 · 레이어 ${names.length}개(${names.join(' / ')})${empty ? ` · 빈 디자인 ${empty}개는 빠져요` : ''}`),
      h('div', { class: 'banner ' + (nE ? 'err' : nW ? 'warn' : 'ok') }, h('b', {}, nE ? `오류 ${nE}개` : nW ? `경고 ${nW}개` : '모두 통과'), nE ? '고쳐야 저장할 수 있어요.' : nW ? '저장은 할 수 있지만 확인을 권해요.' : '바로 저장해도 좋아요.'),
      h('ul', { class: 'rep' }, rows.map((r) => h('li', {}, h('span', { class: 'tag ' + r.s }, T[r.s]), h('div', {}, h('p', {}, r.t, r.sub ? h('small', {}, r.sub) : null),
        r.boxes && r.boxes.length ? h('button', { class: 'btn', onclick: () => locate(r) }, '문제 위치 보기') : null)))),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => dlg.close() }, '닫기'), h('button', { class: 'btn pri', disabled: nE > 0, onclick: () => { dlg.close(); savePdf(); } }, 'PDF 저장')));
    if (!dlg.open) dlg.showModal();
    say(nE ? `오류 ${nE}개` : nW ? `경고 ${nW}개` : '검증을 모두 통과했어요');
  }
  function locate(r) {
    $('report').close();
    if (ui.d !== r.idx) { ui.d = r.idx; ui.sel.clear(); refresh(); }
    ui.markers = r.boxes; setView(r.view);
    const b = r.boxes[0], z = clamp(Math.min(W, H) / 4 / Math.max(b.x1 - b.x0, b.y1 - b.y0, 2), fitZoom, 60);
    ui.zoom = z; ui.panX = W / 2 - (b.x0 + b.x1) / 2 * z; ui.panY = H / 2 - (b.y0 + b.y1) / 2 * z; ui.manual = true;
    cv.focus(); draw(); say(`문제 위치 ${r.boxes.length}곳을 표시했어요`);
  }

  // ---------- 연결 ----------
  $('fImg').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; addFiles(f); });
  $('fJson').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadJson(f); });
  $('emptyAdd').onclick = () => $('fImg').click();
  $('load').onclick = () => $('fJson').click();
  $('save').onclick = saveJson;
  $('check').onclick = () => run(true);
  $('export').onclick = () => run(false);
  $('warn').onclick = () => run(true);
  $('zin').onclick = () => zoomAt(1.25); $('zout').onclick = () => zoomAt(0.8);
  $('zfit').onclick = () => { ui.zoom = 0; ui.manual = false; draw(); };
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; $('stage').classList.add('drop'); } });
  addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; $('stage').classList.remove('drop'); } });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; $('stage').classList.remove('drop'); addFiles(e.dataTransfer.files); });
  addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

  startWorker();
  setView('final');
  refresh();
})();
