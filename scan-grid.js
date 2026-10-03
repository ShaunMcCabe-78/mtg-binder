/* Grid layout: cards laid side by side in rows (on a table, or a binder page).
   1. Find bar candidates, then work out the grid: columns of cards, and rows of name bars one card-height apart.
      Only the name bar of each card is read, so type lines, text boxes and artwork are ignored.
   2. A cell whose name bar wasn't detected gets a predicted position and is still read.
   3. Each cell is one card. */
(function (root) {
  "use strict";
  const C = () => root.ScanCore;
  const CARD_RATIO = 88 / 63;          // Magic cards are 63 x 88 mm
  const BAR_OF_CARD = 0.89;            // the name bar spans most of the card's width

  /* Work out where every card's name bar is. bars: candidates in photo pixels; W,H: photo size.
     Returns { cells: [{ row, col, box, predicted, rowY, colX }], cols, pitch, barH, stackLike } or null if no grid could be found.
     1. Columns: bars grouped by their centre; a column needs at least two bars (a stray strip of table can't make one).
     2. Rows, per column: the bars that repeat at one card-height steps (names; stray strips don't fit the pattern).
        Each column keeps its own row positions, so cards that aren't perfectly level still line up. */
  function layoutGrid(bars, W, H) {
    const core = C();
    if (!bars.length) return null;
    const medW = core.median(bars.map(b => b.x1 - b.x0));
    const good = bars.filter(b => (b.x1 - b.x0) >= medW * 0.7 && (b.x1 - b.x0) <= medW * 1.3);
    if (!good.length) return null;
    const barW = core.median(good.map(b => b.x1 - b.x0)), barH = core.median(good.map(b => b.y1 - b.y0));
    const cardH = barW / BAR_OF_CARD * CARD_RATIO;
    const cx = b => (b.x0 + b.x1) / 2, cy = b => (b.y0 + b.y1) / 2;

    // 1. Columns by centre.
    let cols = [];
    for (const b of good.slice().sort((p, q) => cx(p) - cx(q))) {
      const c = cols.find(c => Math.abs(core.median(c.bars.map(cx)) - cx(b)) < barW * 0.35);
      if (c) c.bars.push(b); else cols.push({ bars: [b] });
    }
    cols = cols.filter(c => c.bars.length >= 2).map(c => ({ bars: c.bars.sort((p, q) => p.y0 - q.y0), x0: core.median(c.bars.map(b => b.x0)), x1: core.median(c.bars.map(b => b.x1)) }));
    if (!cols.length) return null;

    // 2. Runs: bars that repeat at one card-height steps within a column. Names and type lines both repeat like that,
    //    so pick one reference run (most bars; its top bar has no bar half a card above it, as the type-line run's would),
    //    then every column uses the bars in step with that reference.
    const tol = cardH * 0.07, half = cardH * 0.53;
    const runsOf = c => {
      const ys = c.bars.map(cy), out = [];
      for (let i = 0; i < ys.length; i++) for (let j = i + 1; j < ys.length; j++) {
        let d = ys[j] - ys[i];
        if (d >= cardH * 1.8 && d <= cardH * 2.6) d /= 2;   // a row in between wasn't detected
        if (d < cardH * 0.95 || d > cardH * 1.3) continue;
        const hit = [];
        for (let k = 0; ys[i] + k * d < H; k++) { const m = c.bars.find(b => Math.abs(cy(b) - (ys[i] + k * d)) < tol); if (m) hit.push([k, m]); }
        const above = c.bars.some(b => Math.abs(cy(b) - (ys[i] - half)) < tol * 1.5);
        out.push({ y: ys[i], d, hit, score: hit.length * 10 - (above ? 15 : 0) });
      }
      return out;
    };
    const fit = h => h.length >= 2 ? (cy(h[h.length - 1][1]) - cy(h[0][1])) / (h[h.length - 1][0] - h[0][0]) : null;
    const phaseOf = (y, y0, p) => { const f = (y - y0) / p; return Math.abs(f - Math.round(f)); };
    for (const c of cols) c.runs = runsOf(c);
    // The reference is the run the most bars across all columns agree with (a stray pattern in one column can't win),
    // then its own score (the type-line run loses for having names above it), then the topmost.
    let ref = null;
    for (const c of cols) for (const r of c.runs) {
      const p = fit(r.hit) || r.d;
      r.agree = cols.reduce((sum, o) => sum + o.bars.filter(b => phaseOf(cy(b), r.y, p) < 0.12 && cy(b) > r.y - p * 0.5).length, 0);
      if (!ref || r.agree * 10 + r.score > ref.agree * 10 + ref.score || (r.agree * 10 + r.score === ref.agree * 10 + ref.score && r.y < ref.y)) ref = r;
    }
    // Names and type lines repeat with the same spacing, half a card apart. If both patterns show, the names are the one
    // that starts higher: the top row's names are above its type lines.
    if (ref) {
      const p = fit(ref.hit) || ref.d;
      const top = (y0, pp) => core.median(cols.map(c => { const b = c.bars.find(b => phaseOf(cy(b), y0, pp) < 0.12); return b ? cy(b) : Infinity; }).filter(isFinite));
      let other = null;
      for (const c of cols) for (const r of c.runs) {
        const f = (r.y - ref.y) / p, off = Math.abs(f - Math.round(f));
        if (off > 0.35 && r.agree >= Math.max(3, ref.agree * 0.3) && (!other || r.agree > other.agree)) other = r;
      }
      if (other && top(other.y, fit(other.hit) || other.d) < top(ref.y, p)) ref = other;
    }
    const pitch = ref ? fit(ref.hit) || ref.d : cardH * 1.02;
    const refY = ref ? ref.y : Math.min(...cols.map(c => cy(c.bars[0])));
    const phase = y => phaseOf(y, refY, pitch);
    for (const c of cols) {
      // The column's own run in step with the reference, else its bars in step, else the reference's rows.
      const err = r => r.hit.reduce((m, [, b]) => Math.max(m, phase(cy(b))), 0);   // worst bar's distance from the reference rows
      const inStep = c.runs.filter(r => err(r) < 0.12).sort((p, q) => q.hit.length - p.hit.length || err(p) - err(q) || p.y - q.y)[0];
      if (inStep) c.run = { y: inStep.y, d: fit(inStep.hit) || pitch, hit: inStep.hit };
      else {
        const b = c.bars.filter(b => phase(cy(b)) < 0.12).sort((p, q) => cy(p) - cy(q))[0];
        c.run = { y: b ? cy(b) : refY, d: pitch, hit: b ? [[0, b]] : [] };
      }
      c.off = Math.round((c.run.y - refY) / pitch);
    }
    const minOff = Math.min(...cols.map(c => c.off));
    for (const c of cols) c.off -= minOff;
    // Rows: as far down as any column's card still mostly fits in the photo.
    let rows = 0;
    for (let r = 0; r < 12; r++) { if (cols.some(c => c.run.y + (r - c.off) * c.run.d - barH / 2 + cardH * 0.5 <= H && c.run.y + (r - c.off) * c.run.d >= 0)) rows = r + 1; else break; }

    const cells = [];
    for (let r = 0; r < rows; r++) cols.forEach((c, col) => {
      const yc = c.run.y + (r - c.off) * c.run.d;
      if (yc - barH / 2 < 0 || yc - barH / 2 + cardH * 0.5 > H) return;   // this column's card would be off the photo
      const b = c.bars.find(b => Math.abs(cy(b) - yc) < tol);
      const rowY = yc - barH / 2;
      cells.push(b ? { row: r, col, rowY, colX: [c.x0, c.x1], box: { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, dark: b.dark }, predicted: false }
        : { row: r, col, rowY, colX: [c.x0, c.x1], box: { x0: c.x0, x1: c.x1, y0: rowY, y1: rowY + barH }, predicted: true });
    });
    // Many bars in one column, closer together than a card height: that's a stack, not a grid.
    const stackLike = cols.length === 1 && cols[0].bars.filter((b, i, arr) => i > 0 && b.y0 - arr[i - 1].y0 < pitch * 0.5).length >= 2;
    return { cells, cols: cols.length, pitch, barH, stackLike };
  }

  async function scan(ctx, src) {
    const core = C();
    ctx.status("finding the cards…");
    const [W, H] = core.dimsOf(src);
    const grid = layoutGrid(core.detectBars(src), W, H);
    // Card outlines first: each card's rectangle gives its exact size and tilt, and the name, set code and number
    // sit at fixed places on a card. The name-bar grid is the backup for any spot without a found card.
    let found = [];
    if (root.CardFinder) {
      const named = grid ? grid.cells.filter(c => !c.predicted) : [];
      const hint = named.length ? core.median(named.map(c => c.colX[1] - c.colX[0])) / BAR_OF_CARD : null;
      try { found = root.CardFinder.find(src, hint); } catch (e) { found = []; }
      if (grid && grid.cols === 1 && grid.stackLike && found.length < 2) found = [];   // a stack, not a grid
    }
    if (!grid && !found.length) return root.ScanStacked.scan(ctx, src);   // no grid found: fall back to the general method

    // Safety net: if the first row of "names" reads as type lines ("Sorcery", "Creature — …"), the rows found are
    // the type lines, which sit about half a card below the names. Move every row up to where the names are.
    // Spots of the name-bar grid not inside a found card are still read the old way.
    if (grid) grid.cells = grid.cells.filter(c => !found.some(card => root.CardFinder.covers(card, (c.box.x0 + c.box.x1) / 2, (c.box.y0 + c.box.y1) / 2, 0.05)));
    const firstRow = grid ? grid.cells.filter(c => c.row === 0 && !c.predicted) : [];
    let typeLines = 0;
    for (const cell of firstRow) {
      ctx.check(); ctx.status("checking the grid…");
      const t = await core.recognize(ctx, core.cropBar(src, cell.box, 0, "otsu"), 7);
      if (CardMatcher.isTypeLine(t)) typeLines++;
    }
    if (firstRow.length && typeLines * 2 >= firstRow.length) {
      const shift = grid.pitch * 0.505;
      grid.cells = grid.cells.map(c => ({ ...c, predicted: true, rowY: c.rowY - shift, box: { ...c.box, y0: c.box.y0 - shift, y1: c.box.y1 - shift } })).filter(c => c.box.y0 >= 0);
      // A row of names may also exist below the last row of type lines found; it isn't needed: names sit above their type lines.
    }

    const counts = new Map(), scores = new Map(), sets = new Map(), leftovers = [], missing = [];
    const add = (m, printing) => {
      counts.set(m.name, (counts.get(m.name) || 0) + 1); scores.set(m.name, Math.min(scores.has(m.name) ? scores.get(m.name) : 1, m.score));
      if (printing) { const s = sets.get(m.name) || {}; s[printing.key] = (s[printing.key] || 0) + 1; sets.set(m.name, s); }
    };
    const total = found.length + (grid ? grid.cells.length : 0);
    let n = 0;
    // --- Found cards: straighten each one and read it at the known positions (mm on a 63 x 88 mm card).
    for (const card of found) {
      ctx.check(); n++;
      ctx.status(`reading card ${n} of ${total}…`);
      const r = await readFoundCard(ctx, src, card);
      if (r.match) add(r.match, r.printing);
      else missing.push({ row: card.row, col: card.col, thumb: r.thumb, seen: "" });
    }
    // --- Backup: name-bar spots without a found card.
    const cells = grid ? grid.cells : [];
    // Card size for reading the set: the median over the grid is steadier than any one name bar.
    const unit = cells.length ? core.median(cells.map(c => (c.box.x1 - c.box.x0) / 0.89 / 63)) : 0;
    for (const cell of cells) {
      ctx.check(); n++;
      ctx.status(`reading card ${n} of ${total}…`);
      let match = null, seen = "", guessed = false;
      const texts = [];   // everything read for this cell, for a best guess at the end
      if (!cell.predicted) {
        const r = await core.readBar(ctx, src, cell.box);
        match = r.match; seen = r.a || r.b; texts.push(r.a, r.b);
      }
      if (!match) {
        // Not detected, or didn't read as a name: look again, a little taller in case the position is slightly off.
        const pad = grid.barH * (cell.predicted ? 0.6 : 0.35);
        const top = cell.rowY != null ? Math.min(cell.box.y0, cell.rowY) : cell.box.y0, bottom = cell.rowY != null ? Math.max(cell.box.y1, cell.rowY + grid.barH) : cell.box.y1;
        const box = { x0: cell.box.x0, x1: cell.box.x1, y0: Math.max(0, top - pad), y1: Math.min(H, bottom + pad), dark: cell.box.dark };
        const line = await core.closerLook(ctx, src, box);
        if (line) match = core.barMatch(ctx.matcher, line);
        if (!match && cell.predicted) { const r = await core.readBar(ctx, src, cell.box); match = r.match; seen = seen || r.a || r.b; }
        // Still nothing: try a few heights around where the name should be (some frames put it lower, under an ornament).
        // Leave out the right side: the mana cost and frame ornaments there throw off the black-and-white cleanup.
        // A bar out of line with its row or column (too high, too thin, cut short, shifted) was probably an ornament, not the name:
        // then use the row's height and the column's full width.
        const bw = cell.box.x1 - cell.box.x0, cw = cell.colX ? cell.colX[1] - cell.colX[0] : bw;
        const offLine = cell.rowY != null && (Math.abs(cell.box.y0 - cell.rowY) > grid.barH * 0.3 || (cell.box.y1 - cell.box.y0) < grid.barH * 0.7
          || Math.abs(cell.box.x0 - cell.colX[0]) > cw * 0.08 || Math.abs(bw - cw) > cw * 0.12);
        if (!match && (!cell.predicted || offLine)) {
          const bh = grid.barH, base = offLine ? cell.rowY : cell.box.y0;
          // Start a little left of the column edge so the first letter isn't cut off.
          const x0 = Math.max(0, (offLine ? cell.colX[0] : cell.box.x0) - cw * 0.05), x1 = offLine ? cell.colX[1] : cell.box.x1;
          tries: for (const dy of [0, 0.4, 0.8, -0.3]) {
            const rb = { x0, x1, y0: Math.max(0, base + (dy - 0.15) * bh), y1: Math.min(H, base + (dy + 1.25) * bh) };
            // One line at a time (two clean-ups), then as separate lines of text: frame decorations above and below
            // the name can stop the single-line read, while the separate-lines read still finds the name among them.
            for (const [mode, psm] of [["otsu", 7], ["local", 7], ["otsu", 11]]) {
              const t = await core.recognize(ctx, core.cropBar(src, rb, 0.4, mode, 80), psm);
              texts.push(t);
              for (const line of String(t || "").split("\n")) { match = core.barMatch(ctx.matcher, line); if (match) break tries; }
            }
          }
        }
        // A detected card whose name never read cleanly: offer the closest card name as a guess, marked "check".
        if (!match && !cell.predicted) {
          let best = null;
          for (const t of texts) for (const line of String(t || "").split("\n")) {
            if (!CardMatcher.usableBarLine(line) || CardMatcher.isTypeLine(line)) continue;
            const m = ctx.matcher.matchLine(line, { relaxed: true });
            if (m && m.score >= 0.8 && CardMatcher.key(m.name).length >= 6 && (!best || m.score > best.score)) best = m;
          }
          if (best) { match = { ...best, score: Math.min(best.score, 0.9) }; guessed = true; }
        }
      }
      // Every square of the grid should hold a card. Still nothing: one last look across the whole top of the card.
      let thumb = null;
      if (!match) {
        ctx.status(`checking square ${cell.row + 1}, ${cell.col + 1} again…`);
        const g = root.ScanSet.geom({ x0: cell.colX[0], x1: cell.colX[1], y0: cell.rowY, y1: cell.rowY + grid.barH }, unit), cw = 63 * g.u;
        const top = { x0: Math.max(0, g.left), x1: Math.min(W, g.left + cw), y0: Math.max(0, g.top), y1: Math.min(H, g.top + 16 * g.u) };
        const t = await core.recognize(ctx, core.cropBar(src, top, 0, "otsu", 160), 11);
        texts.push(t);
        for (const line of t.split("\n")) { match = core.barMatch(ctx.matcher, line); if (match) { match = { ...match, score: Math.min(match.score, 0.9) }; break; } }
        // Closest card name as a guess (marked "check").
        if (!match) {
          let best = null;
          for (const tx of texts) for (const line of String(tx || "").split("\n")) {
            if (!CardMatcher.usableBarLine(line) || CardMatcher.isTypeLine(line)) continue;
            const m = ctx.matcher.matchLine(line, { relaxed: true });
            if (m && m.score >= 0.8 && CardMatcher.key(m.name).length >= 6 && (!best || m.score > best.score)) best = m;
          }
          if (best) { match = { ...best, score: Math.min(best.score, 0.9) }; guessed = true; }
        }
        // Still nothing: a small picture of the square, so it can be named by hand.
        if (!match) {
          const c = document.createElement("canvas"), w = 150, h = Math.round(w * 88 / 63); c.width = w; c.height = h;
          const x = c.getContext("2d"); x.fillStyle = "#888"; x.fillRect(0, 0, w, h); x.imageSmoothingQuality = "high";
          x.drawImage(src, g.left, g.top, cw, 88 * g.u, 0, 0, w, h);
          try { thumb = c.toDataURL("image/jpeg", 0.75); } catch (e) {}
        }
      }
      let printing = null;
      if (match && root.ScanSet && ctx.printsOf) {
        // The whole card shows in a grid, so the small print and set symbol can say which printing it is.
        ctx.status(`reading card ${n} of ${total} (set)…`);
        try { printing = await root.ScanSet.identify(ctx, src, cell.box, match.name, unit); } catch (e) { if (e && e.code === "cancelled") throw e; }
        // A guessed name confirmed by its own collector number in the small print is no longer a guess.
        if (guessed && printing && printing.how === "code" && /:\S/.test(printing.key)) match = { ...match, score: 0.95 };
      }
      if (match) add(match, printing);
      else missing.push({ row: cell.row, col: cell.col, thumb, seen: !cell.predicted && seen && !CardMatcher.clearlyNotName(seen) ? seen.split("\n")[0] : "" });
    }
    const rows = Math.max(0, ...found.map(c => c.row), ...cells.map(c => c.row)) + 1;
    const cols = Math.max(grid ? grid.cols : 0, 0, ...found.map(c => c.col + 1));
    const res = { cards: [...counts].map(([name, qty]) => ({ name, qty, score: scores.get(name), sets: sets.get(name) })), leftovers, missing, grid: { rows, cols, cells: total } };
    // A single column with bars much closer together than a card height is really a stack.
    if (!found.length && grid && grid.cols === 1 && grid.stackLike) res.hint = "stacked";
    return res;
  }

  /* Read one found card. Positions in mm on a 63 x 88 mm card; the name bar spans 3.5-59.5 mm across, about 3.8-8.6 mm down
     (some frames put the name a little lower, so further looks cover 2-13 mm). Returns { match, printing, thumb }. */
  async function readFoundCard(ctx, src, card) {
    const core = C();
    const M = 4;   // mm of margin around the card in the straightened image
    const { canvas: cc, pxPerMm: S } = root.CardFinder.straighten(src, card, 12, M);
    const mm = (x0, y0, x1, y1) => ({ x0: (x0 + M) * S, y0: (y0 + M) * S, x1: (x1 + M) * S, y1: (y1 + M) * S });
    // The name bar: found on the straightened card (the outline can be a millimetre or two off), near where it should be:
    // centre about 6 mm from the top, most of the card wide. Else the standard place.
    let bar = mm(3.465, 3.8, 59.535, 8.6);   // centred on the card, 0.89 of its width: what the set reader expects
    try {
      const near = core.detectBars(cc).filter(b => { const yc = (b.y0 + b.y1) / 2 / S - M, w = (b.x1 - b.x0) / S;
        return yc > 1 && yc < 13 && w > 40 && w < 62; });
      if (near.length) {
        const b = near.sort((p, q) => Math.abs((p.y0 + p.y1) / 2 / S - M - 6.2) - Math.abs((q.y0 + q.y1) / 2 / S - M - 6.2))[0];
        bar = { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, dark: b.dark };
      }
    } catch (e) {}
    const texts = [];
    let match = null, guessed = false;
    // 1. The name bar, as one line.
    const r = await core.readBar(ctx, cc, bar);
    match = r.match; texts.push(r.a, r.b);
    // 2. A closer look over a taller strip.
    if (!match) { const line = await core.closerLook(ctx, cc, mm(2.5, 0.5, 60.5, 12.5)); if (line) match = core.barMatch(ctx.matcher, line); }
    // 3. Strips at a few heights, without the mana cost on the right; as one line and as separate lines.
    if (!match) {
      tries: for (const y of [3.4, 4.6, 5.8, 2.2, 7, 1, -0.5]) {
        const box = mm(2.5, y, 60.5, y + 6);
        for (const [mode, psm] of [["otsu", 7], ["local", 7], ["otsu", 11]]) {
          const t = await core.recognize(ctx, core.cropBar(cc, box, 0.35, mode, 80), psm);
          texts.push(t);
          for (const line of String(t || "").split("\n")) { match = core.barMatch(ctx.matcher, line); if (match) break tries; }
        }
      }
      if (match) match = { ...match, score: Math.min(match.score, 0.9) };
    }
    // 4. The closest card name as a guess (marked "check").
    if (!match) {
      let best = null;
      for (const t of texts) for (const line of String(t || "").split("\n")) {
        if (!CardMatcher.usableBarLine(line) || CardMatcher.isTypeLine(line)) continue;
        const m = ctx.matcher.matchLine(line, { relaxed: true });
        if (m && m.score >= 0.8 && CardMatcher.key(m.name).length >= 6 && !CardMatcher.startsMidWord(line, m) && (!best || m.score > best.score)) best = m;
      }
      if (best) { match = { ...best, score: Math.min(best.score, 0.9) }; guessed = true; }
    }
    let printing = null, thumb = null;
    if (match && root.ScanSet && ctx.printsOf) {
      try { printing = await root.ScanSet.identify(ctx, cc, bar, match.name, S); } catch (e) { if (e && e.code === "cancelled") throw e; }
      // A guess confirmed by its own collector number in the small print is no longer a guess.
      if (guessed && printing && printing.how === "code" && /:\S/.test(printing.key)) match = { ...match, score: 0.95 };
    }
    if (!match) {
      const t = document.createElement("canvas"), w = 150, h = Math.round(w * 88 / 63); t.width = w; t.height = h;
      const x = t.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cc, M * S, M * S, 63 * S, 88 * S, 0, 0, w, h);
      try { thumb = t.toDataURL("image/jpeg", 0.75); } catch (e) {}
    }
    return { match, printing, thumb };
  }

  root.ScanGrid = { scan, layoutGrid };
})(typeof self !== "undefined" ? self : this);
