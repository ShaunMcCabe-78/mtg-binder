/* Which printing (set) a card is, read from a Grid photo where the whole card shows.
   The small print at the bottom left gives rarity, collector number and set code ("U 0178 / SOS • EN"); cards since about 2014 have it.
   Only printings of the already-known card name are considered, and nothing is guessed: unsure means no set.
   (Comparing the set symbol was tried: at photo size the outlines are too alike to tell sets apart reliably.) */
(function (root) {
  "use strict";
  // Positions on a 63 x 88 mm card, in mm from its top-left corner.
  const BAR_CY = 6.2;                    // middle of the name bar
  const INFO = [-1, 76.5, 31, 90];       // bottom-left small print (roomy: the card size is an estimate)

  // Card position from its name bar: the bar spans 0.89 of the card's width.
  // u (photo pixels per mm) can be given: the median over the whole grid is steadier than one bar's width.
  function geom(box, u0) {
    const u = u0 || (box.x1 - box.x0) / 0.89 / 63, cw = u * 63;
    return { u, left: (box.x0 + box.x1) / 2 - cw / 2, top: (box.y0 + box.y1) / 2 - BAR_CY * u };
  }

  // Cut a region (mm) out of the photo at pxPerMm. Returns its grey pixels.
  function grab(src, g, r, pxPerMm) {
    const [W, H] = ScanCore.dimsOf(src);
    const sx = Math.max(0, g.left + r[0] * g.u), sy = Math.max(0, g.top + r[1] * g.u);
    const ex = Math.min(W, g.left + r[2] * g.u), ey = Math.min(H, g.top + r[3] * g.u);
    if (ex - sx < 4 || ey - sy < 4) return null;
    const sc = pxPerMm / g.u, w = Math.max(1, Math.round((ex - sx) * sc)), h = Math.max(1, Math.round((ey - sy) * sc));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high";
    x.drawImage(src, sx, sy, ex - sx, ey - sy, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, grey = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < grey.length; i += 4, j++) grey[j] = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0;
    return { grey, w, h };
  }

  // Black text on white, with a margin, for the reader.
  function toCanvas(px, w, h) {
    const M = 16, c = document.createElement("canvas"); c.width = w + 2 * M; c.height = h + 2 * M;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    const img = x.createImageData(w, h);
    for (let j = 0, i = 0; j < px.length; j++, i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = px[j]; img.data[i + 3] = 255; }
    x.putImageData(img, M, M); return c;
  }

  function infoCanvas(src, box, mode, u) {
    const g = geom(box, u), r = grab(src, g, INFO, 26); if (!r) return null;
    let st = NameBars.stretch(r.grey);
    // The small print is usually white on the black border: flip it to black on white.
    const s = Array.from(st).sort((p, q) => p - q); if (s[s.length >> 1] < 128) st = st.map(v => 255 - v);
    const bw = mode === "local" ? NameBars.localMean(st, r.w, r.h, 41, 12) : NameBars.otsu(st);
    return toCanvas(bw, r.w, r.h);
  }

  async function recognizeRaw(ctx, canvas, psm) {
    if (ctx.psm !== psm) { await ctx.worker.setParameters({ tessedit_pageseg_mode: String(psm) }); ctx.psm = psm; }
    return (await ctx.worker.recognize(canvas, {}, { text: true })).data.text || "";
  }

  /* ---------- reading the small print ---------- */
  const DIGIT = { O: "0", Q: "0", D: "0", I: "1", L: "1", "|": "1", S: "5", B: "8", Z: "2" };
  const LETTER = { 0: "O", 1: "I", 5: "S", 8: "B", 2: "Z" };
  const LANG = /^(EN|DE|FR|IT|ES|SP|PT|JA|JP|KO|RU|ZHS|ZHT|CS|CT|PH)$/;
  // nums: number-like tokens; codes: every possible set code; strong: codes next to a language marker ("SOS • EN").
  function parseInfo(text) {
    const nums = [], codes = [], strong = [];
    for (const line of text.toUpperCase().split(/\n/)) {
      const toks = line.replace(/[^A-Z0-9|\/]+/g, " ").split(/[\s\/]+/).filter(Boolean);
      toks.forEach((t, i) => {
        const digits = (t.match(/\d/g) || []).length;
        if (t.length <= 4 && digits >= 2 && digits / t.length >= 0.5) {
          const s = t.replace(/[A-Z|]/g, ch => DIGIT[ch] || ""); if (/^\d+$/.test(s)) nums.push(s);
        }
        if (t.length >= 3 && t.length <= 5 && /[A-Z]/.test(t)) {
          codes.push(t);
          if (toks.slice(i + 1, i + 3).some(x => LANG.test(x))) strong.push(t);
        }
      });
    }
    return { nums, codes, strong };
  }
  const asLetters = s => s.replace(/[0-9]/g, d => LETTER[d] || d);
  function codeHit(codes, code) {
    const k = asLetters(code);
    return codes.some(t => {
      if (t === code || asLetters(t) === k) return true;
      // Longer codes may have one misread letter.
      return code.length >= 4 && t.length === code.length && [...asLetters(t)].filter((ch, i) => ch !== k[i]).length <= 1;
    });
  }
  const numOf = n => parseInt(n, 10);
  // Pick the printing the small print points to, or null.
  function pickFromInfo(cands, info) {
    const numHit = (p, strict) => info.nums.some(n => numOf(n) === numOf(p.num) && (!strict || n.length >= 3));
    // Set code and number agree.
    const both = cands.filter(p => codeHit(info.codes, p.code) && numHit(p, false));
    if (both.length === 1) return { key: both[0].code + ":" + both[0].num, how: "code" };
    // Set code alone: only trusted next to the language marker, since rules text can hold words like "ONE" or "WAR".
    const withCode = cands.filter(p => codeHit(info.strong, p.code));
    const codesFound = [...new Set(withCode.map(p => p.code))];
    if (codesFound.length === 1) {
      const inSet = cands.filter(p => p.code === codesFound[0]);
      return inSet.length === 1 ? { key: inSet[0].code + ":" + inSet[0].num, how: "code" } : { key: codesFound[0] + ":", how: "code" };
    }
    // No code read, but a zero-padded number ("0178") that fits only one printing.
    const byNum = cands.filter(p => numHit(p, true));
    if (byNum.length === 1 && info.nums.some(n => n.length === 4)) return { key: byNum[0].code + ":" + byNum[0].num, how: "number" };
    return null;
  }

  /* Which printing is the card whose name bar is at `box`? ctx.printsOf(name) lists the printings; u is pixels per mm.
     Returns { key: "SOS:178" (or "SOA:" when only the set is known), how } or null. */
  async function identify(ctx, src, box, name, u) {
    const cands = ctx.printsOf ? ctx.printsOf(name) : [];
    if (!cands.length) return null;
    if (cands.length === 1) return { key: cands[0].code + ":" + cands[0].num, how: "only" };
    for (const [mode, psm] of [["otsu", 6], ["local", 6], ["otsu", 11]]) {
      const c = infoCanvas(src, box, mode, u); if (!c) break;
      const p = pickFromInfo(cands, parseInfo(await recognizeRaw(ctx, c, psm)));
      if (p) return p;
    }
    const codes = [...new Set(cands.map(p => p.code))];
    if (codes.length === 1) return { key: codes[0] + ":", how: "only" };   // every printing is from one set
    return null;
  }

  root.ScanSet = { identify, parseInfo, pickFromInfo, geom, infoCanvas };
})(typeof self !== "undefined" ? self : this);
