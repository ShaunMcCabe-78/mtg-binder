/* Card-name matcher: snaps noisy OCR lines to real Magic card names.
   Works fully offline against the downloaded list of every card name. */
(function (root) {
  "use strict";

  // Compare names on letters and digits only, so OCR spacing and punctuation
  // mistakes ("StarkTech", "Scound rel", "U. S. Agent") don't matter.
  function key(s) {
    return String(s || "")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // Letters the reader often mixes up count as the same: I, l, 1, | and ! ("S.H.1E.L.D."), and O and 0.
      .replace(/[|!1l]/g, "i")
      .replace(/0/g, "o")
      .replace(/[^a-z0-9]+/g, "");
  }

  function trigrams(k) {
    const out = new Set();
    const s = "^" + k + "$";
    for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
    return out;
  }

  // Edit distance of `name` aligned anywhere inside `line` (free gaps at both ends of the line).
  // Returns {d, start, end} where line[start:end] is the matched span.
  function fitDistance(name, line) {
    const m = name.length, n = line.length;
    let prev = new Int32Array(n + 1), cur = new Int32Array(n + 1);
    let prevS = new Int32Array(n + 1), curS = new Int32Array(n + 1);
    for (let j = 0; j <= n; j++) { prev[j] = 0; prevS[j] = j; }
    for (let i = 1; i <= m; i++) {
      cur[0] = i; curS[0] = 0;
      const c = name.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const sub = prev[j - 1] + (c === line.charCodeAt(j - 1) ? 0 : 1);
        const del = prev[j] + 1;      // skip a name char
        const ins = cur[j - 1] + 1;   // extra line char inside the match
        if (sub <= del && sub <= ins) { cur[j] = sub; curS[j] = prevS[j - 1]; }
        else if (del <= ins) { cur[j] = del; curS[j] = prevS[j]; }
        else { cur[j] = ins; curS[j] = curS[j - 1]; }
      }
      let t = prev; prev = cur; cur = t;
      t = prevS; prevS = curS; curS = t;
    }
    let best = Infinity, end = 0;
    for (let j = 0; j <= n; j++) if (prev[j] < best) { best = prev[j]; end = j; }
    return { d: best, start: prevS[end], end };
  }

  function Matcher(names) {
    this.names = [];      // display names (full, e.g. "Fire // Ice")
    this.keys = [];       // matching keys (one per face too)
    this.owner = [];      // key index -> name index
    this.exact = new Map();
    this.index = new Map();
    const add = (display, k) => {
      if (k.length < 2) return;
      const ki = this.keys.length;
      this.keys.push(k); this.owner.push(this.names.length - 1);
      if (!this.exact.has(k)) this.exact.set(k, this.names.length - 1);
      for (const g of trigrams(k)) {
        let a = this.index.get(g);
        if (!a) { a = []; this.index.set(g, a); }
        a.push(ki);
      }
    };
    for (const n of names) {
      if (!n) continue;
      this.names.push(n);
      add(n, key(n));
      if (n.includes(" // ")) for (const face of n.split(" // ")) add(n, key(face));
    }
  }

  // Best real card name for one OCR line, or null.
  // Returns {name, score (0-1), exact}
  Matcher.prototype.matchLine = function (line) {
    const q = key(line);
    if (q.length < 3) return null;
    if (this.exact.has(q)) return { name: this.names[this.exact.get(q)], score: 1, exact: true };
    const counts = new Map();
    const qg = trigrams(q);
    for (const g of qg) {
      const post = this.index.get(g);
      if (!post || post.length > 4000) continue;   // skip trigrams so common they say nothing
      for (const ki of post) counts.set(ki, (counts.get(ki) || 0) + 1);
    }
    if (!counts.size) return null;
    const cand = [];
    for (const [ki, c] of counts) {
      const k = this.keys[ki];
      if (k.length > q.length * 1.6 + 4) continue;   // name far longer than what was read
      const share = c / (k.length + 2);               // fraction of the name's trigrams seen
      if (share >= 0.25) cand.push([ki, share]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    let best = null;
    for (const [ki] of cand.slice(0, 60)) {
      const k = this.keys[ki];
      const { d, start, end } = fitDistance(k, q);
      const score = 1 - d / k.length;
      const span = end - start;
      const cover = k.length / q.length;     // how much of the line the name explains
      const short = k.length < 6;
      if (short ? (d > 0 || cover < 0.6) : (score < 0.78 || cover < 0.45)) continue;
      // Prefer the name that explains most of the line, so "S.H.I.E.L.D. Spy Kit" beats the shorter card "Spy Kit"
      // and "Black Widow, Double Agent" beats a partial match.
      const explained = (k.length - d) / Math.max(q.length, k.length);
      const rank = explained + score * 0.5 - (span > k.length * 1.4 ? 0.05 : 0);
      if (!best || rank > best.rank) best = { name: this.names[this.owner[ki]], score, rank, exact: d === 0 };
    }
    return best ? { name: best.name, score: best.score, exact: best.exact } : null;
  };

  // A cut-off name ("Swordsman, Sha…"): accept it when exactly one card name starts that way.
  Matcher.prototype.matchPrefix = function (line) {
    const q = key(line);
    if (q.length < 9) return null;
    const counts = new Map();
    for (const g of trigrams(q)) {
      const post = this.index.get(g); if (!post || post.length > 4000) continue;
      for (const ki of post) counts.set(ki, (counts.get(ki) || 0) + 1);
    }
    const res = [];
    for (const [ki, c] of counts) {
      const k = this.keys[ki];
      if (k.length <= q.length || c / (q.length + 2) < 0.45) continue;
      const { d } = fitDistance(q, k.slice(0, q.length + 2));
      if (d <= Math.max(1, Math.floor(q.length * 0.15))) res.push([this.owner[ki], d]);
    }
    if (!res.length) return null;
    res.sort((a, b) => a[1] - b[1]);
    const names = new Set(res.filter(r => r[1] === res[0][1]).map(r => r[0]));
    if (names.size !== 1) return null;
    return { name: this.names[res[0][0]], score: 0.8, exact: false, prefix: true };
  };

  // Best names for free text typed by the user (for "did you mean").
  Matcher.prototype.suggest = function (text, limit) {
    const q = key(text); if (q.length < 2) return [];
    const counts = new Map();
    for (const g of trigrams(q)) {
      const post = this.index.get(g); if (!post || post.length > 6000) continue;
      for (const ki of post) counts.set(ki, (counts.get(ki) || 0) + 1);
    }
    const scored = [];
    for (const [ki, c] of counts) {
      const k = this.keys[ki];
      const dice = 2 * c / (trigrams(k).size + trigrams(q).size);
      const prefix = k.startsWith(q) ? 0.4 : 0;
      scored.push([this.owner[ki], dice + prefix]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const out = [], seen = new Set();
    for (const [ni] of scored) { if (seen.has(ni)) continue; seen.add(ni); out.push(this.names[ni]); if (out.length >= (limit || 5)) break; }
    return out;
  };

  Matcher.prototype.isCard = function (name) { return this.exact.has(key(name)); };
  Matcher.prototype.canonical = function (name) { const i = this.exact.get(key(name)); return i == null ? null : this.names[i]; };

  /* Turn the readings of one photo into card counts.
     readings: array of text blocks (each block = several lines) that all show the SAME cards.
     Each matched line is one card; a card's count is the most times it was seen in any single reading. */
  function countFromReadings(matcher, readings) {
    const counts = new Map(), scores = new Map(), unmatched = new Map();
    for (const text of readings) {
      const here = new Map();
      const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m = matcher.matchLine(line);
        // A long name split over two lines: try it joined with the next line.
        if ((!m || m.score < 0.9) && i + 1 < lines.length) {
          const j = matcher.matchLine(line + " " + lines[i + 1]);
          if (j && j.score >= 0.9 && (!m || j.score > m.score) && key(j.name).length > key(line).length + 2) {
            const nextAlone = matcher.matchLine(lines[i + 1]);
            if (!nextAlone || nextAlone.name === j.name) { m = j; i++; }
          }
        }
        if (!m) m = matcher.matchPrefix(line);
        if (m) {
          here.set(m.name, (here.get(m.name) || 0) + 1);
          scores.set(m.name, Math.max(scores.get(m.name) || 0, m.score));
        } else {
          const letters = (line.match(/[A-Za-z]/g) || []).length;
          if (letters >= 8 && letters / line.replace(/\s/g, "").length >= 0.75) unmatched.set(key(line), line);
        }
      }
      for (const [n, c] of here) counts.set(n, Math.max(counts.get(n) || 0, c));
    }
    // A line that went unmatched in one reading but whose card was found in another is not a leftover.
    const leftovers = [];
    for (const [k, line] of unmatched) {
      let covered = false;
      const words = line.toLowerCase().match(/[a-z]{4,}/g) || [];
      for (const n of counts.keys()) {
        const nk = key(n);
        if (nk.includes(k) || k.includes(nk) || words.some(w => nk.includes(w)) || fitDistance(k, nk).d <= k.length * 0.35) { covered = true; break; }
      }
      // Lines with no real word in them are artwork noise, not a missed card.
      if (!covered && !words.some(w => w.length >= 5 || /^(of|the)$/.test(w))) covered = true;
      if (!covered) leftovers.push(line);
    }
    return { cards: [...counts].map(([name, qty]) => ({ name, qty, score: scores.get(name) })), leftovers };
  }

  const api = { Matcher, key, fitDistance, countFromReadings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CardMatcher = api;
})(typeof self !== "undefined" ? self : this);
