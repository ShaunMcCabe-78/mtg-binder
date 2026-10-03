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
    this.face = [];       // key index -> true when it is only one half of a split/double card ("Rise" of "Rise // Fall")
    this.faceOnly = new Set();
    this.exact = new Map();
    this.index = new Map();
    const add = (display, k, isFace) => {
      if (k.length < 2) return;
      const ki = this.keys.length;
      this.keys.push(k); this.owner.push(this.names.length - 1); this.face.push(!!isFace);
      if (!this.exact.has(k)) { this.exact.set(k, this.names.length - 1); if (isFace) this.faceOnly.add(k); }
      else if (!isFace) this.faceOnly.delete(k);
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
      if (n.includes(" // ")) for (const face of n.split(" // ")) add(n, key(face), true);
    }
  }

  // Best real card name for one OCR line, or null.
  // Returns {name, score (0-1), exact}
  // opts.strict: for text read from the whole photo (rules text, flavor text, artwork), only accept clear,
  // whole-line matches of full card names.
  Matcher.prototype.matchLine = function (line, opts) {
    const strict = !!(opts && opts.strict), relaxed = !!(opts && opts.relaxed);
    const q = key(line);
    if (q.length < 3) return null;
    if (this.exact.has(q)) {
      if (strict && (this.faceOnly.has(q) || q.length < 7)) return null;
      return { name: this.names[this.exact.get(q)], score: 1, exact: true };
    }
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
      if (share >= (relaxed ? 0.15 : 0.25)) cand.push([ki, share]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    let best = null, second = null;
    for (const [ki] of cand.slice(0, relaxed ? 200 : 60)) {
      const k = this.keys[ki];
      const { d, start, end } = fitDistance(k, q);
      const score = 1 - d / k.length;
      const span = end - start;
      const cover = k.length / q.length;     // how much of the line the name explains
      const short = k.length < 6;
      if (short ? (d > 0 || cover < 0.6) : (score < (relaxed && k.length >= 7 ? 0.7 : 0.78) || cover < 0.45)) continue;
      // Half of a split card ("Invent", "Rise") only counts when read exactly, never as a near miss.
      if (this.face[ki] && d > 0) continue;
      if (strict && (this.face[ki] || k.length < 7 || score < 0.9 || (k.length - d) / Math.max(q.length, k.length) < 0.7)) continue;
      // Prefer the name that explains most of the line, so "S.H.I.E.L.D. Spy Kit" beats the shorter card "Spy Kit"
      // and "Black Widow, Double Agent" beats a partial match.
      const explained = (k.length - d) / Math.max(q.length, k.length);
      const rank = explained + score * 0.5 - (span > k.length * 1.4 ? 0.05 : 0);
      const name = this.names[this.owner[ki]];
      if (!best || rank > best.rank) { if (best && best.name !== name) second = best; best = { name, score, rank, exact: d === 0, explained, start }; }
      else if (name !== best.name && (!second || rank > second.rank)) second = { name, score, rank };
    }
    // A forgiving match only counts when it's clearly the best candidate and explains most of the line.
    if (best && relaxed && best.score < 0.78 && (q.length > key(best.name).length * 1.5 || (second && best.rank - second.rank < 0.1))) return null;
    return best ? { name: best.name, score: best.score, exact: best.exact, start: best.start } : null;
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
      if (this.face[ki] || k.length <= q.length || c / (q.length + 2) < 0.45) continue;
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
  // Type lines ("Sorcery", "Creature — Human Soldier") sit in bars that look like name bars.
  const TYPE_LINE = /^[^A-Za-z]*(?:(?:[Ll]egendary|[Bb]asic|[Ss]now|[Ww]orld|[Kk]indred|[Tt]ribal)\s+)*(?:[Aa]rtifact|[Ee]nchantment|[Cc]reature|[Ll]and|[Pp]laneswalker|[Ii]nstant|[Ss]orcery|[Bb]attle)(?:\s+(?:[Aa]rtifact|[Cc]reature|[Ll]and))*(?:\s*[—–\-~]|\s*$|\s+[^A-Z])/;
  // A type line with junk in front of it ("ik Creature — Orc Sorcerer").
  const TYPE_ANYWHERE = /\b(?:[Cc]reature|[Aa]rtifact|[Ee]nchantment|[Ll]and|[Pp]laneswalker|[Bb]attle)\s*[—–]\s*[A-Z]/;
  const SMALL = /^(a|an|and|at|by|for|from|in|into|of|on|or|over|the|to|upon|with|within|without|under|beyond|through|between|against|among|before|after|vs)$/;
  // Rules and flavor text read like sentences: they start in lowercase, end with a full stop, or have several lowercase words.
  function looksLikeSentence(line, loose) {
    const t = line.replace(/^[^A-Za-z]+/, "");
    if (!loose && /^[a-z]/.test(t)) return true;
    if (/[a-z]{2,}[.:;]\W*$/.test(t)) return true;
    const low = (t.match(/\b[a-z][a-z']{2,}\b/g) || []).filter(w => !SMALL.test(w));
    return low.length >= 2;
  }

  // opts.strict: the readings are of the whole photo, so ignore sentence-like lines and accept only clear matches.
  // opts.oneNamePerLine: each line is one name bar, so never join lines.
  function countFromReadings(matcher, readings, opts) {
    const strict = !!(opts && opts.strict);
    const counts = new Map(), scores = new Map(), unmatched = new Map();
    for (const text of readings) {
      const here = new Map();
      const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !TYPE_LINE.test(l) && !TYPE_ANYWHERE.test(l) && !(strict ? looksLikeSentence(l) : looksLikeSentence(l, true)));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m = matcher.matchLine(line, opts);
        // A long name split over two lines: try it joined with the next line.
        // (Not for name-bar readings: each bar holds exactly one name.)
        if (!(opts && opts.oneNamePerLine) && (!m || m.score < 0.9) && i + 1 < lines.length) {
          const j = matcher.matchLine(line + " " + lines[i + 1], opts);
          if (j && j.score >= 0.9 && (!m || j.score > m.score) && key(j.name).length > key(line).length + 2) {
            const nextAlone = matcher.matchLine(lines[i + 1], opts);
            // Only join when the next line isn't already a good match on its own.
            if (!nextAlone || (nextAlone.name === j.name && nextAlone.score < 0.9)) { m = j; i++; }
          }
        }
        if (!m && !strict) m = matcher.matchPrefix(line);
        if (m) {
          here.set(m.name, (here.get(m.name) || 0) + 1);
          scores.set(m.name, Math.max(scores.get(m.name) || 0, m.score));
        } else {
          const letters = (line.match(/[A-Za-z]/g) || []).length;
          if (!strict && letters >= 8 && letters / line.replace(/\s/g, "").length >= 0.75) unmatched.set(key(line), line);
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

  // Would a name-bar line be considered at all? (not a type line, not sentence-like)
  // Clearly not a name: a type line, or text with several ordinary lowercase words or a full stop (rules/flavor text).
  function clearlyNotName(l) {
    if (!l) return false;
    if (TYPE_LINE.test(l) || TYPE_ANYWHERE.test(l)) return true;
    const t = l.replace(/^[^A-Za-z]+/, "");
    if (/[a-z]{3,}[.:;]/.test(t)) return true;
    return (t.match(/\b[a-z][a-z']{2,}\b/g) || []).filter(w => !SMALL.test(w)).length >= 3;
  }
  // True when an imperfect match starts inside a word of the line ("Rapier Wit" read inside "Grap le with").
  // The skipped part only counts if it holds real letters (not "|" or "!" read from a frame edge).
  function startsMidWord(line, m) {
    if (!m || m.exact || m.score >= 0.95 || !m.start) return false;
    let acc = 0;
    for (const tok of String(line).split(/\s+/)) {
      const k = key(tok); if (!k) continue;
      if (m.start > acc && m.start < acc + k.length) {
        const before = tok.normalize("NFKD").replace(/[^A-Za-z0-9|!]/g, "").slice(0, m.start - acc);
        return /[A-Za-z]/.test(before.replace(/^[|!lI1]+/, ""));
      }
      acc += k.length;
    }
    return false;
  }
  function usableBarLine(l) { return !!l && !TYPE_LINE.test(l) && !TYPE_ANYWHERE.test(l) && !looksLikeSentence(l, true); }

  // Does a line start like a type line? (used to check which row of a grid was found; a few real names such as
  // "Land Tax" start with a type word too, so this is only used as a majority vote over a whole row)
  function isTypeLine(l) {
    if (!l) return false;
    const t = l.replace(/^[^A-Za-z]*(?:[A-Za-z]{1,2}\s+)?/, "");
    return TYPE_LINE.test(l.trim()) || TYPE_ANYWHERE.test(l) ||
      /^(?:(?:Legendary|Basic|Snow|World|Kindred|Tribal)\s+)*(?:Artifact|Enchantment|Creature|Land|Planeswalker|Instant|Sorcery|Battle)\b/i.test(t);
  }
  const api = { Matcher, key, fitDistance, countFromReadings, usableBarLine, clearlyNotName, isTypeLine, startsMidWord };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CardMatcher = api;
})(typeof self !== "undefined" ? self : this);
