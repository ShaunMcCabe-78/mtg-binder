/* Built-in deckbuilder: picks a playable deck from the cards you own, no AI or internet needed. */
(function (root) {
  "use strict";
  const COLORS = ["W", "U", "B", "R", "G"];
  const BASIC = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
  const BASIC_NAMES = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes",
    "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest"]);
  const FORMATS = {
    casual: { size: 60, lands: 24, maxCopies: 4, creatures: 22 },
    limited: { size: 40, lands: 17, maxCopies: 99, creatures: 15 },
    commander: { size: 100, lands: 37, maxCopies: 1, creatures: 30 }
  };

  const has = (o, re) => re.test(o || "");
  function mainType(t) {
    t = (t || "").toLowerCase();
    for (const k of ["creature", "planeswalker", "battle", "instant", "sorcery", "artifact", "enchantment", "land"]) if (t.includes(k)) return k;
    return "other";
  }
  function subtypes(t) { const i = (t || "").indexOf("—"); return i < 0 ? [] : t.slice(i + 1).trim().split(/\s+/).filter(Boolean); }
  function colorsOf(c) {
    const set = new Set((c.k || "").split("").filter(x => COLORS.includes(x)));
    return set;
  }
  // Colors a card needs, including symbols in its rules text (for Commander color identity).
  function identity(c) {
    const s = colorsOf(c);
    for (const m of (c.o || "").matchAll(/\{([WUBRG])(?:\/[WUBRGP])?\}/g)) s.add(m[1]);
    return s;
  }
  function pt(c) { const m = /^(\*|\d+)\/(\*|\d+)/.exec(c.p || ""); return m ? [m[1] === "*" ? 2 : +m[1], m[2] === "*" ? 2 : +m[2]] : null; }

  // What a card does, as short tags used for scoring and for the "why" line.
  function roles(c) {
    const o = c.o || "", r = [];
    const mt = mainType(c.t);
    if (has(o, /(destroy|exile) (target|each|all) (creature|permanent|nonland|artifact or creature|creature or planeswalker|attacking)/i) ||
        has(o, /deals? (\d+|X) damage to (any target|target creature|each creature|target attacking|target .*creature)/i) ||
        has(o, /target creature (gets|an opponent controls gets) -\d+\/-\d+|-X\/-X/i) || has(o, /\bfights?\b/i) ||
        has(o, /(return|put) target (creature|nonland permanent).* (to|on) its owner's (hand|library)/i) ||
        has(o, /can't attack or block/i)) r.push("removal");
    if (has(o, /draw (a|two|three|X|\d+) cards?|draws? (a|two) cards?|investigate|connives?|surveil/i)) r.push("card advantage");
    if (has(o, /counter target (spell|creature spell|noncreature spell)/i)) r.push("counterspell");
    if (has(o, /add (\{[WUBRGC]\}|one mana|two mana|mana of any)|search your library for (a|up to two) basic land/i) && mt !== "land") r.push("ramp");
    if (has(o, /create .*token/i)) r.push("makes tokens");
    if (has(o, /gain (\d+|that much) life|lifelink/i)) r.push("life gain");
    if (mt === "creature") {
      for (const [k, re] of [["flying", /\bflying\b/i], ["deathtouch", /\bdeathtouch\b/i], ["trample", /\btrample\b/i], ["haste", /\bhaste\b/i],
        ["first strike", /\b(first|double) strike\b/i], ["menace", /\bmenace\b/i], ["lifelink", /\blifelink\b/i], ["vigilance", /\bvigilance\b/i], ["hexproof", /\b(hexproof|ward)\b/i]])
        if (re.test(o)) r.push(k);
    }
    if (mt === "artifact" && /Equipment/.test(c.t)) r.push("equipment");
    return r;
  }

  // A rough power rating for one card, adjusted for play style.
  function rate(c, style) {
    const mt = mainType(c.t), mv = c.v || 0, rs = roles(c);
    let s = 1;
    if (mt === "creature") {
      const p = pt(c);
      if (p) s += Math.max(0, (p[0] + p[1] * 0.8) / Math.max(1, mv) - 1) * 1.6 + (p[0] >= 4 ? 0.5 : 0);
      s += 0.6 * rs.filter(x => ["flying", "deathtouch", "trample", "first strike", "menace", "lifelink", "haste", "hexproof", "vigilance"].includes(x)).length;
      if ((c.o || "").length > 40) s += 0.6;   // has an ability
    } else if (mt === "planeswalker") s += 3;
    if (rs.includes("removal")) s += 2.2;
    if (rs.includes("card advantage")) s += 1.2;
    if (rs.includes("counterspell")) s += style === "control" ? 1.8 : 0.6;
    if (rs.includes("ramp")) s += 0.8;
    if (rs.includes("makes tokens")) s += 0.8;
    if (rs.includes("equipment")) s += 0.5;
    if (/Legendary/.test(c.t)) s += 0.2;
    if (mv >= 7) s -= 1.2;
    if (style === "aggro") { if (mv <= 2) s += 1; if (mv >= 5) s -= 1.2; if (rs.includes("haste")) s += 0.6; }
    if (style === "control") { if (mt === "creature" && mv <= 2) s -= 0.5; if (rs.includes("removal")) s += 1; if (mv >= 5 && mt === "creature") s += 0.5; }
    if (style === "beginner") { if ((c.o || "").length > 160) s -= 0.8; if (mt === "creature") s += 0.3; }
    return s;
  }

  function why(c) {
    const rs = roles(c), mt = mainType(c.t), p = pt(c);
    if (rs.includes("removal")) return "Removal: deals with threats";
    if (rs.includes("counterspell")) return "Stops your opponent's spells";
    if (rs.includes("card advantage")) return "Keeps your hand full";
    if (rs.includes("ramp")) return "Speeds up your mana";
    if (mt === "creature") {
      const kw = rs.filter(x => ["flying", "deathtouch", "trample", "first strike", "menace", "lifelink", "haste", "hexproof", "vigilance"].includes(x));
      if (kw.length) return (kw.slice(0, 2).join(" and ") + (p ? ` ${p[0]}/${p[1]}` : "")).replace(/^./, m => m.toUpperCase());
      if (p && c.v <= 2) return `Early ${p[0]}/${p[1]} to pressure`;
      if (p && p[0] >= 4) return `Big ${p[0]}/${p[1]} threat`;
      return "Solid creature";
    }
    if (rs.includes("makes tokens")) return "Builds a board of tokens";
    if (rs.includes("equipment")) return "Makes a creature stronger";
    return "Supports the plan";
  }

  // Does a nonbasic land help these colors?
  function landFits(c, cols) {
    const o = c.o || "";
    if (/any color|mana of any/i.test(o)) return 2;
    const made = new Set([...o.matchAll(/add[^.]*?\{([WUBRG])\}/gi)].map(m => m[1]));
    if (!made.size) return /\{C\}/.test(o) ? 0.3 : 0;
    let hit = 0; for (const x of made) if (cols.has(x)) hit++;
    return hit === 0 ? -1 : hit / made.size + (made.size > 1 && hit === made.size ? 1 : 0);
  }

  /*
    pool: [{name, qty, card}] where card = {n,c,v,k,t,p,o} (card may be partial)
    opts: {format, colors:[], style:"aggro"|"midrange"|"control"|"tribal"|"beginner"|"", }
  */
  function build(pool, opts) {
    const F = FORMATS[opts.format] || FORMATS.casual;
    const style = opts.style || "";
    const owned = pool.filter(e => e.card && e.qty > 0 && !BASIC_NAMES.has(e.name));
    const spellsAll = owned.filter(e => mainType(e.card.t) !== "land");
    const landsAll = owned.filter(e => mainType(e.card.t) === "land");
    const copies = e => Math.min(e.qty, F.maxCopies);

    // Pick colors: try every 1- and 2-color combo (3 for Commander) and keep the best-scoring.
    let combos = [];
    if (opts.colors && opts.colors.length) combos = [opts.colors.slice()];
    else {
      for (const a of COLORS) combos.push([a]);
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) combos.push([COLORS[i], COLORS[j]]);
      if (opts.format === "commander") for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) combos.push([COLORS[i], COLORS[j], COLORS[k]]);
    }
    const nonlandTarget = F.size - F.lands;
    const fits = (e, set) => { for (const x of (opts.format === "commander" ? identity(e.card) : colorsOf(e.card))) if (!set.has(x)) return false; return true; };
    function comboScore(cols) {
      const set = new Set(cols);
      const vals = [];
      for (const e of spellsAll) if (fits(e, set)) { const r = rate(e.card, style); for (let i = 0; i < copies(e); i++) vals.push(r); }
      vals.sort((a, b) => b - a);
      const top = vals.slice(0, nonlandTarget);
      const shortfall = Math.max(0, nonlandTarget - top.length);
      return top.reduce((a, b) => a + b, 0) - shortfall * 2 - (cols.length - 1) * 2.5;
    }
    let best = combos[0], bestS = -Infinity;
    for (const c of combos) { const s = comboScore(c); if (s > bestS) { bestS = s; best = c; } }
    const cols = new Set(best);

    let cand = spellsAll.filter(e => fits(e, cols));

    // Commander: best legendary creature within the colors.
    let commander = null;
    if (opts.format === "commander") {
      const legends = cand.filter(e => /Legendary/.test(e.card.t) && mainType(e.card.t) === "creature");
      legends.sort((a, b) => (identity(b.card).size - identity(a.card).size) || (rate(b.card, style) - rate(a.card, style)));
      const exact = legends.find(e => [...cols].every(x => identity(e.card).has(x)));
      commander = exact || legends[0] || null;
      if (commander) cand = cand.filter(e => e !== commander);
    }

    // Synergy: the creature type most common in the pool gets a bonus (Heroes, Villains, Goblins…).
    const tribe = new Map();
    for (const e of cand) if (mainType(e.card.t) === "creature") for (const st of subtypes(e.card.t)) if (!/^(Human|Soldier|Warrior|Wizard)$/.test(st) || style === "tribal") tribe.set(st, (tribe.get(st) || 0) + copies(e));
    let theme = null, themeN = 0; for (const [k, n] of tribe) if (n > themeN) { theme = k; themeN = n; }
    if (themeN < Math.max(4, nonlandTarget * 0.15)) theme = null;
    const themeRe = theme ? new RegExp("\\b" + theme + "s?\\b") : null;
    const score = e => rate(e.card, style) + (themeRe && (themeRe.test(e.card.t) || themeRe.test(e.card.o || "")) ? (style === "tribal" ? 2.5 : 1.2) : 0)
      + (commander && commander.card.o && subtypes(e.card.t).some(st => new RegExp("\\b" + st + "\\b").test(commander.card.o)) ? 1 : 0);

    // Fill nonland slots with the best cards, keeping a sensible curve.
    const caps = opts.format === "commander" ? [99, 12, 14, 14, 12, 9, 6, 5] : style === "aggro" ? [99, 12, 12, 9, 6, 3, 2, 1] : style === "control" ? [99, 8, 10, 10, 8, 6, 4, 3] : [99, 10, 11, 10, 7, 5, 3, 2];
    const scale = nonlandTarget / 36;
    const capFor = mv => Math.max(1, Math.round(caps[Math.min(7, mv)] * (opts.format === "commander" ? 1 : scale)));
    const singles = [];
    for (const e of cand) for (let i = 0; i < copies(e); i++) singles.push({ e, s: score(e) - i * 0.15 });
    singles.sort((a, b) => b.s - a.s);
    const picked = new Map(), byMv = new Map(); let n = 0, creatures = 0;
    const want = nonlandTarget - (commander ? 1 : 0);
    const minCreatures = Math.round(F.creatures * (style === "control" ? 0.6 : 1) * (commander ? 0.9 : 1));
    const take = x => { picked.set(x.e, (picked.get(x.e) || 0) + 1); const mv = Math.min(7, x.e.card.v || 0); byMv.set(mv, (byMv.get(mv) || 0) + 1); n++; if (mainType(x.e.card.t) === "creature") creatures++; };
    // First pass: respect the curve and leave room for enough creatures.
    for (const x of singles) {
      if (n >= want) break;
      const mv = Math.min(7, x.e.card.v || 0);
      if ((byMv.get(mv) || 0) >= capFor(mv)) continue;
      const isC = mainType(x.e.card.t) === "creature";
      const left = want - n, needC = minCreatures - creatures;
      if (!isC && needC >= left) continue;
      x.used = true; take(x);
    }
    // Second pass: fill any remaining slots with the best leftovers.
    for (const x of singles) { if (n >= want) break; if (!x.used) { x.used = true; take(x); } }

    // Lands: nonbasics that fit, then basics split by color pips.
    const chosen = [...picked].map(([e, q]) => ({ e, q }));
    if (commander) chosen.unshift({ e: commander, q: 1, commander: true });
    const spellCount = chosen.reduce((a, x) => a + x.q, 0);
    const landSlots = Math.max(0, F.size - spellCount);
    const nonbasic = [];
    let landLeft = landSlots;
    const lc = landsAll.map(e => ({ e, f: landFits(e.card, cols) })).filter(x => x.f >= 1).sort((a, b) => b.f - a.f);
    for (const x of lc) { const keep = Math.ceil(landSlots * 0.65); if (landLeft <= keep) break; const q = Math.min(copies(x.e), landLeft - keep); if (q > 0) { nonbasic.push({ e: x.e, q }); landLeft -= q; } }
    const pips = {}; for (const x of cols) pips[x] = 0;
    for (const x of chosen) for (const m of (x.e.card.c || "").matchAll(/\{([WUBRG])(?:\/[WUBRGP])?\}/g)) if (m[1] in pips) pips[m[1]] += x.q;
    const totalP = Object.values(pips).reduce((a, b) => a + b, 0) || 1;
    const basics = {};
    const colList = [...cols];
    if (colList.length) {
      let given = 0;
      colList.forEach((x, i) => { const q = i === colList.length - 1 ? landLeft - given : Math.round(landLeft * ((pips[x] || 0) / totalP || 1 / colList.length)); if (q > 0) { basics[BASIC[x]] = q; given += q; } });
    } else if (landLeft > 0) basics["Wastes"] = landLeft;

    const cards = chosen.concat(nonbasic).map(x => ({ name: x.e.name, qty: x.q, type: x.e.card.t || "", manaCost: x.e.card.c || "", cmc: x.e.card.v || 0, colors: [...colorsOf(x.e.card)], why: x.commander ? "Your commander" : mainType(x.e.card.t) === "land" ? "Fixes your mana" : why(x.e.card) }));
    const total = cards.reduce((a, c) => a + c.qty, 0) + Object.values(basics).reduce((a, b) => a + b, 0);
    const COLORNAME = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
    const PAIR = { WU: "Azorius", UB: "Dimir", BR: "Rakdos", RG: "Gruul", WG: "Selesnya", WB: "Orzhov", UR: "Izzet", BG: "Golgari", WR: "Boros", UG: "Simic" };
    const ck = COLORS.filter(x => cols.has(x)).join("");
    const colorLabel = ck.length === 1 ? "Mono-" + COLORNAME[ck] : PAIR[ck] || ck.split("").map(x => COLORNAME[x]).join("-");
    const styleLabel = { aggro: "Aggro", control: "Control", tribal: "Tribal", beginner: "Starter", midrange: "Midrange" }[style] || (theme ? theme + "s" : "Midrange");
    const removal = cards.filter(c => /Removal/.test(c.why)).reduce((a, c) => a + c.qty, 0);
    const notes = [];
    if (spellCount < nonlandTarget - (commander ? 0 : 0) && total < F.size) notes.push(`Your collection only had ${spellCount} playable cards in these colors, so the deck is filled with extra basic lands. Scan more cards or try other colors.`);
    if (opts.format === "commander" && !commander) notes.push("No legendary creature in these colors was found to be your commander. Add one or pick different colors.");
    if (removal < (F.size >= 60 ? 4 : 3)) notes.push("Light on removal. If you own more cards that destroy or damage creatures, add them.");
    const tips = [];
    tips.push(style === "aggro" ? "Play a creature every turn and attack early; your opponent has to react to you." :
      style === "control" ? "Hold removal for their best threats and win late with your biggest cards." :
      "Use your early turns to develop creatures, then trade removal for their best threats.");
    if (theme) tips.push(`Many cards care about ${theme}s; keep them together on the battlefield for extra value.`);
    tips.push("Keep an opening hand with 2–4 lands. Mulligan hands with 0–1 or 6–7 lands.");
    if (commander) tips.push(`${commander.name} starts in the command zone; cast it early and rebuild around it if it dies.`);
    return {
      name: (theme ? theme + " " : (PAIR[ck] || (ck.length === 1 ? COLORNAME[ck] : "Rainbow")) + " ") + (styleLabel === "Aggro" ? "Rush" : styleLabel === "Control" ? "Lockdown" : "Squad"),
      archetype: colorLabel + " " + styleLabel,
      colors: [...cols], commander: commander ? commander.name : "",
      summary: `Built from your own cards in ${colorLabel.toLowerCase()} colors. ` + (theme ? `It leans on your ${theme}s for synergy.` : "It picks your most efficient creatures and best removal."),
      cards, lands: basics, howToPlay: tips, notes: notes.join(" "), total, builtBy: "built-in"
    };
  }

  const api = { build, roles, rate, mainType, FORMATS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DeckBuilder = api;
})(typeof self !== "undefined" ? self : this);
