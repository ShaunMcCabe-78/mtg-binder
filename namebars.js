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

  /* grey: Uint8Array of w*h brightness values (photo scaled so its long side is ~1000 px).
     Returns boxes {x0,y0,x1,y1} in the same pixel units, top to bottom. */
  function findBars(grey, w, h) {
    // Stretch contrast using the 2nd and 98th percentile so lighting doesn't matter.
    const hist = new Uint32Array(256); for (let i = 0; i < grey.length; i++) hist[grey[i]]++;
    const pct = q => { let c = 0; const t = grey.length * q; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= t) return v; } return 255; };
    const lo = pct(0.02), hi = pct(0.98), span = Math.max(1, hi - lo);
    const g = new Uint8Array(grey.length); for (let i = 0; i < grey.length; i++) g[i] = Math.max(0, Math.min(255, ((grey[i] - lo) * 255 / span) | 0));
    const rClose = Math.max(1, Math.round(w / 120)), rOpenX = Math.max(1, Math.round(w / 80)), rOpenY = 2;
    const raw = [];
    // Name bars are brighter than their surroundings, but how bright varies: try several cut-offs.
    for (const thr of [110, 130, 150, 170, 190, 210]) {
      let m = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) m[i] = g[i] > thr ? 1 : 0;
      m = horiz(horiz(m, w, h, rClose, dilate1), w, h, rClose, erode1);                 // fill the gaps between letters
      m = vert(horiz(m, w, h, rOpenX, erode1), w, h, rOpenY, erode1);                   // remove thin bits…
      m = vert(horiz(m, w, h, rOpenX, dilate1), w, h, rOpenY, dilate1);                 // …and grow the rest back
      for (const c of components(m, w, h)) {
        const bw = c.x1 - c.x0, bh = c.y1 - c.y0;
        if (bw < w * 0.3 || bh < h * 0.012 || bh > h * 0.09 || bw / bh < 5 || c.a / (bw * bh) < 0.5) continue;
        raw.push(c);
      }
    }
    // The same bar is found at several cut-offs: merge boxes that overlap.
    raw.sort((a, b) => a.y0 - b.y0);
    const merged = [];
    for (const b of raw) {
      const m = merged.find(m => {
        const ov = Math.min(m.y1, b.y1) - Math.max(m.y0, b.y0), hov = Math.min(m.x1, b.x1) - Math.max(m.x0, b.x0);
        return ov > 0.4 * Math.min(m.y1 - m.y0, b.y1 - b.y0) && hov > 0.5 * Math.min(m.x1 - m.x0, b.x1 - b.x0);
      });
      if (m) { m.x0 = Math.min(m.x0, b.x0); m.y0 = Math.min(m.y0, b.y0); m.x1 = Math.max(m.x1, b.x1); m.y1 = Math.max(m.y1, b.y1); }
      else merged.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
    }
    // Bars of different cards never overlap, so any boxes that still touch are pieces of one bar.
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
    // A merged box taller than a name bar is two things glued together; drop it.
    return merged.filter(b => b.y1 - b.y0 <= h * 0.1).sort((a, b) => a.y0 - b.y0);
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
