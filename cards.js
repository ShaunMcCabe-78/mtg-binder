/* Card finder: the outline of each card in a photo of cards laid out side by side.
   Magic cards are 63 x 88 mm with a dark border, so on a lighter table each card is a dark, card-shaped patch.
   1. Work on a small grey copy (~1000 px). Mark dark pixels, close small gaps (glare on the border), fill each patch's holes.
   2. Each patch: its direction (tilt) from its shape, its length and width along that direction.
   3. Keep patches with a card's proportions that fill their rectangle; split patches that are several touching cards.
   Returns cards in photo pixels: { cx, cy, w, h, angle } (angle: the card's tilt in radians, 0 = upright),
   ordered by rows, top to bottom, left to right, each with row and col. */
(function (root) {
  "use strict";
  const RATIO = 63 / 88;   // width / height

  function greyOf(src, long) {
    const [W, H] = root.ScanCore.dimsOf(src), sc = Math.min(1, long / Math.max(W, H));
    const w = Math.round(W * sc), h = Math.round(H * sc);
    const { x } = root.ScanCore.shrink(src, w, h);
    const d = x.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0;
    return { g, w, h, sc };
  }

  // Square dilation / erosion of a 0/1 mask (separable, radius r).
  function morph(m, w, h, r, grow) {
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        for (let k = -r; k <= r; k++) { const xx = x + k; const p = xx < 0 || xx >= w ? (grow ? 0 : 1) : m[y * w + xx]; if (grow ? p : !p) { v = grow ? 1 : 0; break; } }
        t[y * w + x] = v; run;
      }
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) { const yy = y + k; const p = yy < 0 || yy >= h ? (grow ? 0 : 1) : t[yy * w + x]; if (grow ? p : !p) { v = grow ? 1 : 0; break; } }
      o[y * w + x] = v;
    }
    return o;
  }

  // hintW: expected card width in photo pixels (from the name bars), so a block of touching cards isn't taken for one card.
  function find(src, hintW) {
    const { g, w, h, sc } = greyOf(src, 1000);
    // Dark threshold: Otsu split, capped so wood grain and shadows mostly stay "light".
    const otsuT = (() => { const hist = new Float64Array(256); for (const v of g) hist[v]++; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sB = 0, wB = 0, best = 0, t = 100; for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = g.length - wB; if (!wF) break; sB += i * hist[i];
        const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; t = i; } } return t; })();
    const T = Math.min(otsuT, 95);
    let m = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) m[i] = g[i] < T ? 1 : 0;
    m = morph(morph(m, w, h, 2, true), w, h, 2, false);   // close small gaps in the border
    // Fill holes: whatever the outside can't reach belongs to a patch.
    const out = new Uint8Array(w * h), st = [];
    for (let x = 0; x < w; x++) st.push(x, (h - 1) * w + x); for (let y = 0; y < h; y++) st.push(y * w, y * w + w - 1);
    while (st.length) { const i = st.pop(); if (out[i] || m[i]) continue; out[i] = 1; const x = i % w, y = (i / w) | 0;
      if (x > 0) st.push(i - 1); if (x < w - 1) st.push(i + 1); if (y > 0) st.push(i - w); if (y < h - 1) st.push(i + w); }
    const filled = new Uint8Array(w * h); for (let i = 0; i < filled.length; i++) filled[i] = out[i] ? 0 : 1;
    const minArea = w * h * 0.004;
    const lab = new Int32Array(w * h).fill(-1), patches = [];
    for (let s = 0; s < filled.length; s++) {
      if (!filled[s] || lab[s] >= 0) continue;
      const q = [s], px = []; lab[s] = patches.length;
      while (q.length) { const i = q.pop(); px.push(i); const x = i % w, y = (i / w) | 0;
        for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (n >= 0 && filled[n] && lab[n] < 0) { lab[n] = patches.length; q.push(n); } }
      patches.push(px);
    }
    const shapes = [];
    for (const px of patches) {
      if (px.length < minArea) continue;
      // Direction from the shape's spread (second moments).
      let mx = 0, my = 0; for (const i of px) { mx += i % w; my += (i / w) | 0; } mx /= px.length; my /= px.length;
      let sxx = 0, syy = 0, sxy = 0; for (const i of px) { const dx = i % w - mx, dy = ((i / w) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      let a = 0.5 * Math.atan2(2 * sxy, sxx - syy);           // angle of the long axis from the x axis
      // Express as the tilt of the card's vertical axis (cards lie roughly upright after the photo is turned upright).
      let tilt = a - Math.PI / 2; while (tilt > Math.PI / 4) tilt -= Math.PI / 2; while (tilt < -Math.PI / 4) tilt += Math.PI / 2;
      const c = Math.cos(tilt), s = Math.sin(tilt);
      const us = [], vs = [];   // u: across (card width), v: along (card height)
      for (const i of px) { const dx = i % w - mx, dy = ((i / w) | 0) - my; us.push(dx * c + dy * s); vs.push(-dx * s + dy * c); }
      us.sort((p, q) => p - q); vs.sort((p, q) => p - q);
      const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
      const u0 = pct(us, 0.004), u1 = pct(us, 0.996), v0 = pct(vs, 0.004), v1 = pct(vs, 0.996);
      const W = u1 - u0, Hh = v1 - v0;
      const ccx = mx + c * (u0 + u1) / 2 - s * (v0 + v1) / 2, ccy = my + s * (u0 + u1) / 2 + c * (v0 + v1) / 2;
      shapes.push({ cx: ccx, cy: ccy, w: W, h: Hh, angle: tilt, fill: px.length / (W * Hh) });
    }
    // Card size: from the name bars if known, else from the patches with a single card's proportions.
    const med = a => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
    let cw, ch;
    if (hintW) { cw = hintW * sc; ch = cw / RATIO; }
    else {
      const single = shapes.filter(p => Math.abs(p.w / p.h - RATIO) < RATIO * 0.12 && p.fill > 0.85);
      if (!single.length) return [];
      cw = med(single.map(p => p.w)); ch = med(single.map(p => p.h));
    }
    const cards = [];
    for (const p of shapes) {
      if (p.fill < 0.8) continue;
      const nx = Math.round(p.w / cw), ny = Math.round(p.h / ch);
      if (nx < 1 || ny < 1 || nx * ny > 12) continue;
      if (Math.abs(p.w / nx - cw) > cw * 0.15 || Math.abs(p.h / ny - ch) > ch * 0.15) continue;   // not whole cards
      // Several touching cards: split the patch into equal card-sized parts.
      const c = Math.cos(p.angle), s = Math.sin(p.angle), pw = p.w / nx, ph = p.h / ny;
      for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
        const du = (ix + 0.5) * pw - p.w / 2, dv = (iy + 0.5) * ph - p.h / 2;
        cards.push({ cx: (p.cx + c * du - s * dv) / sc, cy: (p.cy + s * du + c * dv) / sc, w: pw / sc, h: ph / sc, angle: p.angle });
      }
    }
    // Refine every card on a sharper copy: its own four edges and its own tilt (touching cards were only split evenly).
    const fine = greyOf(src, 1600);
    // All cards are the same size: refining moves and turns a card but keeps that size.
    const size = { w: med(cards.map(c => c.w)) };
    size.h = size.w / RATIO;
    for (let i = 0; i < cards.length; i++) cards[i] = refine(refine(cards[i], fine, T, size), fine, T, size);   // twice: the second pass finishes the turn
    // Rows: cards whose centres are within half a card height of each other; left to right inside a row.
    cards.sort((p, q) => p.cy - q.cy);
    const rows = [];
    for (const c of cards) { const r = rows.find(r => Math.abs(r.y - c.cy) < (ch / sc) * 0.5); if (r) { r.cards.push(c); r.y = (r.y * (r.cards.length - 1) + c.cy) / r.cards.length; } else rows.push({ y: c.cy, cards: [c] }); }
    rows.sort((p, q) => p.y - q.y);
    const ordered = [];
    rows.forEach((r, ri) => r.cards.sort((p, q) => p.cx - q.cx).forEach((c, ci) => ordered.push({ ...c, row: ri, col: ci })));
    return ordered;
  }

  /* Refine one card (photo pixels) on grey image G {g, w, h, sc}: for each side, at several places along it, find where the
     dark border meets the lighter table or gap (the strongest dark-to-light step going outwards, within 12% of the card size),
     fit a line through those points, and rebuild the card from the four lines. Sides without a clear edge keep their place. */
  function refine(card, G, T, size) {
    const { g, w, h, sc } = G;
    const at = (x, y) => { if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return -1; const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
      return g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + w] * (1 - fx) * fy + g[i + w + 1] * fx * fy; };
    const cx = card.cx * sc, cy = card.cy * sc, W = card.w * sc, H = card.h * sc, c = Math.cos(card.angle), s = Math.sin(card.angle);
    const P = (u, v) => [cx + c * u - s * v, cy + s * u + c * v];   // card coordinates (u across, v down) to image
    // side: [normal axis ("u" or "v"), sign (outwards)], half-size along normal, half-size along side
    const sides = [["u", -1, W / 2, H / 2], ["u", 1, W / 2, H / 2], ["v", -1, H / 2, W / 2], ["v", 1, H / 2, W / 2]];
    const fits = sides.map(([ax, sg, hn, hs]) => {
      const pts = [], range = 0.12 * (ax === "u" ? W : H), step = 1;
      for (let k = -4; k <= 4; k++) {
        const t = k / 4 * hs * 0.6;   // along the side, away from the corners
        // The outer edge: dark border just inside (two depths), clearly lighter just outside. Of those, the one nearest
        // the first estimate (lines inside the card, like the art frame, don't have dark border on their inside).
        let bestD = null, bestScore = -Infinity;
        const dark = T + 15;
        for (let d = -range; d <= range; d += step) {
          const n = sg * (hn + d);
          const Q = k => ax === "u" ? P(n + sg * k, t) : P(t, n + sg * k);
          const [i1, i2, o1] = [Q(-2), Q(-5), Q(2)];
          const a = at(i1[0], i1[1]), a2 = at(i2[0], i2[1]), b = at(o1[0], o1[1]); if (a < 0 || a2 < 0 || b < 0) continue;
          if (a > dark || a2 > dark || b - a < 35) continue;
          const score = -Math.abs(d) + (b - a) * 0.05;
          if (score > bestScore) { bestScore = score; bestD = d; }
        }
        if (bestD != null) pts.push([t, bestD]);
      }
      if (pts.length < 6) return null;   // an edge must show along most of the side
      // Line d = a + b * t (least squares), dropping the worst point once.
      const fit = ps => { const n = ps.length, mt = ps.reduce((q, p) => q + p[0], 0) / n, md = ps.reduce((q, p) => q + p[1], 0) / n;
        let sxy = 0, sxx = 0; for (const [t, d] of ps) { sxy += (t - mt) * (d - md); sxx += (t - mt) ** 2; } const b = sxx ? sxy / sxx : 0; return { a: md - b * mt, b }; };
      let L = fit(pts);
      const res = pts.map(([t, d]) => Math.abs(d - (L.a + L.b * t))); const worst = res.indexOf(Math.max(...res));
      if (res[worst] > 3) L = fit(pts.filter((_, i) => i !== worst));
      return L;
    });
    // Slopes give the tilt: a card turned clockwise (in screen terms) has its left and bottom edges moving out as t grows,
    // its right and top edges moving in.
    const slopes = [];
    if (fits[0]) slopes.push(fits[0].b); if (fits[1]) slopes.push(-fits[1].b); if (fits[2]) slopes.push(-fits[2].b); if (fits[3]) slopes.push(fits[3].b);
    slopes.sort((p, q) => p - q);
    const mid = slopes.length ? slopes[slopes.length >> 1] : 0;
    // Only turn when at least two edges agree on it.
    const turn = slopes.filter(b => Math.abs(b - mid) < 0.015).length >= 2 ? Math.atan(mid) : 0;
    if (Math.abs(turn) > 0.1) return card;
    // Centre from the edges found, with the card's known size: both edges → their middle (if they're a card apart),
    // else the more trustworthy one (nearer the first estimate) plus half a card.
    const W0 = size.w * sc, H0 = size.h * sc;
    const centre = (fa, fb, half, full) => {
      const lo = fa ? -(half + fa.a) : null, hi = fb ? half + fb.a : null;
      if (lo != null && hi != null && Math.abs((hi - lo) - full) < full * 0.05) return (lo + hi) / 2;
      const useLo = lo != null && (hi == null || Math.abs(fa.a) <= Math.abs(fb.a));
      if (useLo) return lo + full / 2;
      if (hi != null) return hi - full / 2;
      return 0;
    };
    const du = centre(fits[0], fits[1], W / 2, W0), dv = centre(fits[2], fits[3], H / 2, H0);
    if (Math.abs(du) > W0 * 0.08 || Math.abs(dv) > H0 * 0.08) return card;
    const [ncx, ncy] = P(du, dv);
    return { ...card, cx: ncx / sc, cy: ncy / sc, w: size.w, h: size.h, angle: card.angle + turn };
  }

  // An upright, straightened image of one card at about pxPerMm (at most the photo's own detail), with marginMm around it
  // (so a card found slightly off can still be read). Card point (x, y) in mm is at ((x + margin) * pxPerMm, (y + margin) * pxPerMm).
  function straighten(src, card, maxPxPerMm, marginMm) {
    const native = card.w / 63, s = Math.min(native, maxPxPerMm || 14), M = marginMm || 0;
    const cw = Math.round((63 + 2 * M) * s), ch = Math.round((88 + 2 * M) * s);
    const c = document.createElement("canvas"); c.width = cw; c.height = ch;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#000"; x.fillRect(0, 0, cw, ch); x.imageSmoothingQuality = "high";
    x.translate(cw / 2, ch / 2); x.rotate(-card.angle); x.scale(s / native, s / native); x.translate(-card.cx, -card.cy);
    x.drawImage(src, 0, 0);
    return { canvas: c, pxPerMm: s };
  }

  // Is a photo point inside a found card (with some margin)?
  function covers(card, px, py, margin) {
    const c = Math.cos(card.angle), s = Math.sin(card.angle), dx = px - card.cx, dy = py - card.cy;
    const u = dx * c + dy * s, v = -dx * s + dy * c, m = 1 + (margin || 0);
    return Math.abs(u) <= card.w / 2 * m && Math.abs(v) <= card.h / 2 * m;
  }

  root.CardFinder = { find, straighten, covers };
})(typeof self !== "undefined" ? self : this);
