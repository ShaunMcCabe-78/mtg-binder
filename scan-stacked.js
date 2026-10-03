/* Stacked layout: cards overlapped in one column so each name bar shows, the bottom card in full.
   1. Find name bars, keep the main column of cards.
   2. Read each bar on its own; take a closer look at bars that didn't read as a name.
   3. Read the whole photo once as a backup, accepting only clear, whole-line card names. */
(function (root) {
  "use strict";
  const C = () => root.ScanCore;

  async function scan(ctx, src) {
    const core = C();
    ctx.status("finding the name bars…");
    let bars = core.detectBars(src);

    // A stack is one column: keep the column with the most bars (drops strips from the table beside the cards).
    let looksLikeGrid = false;
    if (bars.length) {
      const cols = core.columnsOf(bars).sort((p, q) => q.bars.length - p.bars.length);
      const main = cols[0];
      // Two or more columns of cards side by side means this is really a grid.
      const medW = core.median(bars.map(b => b.x1 - b.x0));
      looksLikeGrid = cols.filter(c => c.bars.length >= 2 && (c.x1 - c.x0) > medW * 0.6).length >= 2;
      bars = bars.filter(b => Math.min(b.x1, main.x1) - Math.max(b.x0, main.x0) > 0.5 * Math.min(b.x1 - b.x0, main.x1 - main.x0));
    }

    const a = [], b = [], retry = [];
    for (let n = 0; n < bars.length; n++) {
      ctx.check(); ctx.status(`reading name ${n + 1} of ${bars.length}…`);
      const r = await core.readBar(ctx, src, bars[n]);
      a.push(r.a); b.push(r.b);
      if (!r.match && !CardMatcher.clearlyNotName(r.a) && !CardMatcher.clearlyNotName(r.b)) retry.push(n);
    }
    // Closer look: dark bars first, then the strips that gave the most letters.
    const letters = n => ((a[n] + " " + b[n]).match(/[A-Za-z]/g) || []).length;
    retry.sort((p, q) => (bars[q].dark - bars[p].dark) || (letters(q) - letters(p)));
    for (const n of retry.slice(0, 6)) {
      ctx.check(); ctx.status("taking a closer look at a name…");
      const line = await core.closerLook(ctx, src, bars[n]);
      if (line) a[n] = line;
    }

    ctx.status("checking the whole photo…");
    const whole = await core.readWholePhoto(ctx, src, bars.length ? 1 : 2);

    const res = CardMatcher.countFromReadings(ctx.matcher, bars.length ? [a.join("\n"), b.join("\n")] : [], { oneNamePerLine: true });
    const w = CardMatcher.countFromReadings(ctx.matcher, whole, { strict: bars.length > 0 });
    for (const c of w.cards) { const f = res.cards.find(x => x.name === c.name); if (f) f.qty = Math.max(f.qty, c.qty); else res.cards.push(c); }
    if (!bars.length) res.leftovers.push(...w.leftovers);
    if (looksLikeGrid) res.hint = "grid";
    return res;
  }

  root.ScanStacked = { scan };
})(typeof self !== "undefined" ? self : this);
