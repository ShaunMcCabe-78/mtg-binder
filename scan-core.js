/* Scanner core: shared by both scan layouts (Stacked and Grid).
   Image helpers, finding which way the text runs, finding name bars, and reading a single name bar. */
(function (root) {
  "use strict";

  const dimsOf = src => [src.naturalWidth || src.width, src.naturalHeight || src.height];

  function loadImg(file) {
    return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = () => { URL.revokeObjectURL(url); rej({ code: "badimg" }); }; img.src = url; });
  }

  // Scale + clean a whole photo for reading: contrast-stretched grey, or black-and-white (Otsu).
  function prepCanvas(src, long, binar) {
    const [W, H] = dimsOf(src); const sc = Math.min(3, long / Math.max(W, H));
    const w = Math.round(W * sc), h = Math.round(H * sc);
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h), a = d.data, n = w * h, g = new Uint8Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = (a[i] * .299 + a[i + 1] * .587 + a[i + 2] * .114) | 0;
    const st = NameBars.stretch(g), bw = binar ? NameBars.otsu(st) : st;
    for (let i = 0, j = 0; j < n; i += 4, j++) a[i] = a[i + 1] = a[i + 2] = bw[j];
    x.putImageData(d, 0, 0);
    return c;
  }

  function rotated(src, deg) {
    const [W, H] = dimsOf(src); const c = document.createElement("canvas"); const side = deg % 180 !== 0;
    c.width = side ? H : W; c.height = side ? W : H; const x = c.getContext("2d");
    x.translate(c.width / 2, c.height / 2); x.rotate(deg * Math.PI / 180); x.drawImage(src, -W / 2, -H / 2); return c;
  }

  // How much real text a reading found: letters in confident, word-like words.
  function textScore(data) {
    let s = 0; for (const w of (data && data.words) || []) { const t = (w.text || "").trim();
      if (w.confidence >= 60 && /^[A-Za-z][A-Za-z'.,\-]{2,}$/.test(t)) s += t.length; } return s;
  }

  // Which way does the text run? Quick small readings at each quarter turn; keep the clearest.
  async function findTextDirection(ctx, img) {
    const small = prepCanvas(img, 1400, false); const scores = {};
    for (const deg of [0, 90, 270, 180]) {
      ctx.check();
      const { data } = await ctx.worker.recognize(deg ? rotated(small, deg) : small, {}, { text: true, blocks: true });
      scores[deg] = textScore(data);
      if (deg === 0 && scores[0] >= 40) return 0;
    }
    let best = 0; for (const d in scores) if (scores[d] > scores[best]) best = +d;
    return scores[best] >= 8 ? best : 0;
  }

  // Keep lines that are mostly letters.
  function cleanOcr(text) {
    return (text || "").split(/\r?\n/).map(l => l.replace(/[ \t]+/g, " ").trim()).filter(l => {
      const letters = (l.match(/[A-Za-z]/g) || []).length; return letters >= 4 && letters / l.replace(/\s/g, "").length >= 0.6;
    }).join("\n");
  }

  // Rebuild lines from word positions so names split into pieces are joined back up.
  // regroupLines gives each line with its vertical position (yc, in the read image's pixels).
  function regroupLines(data) {
    const ws = ((data && data.words) || []).filter(w => w && w.text && w.text.trim() && w.bbox).map(w => ({ t: w.text.trim(), x0: w.bbox.x0, x1: w.bbox.x1, yc: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 }));
    if (!ws.length) return [];
    const hs = ws.map(w => w.h).sort((a, b) => a - b), mh = hs[hs.length >> 1] || 10;
    ws.sort((a, b) => a.yc - b.yc); const lines = [];
    for (const w of ws) { const L = lines.find(L => Math.abs(L.yc - w.yc) < mh * 0.6);
      if (L) { L.w.push(w); L.yc = L.w.reduce((a, v) => a + v.yc, 0) / L.w.length; } else lines.push({ yc: w.yc, w: [w] }); }
    return lines.sort((a, b) => a.yc - b.yc).map(L => { const ww = L.w.sort((a, b) => a.x0 - b.x0); let s = ww[0].t;
      for (let i = 1; i < ww.length; i++) s += (ww[i].x0 - ww[i - 1].x1 < mh * 0.25 ? "" : " ") + ww[i].t; return { text: s, yc: L.yc }; });
  }
  function regroupWords(data) {
    const ws = ((data && data.words) || []).filter(w => w && w.text && w.text.trim() && w.bbox).map(w => ({ t: w.text.trim(), x0: w.bbox.x0, x1: w.bbox.x1, yc: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 }));
    if (!ws.length) return "";
    const hs = ws.map(w => w.h).sort((a, b) => a - b), mh = hs[hs.length >> 1] || 10;
    ws.sort((a, b) => a.yc - b.yc); const lines = [];
    for (const w of ws) { const L = lines.find(L => Math.abs(L.yc - w.yc) < mh * 0.6);
      if (L) { L.w.push(w); L.yc = L.w.reduce((a, v) => a + v.yc, 0) / L.w.length; } else lines.push({ yc: w.yc, w: [w] }); }
    return cleanOcr(lines.sort((a, b) => a.yc - b.yc).map(L => { const ww = L.w.sort((a, b) => a.x0 - b.x0); let s = ww[0].t;
      for (let i = 1; i < ww.length; i++) s += (ww[i].x0 - ww[i - 1].x1 < mh * 0.25 ? "" : " ") + ww[i].t; return s; }).join("\n"));
  }

  // Grey pixels of the photo at ~1000 px on the long side, for layout analysis.
  function smallGrey(src) {
    const [W, H] = dimsOf(src); const sc = Math.min(1, 1000 / Math.max(W, H));
    const w = Math.round(W * sc), h = Math.round(H * sc);
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0;
    return { g, w, h, sc };
  }
  // All name-bar candidates, in full-photo pixels.
  function detectBars(src) {
    const { g, w, h, sc } = smallGrey(src);
    return NameBars.findBars(g, w, h).map(b => ({ x0: b.x0 / sc, y0: b.y0 / sc, x1: b.x1 / sc, y1: b.y1 / sc, dark: !!b.dark }));
  }

  // Cut one bar out of the full-size photo (default ~60 px tall), clean it up, add a white margin.
  function cropBar(src, b, trimRight, mode, height) {
    const bh = b.y1 - b.y0, pad = bh * 0.1, sw = (b.x1 - b.x0) * (1 - trimRight), sh = bh + 2 * pad;
    const [W, H] = dimsOf(src); const sy = Math.max(0, b.y0 - pad), sx = Math.max(0, b.x0);
    const sc = (height || 60) / bh, dw = Math.max(1, Math.round(sw * sc)), dh = Math.max(1, Math.round(Math.min(sh, H - sy) * sc)), M = 20;
    const c = document.createElement("canvas"); c.width = dw + 2 * M; c.height = dh + 2 * M;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = "high";
    x.drawImage(src, sx, sy, Math.min(sw, W - sx), Math.min(sh, H - sy), M, M, dw, dh);
    const img = x.getImageData(M, M, dw, dh), d = img.data, g = new Uint8Array(dw * dh);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0;
    let st = NameBars.stretch(g);
    // Most bars are dark text on a light strip; a few frames use light text on a dark strip. Flip those.
    const sorted = Array.from(st).sort((p, q) => p - q); if (sorted[sorted.length >> 1] < 110) st = st.map(v => 255 - v);
    const bw = mode === "local" ? NameBars.localMean(st, dw, dh, 49, 10) : NameBars.otsu(st);
    for (let i = 0, j = 0; j < bw.length; i += 4, j++) { d[i] = d[i + 1] = d[i + 2] = bw[j]; d[i + 3] = 255; }
    x.putImageData(img, M, M);
    return c;
  }

  // Does this line read as a card name? (a full name, or a clear start of one)
  function barMatch(matcher, line) {
    if (!line || !matcher) return null;
    const l = line.split("\n")[0];
    if (!CardMatcher.usableBarLine(l)) return null;
    return matcher.matchLine(l) || matcher.matchPrefix(l);
  }

  async function recognize(ctx, canvas, psm) {
    if (ctx.psm !== psm) { await ctx.worker.setParameters({ tessedit_pageseg_mode: String(psm) }); ctx.psm = psm; }
    return cleanOcr((await ctx.worker.recognize(canvas, {}, { text: true })).data.text);
  }

  /* Read one name bar: as a single line, cleaned two ways (the second only if the first isn't confident).
     Returns { a, b, match } where match is the best card-name match or null. */
  async function readBar(ctx, src, bar) {
    const a = await recognize(ctx, cropBar(src, bar, 0, "otsu"), 7);
    const ma = barMatch(ctx.matcher, a);
    if (ma && ma.score >= 0.95) return { a, b: a, match: ma };
    const b = await recognize(ctx, cropBar(src, bar, 0.15, "local"), 7);
    const mb = barMatch(ctx.matcher, b);
    const match = ma && (!mb || ma.score >= mb.score) ? ma : mb;
    return { a, b, match };
  }

  /* A closer look at a bar that didn't read as a name (decorated or dark frames): read it bigger in
     scattered-text mode and keep only the line that best matches a real card. Returns that line or null. */
  async function closerLook(ctx, src, bar) {
    const text = await recognize(ctx, cropBar(src, bar, 0, "otsu", 120), 11);
    let best = null;
    for (const line of text.split("\n")) {
      const m = barMatch(ctx.matcher, line);
      if (m && m.score >= 0.85 && CardMatcher.key(m.name).length >= 6 && (!best || m.score > best.m.score)) best = { line, m };
    }
    return best ? best.line : null;
  }

  // Read the whole photo (backup for cards whose bar wasn't found). Returns text readings.
  async function readWholePhoto(ctx, src, variants) {
    const readings = []; let lines = [];
    const vars = variants === 2 ? [prepCanvas(src, 3000, true), prepCanvas(src, 2200, false)] : [prepCanvas(src, 3000, true)];
    if (ctx.psm !== 11) { await ctx.worker.setParameters({ tessedit_pageseg_mode: "11" }); ctx.psm = 11; }
    for (let v = 0; v < vars.length; v++) {
      ctx.check();
      ctx.progress((v) / vars.length);
      const { data } = await ctx.worker.recognize(vars[v], { rotateAuto: true }, { text: true, blocks: true });
      readings.push(cleanOcr(data && data.text));
      if (v === 0) {
        readings.push(regroupWords(data));
        // Where each line sits in the photo (for putting cards in order).
        const [W, H] = dimsOf(src), sc = vars[0].height / H;
        lines = regroupLines(data).map(l => ({ text: l.text, y: l.yc / sc }));
      }
    }
    readings.lines = lines;
    return readings;
  }

  // Columns of cards: x-ranges shared by bars (one column for a stack, three for a 3x3 grid).
  function columnsOf(bars) {
    const cols = [];
    for (const b of bars.slice().sort((p, q) => p.x0 - q.x0)) {
      const c = cols.find(c => Math.min(c.x1, b.x1) - Math.max(c.x0, b.x0) > 0.5 * Math.min(c.x1 - c.x0, b.x1 - b.x0));
      if (c) { c.bars.push(b); c.x0 = Math.min(c.x0, b.x0); c.x1 = Math.max(c.x1, b.x1); }
      else cols.push({ x0: b.x0, x1: b.x1, bars: [b] });
    }
    const med = a => a.slice().sort((p, q) => p - q)[a.length >> 1];
    return cols.map(c => ({ x0: med(c.bars.map(b => b.x0)), x1: med(c.bars.map(b => b.x1)), bars: c.bars.sort((p, q) => p.y0 - q.y0) }));
  }
  const median = a => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };

  root.ScanCore = { dimsOf, loadImg, prepCanvas, rotated, findTextDirection, cleanOcr, regroupWords, detectBars, cropBar, barMatch, readBar, closerLook, readWholePhoto, columnsOf, median, recognize };
})(typeof self !== "undefined" ? self : this);
