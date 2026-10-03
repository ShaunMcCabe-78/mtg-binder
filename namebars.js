/* Name-bar detection: finds the light, wide strips at the top of Magic cards in an upright photo,
   so each card name can be cut out and read on its own, away from the artwork. Pure functions on grey pixels. */
(function (root) {
  "use strict";

  // Sliding-window helpers on a 0/1 row or column (r = half window).
  function dilate1(src, out, n, r, get, set) { let c = 0; for (let i = 0; i < Math.min(n, r); i++) c += get(src, i); for (let i = 0; i < n; i++) { if (i + r < n) c += get(src, i + r); if (i - r - 1 >= 0) c -= get(src, i - r - 1); set(out, i, c > 0 ? 1 : 0); } }
  function erode1(src, out, n, r, get, set) { let c = 0; for (let i = 0; i < Math.min(n, r); i++) c += get(src, i); for (let i = 0; i < n; i++) { if (i + r < n) c += get(src, i + r); if (i - r - 1 >= 0) c -= get(src, i - r - 1); const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r); set(out, i, c === hi - lo + 1 ? 1 : 0); } }
  function horiz(m, w, h, r, fn) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { const o = y * w; fn(m, out, w, r, (a, i) => a[o + i], (a, i, v) => { a[o + i] = v; }); }
    return out;
  }
  function vert(m, w, h, r, fn) {
    const out = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) fn(m, out, h, r, (a, i) => a[i * w + x], (a, i, v) => { a[i * w + x] = v; });
    return out;
  }

  // Average brightness over a (2rx+1) x (2ry+1) box around each pixel, using a summed-area table.
  function boxBlur(g, w, h, rx, ry) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) { const ya = Math.max(0, y - ry), yb = Math.min(h, y + ry + 1);
      for (let x = 0; x < w; x++) { const xa = Math.max(0, x - rx), xb = Math.min(w, x + rx + 1);
        out[y * w + x] = (I[yb * (w + 1) + xb] - I[ya * (w + 1) + xb] - I[yb * (w + 1) + xa] + I[ya * (w + 1) + xa]) / ((xb - xa) * (yb - ya)); } }
    return out;
  }

  // Connected areas of 1s: bounding box and pixel count of each.
  function components(m, w, h) {
    const seen = new Uint8Array(w * h), out = [], stack = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || seen[s]) continue;
      let sp = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, a = 0; stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0; a++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && m[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && m[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, a });
    }
    return out;
  }

  /* Light text on a dark bar (some special frames). The dark bar often runs into dark artwork below it, and in a
     grid into the neighbouring cards, so look inside each column of cards (known from the light bars found):
     a dark bar is a band of rows that are dark almost all the way across the column, with some light letters in it. */
  function darkBars(g, w, h, cols, barH) {
    const out = [];
    for (const [cx0, cx1] of cols) {
      const cw = cx1 - cx0; if (cw < 10) continue;
      const dark = new Uint8Array(h);
      for (let y = 0; y < h; y++) { let d = 0; for (let x = cx0; x < cx1; x++) if (g[y * w + x] < 90) d++; dark[y] = d >= cw * 0.8 ? 1 : 0; }
      for (let y = 0; y < h; y++) {
        if (!dark[y]) continue;
        let y1 = y + 1, gap = 0;
        while (y1 < h && (dark[y1] || (gap < 1 && y1 + 1 < h && dark[y1 + 1]))) { gap = dark[y1] ? 0 : gap + 1; y1++; }
        const end = y1;
        // The name sits at the top of a dark area that continues into artwork, so keep just the top strip.
        if (y1 - y > h * 0.09) y1 = y + Math.round(Math.min(barH, h * 0.09));
        const bh = y1 - y;
        if (bh >= h * 0.012 && bh <= h * 0.09 && cw / bh >= 5) {
          // The name is where the light letters are: fit the box to those rows (plus a margin, since the very
          // tops and bottoms of letters sit in rows that may not count as dark).
          // Look for letters in the left three-quarters only (the mana cost and frame ornaments sit at the ends),
          // and count a row as part of the name when it has a good share of the strongest row's light pixels.
          const ix0 = cx0 + Math.round(cw * 0.04), ix1 = cx0 + Math.round(cw * 0.75), iw = ix1 - ix0;
          const rowsLight = [];
          for (let yy = y; yy < y1; yy++) { let l = 0; for (let x = ix0; x < ix1; x++) if (g[yy * w + x] > 150) l++; rowsLight.push(l); }
          const peak = Math.max(...rowsLight), light = rowsLight.reduce((p, q) => p + q, 0);
          let first = -1, last = -1;
          rowsLight.forEach((l, i) => { if (l >= Math.max(iw * 0.03, peak * 0.3)) { if (first < 0) first = y + i; last = y + i; } });
          const f = light / (bh * iw);
          if (first >= 0 && f >= 0.02 && f <= 0.45) {
            const th = last - first + 1, pad = Math.round(Math.max(th * 0.35, 2));
            out.push({ x0: cx0, y0: Math.max(0, first - pad), x1: cx1, y1: Math.min(h, last + 1 + pad), a: th * cw, dark: true });
          }
        }
        y = end - 1;
      }
    }
    return out;
  }

  // Columns of cards: x-ranges shared by the light bars found (one column for a stack, three for a 3x3 grid).
  function columnsOf(bars) {
    const cols = [];
    for (const b of bars.slice().sort((p, q) => p.x0 - q.x0)) {
      const c = cols.find(c => Math.min(c.x1, b.x1) - Math.max(c.x0, b.x0) > 0.5 * Math.min(c.x1 - c.x0, b.x1 - b.x0));
      if (c) { c.xs0.push(b.x0); c.xs1.push(b.x1); c.x0 = Math.min(c.x0, b.x0); c.x1 = Math.max(c.x1, b.x1); }
      else cols.push({ x0: b.x0, x1: b.x1, xs0: [b.x0], xs1: [b.x1] });
    }
    const med = a => a.slice().sort((p, q) => p - q)[a.length >> 1];
    return cols.map(c => [med(c.xs0), med(c.xs1)]);
  }

  /* grey: Uint8Array of w*h brightness values (photo scaled so its long side is ~1000 px).
     Returns boxes {x0,y0,x1,y1} in the same pixel units, top to bottom. */
  function findBars(grey, w, h) {
    // Stretch contrast using the 2nd and 98th percentile so lighting doesn't matter.
    const hist = new Uint32Array(256); for (let i = 0; i < grey.length; i++) hist[grey[i]]++;
    const pct = q => { let c = 0; const t = grey.length * q; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= t) return v; } return 255; };
    const lo = pct(0.02), hi = pct(0.98), span = Math.max(1, hi - lo);
    const g = new Uint8Array(grey.length); for (let i = 0; i < grey.length; i++) g[i] = Math.max(0, Math.min(255, ((grey[i] - lo) * 255 / span) | 0));
    const rClose = Math.max(1, Math.round(w / 200)), rOpenX = Math.max(1, Math.round(w / 80)), rOpenY = 2;
    // Each card's local surroundings, for spotting strips that are lighter than what's around them
    // (gold bars inside a gold frame) rather than light overall.
    const local = boxBlur(g, w, h, Math.max(3, Math.round(w / 12)), Math.max(3, Math.round(h / 25)));
    const masks = [];
    for (const thr of [110, 130, 150, 170, 190, 210]) masks.push(["light", i => g[i] > thr]);   // dark text on a light bar
    masks.push(["local", i => g[i] > local[i] + 12]);
    const found = { light: [], dark: [], local: [] };
    for (const [kind, test] of masks) {
      let m = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) m[i] = test(i) ? 1 : 0;
      m = horiz(horiz(m, w, h, rClose, dilate1), w, h, rClose, erode1);                 // fill the gaps between letters
      m = vert(horiz(m, w, h, rOpenX, erode1), w, h, rOpenY, erode1);                   // remove thin bits…
      m = vert(horiz(m, w, h, rOpenX, dilate1), w, h, rOpenY, dilate1);                 // …and grow the rest back
      for (const c of components(m, w, h)) {
        const bw = c.x1 - c.x0, bh = c.y1 - c.y0;
        if (bw < w * 0.2 || bh < h * 0.012 || bh > h * 0.09 || bw / bh < 5 || c.a / (bw * bh) < 0.5) continue;
        found[kind].push(c);
      }
    }
    // The same bar is found at several cut-offs: merge boxes of the same kind that overlap or touch.
    const mergeAll = raw => {
      const merged = raw.slice().sort((a, b) => a.y0 - b.y0).map(b => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, dark: !!b.dark }));
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < merged.length && !changed; i++) for (let j = i + 1; j < merged.length && !changed; j++) {
          const m = merged[i], b = merged[j];
          const ov = Math.min(m.y1, b.y1) - Math.max(m.y0, b.y0), hov = Math.min(m.x1, b.x1) - Math.max(m.x0, b.x0);
          if (ov >= 0 && hov > 0.5 * Math.min(m.x1 - m.x0, b.x1 - b.x0)) {
            m.x0 = Math.min(m.x0, b.x0); m.y0 = Math.min(m.y0, b.y0); m.x1 = Math.max(m.x1, b.x1); m.y1 = Math.max(m.y1, b.y1);
            merged.splice(j, 1); changed = true;
          }
        }
      }
      return merged.filter(b => b.y1 - b.y0 <= h * 0.1);
    };
    // Light bars first; a dark or local box is only added where no bar was found yet.
    const merged = mergeAll(found.light);
    const overlaps = (a, b) => { const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0), hov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0); return ov > 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && hov > 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0); };
    // Judge dark bars against the width of the light bars found (cards can be small in the photo).
    const widths = merged.map(b => b.x1 - b.x0).sort((a, b) => a - b);
    const typical = widths.length ? widths[widths.length >> 1] : w * 0.5;
    const heights = merged.map(b => b.y1 - b.y0).sort((a, b) => a - b);
    const typicalH = heights.length ? heights[heights.length >> 1] * 1.3 : h * 0.03;
    const usable = merged.filter(b => (b.x1 - b.x0) >= typical * 0.6 && (b.x1 - b.x0) <= typical * 1.5);
    found.dark = darkBars(g, w, h, columnsOf(usable), typicalH);
    for (const kind of ["local", "dark"]) for (const b of mergeAll(found[kind])) if (!merged.some(m => overlaps(m, b))) merged.push(b);
    // Drop strips that can't be a name bar: touching the edge of the photo (table, background), or far wider or
    // narrower than the typical bar in this photo.
    const ws = merged.map(b => b.x1 - b.x0).sort((a, b) => a - b), med = ws.length ? ws[ws.length >> 1] : 0;
    const ex = w * 0.01, ey = h * 0.01;
    return merged.filter(b => b.x0 > ex && b.x1 < w - ex && b.y0 > ey && b.y1 < h - ey && (b.x1 - b.x0) >= med * 0.6 && (b.x1 - b.x0) <= med * 1.5)
      .sort((a, b) => a.y0 - b.y0);
  }

  // Black-and-white versions of one cut-out bar (grey pixels, w*h): Otsu (one cut-off for the strip)
  // and a local mean cut-off (each pixel against its neighbourhood), which copes with glare.
  function otsu(g) {
    const hist = new Uint32Array(256); for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = g.length - wB; if (!wF) break; sB += i * hist[i];
      const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; t = i; } }
    const out = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) out[i] = g[i] > t ? 255 : 0; return out;
  }
  function localMean(g, w, h, win, C) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
    const r = win >> 1, out = new Uint8Array(g.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1), ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
      const s = I[yb * (w + 1) + xb] - I[ya * (w + 1) + xb] - I[yb * (w + 1) + xa] + I[ya * (w + 1) + xa];
      out[y * w + x] = g[y * w + x] > s / ((xb - xa) * (yb - ya)) - C ? 255 : 0;
    }
    return out;
  }
  function stretch(g) { let lo = 255, hi = 0; for (const v of g) { if (v < lo) lo = v; if (v > hi) hi = v; } const s = Math.max(1, hi - lo), o = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) o[i] = ((g[i] - lo) * 255 / s) | 0; return o; }

  const api = { findBars, otsu, localMean, stretch };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.NameBars = api;
})(typeof self !== "undefined" ? self : this);
