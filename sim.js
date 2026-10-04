/* Combat simulator: resolves one combat under the Comprehensive Rules, step by step, citing rule numbers.
   Handles: flying / reach / menace / defender (who may attack and block), first strike and double strike
   (two combat damage steps), trample (including blockers that are already gone), deathtouch (1 damage is lethal),
   lifelink, indestructible, vigilance. Other abilities (triggers, pump effects) are outside it: set power and
   toughness by hand, or ask Claude.
   run({ attackers: [{ id, name, power, toughness, kw: [...] }], blockers: [{ ..., blocks: attackerId | null }], lifeA, lifeD })
   → { problems: [...], steps: [{ title, rule, lines: [...] }], result: { lifeA, lifeD, died: [...], survived: [...], loser } } */
(function (root) {
  "use strict";
  const KW = ["flying", "reach", "menace", "first strike", "double strike", "trample", "deathtouch", "lifelink", "indestructible", "vigilance", "defender"];

  // Keywords from Oracle text: lines that are only a list of keywords ("Flying, vigilance", "Deathtouch").
  function keywordsFrom(text) {
    const out = new Set();
    for (let line of String(text || "").split(/\n/)) {
      line = line.replace(/\([^)]*\)/g, "").trim().toLowerCase().replace(/\.$/, "");
      if (!line) continue;
      const parts = line.split(/,\s*|;\s*/).map(p => p.trim()).filter(Boolean);
      if (parts.length && parts.every(p => KW.includes(p))) parts.forEach(p => out.add(p));
    }
    return [...out];
  }

  const has = (c, k) => c.kw.includes(k);
  const nameOf = c => c.name + (c.dup ? ` (${c.dup})` : "");

  function run(input) {
    const A = input.attackers.map(c => ({ ...c, side: "A", damage: 0, dt: false, dead: false, kw: [...(c.kw || [])] }));
    const D = input.blockers.map(c => ({ ...c, side: "D", damage: 0, dt: false, dead: false, kw: [...(c.kw || [])] }));
    // Same name twice: number them so the log is clear.
    const count = {}; [...A, ...D].forEach(c => { count[c.name] = (count[c.name] || 0) + 1; });
    const seen = {}; [...A, ...D].forEach(c => { if (count[c.name] > 1) { seen[c.name] = (seen[c.name] || 0) + 1; c.dup = seen[c.name]; } });
    let lifeA = input.lifeA, lifeD = input.lifeD;
    const problems = [], steps = [];
    const byId = new Map([...A, ...D].map(c => [c.id, c]));

    // --- Declare attackers / blockers: legality.
    for (const a of A) if (has(a, "defender")) problems.push(`${nameOf(a)} has defender and can't attack [702.3b].`);
    const blockersOf = new Map(A.map(a => [a.id, D.filter(b => b.blocks === a.id)]));
    for (const a of A) {
      const bl = blockersOf.get(a.id);
      if (has(a, "flying")) for (const b of bl) if (!has(b, "flying") && !has(b, "reach")) problems.push(`${nameOf(b)} can't block ${nameOf(a)}: a creature with flying can only be blocked by creatures with flying or reach [702.9b].`);
      if (has(a, "menace") && bl.length === 1) problems.push(`${nameOf(a)} has menace, so it can't be blocked by just one creature [702.111b]. Add a second blocker or remove the block.`);
    }
    if (problems.length) return { problems, steps, result: null };

    const decl = { title: "Declare attackers and blockers", rule: "508, 509", lines: [] };
    for (const a of A) {
      const bl = blockersOf.get(a.id);
      decl.lines.push(bl.length ? `${nameOf(a)} (${a.power}/${a.toughness}) is blocked by ${bl.map(b => `${nameOf(b)} (${b.power}/${b.toughness})`).join(" and ")}.` : `${nameOf(a)} (${a.power}/${a.toughness}) is unblocked.`);
      if (has(a, "vigilance")) decl.lines.push(`${nameOf(a)} has vigilance: attacking doesn't cause it to tap [702.20b].`);
    }
    const idle = D.filter(b => !b.blocks); if (idle.length) decl.lines.push(`Not blocking: ${idle.map(nameOf).join(", ")}.`);
    steps.push(decl);

    // --- Combat damage: one step, or two if anyone has first strike or double strike.
    const twoSteps = [...A, ...D].some(c => has(c, "first strike") || has(c, "double strike"));
    const phases = twoSteps ? ["first", "regular"] : ["only"];
    for (const ph of phases) {
      const deals = c => !c.dead && c.power > 0 && (ph === "only" || (ph === "first" ? (has(c, "first strike") || has(c, "double strike")) : (!has(c, "first strike") || has(c, "double strike"))));
      const step = { title: ph === "first" ? "First-strike combat damage step" : ph === "regular" ? "Regular combat damage step" : "Combat damage step",
        rule: ph === "only" ? "510.1–510.2" : "510.4", lines: [] };
      if (ph === "first") step.lines.push("Creatures with first strike or double strike deal their damage first [702.7b, 702.4b].");
      if (ph === "regular") step.lines.push("Now the creatures without first strike deal damage, and creatures with double strike deal damage again [510.4, 702.4b].");
      const hits = [];   // { from, to (creature) | player: "A"/"D", n }
      for (const a of A) {
        if (!deals(a)) continue;
        const bl = blockersOf.get(a.id);
        if (!bl.length) { hits.push({ from: a, player: "D", n: a.power }); continue; }
        const live = bl.filter(b => !b.dead);
        if (!live.length) {
          if (has(a, "trample")) { hits.push({ from: a, player: "D", n: a.power }); step.lines.push(`${nameOf(a)} was blocked, but its blockers are gone; with trample all its damage goes to the defending player [702.19d].`); }
          else step.lines.push(`${nameOf(a)} was blocked, but its blockers are gone, so it deals no combat damage [510.1c].`);
          continue;
        }
        // Lethal damage to each blocker first (deathtouch: 1 is lethal), killing as many as possible, smallest first.
        const need = b => Math.max(0, (has(a, "deathtouch") ? (b.damage > 0 && b.dt ? 0 : 1) : b.toughness - b.damage));
        const order = live.slice().sort((p, q) => need(p) - need(q));
        let left = a.power; const parts = [];
        for (const b of order) { const n = Math.min(left, need(b)); if (n > 0) { parts.push([b, n]); left -= n; } }
        if (left > 0) {
          if (has(a, "trample")) { hits.push({ from: a, player: "D", n: left }); step.lines.push(`${nameOf(a)} has trample: once each blocker is assigned lethal damage${has(a, "deathtouch") ? " (with deathtouch, 1 damage is lethal [702.2c])" : ""}, the rest (${left}) can go to the defending player [702.19b].`); }
          else { const tgt = parts.length ? parts[0] : [order[0], 0]; const i = parts.indexOf(tgt); if (i >= 0) parts[i] = [tgt[0], tgt[1] + left]; else parts.push([order[0], left]); }
        }
        if (bl.length > 1) step.lines.push(`${nameOf(a)} divides its damage among its blockers as its controller chooses [510.1c]; here it's split to destroy as many as possible.`);
        for (const [b, n] of parts) hits.push({ from: a, to: b, n });
      }
      for (const b of D) {
        if (!b.blocks || !deals(b)) continue;
        const a = byId.get(b.blocks);
        if (!a || a.dead) { step.lines.push(`${nameOf(b)} is no longer blocking anything, so it deals no combat damage [510.1d].`); continue; }
        hits.push({ from: b, to: a, n: b.power });
      }
      if (!hits.length) { if (step.lines.length) { step.lines.push("No creature is left to deal damage in this step."); steps.push(step); } continue; }
      // All damage is dealt at the same time [510.2].
      for (const h of hits) {
        if (h.player) { if (h.player === "D") lifeD -= h.n; else lifeA -= h.n; step.lines.push(`${nameOf(h.from)} deals ${h.n} damage to the defending player (${h.player === "D" ? lifeD + h.n : lifeA + h.n} → ${h.player === "D" ? lifeD : lifeA} life).`); }
        else { h.to.damage += h.n; if (has(h.from, "deathtouch")) h.to.dt = true; step.lines.push(`${nameOf(h.from)} deals ${h.n} damage to ${nameOf(h.to)}${has(h.from, "deathtouch") ? " (deathtouch)" : ""}.`); }
        if (has(h.from, "lifelink")) { if (h.from.side === "A") lifeA += h.n; else lifeD += h.n; step.lines.push(`Lifelink: ${h.from.side === "A" ? "the attacking" : "the defending"} player gains ${h.n} life [702.15b].`); }
      }
      step.lines.push("All of this damage is dealt at the same time [510.2].");
      // State-based actions.
      const sba = [];
      for (const c of [...A, ...D]) {
        if (c.dead) continue;
        const lethal = c.damage >= c.toughness, dt = c.dt && c.damage > 0;
        if (!lethal && !dt) continue;
        if (has(c, "indestructible")) { sba.push(`${nameOf(c)} has ${c.damage} damage${dt ? " from deathtouch" : ""} but is indestructible, so it isn't destroyed [702.12b].`); continue; }
        c.dead = true;
        sba.push(lethal ? `${nameOf(c)} has ${c.damage} damage marked, at least its toughness ${c.toughness}, and is destroyed [704.5g].` : `${nameOf(c)} was dealt damage by a creature with deathtouch and is destroyed [704.5h, 702.2b].`);
      }
      if (lifeD <= 0) sba.push(`The defending player is at ${lifeD} life and loses the game [704.5a].`);
      if (lifeA <= 0) sba.push(`The attacking player is at ${lifeA} life and loses the game [704.5a].`);
      if (sba.length) step.lines.push("State-based actions are checked:", ...sba.map(x => "  • " + x));
      steps.push(step);
      if (lifeD <= 0 || lifeA <= 0) break;
    }
    const all = [...A, ...D];
    return { problems, steps, result: { lifeA, lifeD, died: all.filter(c => c.dead).map(nameOf), survived: all.filter(c => !c.dead).map(c => `${nameOf(c)}${c.damage ? ` (${c.damage} damage)` : ""}`), loser: lifeD <= 0 ? "D" : lifeA <= 0 ? "A" : null } };
  }

  const api = { run, keywordsFrom, KW };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CombatSim = api;
})(typeof self !== "undefined" ? self : this);
