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
     Returns { cells: [{ row, col, box, predicted }], cols, pitch } or null if no grid could be found. */
  function layoutGrid(bars, W, H) {
    const core = C();
    if (!bars.length) return null;
    const medW = core.median(bars.map(b => b.x1 - b.x0));
    const good = bars.filter(b => (b.x1 - b.x0) >= medW * 0.6 && (b.x1 - b.x0) <= medW * 1.5);
    let cols = core.columnsOf(good).filter(c => (c.x1 - c.x0) >= medW * 0.7 && (c.x1 - c.x0) <= medW * 1.4);
    if (!cols.length) return null;
    const barW = core.median(cols.map(c => c.x1 - c.x0));
    const barH = core.median(good.map(b => b.y1 - b.y0));
    let pitch = barW / BAR_OF_CARD * CARD_RATIO * 1.02;   // one card height plus a small gap

    // First row: the highest top that at least half of the columns share.
    const near = (y, col, tol) => col.bars.reduce((best, b) => { const d = Math.abs(b.y0 - y); return d < tol && (!best || d < Math.abs(best.y0 - y)) ? b : best; }, null);
    const tops = cols.map(c => c.bars[0].y0).sort((p, q) => p - q);
    let y0 = tops[0];
    for (const t of tops) { if (cols.filter(c => near(t, c, barH * 1.5)).length >= Math.ceil(cols.length / 2)) { y0 = t; break; } }

    const lastBar = Math.max(...good.map(b => b.y0));
    const cells = [];
    let Y = y0, first = null;
    const cardH = barW / BAR_OF_CARD * CARD_RATIO;
    // A row only counts if at least half its card fits in the photo (strips near the bottom are copyright lines, not names).
    for (let row = 0; row < 12 && Y + barH <= H && Y + cardH * 0.5 <= H; row++) {
      const found = cols.map(c => near(Y, c, pitch * 0.1));
      const hits = found.filter(Boolean);
      if (!hits.length) { if (Y > lastBar) break; }
      else {
        Y = core.median(hits.map(b => b.y0));
        if (first == null) first = Y; else if (row > 0) pitch = (Y - first) / row;
      }
      cols.forEach((c, col) => {
        const b = found[col];
        // rowY: where this row's bars usually are, in case this cell's bar was found a little off (an ornate frame, say).
        // colX: the column's usual left/right edges, in case this bar was found cut short or shifted sideways.
        cells.push(b ? { row, col, rowY: Y, colX: [c.x0, c.x1], box: { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, dark: b.dark }, predicted: false }
          : { row, col, rowY: Y, colX: [c.x0, c.x1], box: { x0: c.x0, x1: c.x1, y0: Y, y1: Y + barH }, predicted: true });
      });
      Y += pitch;
    }
    // Many bars in one column, closer together than a card height: that's a stack, not a grid.
    const stackLike = cols.length === 1 && cols[0].bars.filter((b, i, arr) => i > 0 && b.y0 - arr[i - 1].y0 < pitch * 0.5).length >= 2;
    return { cells, cols: cols.length, pitch, barH, stackLike };
  }

  async function scan(ctx, src) {
    const core = C();
    ctx.status("finding the cards…");
    const [W, H] = core.dimsOf(src);
    const grid = layoutGrid(core.detectBars(src), W, H);
    if (!grid) return root.ScanStacked.scan(ctx, src);   // no grid found: fall back to the general method

    // Safety net: if the first row of "names" reads as type lines ("Sorcery", "Creature — …"), the rows found are
    // the type lines, which sit about half a card below the names. Move every row up to where the names are.
    const firstRow = grid.cells.filter(c => c.row === 0 && !c.predicted);
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

    const counts = new Map(), scores = new Map(), sets = new Map(), leftovers = [];
    const add = (m, printing) => {
      counts.set(m.name, (counts.get(m.name) || 0) + 1); scores.set(m.name, Math.min(scores.has(m.name) ? scores.get(m.name) : 1, m.score));
      if (printing) { const s = sets.get(m.name) || {}; s[printing.key] = (s[printing.key] || 0) + 1; sets.set(m.name, s); }
    };
    // Card size for reading the set: the median over the grid is steadier than any one name bar.
    const unit = core.median(grid.cells.map(c => (c.box.x1 - c.box.x0) / 0.89 / 63));
    let n = 0;
    for (const cell of grid.cells) {
      ctx.check(); n++;
      ctx.status(`reading card ${n} of ${grid.cells.length}…`);
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
            if (m && m.score >= 0.7 && CardMatcher.key(m.name).length >= 6 && (!best || m.score > best.score)) best = m;
          }
          if (best) { match = { ...best, score: Math.min(best.score, 0.9) }; guessed = true; }
        }
      }
      let printing = null;
      if (match && root.ScanSet && ctx.printsOf) {
        // The whole card shows in a grid, so the small print and set symbol can say which printing it is.
        ctx.status(`reading card ${n} of ${grid.cells.length} (set)…`);
        try { printing = await root.ScanSet.identify(ctx, src, cell.box, match.name, unit); } catch (e) { if (e && e.code === "cancelled") throw e; }
        // A guessed name confirmed by its own collector number in the small print is no longer a guess.
        if (guessed && printing && printing.how === "code" && /:\S/.test(printing.key)) match = { ...match, score: 0.95 };
      }
      if (match) add(match, printing);
      else if (!cell.predicted && seen && !CardMatcher.clearlyNotName(seen)) leftovers.push(seen.split("\n")[0]);
    }
    const rows = Math.max(0, ...grid.cells.map(c => c.row)) + 1;
    // A single column with bars much closer together than a card height is really a stack.
    const res = { cards: [...counts].map(([name, qty]) => ({ name, qty, score: scores.get(name), sets: sets.get(name) })), leftovers, grid: { rows, cols: grid.cols } };
    if (grid.cols === 1 && grid.stackLike) res.hint = "stacked";
    return res;
  }

  root.ScanGrid = { scan, layoutGrid };
})(typeof self !== "undefined" ? self : this);
