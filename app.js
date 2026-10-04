(function () {
"use strict";
const APP_VERSION = "1.15.1";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const keyOf = n => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
const BASIC_NAMES = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
const BASIC_SET = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes"]);
const FORMATS = {
  casual: { label: "Casual", size: 60, maxCopies: 4, desc: "a 60-card casual constructed deck, max 4 copies of any non-basic card, about 22-25 lands" },
  limited: { label: "Quick game", size: 40, maxCopies: 99, desc: "a 40-card deck for a quick kitchen-table game, about 16-17 lands, any number of copies the player owns" },
  commander: { label: "Commander", size: 100, maxCopies: 1, desc: "a 100-card Commander deck: exactly one legendary creature as commander, singleton (1 copy of each non-basic card), all cards within the commander's color identity, about 36-38 lands" }
};
const TESS = {
  lib: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
  worker: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
  core: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/",
  coreFiles: ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"],
  // Fingerprints (SHA-256) of the exact published files. The browser refuses a file that doesn't match,
  // so a tampered copy on the CDN can't run here. (From jsDelivr's file list; the core files also checked against the project's source.)
  sri: {
    "/dist/tesseract.min.js": "sha256-qOKZGNCYsrBuEBK9rv+0rsBEXF1WVHCQI+C9H0QqgOg=",
    "/dist/worker.min.js": "sha256-rKEiljn8mQfYb5boJZVaK3xXFtF/O8Os1x+cerZhgfw=",
    "/tesseract-core-simd-lstm.wasm.js": "sha256-ziDtqVM8vtHmwrQnb7rh4K3GG2dUtVEwhL5gF4e0V88=",
    "/tesseract-core-lstm.wasm.js": "sha256-jwSqDMgee94z+A6S+gGnpmXwtIhNCYrPXenHEEoR36o="
  }
};
const sriFor = url => { for (const [end, h] of Object.entries(TESS.sri)) if (url.endsWith(end)) return h; return undefined; };
const CLAUDE_MODELS = ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"];

/* ---------- state + storage ---------- */
const S = { wl: null, scanMode: "stacked", cols: {}, order: [], target: "main", view: "all", buildFrom: "all", decks: [], photos: [], review: [], leftovers: [], fmt: "casual", colors: new Set(), filter: new Set(), deck: null, engine: "claude" };
// Named wishlists: S.wl = { order: [ids], lists: { id: { name, items } }, cur }. S.wish is the list being shown.
Object.defineProperty(S, "wish", { get() { return S.wl.lists[S.wl.cur].items; }, set(v) { S.wl.lists[S.wl.cur].items = v; } });
let DB = new Map();          // name -> card data
let matcher = null;
let extraNames = [], extraCards = {};
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast("Couldn't save: storage is full or blocked"); return false; } }
function persist() { lsSet("mtg.cols", { order: S.order, cols: S.cols }); lsSet("mtg.target", S.target); lsSet("mtg.view", S.view); lsSet("mtg.buildFrom", S.buildFrom); }
/* ---------- collections ---------- */
const colName = id => (S.cols[id] || {}).name || "Collection";
function newCollection(name) {
  name = String(name || "").trim().slice(0, 40); if (!name) return null;
  const ex = S.order.find(id => keyOf(S.cols[id].name) === keyOf(name)); if (ex) return ex;
  const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  S.cols[id] = { name, created: Date.now(), cards: {} }; S.order.push(id); persist(); renderColSelects(); return id;
}
// Cards across one collection ("id") or every collection ("all"), merged by name.
function merged(scope) {
  const out = {};
  for (const id of scope === "all" ? S.order : [scope]) {
    const col = S.cols[id]; if (!col) continue;
    for (const [k, c] of Object.entries(col.cards)) {
      const m = out[k] || (out[k] = { name: c.name, qty: 0, added: 0, where: {}, sets: {} });
      for (const [sk, n] of Object.entries(c.sets || {})) m.sets[sk] = (m.sets[sk] || 0) + n;
      for (const [fk, n] of Object.entries(c.foil || {})) (m.foil = m.foil || {})[fk] = (m.foil[fk] || 0) + n;
      m.qty += c.qty; m.added = Math.max(m.added, c.added || 0); m.where[id] = c.qty;
    }
  }
  return out;
}
function colCount(id) { let n = 0; for (const c of Object.values((S.cols[id] || {}).cards || {})) n += c.qty; return n; }
function renderColSelects() {
  if (!S.cols[S.target]) S.target = S.order[0];
  if (S.view !== "all" && !S.cols[S.view]) S.view = "all";
  if (S.buildFrom !== "all" && !S.cols[S.buildFrom]) S.buildFrom = "all";
  const opts = (sel) => S.order.map(id => `<option value="${id}"${id === sel ? " selected" : ""}>${esc(S.cols[id].name)} (${colCount(id)})</option>`).join("");
  const allOpt = sel => `<option value="all"${sel === "all" ? " selected" : ""}>All collections (${totals().n})</option>`;
  $("#targetSel").innerHTML = opts(S.target);
  $("#viewSel").innerHTML = allOpt(S.view) + opts(S.view);
  $("#buildSel").innerHTML = allOpt(S.buildFrom) + opts(S.buildFrom);
  $("#btnAddReviewed").textContent = "Add to " + colName(S.target);
}
function persistDecks() { lsSet("mtg.decks", S.decks); }
const apiKey = () => lsGet("mtg.apiKey", "");

/* ---------- card data ---------- */
function info(name) { return DB.get(name) || extraCards[name] || null; }
async function loadDB() {
  try {
    const r = await fetch("cards.json");
    if (!r.ok) throw new Error(r.status);
    const arr = await r.json();
    DB = new Map(arr.map(c => [c.n, c]));
    extraNames = lsGet("mtg.extraNames", []);
    extraCards = lsGet("mtg.extraCards", {});
    const names = arr.map(c => c.n).concat(extraNames.filter(n => !DB.has(n)));
    matcher = new CardMatcher.Matcher(names);
    $("#dbStatus").innerHTML = `Card list ready: <b>${names.length.toLocaleString()}</b> cards on this phone.`;
    renderDbInfo();
    // Fix up names typed or scanned before the list loaded
    let changed = false;
    for (const id of S.order) for (const c of Object.values(S.cols[id].cards)) { const can = matcher.canonical(c.name); if (can && can !== c.name) { c.name = can; changed = true; } }
    if (changed) persist();
    renderHeader(); if (!$("#pane-coll").hidden) renderColl();
  } catch (e) {
    $("#dbStatus").innerHTML = `<span class="err">The card list couldn't load. Check your connection and reopen the app.</span>`;
  }
}

/* ---------- printings (which set a copy is from) ----------
   A saved card keeps its total count in qty, plus sets: { "SOS:178": 2, "SOA:": 1 } for copies whose printing is known
   ("SOA:" = set known, number not). Copies not listed in sets have no set recorded. */
let PRINTS = null, printsP = null;
let extraPrints = lsGet("mtg.extraPrints", {}), extraSets = lsGet("mtg.extraSets", {});
function loadPrints() {
  return printsP || (printsP = fetch("prints.json").then(r => { if (!r.ok) throw 0; return r.json(); }).then(j => (PRINTS = j)).catch(() => { printsP = null; return null; }));
}
function printsOf(name) {
  const out = [], raw = PRINTS && PRINTS.p[name];
  if (raw) for (const p of raw.split("|")) { const [code, num, rar] = p.split(":"); out.push({ code, num, rar }); }
  for (const p of extraPrints[name] || []) if (!out.some(o => o.code === p.code && o.num === p.num)) out.push(p);
  return out;
}
const setInfo = code => (PRINTS && PRINTS.s[code]) || extraSets[code] || null;
function printLabel(key, long) {
  const [code, num] = key.split(":"); const si = setInfo(code);
  return `${code}${num ? " #" + num : ""}` + (long && si ? ` · ${si[0]}${si[1] ? " (" + si[1].slice(0, 4) + ")" : ""}` : "");
}
// More printings from Scryfall (newer than the downloaded list), when online. Kept on the phone.
const printsFetched = new Set();
async function fetchPrintsOnline(name) {
  if (!navigator.onLine || printsFetched.has(name)) return false;
  printsFetched.add(name);
  try {
    const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent('!"' + name + '"')}&unique=prints&order=released&dir=desc`, { headers: { Accept: "application/json" } });
    if (!r.ok) return false;
    const j = await r.json(), have = printsOf(name), add = [];
    for (const c of j.data || []) {
      if (c.digital) continue;
      const code = String(c.set).toUpperCase(), num = String(c.collector_number);
      if (!setInfo(code)) extraSets[code] = [c.set_name, c.released_at || ""];
      if (!have.some(p => p.code === code && p.num === num)) add.push({ code, num, rar: (c.rarity || "")[0].toUpperCase() });
    }
    if (!add.length) return false;
    extraPrints[name] = (extraPrints[name] || []).concat(add);
    lsSet("mtg.extraPrints", extraPrints); lsSet("mtg.extraSets", extraSets);
    return true;
  } catch (e) { return false; }
}
/* Foil copies: foil: { "SOS:178": 1, "": 2 } counts foil copies per printing ("" = copies without a recorded set),
   each within the number of copies of that printing. */
const foilTotal = c => Object.values(c.foil || {}).reduce((a, n) => a + n, 0);
// Keep a card's set and foil counts within its total.
function tidySets(c) {
  if (c.sets) {
    let room = c.qty;
    for (const k of Object.keys(c.sets)) { const n = Math.min(c.sets[k] | 0, room); if (n > 0) { c.sets[k] = n; room -= n; } else delete c.sets[k]; }
    if (!Object.keys(c.sets).length) delete c.sets;
  }
  if (c.foil) {
    const plain = c.qty - Object.values(c.sets || {}).reduce((a, n) => a + n, 0);
    for (const k of Object.keys(c.foil)) { const n = Math.min(c.foil[k] | 0, k ? (c.sets || {})[k] || 0 : plain); if (n > 0) c.foil[k] = n; else delete c.foil[k]; }
    if (!Object.keys(c.foil).length) delete c.foil;
  }
  return c;
}
function addSets(c, sets, foil) {
  if (sets) { c.sets = c.sets || {}; for (const [k, n] of Object.entries(sets)) c.sets[k] = (c.sets[k] || 0) + n; }
  if (foil) { c.foil = c.foil || {}; for (const [k, n] of Object.entries(foil)) c.foil[k] = (c.foil[k] || 0) + n; }
  tidySets(c);
}
// Every copy of an entry as { key, foil } (key "" = no set recorded).
function copiesOf(c) {
  const out = [], f = { ...(c.foil || {}) };
  const push = (key, n) => { for (let i = 0; i < n; i++) { const fo = (f[key] || 0) > 0; if (fo) f[key]--; out.push({ key, foil: fo }); } };
  let rest = c.qty;
  for (const [key, n] of Object.entries(c.sets || {})) { push(key, n); rest -= n; }
  if (rest > 0) push("", rest);
  return out;
}
const setChips = sets => sets ? Object.entries(sets).map(([k, n]) => `<span class="badge set">${esc(printLabel(k))}${n > 1 ? " ×" + n : ""}</span>`).join("") : "";
const foilChip = c => { const n = foilTotal(c); return n ? `<span class="badge foil">✦ Foil${n > 1 ? " ×" + n : ""}</span>` : ""; };

/* ---------- prices: Cardmarket euro prices via Scryfall (updated once a day) ----------
   Kept on the phone so they show offline. Price ids: "SOS:178" (a printing), "SOA:|Zombify" (set known, number not),
   "|Zombify" (no set: Scryfall's usual printing of the card). Each holds [euro, foil euro], null where Scryfall has none. */
let PRICES = lsGet("mtg.prices", null) || { at: 0, p: {} };
const DAY = 24 * 3600 * 1000;
const fmtEur = v => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(v); } catch (e) { return "€" + v.toFixed(2); } };
function priceId(name, key) {
  if (!key) return "|" + name;
  const [code, num] = key.split(":"); return num ? code + ":" + num : code + ":|" + name;
}
// One copy's price: its printing's, or the card's usual price when the printing has none. approx: not the exact printing.
// A foil copy uses the foil price; when there's none, the normal price (marked approximate).
function copyPrice(name, key, foil) {
  const i = foil ? 1 : 0;
  if (key) { const v = PRICES.p[priceId(name, key)]; if (v && v[i] != null) return { v: v[i], approx: !key.split(":")[1] }; }
  const g = PRICES.p[priceId(name)]; if (g && g[i] != null) return { v: g[i], approx: !!key };
  if (foil) { const p = copyPrice(name, key, false); return p && { v: p.v, approx: true }; }
  return null;
}
// Value of a collection entry (all its copies). missing: copies without a price.
function entryValue(c) {
  if (BASIC_SET.has(keyOf(c.name))) return { v: 0, missing: 0, approx: false };   // basic lands: not priced
  let v = 0, missing = 0, approx = false, lo = Infinity, hi = 0;
  for (const cp of copiesOf(c)) {
    const p = copyPrice(c.name, cp.key, cp.foil);
    if (!p) { missing++; continue; }
    v += p.v; approx = approx || p.approx; lo = Math.min(lo, p.v); hi = Math.max(hi, p.v);
  }
  return { v, missing, approx, lo, hi };
}
function valueOf(cards) { let v = 0, missing = 0; for (const c of cards) { const e = entryValue(c); v += e.v; missing += e.missing; } return { v, missing }; }
// One copy's value; a range when copies are different printings with different prices.
const eachText = e => e.lo === Infinity ? "" : e.lo === e.hi ? fmtEur(e.lo) : `${fmtEur(e.lo)}–${fmtEur(e.hi)}`;
// In the list: total, plus each copy's value when there are several ("€0.50 (€0.25 each)").
const priceHTML = (e, qty) => e && e.v > 0 ? `<span class="price inl">${fmtEur(e.v)}${qty > 1 ? ` <span class="each">(${eachText(e)} each)</span>` : ""}</span>` : "";
// Wide screens (landscape): separate Each and Total columns.
const valsHTML = e => `<div class="vals"><span>${e && e.v > 0 ? eachText(e) : "–"}</span><span>${e && e.v > 0 ? fmtEur(e.v) : "–"}</span></div>`;

let pricesBusy = null;
// Fetch prices for every card owned. all: refresh everything (else only cards without a price yet).
function updatePrices(all, extra) {
  if (pricesBusy) return pricesBusy.then(() => updatePrices(all, extra));
  if (!navigator.onLine) return Promise.resolve(false);
  const ids = new Set();
  for (const id of S.order) for (const c of Object.values(S.cols[id].cards)) {
    if (BASIC_SET.has(keyOf(c.name))) continue;
    ids.add(priceId(c.name)); for (const key of Object.keys(c.sets || {})) ids.add(priceId(c.name, key));
  }
  for (const { w } of allWish()) { if (BASIC_SET.has(keyOf(w.name))) continue; ids.add(priceId(w.name)); if (w.set) ids.add(priceId(w.name, w.set)); }
  for (const id of extra || []) ids.add(id);
  const todo = [...ids].filter(id => all || !(id in PRICES.p));
  if (!todo.length) return Promise.resolve(false);
  const ident = id => {
    const bar = id.indexOf("|");
    if (bar < 0) { const [code, num] = id.split(":"); return { set: code.toLowerCase(), collector_number: num }; }
    const name = id.slice(bar + 1), code = id.slice(0, bar).replace(":", "");
    return code ? { name, set: code.toLowerCase() } : { name };
  };
  const num = x => x == null || x === "" ? null : +x;
  pricesBusy = (async () => {
    let got = 0;
    for (let i = 0; i < todo.length; i += 75) {
      const chunk = todo.slice(i, i + 75);
      try {
        const r = await fetch("https://api.scryfall.com/cards/collection", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ identifiers: chunk.map(ident) }) });
        if (!r.ok) continue;
        const data = (await r.json()).data || [];
        for (const id of chunk) {
          const q = ident(id), nk = q.name && keyOf(q.name);
          const card = data.find(c => q.collector_number ? c.set === q.set && c.collector_number === q.collector_number
            : (keyOf(c.name) === nk || (c.card_faces || []).some(f => keyOf(f.name) === nk)) && (!q.set || c.set === q.set));
          const pr = card && card.prices || {};
          PRICES.p[id] = [num(pr.eur), num(pr.eur_foil)];
          if (card) got++;
        }
      } catch (e) { break; }
      await new Promise(res => setTimeout(res, 120));   // Scryfall asks for a short pause between requests
    }
    if (got && (all || !PRICES.at)) PRICES.at = Date.now();
    lsSet("mtg.prices", PRICES);
    return got > 0;
  })().finally(() => { pricesBusy = null; });
  return pricesBusy;
}
// Prices older than a day get refreshed when the collection is opened (online only).
function refreshPricesSoon() {
  const stale = Date.now() - PRICES.at > DAY;
  updatePrices(stale).then(changed => { if (changed) { if (!$("#pane-coll").hidden) renderColl(); if (!$("#pane-wish").hidden) renderWish(); if (!$("#pane-deck").hidden) renderDeck(); if (!$("#pane-set").hidden) renderPriceInfo(); } });
}
function renderPriceInfo() {
  const el = $("#priceStatus"); if (!el) return;
  const all = []; for (const id of S.order) all.push(...Object.values(S.cols[id].cards));
  const t = valueOf(all);
  el.textContent = PRICES.at ? `All collections ≈ ${fmtEur(t.v)}${t.missing ? ` (${t.missing} card${t.missing === 1 ? "" : "s"} without a price)` : ""}. Prices from ${new Date(PRICES.at).toLocaleDateString()}.` : "No prices yet. They load when you're online.";
}

/* ---------- helpers ---------- */
function costHTML(cost) {
  if (!cost) return "";
  const toks = String(cost).match(/\{[^}]+\}|\/\//g) || [];
  return '<span class="cost">' + toks.map(t => {
    if (t === "//") return '<span class="small muted">//</span>';
    const v = t.slice(1, -1).toUpperCase();
    if (/^[WUBRG]$/.test(v)) return `<span class="pip ${v}">${v}</span>`;
    if (v.includes("/")) { const c = v.split("/").find(x => /^[WUBRG]$/.test(x)); return `<span class="pip H ${c || ""}">${esc(v)}</span>`; }
    return `<span class="pip">${esc(v)}</span>`;
  }).join("") + "</span>";
}
function colorsOf(c) { return (c && c.k ? c.k.split("") : []); }
function colorBucket(name) {
  const c = info(name); if (!c) return "C";
  const t = (c.t || "").toLowerCase(); const cols = colorsOf(c);
  if (t.includes("land") && !cols.length) return "L";
  if (cols.length > 1) return "M"; if (cols.length === 1) return cols[0]; return "C";
}
function mainType(t) { return DeckBuilder.mainType(t); }
function totals(scope) { let n = 0, u = 0; for (const c of Object.values(merged(scope || "all"))) { n += c.qty; u++; } return { n, u }; }
// action: optional { label, run } shown as a button (e.g. Undo); the toast then stays a little longer.
function toast(msg, action) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t);
  if (action) { const b = document.createElement("button"); b.className = "toastbtn"; b.textContent = action.label; b.onclick = () => { t.hidden = true; action.run(); }; t.append(" ", b); }
  toast._t = setTimeout(() => t.hidden = true, action ? 7000 : 2600);
}
async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); toast("Copied"); }
  catch (e) { const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Copied"); } catch (_) { toast("Select and copy the text manually"); } ta.remove(); }
}
function suggHTML(list, attr) { return list.map(n => `<button data-${attr}="${esc(n)}">${esc(n)}</button>`).join(""); }

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  ["scan", "coll", "wish", "deck", "set", "rules"].forEach(n => $("#pane-" + n).hidden = n !== name);
  renderColSelects();
  if (name !== "coll") S.sel = null;
  if (name === "coll") renderColl();
  if (name === "deck") renderEngine();
  if (name === "wish") renderWish();
  if (name === "rules") openRules();
  if (name === "set") renderSettings();
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function renderHeader() { const t = totals(); $("#hdrCount").textContent = `${t.n} card${t.n === 1 ? "" : "s"} · ${t.u} unique`; }

/* ---------- collection changes ---------- */
// After cards are added: if some were on a wishlist, offer to take them off (by the number added).
function offerWishTickOff(items) {
  const got = new Map(), lists = new Set();
  for (const it of items) { const on = allWish().filter(({ w }) => keyOf(w.name) === keyOf(it.name)); if (on.length) { got.set(keyOf(it.name), (got.get(keyOf(it.name)) || 0) + (it.qty || 1)); on.forEach(o => lists.add(o.id)); } }
  if (!got.size) return;
  const first = allWish().find(({ w }) => got.has(keyOf(w.name))).w.name;
  const where = lists.size === 1 ? S.wl.lists[[...lists][0]].name : "your wishlists";
  setTimeout(() => toast(`${got.size === 1 ? first + " is" : got.size + " cards are"} on ${where}`, { label: "Tick off", run: () => {
    let n = 0;
    for (const [k, q] of got) { let left = q; for (const { w } of allWish().filter(({ w }) => keyOf(w.name) === k)) { const t = Math.min(left, w.qty); w.qty -= t; left -= t; n += t; } }
    for (const id of S.wl.order) S.wl.lists[id].items = S.wl.lists[id].items.filter(w => w.qty > 0);
    persistWish(); if (!$("#pane-wish").hidden) renderWish(); toast(`Ticked off ${n} from ${where}`);
  } }), 2700);
}
function addToCollection(items, colId) {
  const now = Date.now();
  const byCol = {};
  for (const [i, c] of items.entries()) {
    const name = String(c.name || "").trim(); if (!name) continue;
    const at = now - i;   // keeps the scanned order in "Recently added"
    const id = S.cols[c.col] ? c.col : S.cols[colId] ? colId : S.target;
    const cards = S.cols[id].cards; const k = keyOf(name);
    if (cards[k]) { cards[k].qty += c.qty; cards[k].added = at; }
    else cards[k] = { name, qty: c.qty, added: at };
    addSets(cards[k], c.sets, c.foil);
    byCol[id] = (byCol[id] || 0) + c.qty;
  }
  persist(); renderHeader(); renderColSelects();
  fetchMissingDetails(items.map(i => i.name));
  offerWishTickOff(items);
  updatePrices(false);
}
// Look up cards that aren't in the downloaded list (brand-new sets) on Scryfall, when online.
async function fetchMissingDetails(names) {
  const missing = [...new Set(names)].filter(n => n && !info(n) && !BASIC_SET.has(keyOf(n)));
  if (!missing.length || !navigator.onLine) return;
  for (let i = 0; i < missing.length; i += 70) {
    try {
      const r = await fetch("https://api.scryfall.com/cards/collection", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ identifiers: missing.slice(i, i + 70).map(name => ({ name })) }) });
      if (!r.ok) continue;
      const j = await r.json();
      for (const card of j.data || []) {
        const face = card.card_faces && card.card_faces[0] || card;
        const rec = { n: card.name, c: card.mana_cost ?? face.mana_cost ?? "", v: card.cmc || 0, k: (card.colors || face.colors || []).join(""), t: (card.type_line || "").split(" // ")[0], o: (card.oracle_text ?? face.oracle_text ?? "").replace(/\s*\([^)]*\)/g, "").slice(0, 220) };
        if (face.power != null) rec.p = face.power + "/" + face.toughness;
        extraCards[card.name] = rec;
        // Scryfall may correct the spelling
        const wanted = missing.find(m => keyOf(m) === keyOf(card.name)); if (!wanted) continue;
      }
      lsSet("mtg.extraCards", extraCards);
      await new Promise(r => setTimeout(r, 120));
    } catch (e) { return; }
  }
  if (!$("#pane-coll").hidden) renderColl();
}

/* ---------- SCAN: photos ---------- */
function addPhotos(files) {
  for (const f of files) { if (!f || !/^image\//.test(f.type)) continue; S.photos.push({ file: f, url: URL.createObjectURL(f), rot: null }); }
  renderPhotos();
}
function renderPhotos() {
  const th = $("#thumbs");
  th.innerHTML = S.photos.map((p, i) => `<button class="thumb" data-rot="${i}" aria-label="Rotate photo ${i + 1}"><img src="${p.url}" alt="" style="transform:rotate(${p.rot || 0}deg)"><span>${p.rot == null ? "Auto" : "↻ " + p.rot + "°"}</span></button>`).join("");
  th.hidden = !S.photos.length; $("#scanActions").hidden = !S.photos.length; $("#thumbHint").hidden = !S.photos.length;
  $("#btnIdentify").textContent = S.photos.length > 1 ? `Identify cards in ${S.photos.length} photos` : "Identify cards";
}
$("#thumbs").onclick = e => { const b = e.target.closest("button[data-rot]"); if (!b) return; const p = S.photos[+b.dataset.rot]; p.rot = p.rot == null ? 90 : (p.rot === 270 ? null : p.rot + 90); renderPhotos(); };
$("#camInput").onchange = e => { addPhotos(e.target.files); e.target.value = ""; };
$("#libInput").onchange = e => { addPhotos(e.target.files); e.target.value = ""; };
$("#btnClearPhotos").onclick = () => { S.photos.forEach(p => URL.revokeObjectURL(p.url)); S.photos = []; renderPhotos(); };

/* ---------- SCAN: text reader (Tesseract) ---------- */
let ocrWorkerP = null, ocrStop = false, ocrPct = null;
function loadScript(src) { return new Promise((res, rej) => { if (window.Tesseract) return res(); const s = document.createElement("script"); s.crossOrigin = "anonymous"; const h = sriFor(src); if (h) s.integrity = h; s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load the text reader")); document.head.appendChild(s); }); }
async function blobUrlFor(url, suffix) {
  const r = await fetch(url, { integrity: sriFor(url) }); if (!r.ok) throw new Error("Download failed (" + r.status + ")");
  return URL.createObjectURL(new Blob([await r.text()], { type: "application/javascript" })) + (suffix || "");
}
async function makeWorker(coreFile) {
  // Load the reader's files through the page so the offline cache serves them next time.
  const workerUrl = await blobUrlFor(TESS.worker);
  const coreUrl = await blobUrlFor(TESS.core + coreFile, "#core.wasm.js");
  return Tesseract.createWorker("eng", 1, {
    workerPath: workerUrl, workerBlobURL: false, corePath: coreUrl,
    langPath: new URL(".", location.href).href.replace(/\/$/, ""), gzip: true,
    logger: m => { if (m && m.status === "recognizing text" && ocrPct) ocrPct(m.progress); }
  });
}
function getOcr() {
  if (ocrWorkerP) return ocrWorkerP;
  ocrWorkerP = (async () => {
    await loadScript(TESS.lib);
    let lastErr;
    for (const f of TESS.coreFiles) { try { return await makeWorker(f); } catch (e) { lastErr = e; } }
    throw lastErr;
  })();
  ocrWorkerP.catch(() => { ocrWorkerP = null; });
  return ocrWorkerP;
}
$("#btnStopScan").onclick = () => { ocrStop = true; };
$("#btnIdentify").onclick = async () => {
  $("#scanErr").hidden = true; $("#modeHint").hidden = true; ocrStop = false;
  if (!matcher) { showScanErr("The card list is still loading. Try again in a moment."); return; }
  const st = $("#scanStatusTxt");
  $("#btnIdentify").disabled = true; $("#scanStatus").hidden = false;
  st.textContent = ocrWorkerP ? "Starting the reader…" : "Loading the reader (the first time takes a little while)…";
  const found = new Map(); const leftovers = new Set(); const notes = []; let hint = null; const missing = [];
  try {
    let worker;
    try { worker = await getOcr(); } catch (e) { throw { code: "ocr_load", message: String(e && e.message || e) }; }
    try { await worker.setParameters({ tessedit_pageseg_mode: "11" }); } catch (e) {}
    const scanner = S.scanMode === "grid" ? ScanGrid : ScanStacked;
    // Grid photos show whole cards, so the set can be read too.
    if (S.scanMode === "grid") { st.textContent = "Loading the set list…"; await loadPrints(); }
    for (let i = 0; i < S.photos.length; i++) {
      const lbl = S.photos.length > 1 ? `Photo ${i + 1} of ${S.photos.length}` : (S.scanMode === "grid" ? "Grid" : "Stack");
      // Everything a scanner needs: the reader, the card list, and a way to report progress or stop.
      const ctx = {
        worker, matcher, psm: 11,
        printsOf: PRINTS ? printsOf : null,
        check: () => { if (ocrStop) throw { code: "cancelled" }; },
        status: t => { st.textContent = `${lbl}: ${t}`; },
        progress: p => { st.textContent = `${lbl}: checking the whole photo… ${Math.round(p * 100)}%`; }
      };
      ctx.check();
      const img = await ScanCore.loadImg(S.photos[i].file);
      const manual = S.photos[i].rot;
      ctx.status("finding which way the names run…");
      const deg = manual != null ? manual : await ScanCore.findTextDirection(ctx, img);
      const upright = deg ? ScanCore.rotated(img, deg) : img;
      const res = await scanner.scan(ctx, upright);
      if (res.grid && !res.hint) {
        // A grid should have a card in every square: say how many were read, and list the rest for a check.
        const miss = (res.missing || []).length, all = res.grid.cells || res.grid.rows * res.grid.cols;
        notes.push(`${S.photos.length > 1 ? `Photo ${i + 1}: ` : ""}found a grid of ${res.grid.rows} × ${res.grid.cols}` + (miss ? ` — read ${all - miss} of ${all} cards; ${miss === 1 ? "1 square needs" : miss + " squares need"} your check (marked missing below).` : ` — all ${all} cards read.`));
        for (const m of res.missing || []) missing.push({ ...m, photo: S.photos.length > 1 ? i + 1 : 0 });
      }
      if (res.hint) hint = res.hint;
      for (const c of res.cards) {
        let f = found.get(c.name);
        if (f) { f.qty += c.qty; f.score = Math.min(f.score, c.score); } else found.set(c.name, f = { name: c.name, qty: c.qty, score: c.score });
        addSets(f, c.sets);
      }
      res.leftovers.forEach(l => leftovers.add(l));
    }
    S.review = [...found.values()].map(c => ({ name: c.name, qty: c.qty, low: c.score < 0.95, sets: c.sets }));
    // Squares where no card could be read: an empty entry with a picture of the square, to name by hand (or remove).
    for (const m of missing) S.review.push({ name: "", qty: 1, low: true, missing: m });
    S.leftovers = [...leftovers];
    $("#scanNote").textContent = notes.join(" "); $("#scanNote").hidden = !notes.length;
    // The photo looks like the other layout: offer to scan it again that way.
    $("#modeHint").hidden = !hint;
    if (hint) {
      $("#modeHintTxt").textContent = hint === "grid" ? "This photo looks like cards side by side in a grid." : "This photo looks like a stack of cards.";
      $("#btnSwitchMode").textContent = hint === "grid" ? "Scan again as Grid" : "Scan again as Stacked";
      $("#btnSwitchMode").onclick = () => { S.scanMode = hint; lsSet("mtg.scanMode", hint); renderScanMode(); $("#modeHint").hidden = true; S.review = []; S.leftovers = []; renderReview(); $("#btnIdentify").click(); };
    }
    if (!S.review.length) showScanErr(S.leftovers.length ? "No card names matched. Check the unmatched text below, or retake the photo closer and sharper." : "No names could be read. Check the layout setting, keep the names in focus, and avoid glare.");
    renderReview(true);
  } catch (e) {
    if (e && e.code === "cancelled") {}
    else if (e && e.code === "ocr_load") showScanErr(navigator.onLine ? `The reader couldn't start (${e.message}). Close and reopen the app, then try again.` : "The reader needs internet the first time. Connect once, then it works offline.");
    else if (e && e.code === "badimg") showScanErr("That photo couldn't be opened. Try taking it again.");
    else showScanErr("Something went wrong while reading. Try again. (" + esc(e && e.message || e) + ")");
  } finally { $("#btnIdentify").disabled = false; $("#scanStatus").hidden = true; ocrPct = null; }
};

/* ---------- SCAN: layout picker ---------- */
function renderScanMode() {
  document.querySelectorAll("#modeSeg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === S.scanMode)));
  $("#tipsStacked").hidden = S.scanMode !== "stacked"; $("#tipsGrid").hidden = S.scanMode !== "grid";
}
$("#modeSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.scanMode = b.dataset.mode; lsSet("mtg.scanMode", S.scanMode); renderScanMode(); };
function showScanErr(msg) { $("#scanErr").textContent = msg; $("#scanErr").hidden = false; }

/* ---------- SCAN: review ---------- */
function renderReview(scroll) {
  const box = $("#reviewBox"); box.hidden = !S.review.length && !S.leftovers.length;
  const n = S.review.reduce((a, c) => a + c.qty, 0);
  $("#reviewCount").textContent = `${n} card${n === 1 ? "" : "s"}, ${S.review.length} unique`;
  $("#reviewList").innerHTML = S.review.length ? S.review.map((c, i) => {
    const known = matcher && matcher.isCard(c.name);
    const sug = !known && matcher && c.name.trim() ? matcher.suggest(c.name, 3) : [];
    const ci = info(c.name);
    const ms = c.missing;
    return `<div class="crow rv${ms ? " missing" : ""}">${ms ? `<div class="mthumb">${ms.thumb ? `<img src="${ms.thumb}" alt="The unread card">` : ""}<span class="small"><span class="badge bad">missing</span> ${ms.photo ? `Photo ${ms.photo}, ` : ""}row ${ms.row + 1}, column ${ms.col + 1}: no card name could be read here. Type it, or remove this if the square is empty.</span></div>` : ""}
      <input class="nm-edit" type="text" id="rv-${i}" data-i="${i}" value="${esc(c.name)}" aria-label="Card name" autocomplete="off"${ms ? ' placeholder="Type this card\'s name"' : ""}>
      <div class="meta">${ci ? costHTML(ci.c) + `<span>${esc(ci.t)}</span>` : ""}${setChips(c.sets)}${foilChip(c)}${ms && !c.name.trim() ? "" : !known ? '<span class="badge bad">unknown</span>' : c.low ? '<span class="badge low">check</span>' : ""}${c.col && c.col !== S.target ? `<span class="badge ex">→ ${esc(colName(c.col))}</span>` : ""}<button class="ghost small" data-rm="${i}">Remove</button></div>
      <div class="ctl stepper"><button data-dec="${i}" aria-label="Fewer">−</button><span>${c.qty}</span><button data-inc="${i}" aria-label="More">+</button></div>
      ${sug.length ? `<div class="sugg"><span class="small muted">Did you mean</span>${sug.map(s => `<button data-fix="${i}" data-name="${esc(s)}">${esc(s)}</button>`).join("")}</div>` : ""}
    </div>`;
  }).join("") : `<div class="crow"><span class="muted small">No cards yet. Pick from the unmatched text below, or retake the photo.</span></div>`;
  $("#leftBox").hidden = !S.leftovers.length; $("#leftCount").textContent = S.leftovers.length;
  $("#leftList").innerHTML = S.leftovers.map((l, i) => {
    const sug = matcher ? matcher.suggest(l, 3) : [];
    return `<div class="stack" style="gap:6px"><span class="small"><span class="muted">Read:</span> “${esc(l)}”</span><div class="sugg">${sug.map(s => `<button data-take="${i}" data-name="${esc(s)}">+ ${esc(s)}</button>`).join("")}<button class="ghost" data-skip="${i}">Ignore</button></div></div>`;
  }).join("");
  $("#btnAskClaudeLeft").hidden = !apiKey() || !S.leftovers.length;
  if (scroll && !box.hidden) box.scrollIntoView({ behavior: "smooth", block: "start" });
}
let reviewEditTimer = null;
$("#reviewList").addEventListener("input", e => {
  const i = e.target.dataset.i; if (i == null) return;
  S.review[i].name = e.target.value; S.review[i].low = false; delete S.review[i].sets;
  clearTimeout(reviewEditTimer);
  reviewEditTimer = setTimeout(() => { const pos = e.target.selectionStart; renderReview(); const el = $("#rv-" + i); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (_) {} } }, 700);
});
$("#reviewList").addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.inc != null) S.review[t.dataset.inc].qty++;
  else if (t.dataset.dec != null) { const c = S.review[t.dataset.dec]; c.qty = Math.max(1, c.qty - 1); tidySets(c); }
  else if (t.dataset.rm != null) S.review.splice(+t.dataset.rm, 1);
  else if (t.dataset.fix != null) { S.review[t.dataset.fix].name = t.dataset.name; S.review[t.dataset.fix].low = false; delete S.review[t.dataset.fix].sets; }
  else return;
  renderReview();
});
$("#leftList").addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.take != null) { const ex = S.review.find(r => r.name === t.dataset.name); if (ex) ex.qty++; else S.review.push({ name: t.dataset.name, qty: 1, low: false }); S.leftovers.splice(+t.dataset.take, 1); }
  else if (t.dataset.skip != null) S.leftovers.splice(+t.dataset.skip, 1);
  else return;
  renderReview();
});
$("#btnDiscard").onclick = () => { S.review = []; S.leftovers = []; renderReview(); };
$("#btnAddReviewed").onclick = () => {
  // Missing squares need a decision first: name the card, or remove the entry if the square is empty.
  const unnamed = S.review.findIndex(c => c.missing && !c.name.trim());
  if (unnamed >= 0) { toast("Name the missing card, or remove it if that square is empty"); const el = $("#rv-" + unnamed); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.focus(); } return; }
  const items = S.review.filter(c => c.name.trim()).map(c => ({ name: (matcher && matcher.canonical(c.name)) || c.name.trim(), qty: c.qty, col: c.col, sets: c.sets, foil: c.foil }));
  if (!items.length) return;
  addToCollection(items, S.target);
  const multi = items.some(i => i.col && i.col !== S.target);
  S.review = []; S.leftovers = []; renderReview();
  S.photos.forEach(p => URL.revokeObjectURL(p.url)); S.photos = []; renderPhotos();
  const n = items.reduce((a, c) => a + c.qty, 0);
  toast(`Added ${n} card${n === 1 ? "" : "s"} to ${multi ? "your collections" : colName(S.target)}`);
};
$("#btnAskClaudeLeft").onclick = async () => {
  const b = $("#btnAskClaudeLeft"); b.disabled = true; b.textContent = "Asking Claude…";
  try {
    const res = await askClaudeJSON(`These lines were read by OCR from the name bars of stacked Magic: The Gathering cards, but didn't match my card list (it may be missing very new sets). For each line that is really a card name, give the exact official English card name. Skip lines that are just noise.\nReply with ONLY a JSON array of strings.\n\n${S.leftovers.map(l => "- " + l).join("\n")}`, 800, true);
    let added = 0;
    for (const n of Array.isArray(res) ? res : []) { if (typeof n !== "string" || !n.trim()) continue; const name = (matcher && matcher.canonical(n)) || n.trim(); const ex = S.review.find(r => keyOf(r.name) === keyOf(name)); if (ex) ex.qty++; else S.review.push({ name, qty: 1, low: true }); added++; }
    S.leftovers = []; renderReview(); toast(added ? `Claude found ${added} more` : "Claude didn't find any card names there");
  } catch (e) { toast(claudeErr(e)); }
  finally { b.disabled = false; b.textContent = "Ask Claude about this text"; }
};

/* ---------- SCAN: manual + paste ---------- */
let mQty = 1;
$("#mMinus").onclick = () => { mQty = Math.max(1, mQty - 1); $("#mQty").textContent = mQty; };
$("#mPlus").onclick = () => { mQty++; $("#mQty").textContent = mQty; };
$("#manualName").addEventListener("input", () => {
  const v = $("#manualName").value; $("#manualSugg").innerHTML = matcher && v.trim().length >= 2 ? suggHTML(matcher.suggest(v, 5), "pick") : "";
});
$("#manualSugg").onclick = e => { const b = e.target.closest("button[data-pick]"); if (!b) return; $("#manualName").value = b.dataset.pick; $("#manualSugg").innerHTML = ""; };
$("#btnManualAdd").onclick = () => {
  const raw = $("#manualName").value.trim(); if (!raw) return;
  const name = (matcher && (matcher.canonical(raw) || (matcher.matchLine(raw) || {}).name)) || raw;
  addToCollection([{ name, qty: mQty }], S.target);
  toast(`Added ${mQty} × ${name} to ${colName(S.target)}${matcher && !matcher.isCard(name) ? " (not in the card list)" : ""}`);
  $("#manualName").value = ""; $("#manualSugg").innerHTML = ""; mQty = 1; $("#mQty").textContent = 1;
};
$("#manualName").addEventListener("keydown", e => { if (e.key === "Enter") $("#btnManualAdd").click(); });
$("#btnPasteAdd").onclick = () => {
  const text = $("#pasteList").value; if (!text.trim()) return;
  const items = []; let col = null, toWish = false; const wished = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    const h = /^#+\s*collection:\s*(.+)$/i.exec(line);
    if (h) { col = newCollection(h[1]); toWish = false; continue; }
    const wh = /^#+\s*wish\s*list(?:\s*:\s*(.+))?\s*$/i.exec(line);
    if (wh) { toWish = newWishList((wh[1] || "My wishlist").trim().slice(0, 40)); continue; }
    if (!line || line.startsWith("#") || /^(deck|sideboard|commander|companion|maybeboard|about|name .*)$/i.test(line)) continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    let qty = 1, name = line; if (m) { qty = parseInt(m[1], 10) || 1; name = m[2]; }
    // "Name (SOS) 178" keeps the printing.
    const pm = name.match(/\s*\(([A-Za-z0-9]{2,6})\)\s*([^\s*]*)\s*(\*F\*)?$/);
    const sets = pm ? { [pm[1].toUpperCase() + ":" + (pm[2] || "")]: qty } : undefined;
    // "*F*" at the end marks foil copies (the usual deck-list style).
    const isFoil = /\*F\*\s*$/i.test(name);
    const foil = isFoil ? { [sets ? Object.keys(sets)[0] : ""]: qty } : undefined;
    name = name.replace(/\s*\*F\*\s*$/i, "");
    name = name.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/\s*\([A-Za-z0-9]{2,6}\)\s*\S*\s*(\*F\*)?$/, "").replace(/^[-•*]\s*/, "").trim();
    if (!name) continue;
    const can = matcher && (matcher.canonical(name) || (matcher.matchLine(name) || {}).name);
    if (toWish) { wished.push({ name: can || name, qty, set: sets ? Object.keys(sets)[0] : "", foil: !!foil, list: toWish }); continue; }
    items.push({ name: can || name, qty, low: !can || keyOf(can) !== keyOf(name), col: col || undefined, sets, foil });
  }
  if (wished.length) { const keep = S.wl.cur; for (const w of wished.reverse()) { S.wl.cur = w.list; addToWish(w.name, w.qty, w.set, w.foil); } S.wl.cur = keep; persistWish(); toast(`Restored ${wished.length} wishlist entr${wished.length === 1 ? "y" : "ies"}`); }
  if (!items.length) { $("#pasteList").value = ""; return; }
  for (const it of items) { const ex = S.review.find(r => r.name === it.name && r.col === it.col); if (ex) { ex.qty += it.qty; addSets(ex, it.sets, it.foil); } else S.review.push(it); }
  $("#pasteList").value = "";
  renderReview(true);
};

$("#targetSel").onchange = e => { S.target = e.target.value; persist(); renderColSelects(); renderReview(); toast("Now saving to " + colName(S.target)); };
$("#btnNewTarget").onclick = () => { $("#newTargetBox").hidden = false; $("#newTargetName").focus(); };
$("#btnCancelTarget").onclick = () => { $("#newTargetBox").hidden = true; $("#newTargetName").value = ""; };
$("#btnCreateTarget").onclick = () => {
  const id = newCollection($("#newTargetName").value); if (!id) { $("#newTargetName").focus(); return; }
  S.target = id; persist(); renderColSelects(); renderReview();
  $("#newTargetBox").hidden = true; $("#newTargetName").value = ""; toast("Now saving to " + colName(id));
};
$("#newTargetName").addEventListener("keydown", e => { if (e.key === "Enter") $("#btnCreateTarget").click(); });

/* ---------- COLLECTION ---------- */
const FILTERS = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["M", "Multi"], ["C", "Colorless"], ["L", "Lands"]];
$("#colorFilter").innerHTML = FILTERS.map(([k, l]) => `<button class="chip" aria-pressed="false" data-f="${k}">${/[WUBRG]/.test(k) ? `<span class="pip ${k}">${k}</span>` : ""}${l}</button>`).join("");
$("#colorFilter").onclick = e => { const b = e.target.closest("button"); if (!b) return; const k = b.dataset.f; S.filter.has(k) ? S.filter.delete(k) : S.filter.add(k); b.setAttribute("aria-pressed", String(S.filter.has(k))); renderColl(); };
$("#collSearch").oninput = () => renderColl();
$("#collSort").onchange = () => renderColl();
function renderColl() {
  renderColSelects();
  const body = $("#collBody"); const view = S.view; const all = Object.entries(merged(view));
  const t = totals(view); const val = valueOf(Object.values(merged(view)));
  $("#collSummary").textContent = `${t.n} cards · ${t.u} unique` + (val.v > 0 ? ` · ≈ ${fmtEur(val.v)}` : "");
  refreshPricesSoon();
  renderManage();
  if (!all.length) {
    // Nothing left to select: leave select mode so its bar goes away.
    S.sel = null; S.shown = []; body.classList.remove("selecting"); renderSelBar();
    body.innerHTML = view === "all" && !totals().n ? `<div class="empty"><h2>No cards yet</h2>
      <ol><li>On <b>Scan</b>, pick or create the collection to save to.</li><li>Photograph a stack of cards, check the names, then add them.</li><li>Open <b>Deck</b> to build from what you own.</li></ol>
      <div class="row"><button class="primary" id="goScan">Scan cards</button></div></div>`
      : `<div class="empty"><h2>${esc(colName(view))} is empty</h2><p class="muted">Choose it under <b>Saving to</b> on the Scan tab, then scan or type cards in.</p><div class="row"><button class="primary" id="goScan">Scan into ${esc(colName(view))}</button></div></div>`;
    $("#goScan").onclick = () => { if (view !== "all") { S.target = view; persist(); renderColSelects(); } showTab("scan"); }; return;
  }
  const q = keyOf($("#collSearch").value); const sort = $("#collSort").value;
  let rows = all.filter(([k, c]) => { const ci = info(c.name) || {}; return (!q || k.includes(q) || (q === "foil" && foilTotal(c) > 0) || (ci.t || "").toLowerCase().includes(q) || (ci.o || "").toLowerCase().includes(q)) && (!S.filter.size || S.filter.has(colorBucket(c.name))); });
  const mv = c => (info(c.name) || {}).v || 0;
  // "each": the most valuable single copy (then the total); "value": all copies together.
  const vals = new Map(rows.map(([k, c]) => { const e = entryValue(c); return [k, { each: e.lo === Infinity ? 0 : e.hi, total: e.v }]; }));
  const byEach = (a, b) => (vals.get(b[0]).each - vals.get(a[0]).each) || (vals.get(b[0]).total - vals.get(a[0]).total) || a[0].localeCompare(b[0]);
  const byTotal = (a, b) => (vals.get(b[0]).total - vals.get(a[0]).total) || (vals.get(b[0]).each - vals.get(a[0]).each) || a[0].localeCompare(b[0]);
  rows.sort((a, b) => sort === "each" ? byEach(a, b) : sort === "value" ? byTotal(a, b) : sort === "cmc" ? (mv(a[1]) - mv(b[1])) || a[0].localeCompare(b[0]) : sort === "qty" ? (b[1].qty - a[1].qty) || a[0].localeCompare(b[0]) : sort === "added" ? (b[1].added || 0) - (a[1].added || 0) : a[0].localeCompare(b[0]));
  const single = view !== "all";
  const sel = S.sel;
  if (sel) { const have = new Set(all.map(([k]) => k)); for (const k of [...sel]) if (!have.has(k)) sel.delete(k); }
  S.shown = rows.map(([k]) => k);
  body.classList.toggle("selecting", !!sel);
  body.innerHTML = rows.length ? `<div class="list"><div class="crow lhead" aria-hidden="true"><span>Card</span><div class="vals"><span>Each</span><span>Total</span></div><span class="ctl">Copies</span></div>${rows.map(([k, c]) => { const ci = info(c.name); const ids = Object.keys(c.where); const on = sel && sel.has(k); const ev = entryValue(c); return `
    <div class="crow${on ? " picked" : ""}">
      <button class="nm" data-open="${esc(k)}"${sel ? ` aria-pressed="${on}"` : ""}>${sel ? `<span class="tick" aria-hidden="true">${on ? "✓" : ""}</span>` : ""}${esc(c.name)}</button>
      <div class="meta">${ci ? costHTML(ci.c) + `<span>${esc(ci.t)}</span>` : '<span class="badge bad">not in card list</span>'}${priceHTML(ev, c.qty)}${setChips(Object.keys(c.sets || {}).length ? c.sets : null)}${foilChip(c)}${!single && S.order.length > 1 ? `<span>· ${ids.map(id => esc(colName(id))).join(", ")}</span>` : ""}</div>
      ${valsHTML(ev)}
      ${sel ? `<div class="ctl"><span class="badge" style="font-size:.85rem">×${c.qty}</span></div>` : single ? `<div class="ctl stepper"><button data-cdec="${esc(k)}" aria-label="Fewer ${esc(c.name)}">−</button><span>${c.qty}</span><button data-cinc="${esc(k)}" aria-label="More ${esc(c.name)}">+</button></div>`
        : `<div class="ctl"><span class="badge" style="font-size:.85rem">×${c.qty}</span></div>`}
    </div>`; }).join("")}</div>` : `<p class="muted">No cards match.</p>`;
  renderSelBar();
}
/* ---------- selecting cards to delete ---------- */
function renderSelBar() {
  const sel = S.sel, bar = $("#selBar");
  $("#btnSelect").textContent = sel ? "Done" : "Select";
  bar.hidden = !sel; $("#selConfirm").hidden = true;
  if (!sel) return;
  const n = sel.size; $("#selCount").textContent = `${n} selected`;
  $("#btnSelDel").disabled = !n; $("#btnSelAll").disabled = !S.shown.length;
  const allOn = S.shown.length && S.shown.every(k => sel.has(k));
  $("#btnSelAll").textContent = allOn ? "Select none" : "Select all";
}
$("#btnSelect").onclick = () => { S.sel = S.sel ? null : new Set(); renderColl(); };
$("#btnSelAll").onclick = () => {
  const allOn = S.shown.every(k => S.sel.has(k));
  for (const k of S.shown) allOn ? S.sel.delete(k) : S.sel.add(k);
  renderColl();
};
$("#btnSelDel").onclick = () => {
  const view = S.view, m = merged(view); let copies = 0; for (const k of S.sel) copies += (m[k] || {}).qty || 0;
  const n = S.sel.size;
  $("#selMsg").textContent = `Delete ${n === 1 ? (m[[...S.sel][0]] || {}).name || "1 card" : n + " cards"} (${copies} cop${copies === 1 ? "y" : "ies"}) from ${view === "all" ? (S.order.length > 1 ? "every collection" : colName(S.order[0])) : colName(view)}?`;
  $("#selConfirm").hidden = false;
};
$("#selNo").onclick = () => { $("#selConfirm").hidden = true; };
$("#selYes").onclick = () => {
  if (!S.sel || !S.sel.size) { renderSelBar(); return; }
  const before = JSON.stringify(S.cols), ids = S.view === "all" ? S.order : [S.view];
  let copies = 0; for (const id of ids) for (const k of S.sel) { const c = S.cols[id].cards[k]; if (c) { copies += c.qty; delete S.cols[id].cards[k]; } }
  const n = S.sel.size; S.sel = new Set();
  persist(); renderHeader(); renderColl();
  toast(`Deleted ${n} card${n === 1 ? "" : "s"} (${copies} cop${copies === 1 ? "y" : "ies"})`, { label: "Undo", run: () => { S.cols = JSON.parse(before); persist(); renderHeader(); renderColl(); toast("Restored"); } });
};
$("#collBody").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.open) {
    if (S.sel) { const k = b.dataset.open; S.sel.has(k) ? S.sel.delete(k) : S.sel.add(k); renderColl(); return; }
    openCard(b.dataset.open); return;
  }
  const k = b.dataset.cinc ?? b.dataset.cdec; const col = S.cols[S.view]; if (k == null || !col || !col.cards[k]) return;
  if (b.dataset.cinc != null) col.cards[k].qty++; else { col.cards[k].qty--; if (col.cards[k].qty <= 0) delete col.cards[k]; else tidySets(col.cards[k]); }
  persist(); renderHeader(); renderColl();
});
// Text backup: one "# Collection:" header per collection, so pasting it back recreates them.
// withSets: copies with a known printing get their own "2 Name (SOS) 178" line (the usual deck-list style), so a restore keeps them.
function collText(scope, withSets) {
  const lines = c => {
    if (!withSets || (!c.sets && !c.foil)) return [`${c.qty} ${c.name}`];
    // One line per printing and finish: "2 Name (SOS) 178", "1 Name (SOS) 178 *F*".
    const groups = new Map();
    for (const cp of copiesOf(c)) { const g = cp.key + "|" + (cp.foil ? 1 : 0); groups.set(g, (groups.get(g) || 0) + 1); }
    return [...groups].map(([g, n]) => { const [key, fo] = g.split("|"); const [code, num] = key.split(":");
      return `${n} ${c.name}${code ? ` (${code})${num ? " " + num : ""}` : ""}${fo === "1" ? " *F*" : ""}`; });
  };
  return (scope === "all" ? S.order : [scope]).filter(id => Object.keys(S.cols[id].cards).length).map(id =>
    `# Collection: ${S.cols[id].name}\n` + Object.values(S.cols[id].cards).sort((a, b) => a.name.localeCompare(b.name)).flatMap(lines).join("\n")).join("\n\n");
}
$("#btnCopyColl").onclick = () => copyText(collText(S.view));

/* ---------- managing collections ---------- */
$("#viewSel").onchange = e => { S.view = e.target.value; if (S.sel) S.sel = new Set(); persist(); $("#delColConfirm").hidden = true; renderColl(); };
$("#btnManageCol").onclick = () => { $("#manageBox").hidden = !$("#manageBox").hidden; renderManage(); };
function renderManage() {
  const single = S.view !== "all";
  $("#editColBox").hidden = !single; $("#manageAllHint").hidden = single;
  if (single) {
    $("#renameCol").value = colName(S.view);
    const others = S.order.filter(id => id !== S.view);
    $("#mergeSel").innerHTML = others.map(id => `<option value="${id}">${esc(S.cols[id].name)}</option>`).join("");
    $("#mergeSel").parentElement.hidden = !others.length;
    $("#btnDeleteCol").hidden = S.order.length < 2;
  }
}
$("#btnCreateCol").onclick = () => { const id = newCollection($("#newColName").value); if (!id) { $("#newColName").focus(); return; } $("#newColName").value = ""; S.view = id; persist(); renderColl(); toast("Created " + colName(id)); };
$("#newColName").addEventListener("keydown", e => { if (e.key === "Enter") $("#btnCreateCol").click(); });
$("#btnRenameCol").onclick = () => { const v = $("#renameCol").value.trim().slice(0, 40); if (!v || !S.cols[S.view]) return; S.cols[S.view].name = v; persist(); renderColl(); toast("Renamed"); };
$("#btnMergeCol").onclick = () => {
  const from = S.cols[S.view], toId = $("#mergeSel").value, to = S.cols[toId]; if (!from || !to) return;
  for (const [k, c] of Object.entries(from.cards)) { if (to.cards[k]) { to.cards[k].qty += c.qty; addSets(to.cards[k], c.sets, c.foil); } else to.cards[k] = { ...c, sets: c.sets ? { ...c.sets } : undefined, foil: c.foil ? { ...c.foil } : undefined }; tidySets(to.cards[k]); }
  const n = colCount(S.view); from.cards = {}; persist(); toast(`Moved ${n} card${n === 1 ? "" : "s"} to ${to.name}`); renderColl();
};
$("#btnDeleteCol").onclick = () => { const n = colCount(S.view); $("#delColMsg").textContent = `Delete "${colName(S.view)}"` + (n ? ` and the ${n} card${n === 1 ? "" : "s"} in it? To keep the cards, move them into another collection first.` : "?"); $("#delColConfirm").hidden = false; };
$("#noDelCol").onclick = () => $("#delColConfirm").hidden = true;
$("#yesDelCol").onclick = () => {
  if (S.order.length < 2) return; const id = S.view, name = colName(id);
  delete S.cols[id]; S.order = S.order.filter(x => x !== id); S.view = "all";
  $("#delColConfirm").hidden = true; persist(); renderHeader(); renderColl(); toast("Deleted " + name);
};

/* ---------- card sheet (details, copies per collection, rename, remove) ---------- */
function openCard(k) {
  const c = merged("all")[k]; if (!c) return;
  const ci = info(c.name);
  const imgOf = key => {
    const [code, num] = (key || "").split(":");
    if (code && num) return `https://api.scryfall.com/cards/${encodeURIComponent(code.toLowerCase())}/${encodeURIComponent(num)}?format=image&version=normal`;
    return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.name)}${code ? "&set=" + encodeURIComponent(code.toLowerCase()) : ""}&format=image&version=normal`;
  };
  const qty = {}, copies = {};
  // One entry per copy: { key: its printing ("SOS:178") or "" when no set is recorded, foil }.
  for (const id of S.order) { const e = S.cols[id].cards[k]; qty[id] = e ? e.qty : 0; copies[id] = e ? copiesOf(e) : []; }
  const firstSet = () => { for (const id of S.order) { const x = copies[id].find(cp => cp.key); if (x) return x.key; } return ""; };
  const setOpts = cur => {
    const list = printsOf(c.name), keys = list.map(p => p.code + ":" + p.num);
    if (cur && !keys.includes(cur)) keys.unshift(cur);
    return `<option value="">Set not recorded</option>` + keys.map(key => `<option value="${esc(key)}"${key === cur ? " selected" : ""}>${esc(printLabel(key, true))}${key.endsWith(":") ? " (number unknown)" : ""}</option>`).join("");
  };
  const whereHTML = () => S.order.map(id => `<div class="wrow"><span>${esc(S.cols[id].name)}</span><div class="stepper"><button data-wdec="${id}" aria-label="Fewer in ${esc(S.cols[id].name)}">−</button><span>${qty[id]}</span><button data-winc="${id}" aria-label="More in ${esc(S.cols[id].name)}">+</button></div></div>` +
    (qty[id] ? `<div class="sets">${copies[id].map((cp, i) => { const p = copyPrice(c.name, cp.key, cp.foil);
      return `<div class="setrow"><span class="small muted">${qty[id] > 1 ? "Copy " + (i + 1) : "Set"}</span><select data-scol="${id}" data-si="${i}" aria-label="Set of copy ${i + 1} in ${esc(S.cols[id].name)}">${setOpts(cp.key)}</select><button class="foilbtn" data-fcol="${id}" data-fi="${i}" aria-pressed="${cp.foil}" aria-label="Copy ${i + 1} is foil">✦ Foil</button><span class="price">${p ? (p.approx ? "≈" : "") + fmtEur(p.v) : "–"}</span></div>`; }).join("")}</div>` : "")).join("");
  // Price line: the shown printing's price and foil price.
  const priceLine = () => {
    const key = firstSet(), v = PRICES.p[priceId(c.name, key)], g = PRICES.p[priceId(c.name)];
    const pr = v && v[0] != null ? v : g; if (!pr || (pr[0] == null && pr[1] == null)) return pr || v ? "No price on Cardmarket" : navigator.onLine ? "Price loading…" : "No price saved yet";
    return `Price${pr === v && key ? " (" + esc(printLabel(key)) + ")" : ""}: <b>${pr[0] != null ? fmtEur(pr[0]) : "–"}</b>${pr[1] != null ? ` · foil ${fmtEur(pr[1])}` : ""} <span class="muted">· Cardmarket via Scryfall${PRICES.at ? ", " + new Date(PRICES.at).toLocaleDateString() : ""}</span>`;
  };
  const img = imgOf(firstSet());
  $("#sheet").innerHTML = `<div class="grab"></div>
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2 style="min-width:0">${esc(c.name)}</h2><button class="ghost" id="shClose" aria-label="Close">✕</button></div>
    <div class="cardimg" id="shImg">${navigator.onLine ? `<img src="${img}" alt="${esc(c.name)}" loading="lazy">` : "Picture needs internet"}</div>
    ${ci ? `<div class="stack" style="gap:6px"><div class="row">${costHTML(ci.c)}<span class="small muted">mana value ${ci.v}</span></div><b>${esc(ci.t)}${ci.p ? " · " + esc(ci.p) : ""}${ci.l ? " · loyalty " + esc(ci.l) : ""}</b>${ci.o ? `<p class="oracle">${esc(ci.o)}</p>` : ""}</div>` : `<p class="note">This name isn't in the card list. If it's misspelled, rename it below.</p>`}
    <p class="small" id="shPrice">${priceLine()}</p>
    <div class="stack" style="gap:6px"><h3>Copies and sets</h3><div class="where" id="shWhere">${whereHTML()}</div><p class="small muted">To move a copy, take it out of one collection and add it to another. Pick a set to record which printing a copy is, and tap ✦ Foil for foil copies.</p><button class="ghost small" id="shMorePrints" hidden>Look for more printings online</button></div>
    <label class="field">Rename / correct this card<input type="text" id="shName" value="${esc(c.name)}" autocomplete="off" autocapitalize="words"></label>
    <div class="sugg" id="shSugg"></div>
    <div class="row"><button class="primary" id="shSave" style="flex:1">Save</button><button class="ghost danger" id="shDel">Remove everywhere</button></div>
    <div class="panel" id="shDelConfirm" hidden><p>Remove all ${c.qty} cop${c.qty === 1 ? "y" : "ies"} of ${esc(c.name)} from every collection?</p><div class="row"><button class="primary" id="shYes">Remove</button><button id="shNo">Keep</button></div></div>
    <details class="stack" id="shRulings"><summary><b>Official rulings</b> <span class="small muted">(Wizards of the Coast, via Scryfall)</span></summary><div id="shRulingsBody" class="small muted" style="margin-top:6px">Loading…</div></details>
    <div class="row"><button class="wishbtn" id="shWish">♡ Add to wishlist</button><a class="small" href="https://scryfall.com/search?q=${encodeURIComponent('!"' + c.name + '"')}" target="_blank" rel="noopener">Open on Scryfall</a></div>`;
  $("#sheetBg").hidden = false;
  // Official rulings for this card (loaded when opened; needs internet).
  $("#shRulings").addEventListener("toggle", () => { if ($("#shRulings").open) loadRulings(c.name).then(html => { if ($("#shRulingsBody")) $("#shRulingsBody").innerHTML = html; }); });
  // Adds to the wishlist shown on the Wishlist tab; says which lists the card is already on.
  const wishLabel = () => { const on = wishListsWith(c.name), cur = S.wl.lists[S.wl.cur].name;
    $("#shWish").textContent = on.length ? `♥ On ${on.join(", ")}${on.includes(cur) ? " · add another" : ` · add to ${cur}`}` : `♡ Add to ${cur}`;
    $("#shWish").setAttribute("aria-pressed", String(on.length > 0)); };
  wishLabel();
  $("#shWish").onclick = () => { addToWish(c.name, 1); wishLabel(); toast(`Added ${c.name} to ${S.wl.lists[S.wl.cur].name}`); };
  const showImg = key => {
    const box = $("#shImg"); if (!box || !navigator.onLine) return;
    box.innerHTML = `<img src="${imgOf(key)}" alt="${esc(c.name)}" loading="lazy">`;
    // A printing Scryfall doesn't know by number: fall back to the card's usual picture.
    box.querySelector("img").onerror = function () { if (key) showImg(""); else box.textContent = "No picture available"; };
  };
  showImg(firstSet());
  const morePrints = $("#shMorePrints");
  const refreshSets = () => { if (!$("#shWhere")) return; $("#shWhere").innerHTML = whereHTML(); $("#shPrice").innerHTML = priceLine(); };
  // Fetch prices for the printings on screen that don't have one yet.
  const loadSheetPrices = () => { const ids = [priceId(c.name)]; for (const id of S.order) for (const cp of copies[id]) if (cp.key) ids.push(priceId(c.name, cp.key)); updatePrices(false, ids).then(ch => { if (ch) refreshSets(); }); };
  loadSheetPrices();
  morePrints.hidden = !navigator.onLine;
  morePrints.onclick = async () => { morePrints.disabled = true; morePrints.textContent = "Looking…"; const got = await fetchPrintsOnline(c.name); refreshSets(); morePrints.textContent = got ? "More printings added" : "No more printings found"; };
  // The full printings list loads on first use.
  loadPrints().then(() => { if ($("#shWhere")) refreshSets(); if (!printsOf(c.name).length) fetchPrintsOnline(c.name).then(got => { if (got && $("#shWhere")) refreshSets(); }); });
  $("#shWhere").onchange = e => { const t = e.target; if (t.dataset.scol == null) return; copies[t.dataset.scol][+t.dataset.si].key = t.value; showImg(t.value || firstSet()); refreshSets(); loadSheetPrices(); };
  $("#shClose").onclick = closeSheet;
  $("#shWhere").onclick = e => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.winc) { qty[b.dataset.winc]++; copies[b.dataset.winc].push({ key: "", foil: false }); }
    else if (b.dataset.wdec) {
      const id = b.dataset.wdec; if (!qty[id]) return; qty[id]--;
      // Take away a plain copy without a set first.
      const a = copies[id]; let i = -1; for (let j = a.length - 1; j >= 0; j--) if (!a[j].key && !a[j].foil) { i = j; break; }
      a.splice(i >= 0 ? i : a.length - 1, 1);
    } else if (b.dataset.fcol) { const cp = copies[b.dataset.fcol][+b.dataset.fi]; cp.foil = !cp.foil; }
    else return;
    refreshSets(); };
  $("#shName").oninput = () => { const v = $("#shName").value; $("#shSugg").innerHTML = matcher && v.trim().length >= 2 && !matcher.isCard(v) ? suggHTML(matcher.suggest(v, 5), "pick") : ""; };
  $("#shSugg").onclick = e => { const b = e.target.closest("button[data-pick]"); if (!b) return; $("#shName").value = b.dataset.pick; $("#shSugg").innerHTML = ""; };
  $("#shSave").onclick = () => {
    const raw = $("#shName").value.trim() || c.name;
    const name = (matcher && matcher.canonical(raw)) || raw; const nk = keyOf(name);
    for (const id of S.order) {
      const cards = S.cols[id].cards; const old = cards[k]; delete cards[k];
      const q = qty[id]; if (q <= 0) continue;
      // Sets belong to this card: renaming to a different card drops them.
      const sets = {}, foil = {};
      for (const cp of copies[id]) {
        const key = nk === k ? cp.key : "";
        if (key) sets[key] = (sets[key] || 0) + 1;
        if (cp.foil) foil[key] = (foil[key] || 0) + 1;   // foil stays with the copy even if the card is renamed
      }
      if (nk !== k && cards[nk]) { cards[nk].qty += q; addSets(cards[nk], null, foil); }
      else { cards[nk] = { name, qty: q, added: old ? old.added : Date.now() }; if (Object.keys(sets).length) cards[nk].sets = sets; if (Object.keys(foil).length) cards[nk].foil = foil; tidySets(cards[nk]); }
    }
    if (nk !== k) fetchMissingDetails([name]);
    persist(); renderHeader(); renderColl(); closeSheet(); toast("Saved");
  };
  $("#shDel").onclick = () => $("#shDelConfirm").hidden = false;
  $("#shNo").onclick = () => $("#shDelConfirm").hidden = true;
  $("#shYes").onclick = () => { for (const id of S.order) delete S.cols[id].cards[k]; persist(); renderHeader(); renderColl(); closeSheet(); toast("Removed"); };
}
const rulingsCache = new Map();
async function loadRulings(name) {
  if (rulingsCache.has(name)) return rulingsCache.get(name);
  if (!navigator.onLine) return "Rulings need internet.";
  try {
    const c = await (await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`, { headers: { Accept: "application/json" } })).json();
    if (!c.rulings_uri || !/^https:\/\/api\.scryfall\.com\//.test(c.rulings_uri)) return "No rulings found.";
    const j = await (await fetch(c.rulings_uri, { headers: { Accept: "application/json" } })).json();
    const list = (j.data || []).filter(r => r.source === "wotc" || !r.source);
    await loadRules();
    const html = list.length ? `<ul class="rulings">${list.map(r => `<li><span class="muted">${esc(r.published_at || "")}</span> — <span style="color:var(--ink)">${ruleHTML(r.comment || "")}</span></li>`).join("")}</ul>` : "This card has no official rulings.";
    rulingsCache.set(name, html); return html;
  } catch (e) { return "Rulings couldn't be loaded. Try again later."; }
}
function closeSheet() { $("#sheetBg").hidden = true; $("#sheet").innerHTML = ""; }
$("#sheetBg").addEventListener("click", e => { if (e.target === $("#sheetBg")) closeSheet(); });

/* ---------- RULES: the official Comprehensive Rules (rules.json, kept current by a weekly job), searchable offline ---------- */
let RULES = null, rulesP = null, ruleIndex = null;   // ruleIndex: rule number -> { rule, sub, sec }
function loadRules() {
  return rulesP || (rulesP = fetch("rules.json").then(r => { if (!r.ok) throw 0; return r.json(); }).then(j => {
    RULES = j; ruleIndex = new Map();
    for (const sec of j.sections) for (const sub of sec[2]) { ruleIndex.set(sub[0], { sub, sec }); for (const r of sub[2]) ruleIndex.set(r[0], { rule: r, sub, sec }); }
    return j;
  }).catch(() => { rulesP = null; return null; }));
}
$("#btnRules").onclick = () => showTab("rules");
let rulesView = null;   // null: sections; { sub: "702" , focus: "702.19b" }
// Rule text with references ("rule 702.19b", "rule 702", "section 8") made tappable, and search words marked.
function ruleHTML(text, words) {
  let h = esc(text).replace(/\u2028/g, "<br>");
  h = h.replace(/\b(rules?|section)\s+((?:\d{3}(?:\.\d+[a-z]?)?|[1-9])(?:(?:,\s*|\s+(?:and|or|through)\s+)\d{3}(?:\.\d+[a-z]?)?)*)/gi, (m) =>
    m.replace(/\b(\d{3}(?:\.\d+[a-z]?)?)\b/g, n => ruleIndex && ruleIndex.has(n) ? `<button class="rref" data-rule="${n}">${n}</button>` : n));
  for (const w of words || []) if (w.length > 2) h = h.replace(new RegExp(`(?<![<\\w-])(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![^<]*>)`, "gi"), "<mark>$1</mark>");
  return h;
}
function oneRule(r, words, hit) {
  return `<div class="rule${hit ? " hit" : ""}" id="r-${r[0].replace(".", "_")}"><p><span class="rn">${esc(r[0])}</span>${ruleHTML(r[1], words)}</p>${r[2].map(e => `<div class="ex"><b>Example</b><br>${ruleHTML(e, words)}</div>`).join("")}</div>`;
}
async function openRules() {
  const body = $("#rulesBody");
  if (!RULES) { body.innerHTML = '<p class="muted">Loading the rules…</p>'; await loadRules(); }
  if (!RULES) { body.innerHTML = '<p class="err">The rules couldn\'t load. Connect to the internet once; after that they work offline.</p>'; return; }
  $("#rulesVersion").textContent = `Comprehensive Rules, effective ${RULES.effective}`;
  $("#rulesAskNote").textContent = apiKey() ? "" : "Needs your Claude API key (Settings).";
  $("#btnRulesAsk").disabled = !apiKey();
  renderRules();
}
function renderRules() {
  const body = $("#rulesBody"); if (!RULES) return;
  const q = $("#rulesSearch").value.trim();
  if (q.length >= 2) { body.innerHTML = searchRulesHTML(q); return; }
  if (rulesView) {
    const { sub, sec } = ruleIndex.get(rulesView.sub);
    body.innerHTML = `<div class="row" style="justify-content:space-between;margin:12px 0 6px"><button class="ghost small" id="rulesBack">‹ All sections</button><span class="small muted">${esc(sec[0])}. ${esc(sec[1])}</span></div>
      <div class="list"><div class="rule"><p><span class="rn">${esc(sub[0])}</span><b>${esc(sub[1])}</b></p></div>${sub[2].map(r => oneRule(r, [], r[0] === rulesView.focus)).join("")}</div>`;
    if (rulesView.focus) { const el = document.getElementById("r-" + rulesView.focus.replace(".", "_")); if (el) el.scrollIntoView({ block: "center" }); }
    else window.scrollTo(0, 0);
    return;
  }
  body.innerHTML = `<div class="list">${RULES.sections.map(sec => `<details class="rules-sec"><summary>${esc(sec[0])}. ${esc(sec[1])}</summary>${sec[2].map(sub => `<button class="rules-sub" data-sub="${esc(sub[0])}"><span class="rn">${esc(sub[0])}</span>${esc(sub[1])}</button>`).join("")}</details>`).join("")}
    <details class="rules-sec"><summary>Glossary (${RULES.glossary.length} terms)</summary>${RULES.glossary.map(g => `<div class="rule"><p><b>${esc(g[0])}</b><br>${ruleHTML(g[1])}</p></div>`).join("")}</details></div>
    <p class="small muted" style="margin-top:10px">Official Magic: The Gathering Comprehensive Rules by Wizards of the Coast, updated weekly from <a href="https://magic.wizards.com/en/rules" target="_blank" rel="noopener">magic.wizards.com/en/rules</a>.</p>`;
}
const STOP = new Set("the a an and or of to in on is it its if what when how does do i my your their with for at by from as be can this that which who whom are was were will would should there they them then than so not no any all".split(" "));
const qWords = q => (q.toLowerCase().match(/[a-z0-9'’-]+/g) || []).filter(w => !STOP.has(w));
// Rules and glossary entries that contain all the words (or a rule number); glossary first.
function searchRules(q, limit) {
  const words = qWords(q), out = [];
  const num = /^\d{3}(\.\d+[a-z]?)?$/.test(q.trim()) ? q.trim() : null;
  if (num && ruleIndex.has(num)) { const x = ruleIndex.get(num); if (x.rule) out.push({ kind: "rule", r: x.rule, score: 100 }); }
  for (const g of RULES.glossary) {
    const t = (g[0] + " " + g[1]).toLowerCase(); if (!words.length || !words.every(w => t.includes(w))) continue;
    out.push({ kind: "gloss", g, score: (words.some(w => g[0].toLowerCase().includes(w)) ? 50 : 10) + (g[0].toLowerCase() === q.toLowerCase() ? 100 : 0) });
  }
  for (const sec of RULES.sections) for (const sub of sec[2]) for (const r of sub[2]) {
    const t = (r[1] + " " + r[2].join(" ") + " " + sub[1]).toLowerCase();
    if (!words.length || !words.every(w => t.includes(w))) continue;
    let sc = 0; for (const w of words) { sc += (t.split(w).length - 1); if (sub[1].toLowerCase().includes(w)) sc += 8; }
    out.push({ kind: "rule", r, sub, score: sc + (r[2].length ? 2 : 0) });
  }
  // Few rules with every word: add rules with most of the words, ranked below the full matches.
  if (words.length > 1 && out.filter(x => x.kind === "rule").length < 8) {
    const have = new Set(out.map(x => x.r && x.r[0]));
    for (const sec of RULES.sections) for (const sub of sec[2]) for (const r of sub[2]) {
      if (have.has(r[0])) continue;
      const t = (r[1] + " " + r[2].join(" ") + " " + sub[1]).toLowerCase(), n = words.filter(w => t.includes(w)).length;
      if (n >= Math.max(1, words.length - 1)) out.push({ kind: "rule", r, sub, score: n - words.length + (sub[1].toLowerCase().includes(words[0]) ? 0.5 : 0) + (r[2].length ? 0.2 : 0) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit || 60);
}
function searchRulesHTML(q) {
  const res = searchRules(q, 60), words = qWords(q);
  if (!res.length) return `<p class="muted" style="margin-top:12px">Nothing found for “${esc(q)}”. Try fewer or different words.</p>`;
  return `<p class="small muted" style="margin:10px 0 6px">${res.length >= 60 ? "Top 60" : res.length} result${res.length === 1 ? "" : "s"}</p><div class="list">${res.map(x => x.kind === "gloss"
    ? `<div class="rule"><p><span class="rn">Glossary</span><b>${esc(x.g[0])}</b><br>${ruleHTML(x.g[1], words)}</p></div>`
    : oneRule(x.r, words)).join("")}</div>`;
}
let rulesTimer = null;
$("#rulesSearch").addEventListener("input", () => { clearTimeout(rulesTimer); rulesTimer = setTimeout(() => { rulesView = null; renderRules(); }, 200); });
// Tap a rule reference → that rule in its subsection; a subsection → its rules.
document.addEventListener("click", e => {
  const ref = e.target.closest("[data-rule]"); const sub = e.target.closest("[data-sub]"); const back = e.target.closest("#rulesBack");
  if (!ref && !sub && !back) return;
  if (!ruleIndex) return;
  if (back) { rulesView = null; renderRules(); return; }
  const id = ref ? ref.dataset.rule : sub.dataset.sub, x = ruleIndex.get(id); if (!x) return;
  if (!$("#sheetBg").hidden) closeSheet();
  if ($("#pane-rules").hidden) showTab("rules");
  // From the simulator: switch to the rules view (the simulator keeps its setup and result).
  if (!$("#simMain").hidden) $("#rulesSeg button[data-rmode=rules]").click();
  $("#rulesSearch").value = ""; rulesView = { sub: x.sub[0], focus: x.rule ? x.rule[0] : null }; renderRules();
});
// The rules most relevant to a question (for Claude): best matches on any of its words.
function relevantRules(q, n) {
  const words = qWords(q); if (!words.length) return [];
  const scored = [];
  for (const sec of RULES.sections) for (const sub of sec[2]) for (const r of sub[2]) {
    const t = (r[1] + " " + r[2].join(" ")).toLowerCase(), st = sub[1].toLowerCase(); let sc = 0;
    for (const w of words) { const c = t.split(w).length - 1; if (c) sc += 1 + Math.min(c, 3) * 0.3; if (st.includes(w)) sc += 2.5; }
    if (sc > 1) scored.push([sc, r]);
  }
  const gl = RULES.glossary.filter(g => words.some(w => g[0].toLowerCase() === w || g[0].toLowerCase().startsWith(w + " "))).slice(0, 6);
  scored.sort((a, b) => b[0] - a[0]);
  return { rules: scored.slice(0, n || 30).map(x => x[1]), glossary: gl };
}
// Card names mentioned in a question (longest first), with their rules text.
function cardsIn(text) {
  if (!matcher) return [];
  const found = [], t = " " + text.toLowerCase().replace(/[’]/g, "'") + " ";
  for (const name of DB.keys()) { if (name.length < 4) continue; const n = name.toLowerCase(); if (t.includes(n)) found.push(name); }
  return found.sort((a, b) => b.length - a.length).filter((n, i, arr) => !arr.slice(0, i).some(m => m.toLowerCase().includes(n.toLowerCase()))).slice(0, 8);
}
$("#btnRulesAsk").onclick = async () => {
  const q = $("#rulesQ").value.trim(); if (!q) { $("#rulesQ").focus(); return; }
  await loadRules(); if (!RULES) return;
  const b = $("#btnRulesAsk"); b.disabled = true; b.textContent = "Asking…"; $("#rulesAnswer").innerHTML = "";
  try {
    const rel = relevantRules(q, 30), cards = cardsIn(q);
    const cardText = cards.map(n => { const c = info(n) || {}; return `${n} — ${c.c || ""} — ${c.t || ""}${c.p ? " — " + c.p : ""}\n${c.o || ""}`; }).join("\n\n");
    const prompt = `You are an experienced Magic: The Gathering judge helping players settle a rules question at the table.
Answer using the Comprehensive Rules (effective ${RULES.effective}). The excerpts below were picked by keyword search and may be incomplete; use your knowledge of the rules where needed.
Format: first a one- or two-sentence direct answer. Then "Why:" with a short step-by-step explanation citing rule numbers in square brackets like [702.19b]. Then "Example:" with a brief concrete example. If the outcome depends on details the question doesn't give, say which and what changes. Keep it under 250 words. Plain text, no markdown headings.

QUESTION:
${q}
${cardText ? `\nCARDS MENTIONED (Oracle text, may be shortened):\n${cardText}\n` : ""}
RULES EXCERPTS:
${rel.rules.map(r => `${r[0]} ${r[1]}${r[2].length ? " Example: " + r[2].join(" Example: ") : ""}`).join("\n")}
${rel.glossary.length ? "\nGLOSSARY:\n" + rel.glossary.map(g => g[0] + ": " + g[1]).join("\n") : ""}`;
    const a = await askClaude(prompt, 1200);
    // Escape, then make cited rule numbers tappable.
    const html = esc(a).replace(/\[(\d{3}(?:\.\d+[a-z]?)?)\]/g, (m, n) => ruleIndex.has(n) ? `<button class="rref" data-rule="${n}">${n}</button>` : m);
    $("#rulesAnswer").innerHTML = `<div class="answer">${html}</div><p class="small muted" style="margin-top:6px">Answer by Claude from the official rules${cards.length ? ` and the cards ${esc(cards.join(", "))}` : ""}. Tap a rule number to read it.</p>`;
  } catch (e) { $("#rulesAnswer").innerHTML = `<p class="err">${esc(claudeErr(e).replace("build the deck", "answer"))}</p>`; }
  finally { b.disabled = !apiKey(); b.textContent = "Ask"; }
};

/* ---------- COMBAT SIMULATOR (sim.js does the rules; this is the screen) ---------- */
const SIM = { A: [], D: [], lifeA: 20, lifeD: 20, n: 0 };
$("#rulesSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; const sim = b.dataset.rmode === "sim";
  document.querySelectorAll("#rulesSeg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  $("#rulesMain").hidden = sim; $("#rulesBody").hidden = sim; $("#simMain").hidden = !sim; if (sim) renderSim(); };
const ptOf = p => { const m = /^(-?\d+)\/(-?\d+)/.exec(p || ""); return m ? [+m[1], +m[2]] : [0, 1]; };
function simAdd(side, name) {
  const ci = info(name) || {}; const [p, t] = ptOf(ci.p);
  SIM[side].push({ id: ++SIM.n, name, power: p, toughness: t, base: [p, t], kw: CombatSim.keywordsFrom(ci.o || ""), blocks: null });
  renderSim();
}
function simCardHTML(c, side) {
  const atk = SIM.A;
  return `<div class="simc"><div class="top"><b>${esc(c.name)}</b><button class="ghost small" data-sdel="${side}${c.id}" aria-label="Remove ${esc(c.name)}">✕</button></div>
    <div class="top"><div class="pt"><button data-spt="${side}${c.id}:p-" aria-label="Less power">−</button><b>${c.power}</b><button data-spt="${side}${c.id}:p+" aria-label="More power">+</button> / <button data-spt="${side}${c.id}:t-" aria-label="Less toughness">−</button><b>${c.toughness}</b><button data-spt="${side}${c.id}:t+" aria-label="More toughness">+</button></div>
    </div>${side === "D" ? `<select data-sblk="${c.id}" aria-label="What ${esc(c.name)} blocks" style="width:100%"><option value="">Doesn't block</option>${atk.map(a => `<option value="${a.id}"${c.blocks === a.id ? " selected" : ""}>Blocks ${esc(a.name)}${atk.filter(x => x.name === a.name).length > 1 ? " #" + (atk.filter(x => x.name === a.name).indexOf(a) + 1) : ""}</option>`).join("")}</select>` : ""}
    <div class="kws">${CombatSim.KW.map(k => `<button data-skw="${side}${c.id}:${k}" aria-pressed="${c.kw.includes(k)}">${k}</button>`).join("")}</div></div>`;
}
function renderSim() {
  $("#simLifeA").textContent = SIM.lifeA; $("#simLifeD").textContent = SIM.lifeD;
  // A blocker can't keep blocking an attacker that was removed.
  for (const b of SIM.D) if (b.blocks && !SIM.A.some(a => a.id === b.blocks)) b.blocks = null;
  $("#simListA").innerHTML = SIM.A.map(c => simCardHTML(c, "A")).join("") || '<p class="small muted">No attackers yet.</p>';
  $("#simListD").innerHTML = SIM.D.map(c => simCardHTML(c, "D")).join("") || '<p class="small muted">No blockers yet (attackers are then unblocked).</p>';
  $("#btnSimRun").disabled = !SIM.A.length;
}
const simFind = key => { const side = key[0], id = +key.slice(1); return [side, SIM[side].find(c => c.id === id)]; };
for (const side of ["A", "D"]) {
  const inp = $("#simAdd" + side), sug = $("#simSugg" + side);
  inp.addEventListener("input", () => { const v = inp.value.trim();
    // Creature cards first in the suggestions.
    const list = matcher && v.length >= 2 ? matcher.suggest(v, 12).filter(n => /creature/i.test((info(n) || {}).t || "")).slice(0, 6) : [];
    sug.innerHTML = list.map(n => { const ci = info(n) || {}; return `<button data-sadd="${side}" data-name="${esc(n)}">${esc(n)} <span class="muted">${esc(ci.p || "")}</span></button>`; }).join(""); });
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { const b = sug.querySelector("button"); if (b) b.click(); } });
}
$("#simMain").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.sadd) { simAdd(b.dataset.sadd, b.dataset.name); const inp = $("#simAdd" + b.dataset.sadd); inp.value = ""; $("#simSugg" + b.dataset.sadd).innerHTML = ""; $("#simOut").innerHTML = ""; return; }
  if (b.dataset.life) { const k = "life" + b.dataset.life[0]; SIM[k] = Math.max(1, SIM[k] + (b.dataset.life[1] === "+" ? 1 : -1)); renderSim(); return; }
  if (b.dataset.sdel) { const [side, c] = simFind(b.dataset.sdel); SIM[side] = SIM[side].filter(x => x !== c); renderSim(); $("#simOut").innerHTML = ""; return; }
  if (b.dataset.spt) { const [key, op] = b.dataset.spt.split(":"); const [, c] = simFind(key); if (op[0] === "p") c.power = Math.max(0, c.power + (op[1] === "+" ? 1 : -1)); else c.toughness = Math.max(1, c.toughness + (op[1] === "+" ? 1 : -1)); renderSim(); return; }
  if (b.dataset.skw) { const [key, k] = b.dataset.skw.split(":"); const [, c] = simFind(key); c.kw = c.kw.includes(k) ? c.kw.filter(x => x !== k) : c.kw.concat(k); renderSim(); return; }
});
$("#simMain").addEventListener("change", e => { const t = e.target; if (t.dataset.sblk == null) return; const b = SIM.D.find(c => c.id === +t.dataset.sblk); if (b) b.blocks = t.value ? +t.value : null; $("#simOut").innerHTML = ""; });
$("#btnSimClear").onclick = () => { SIM.A = []; SIM.D = []; SIM.lifeA = SIM.lifeD = 20; $("#simOut").innerHTML = ""; renderSim(); };
let lastSim = null;
$("#btnSimRun").onclick = async () => {
  await loadRules();
  const r = CombatSim.run({ attackers: SIM.A, blockers: SIM.D, lifeA: SIM.lifeA, lifeD: SIM.lifeD });
  lastSim = r;
  const cite = t => ruleHTML(t).replace(/\[([\d.,\s–a-z]+)\]/g, (m, inner) => "[" + inner.replace(/\b(\d{3}(?:\.\d+[a-z]?)?)\b/g, n => ruleIndex && ruleIndex.has(n) ? `<button class="rref" data-rule="${n}">${n}</button>` : n) + "]");
  if (r.problems.length) { $("#simOut").innerHTML = `<div class="panel"><h3>These blocks aren't allowed</h3>${r.problems.map(p => `<p>${cite(p)}</p>`).join("")}</div>`; return; }
  const res = r.result;
  $("#simOut").innerHTML = r.steps.map(st => `<div class="simstep panel"><h3>${esc(st.title)} <span class="small muted">rule ${cite(st.rule)}</span></h3>${st.lines.map(l => `<p>${cite(l)}</p>`).join("")}</div>`).join("") +
    `<div class="simres"><b>Result</b><br>Attacking player: ${res.lifeA} life · Defending player: ${res.lifeD} life${res.loser ? ` · <b>${res.loser === "D" ? "the defending" : "the attacking"} player loses</b>` : ""}<br>Destroyed: ${esc(res.died.join(", ") || "none")}<br>Survived: ${esc(res.survived.join(", ") || "none")}</div>
    <p class="small muted" style="margin-top:8px">Covers combat keywords only. Other abilities (triggers like “whenever … deals combat damage”, pump spells, protection) aren't included${apiKey() ? ": ask Claude to check them." : "."}</p>
    ${apiKey() ? `<button id="btnSimClaude">Explain with Claude (includes the cards' other abilities)</button><div id="simClaude"></div>` : ""}`;
  const cb = $("#btnSimClaude"); if (cb) cb.onclick = simAskClaude;
};
async function simAskClaude() {
  const b = $("#btnSimClaude"); b.disabled = true; b.textContent = "Asking…";
  const desc = c => { const ci = info(c.name) || {}; return `${c.name} (${c.power}/${c.toughness}${c.base && (c.base[0] !== c.power || c.base[1] !== c.toughness) ? `, printed ${c.base[0]}/${c.base[1]}` : ""}; keywords used: ${c.kw.join(", ") || "none"})\nOracle: ${ci.c || ""} ${ci.t || ""}\n${ci.o || ""}`; };
  const att = SIM.A.map(desc).join("\n\n"), def = SIM.D.map(c => desc(c) + `\nBlocks: ${c.blocks ? (SIM.A.find(a => a.id === c.blocks) || {}).name : "nothing"}`).join("\n\n");
  const log = lastSim ? lastSim.steps.map(s => s.title + ":\n" + s.lines.join("\n")).join("\n\n") : "";
  const rel = relevantRules("combat damage first strike trample deathtouch lifelink blocking " + SIM.A.concat(SIM.D).flatMap(c => c.kw).join(" "), 25);
  const prompt = `You are an experienced Magic: The Gathering judge. Check and explain this combat.
Attacking player life ${SIM.lifeA}, defending player life ${SIM.lifeD}.

ATTACKERS:
${att}

DEFENDERS:
${def || "none"}

A keyword-only simulator produced this result:
${log}

Tasks: 1) Say whether the simulator's result is right. 2) Point out any other abilities in the Oracle text above that change the outcome (triggers, static abilities, protection, etc.) and give the corrected result step by step. 3) Mention choices a player could make differently (e.g. how to divide damage among several blockers). Cite rule numbers in square brackets like [510.1c]. Keep it under 300 words. Plain text.

RULES EXCERPTS:
${rel.rules.map(r => `${r[0]} ${r[1]}`).join("\n")}`;
  try {
    const a = await askClaude(prompt, 1500);
    $("#simClaude").innerHTML = `<div class="answer" style="margin-top:8px">${esc(a).replace(/\[(\d{3}(?:\.\d+[a-z]?)?)\]/g, (m, n) => ruleIndex.has(n) ? `<button class="rref" data-rule="${n}">${n}</button>` : m)}</div>`;
  } catch (e) { $("#simClaude").innerHTML = `<p class="err">${esc(claudeErr(e).replace("build the deck", "answer"))}</p>`; }
  finally { b.disabled = false; b.textContent = "Explain with Claude (includes the cards' other abilities)"; }
}

/* ---------- WISHLIST ----------
   S.wish: [{ name, qty, set ("SOS:178", "SOA:" or ""), foil, added }]. Stored on the phone; prices from the price list. */
function persistWish() { lsSet("mtg.wlists", S.wl); }
function wishFind(name) { const k = keyOf(name); return S.wish.findIndex(w => keyOf(w.name) === k); }
// Every entry of every wishlist, with its list id.
function allWish() { const out = []; for (const id of S.wl.order) for (const w of S.wl.lists[id].items) out.push({ w, id }); return out; }
// Names of the wishlists a card is on.
function wishListsWith(name) { const k = keyOf(name); return S.wl.order.filter(id => S.wl.lists[id].items.some(w => keyOf(w.name) === k)).map(id => S.wl.lists[id].name); }
function newWishList(name) {
  const ex = S.wl.order.find(id => keyOf(S.wl.lists[id].name) === keyOf(name)); if (ex) return ex;
  const id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  S.wl.lists[id] = { name, items: [] }; S.wl.order.push(id); persistWish(); return id;
}
function renderWishSel() {
  $("#wishSel").innerHTML = S.wl.order.map(id => { const l = S.wl.lists[id], n = l.items.reduce((a, w) => a + w.qty, 0);
    return `<option value="${id}"${id === S.wl.cur ? " selected" : ""}>${esc(l.name)} (${n})</option>`; }).join("");
  $("#renameWish").value = S.wl.lists[S.wl.cur].name;
  $("#btnDeleteWish").disabled = S.wl.order.length < 2;
}
$("#wishSel").onchange = e => { S.wl.cur = e.target.value; persistWish(); $("#delWishConfirm").hidden = true; renderWish(); };
$("#btnWishManage").onclick = () => { const p = $("#wishManage"); p.hidden = !p.hidden; $("#btnWishManage").setAttribute("aria-pressed", String(!p.hidden)); };
$("#btnCreateWish").onclick = () => { const v = $("#newWishName").value.trim().slice(0, 40); if (!v) { $("#newWishName").focus(); return; } S.wl.cur = newWishList(v); persistWish(); $("#newWishName").value = ""; renderWish(); toast(`Created ${v}`); };
$("#btnRenameWish").onclick = () => { const v = $("#renameWish").value.trim().slice(0, 40); if (!v) return; S.wl.lists[S.wl.cur].name = v; persistWish(); renderWish(); toast("Renamed"); };
$("#btnDeleteWish").onclick = () => { const l = S.wl.lists[S.wl.cur], n = l.items.length; $("#delWishMsg").textContent = `Delete "${l.name}"${n ? ` and the ${n} card${n === 1 ? "" : "s"} on it` : ""}?`; $("#delWishConfirm").hidden = false; };
$("#noDelWish").onclick = () => $("#delWishConfirm").hidden = true;
$("#yesDelWish").onclick = () => {
  if (S.wl.order.length < 2) return;
  const id = S.wl.cur, gone = S.wl.lists[id], at = S.wl.order.indexOf(id);
  delete S.wl.lists[id]; S.wl.order.splice(at, 1); S.wl.cur = S.wl.order[Math.max(0, at - 1)];
  persistWish(); $("#delWishConfirm").hidden = true; renderWish();
  toast(`Deleted ${gone.name}`, { label: "Undo", run: () => { S.wl.lists[id] = gone; S.wl.order.splice(at, 0, id); S.wl.cur = id; persistWish(); renderWish(); } });
};
function addToWish(name, qty, set, foil) {
  name = (matcher && (matcher.canonical(name) || (matcher.matchLine(name) || {}).name)) || name.trim(); if (!name) return null;
  // The same card, printing and finish is one entry with a higher count.
  const ex = S.wish.find(w => keyOf(w.name) === keyOf(name) && (w.set || "") === (set || "") && !!w.foil === !!foil);
  if (ex) ex.qty += qty; else S.wish.unshift({ name, qty, set: set || "", foil: !!foil, added: Date.now() });
  persistWish(); updatePrices(false).then(ch => { if (ch && !$("#pane-wish").hidden) renderWish(); });
  return name;
}
const wishEach = w => copyPrice(w.name, w.set, w.foil);
function renderWish() {
  renderWishSel();
  const owned = merged("all");
  let total = 0, missing = 0, n = 0;
  for (const w of S.wish) { n += w.qty; const p = wishEach(w); if (p) total += p.v * w.qty; else if (!BASIC_SET.has(keyOf(w.name))) missing += w.qty; }
  $("#wishSummary").textContent = n ? `${n} card${n === 1 ? "" : "s"}` + (total ? ` · ≈ ${fmtEur(total)}` : "") + (missing ? ` · ${missing} without a price` : "") : "";
  const sort = $("#wishSort").value;
  const rows = S.wish.map((w, i) => ({ w, i, p: wishEach(w) }));
  const each = r => r.p ? r.p.v : -1;
  rows.sort((a, b) => sort === "name" ? a.w.name.localeCompare(b.w.name) : sort === "each" ? each(b) - each(a) : sort === "total" ? each(b) * b.w.qty - each(a) * a.w.qty : (b.w.added || 0) - (a.w.added || 0));
  $("#wishBody").innerHTML = rows.length ? `<div class="list">${rows.map(({ w, i, p }) => {
    const ci = info(w.name), own = owned[keyOf(w.name)];
    return `<div class="crow">
      <button class="nm" data-wopen="${i}">${esc(w.name)}</button>
      <div class="meta">${ci ? costHTML(ci.c) + `<span>${esc(ci.t)}</span>` : '<span class="badge bad">not in card list</span>'}${p ? `<span class="price">${p.approx ? "≈" : ""}${fmtEur(p.v * w.qty)}${w.qty > 1 ? ` <span class="each">(${fmtEur(p.v)} each)</span>` : ""}</span>` : ""}${w.set ? setChips({ [w.set]: 1 }) : ""}${w.foil ? '<span class="badge foil">✦ Foil</span>' : ""}${own ? `<span class="badge own">you have ${own.qty}</span>` : ""}</div>
      <div class="ctl stepper"><button data-wd="${i}" aria-label="Fewer ${esc(w.name)}">−</button><span>${w.qty}</span><button data-wi="${i}" aria-label="More ${esc(w.name)}">+</button></div>
    </div>`; }).join("")}</div>`
    : `<div class="empty"><h2>${esc(S.wl.lists[S.wl.cur].name)} is empty</h2><p class="muted">Add cards you'd like to get above, or tap ♡ Add to wishlist on any card. You'll see what they cost, and when you add one to your collection the app offers to tick it off.</p></div>`;
  $("#btnCopyWish").disabled = !S.wish.length;
  refreshPricesSoon();
}
$("#wishSort").onchange = renderWish;
let wQty = 1;
$("#wMinus").onclick = () => { wQty = Math.max(1, wQty - 1); $("#wQty").textContent = wQty; };
$("#wPlus").onclick = () => { wQty++; $("#wQty").textContent = wQty; };
$("#wishName").addEventListener("input", () => { const v = $("#wishName").value; $("#wishSugg").innerHTML = matcher && v.trim().length >= 2 ? suggHTML(matcher.suggest(v, 5), "pick") : ""; });
$("#wishSugg").onclick = e => { const b = e.target.closest("button[data-pick]"); if (!b) return; $("#wishName").value = b.dataset.pick; $("#wishSugg").innerHTML = ""; };
$("#btnWishAdd").onclick = () => {
  const raw = $("#wishName").value.trim(); if (!raw) { $("#wishName").focus(); return; }
  const name = addToWish(raw, wQty);
  toast(`Added ${wQty} × ${name} to ${S.wl.lists[S.wl.cur].name}${matcher && !matcher.isCard(name) ? " (not in the card list)" : ""}`);
  $("#wishName").value = ""; $("#wishSugg").innerHTML = ""; wQty = 1; $("#wQty").textContent = 1; renderWish();
};
$("#wishName").addEventListener("keydown", e => { if (e.key === "Enter") $("#btnWishAdd").click(); });
$("#wishBody").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.wopen != null) { openWish(+b.dataset.wopen); return; }
  const i = +(b.dataset.wi ?? b.dataset.wd); if (isNaN(i) || !S.wish[i]) return;
  if (b.dataset.wi != null) S.wish[i].qty++;
  else { S.wish[i].qty--; if (S.wish[i].qty <= 0) { const gone = S.wish.splice(i, 1)[0]; toast(`Removed ${gone.name}`, { label: "Undo", run: () => { S.wish.splice(i, 0, { ...gone, qty: 1 }); persistWish(); renderWish(); } }); } }
  persistWish(); renderWish();
});
const wishLine = w => { const [code, num] = (w.set || "").split(":"); return `${w.qty} ${w.name}${code ? ` (${code})${num ? " " + num : ""}` : ""}${w.foil ? " *F*" : ""}`; };
$("#btnCopyWish").onclick = () => copyText(S.wish.map(w => `${w.qty} ${w.name}`).join("\n"));

// One wishlist entry: picture, printing, foil, count, price, how many you own.
function openWish(i) {
  const w = S.wish[i]; if (!w) return;
  const ci = info(w.name), own = merged("all")[keyOf(w.name)];
  let set = w.set || "", foil = !!w.foil, qty = w.qty;
  const imgOf = key => { const [code, num] = (key || "").split(":");
    return code && num ? `https://api.scryfall.com/cards/${encodeURIComponent(code.toLowerCase())}/${encodeURIComponent(num)}?format=image&version=normal`
      : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(w.name)}${code ? "&set=" + encodeURIComponent(code.toLowerCase()) : ""}&format=image&version=normal`; };
  const opts = () => { const keys = printsOf(w.name).map(p => p.code + ":" + p.num); if (set && !keys.includes(set)) keys.unshift(set);
    return `<option value="">Any printing</option>` + keys.map(k => `<option value="${esc(k)}"${k === set ? " selected" : ""}>${esc(printLabel(k, true))}</option>`).join(""); };
  const priceText = () => { const p = copyPrice(w.name, set, foil); return p ? `${p.approx ? "≈ " : ""}${fmtEur(p.v)} each · ${fmtEur(p.v * qty)} for ${qty}` : (navigator.onLine ? "Price loading…" : "No price saved yet"); };
  $("#sheet").innerHTML = `<div class="grab"></div>
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2 style="min-width:0">${esc(w.name)}</h2><button class="ghost" id="shClose" aria-label="Close">✕</button></div>
    <div class="cardimg" id="shImg">${navigator.onLine ? `<img src="${imgOf(set)}" alt="${esc(w.name)}" loading="lazy">` : "Picture needs internet"}</div>
    ${ci ? `<div class="stack" style="gap:6px"><div class="row">${costHTML(ci.c)}<span class="small muted">mana value ${ci.v}</span></div><b>${esc(ci.t)}${ci.p ? " · " + esc(ci.p) : ""}</b>${ci.o ? `<p class="oracle">${esc(ci.o)}</p>` : ""}</div>` : ""}
    <p class="small"><b id="wPrice">${priceText()}</b> <span class="muted">· Cardmarket via Scryfall</span></p>
    ${own ? `<p class="small"><span class="badge own">you have ${own.qty}</span> in ${esc(Object.keys(own.where).map(colName).join(", "))}</p>` : ""}
    <div class="stack" style="gap:8px"><h3>What you want</h3>
      <div class="wrow" style="display:flex;justify-content:space-between;align-items:center"><span>Copies</span><div class="stepper"><button id="wsMinus" aria-label="Fewer">−</button><span id="wsQty">${qty}</span><button id="wsPlus" aria-label="More">+</button></div></div>
      <label class="field">Printing<select id="wsSet">${opts()}</select></label>
      <button class="wishbtn" id="wsFoil" aria-pressed="${foil}">✦ Foil</button>
    </div>
    <div class="row"><button class="primary" id="wsSave" style="flex:1">Save</button><button class="ghost danger" id="wsDel">Remove</button></div>`;
  $("#sheetBg").hidden = false;
  const showImg = () => { const box = $("#shImg"); if (!box || !navigator.onLine) return; box.innerHTML = `<img src="${imgOf(set)}" alt="${esc(w.name)}">`; box.querySelector("img").onerror = function () { box.textContent = "No picture available"; }; };
  showImg();
  const refresh = () => { $("#wPrice").textContent = priceText(); };
  loadPrints().then(() => { if ($("#wsSet")) $("#wsSet").innerHTML = opts(); });
  $("#shClose").onclick = closeSheet;
  $("#wsMinus").onclick = () => { qty = Math.max(1, qty - 1); $("#wsQty").textContent = qty; refresh(); };
  $("#wsPlus").onclick = () => { qty++; $("#wsQty").textContent = qty; refresh(); };
  $("#wsSet").onchange = () => { set = $("#wsSet").value; showImg(); refresh(); updatePrices(false, [priceId(w.name, set)]).then(refresh); };
  $("#wsFoil").onclick = () => { foil = !foil; $("#wsFoil").setAttribute("aria-pressed", String(foil)); refresh(); };
  $("#wsSave").onclick = () => { Object.assign(w, { qty, set, foil }); persistWish(); updatePrices(false); renderWish(); closeSheet(); toast("Saved"); };
  $("#wsDel").onclick = () => { const at = S.wish.indexOf(w); S.wish.splice(at, 1); persistWish(); renderWish(); closeSheet(); toast(`Removed ${w.name}`, { label: "Undo", run: () => { S.wish.splice(at, 0, w); persistWish(); renderWish(); } }); };
}

/* ---------- DECK ---------- */
$("#deckColors").innerHTML = ["W", "U", "B", "R", "G"].map(c => `<button class="chip" aria-pressed="false" data-c="${c}"><span class="pip ${c}">${c}</span>${COLOR_NAMES[c]}</button>`).join("");
$("#deckColors").onclick = e => { const b = e.target.closest("button"); if (!b) return; const c = b.dataset.c; S.colors.has(c) ? S.colors.delete(c) : S.colors.add(c); b.setAttribute("aria-pressed", String(S.colors.has(c))); };
$("#fmtSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.fmt = b.dataset.fmt; document.querySelectorAll("#fmtSeg button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); };
$("#buildSel").onchange = e => { S.buildFrom = e.target.value; persist(); };
$("#engineSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.engine = b.dataset.eng; lsSet("mtg.engine", S.engine); renderEngine(); };
function renderEngine() {
  const hasKey = !!apiKey();
  if (!hasKey) S.engine = "local";
  document.querySelectorAll("#engineSeg button").forEach(x => { x.setAttribute("aria-pressed", String(x.dataset.eng === S.engine)); if (x.dataset.eng === "claude") x.disabled = !hasKey; });
  $("#notesField").hidden = S.engine !== "claude";
  $("#engineHint").innerHTML = !hasKey ? `To build with Claude, add an API key in <b>Settings</b>.` : S.engine === "claude" && !navigator.onLine ? "You're offline, so the built-in builder will be used." : "";
}

function poolForBuild() {
  return Object.values(merged(S.buildFrom)).map(c => ({ name: c.name, qty: c.qty, card: info(c.name) || { n: c.name, c: "", v: 0, k: "", t: "", o: "" } }));
}
let buildCtl = null;
$("#btnStopBuild").onclick = () => buildCtl && buildCtl.abort();
$("#btnBuild").onclick = async () => {
  $("#buildErr").hidden = true;
  const cards = Object.values(merged(S.buildFrom));
  if (!cards.length) { $("#buildErr").textContent = S.buildFrom === "all" ? "Your collection is empty. Scan some cards first." : `${colName(S.buildFrom)} is empty. Pick another collection under Build from, or scan cards into it.`; $("#buildErr").hidden = false; return; }
  const style = $("#deckStyle").value;
  const useClaude = S.engine === "claude" && apiKey() && navigator.onLine;
  if (!useClaude) {
    const d = DeckBuilder.build(poolForBuild(), { format: S.fmt, colors: [...S.colors], style });
    S.deck = finishDeck(d, S.fmt); renderDeck(); $("#deckOut").scrollIntoView({ behavior: "smooth", block: "start" }); return;
  }
  const f = FORMATS[S.fmt];
  const many = cards.length > 350;
  const list = cards.sort((a, b) => a.name.localeCompare(b.name)).map(c => { const ci = info(c.name);
    return `${c.qty}x ${c.name}` + (ci ? ` | ${ci.c || "no cost"} | ${ci.t}${ci.p ? " | " + ci.p : ""}${!many && ci.o ? " | " + ci.o.slice(0, 140) : ""}` : " | (details unknown)"); }).join("\n");
  const colors = [...S.colors].map(c => COLOR_NAMES[c]).join(", ");
  const styleText = $("#deckStyle").selectedOptions[0].textContent;
  const prompt = `You are an expert Magic: The Gathering deckbuilder helping a player build the best deck they can from cards they physically own. Many cards may be from recent sets; rely on the card text given below.

FORMAT: ${f.desc}. Total deck size must be exactly ${f.size} cards.
COLORS: ${colors ? `Use only these colors: ${colors}.` : "Choose the strongest 1-2 colors from the collection."}
STYLE: ${style ? styleText : "Whatever is strongest with these cards."}
${$("#deckNotes").value.trim() ? "PLAYER NOTES: " + $("#deckNotes").value.trim().slice(0, 600) : ""}

HARD RULES:
- Use ONLY cards from the collection below, never more copies than the player owns (the number before x).
- Basic lands (Plains, Island, Swamp, Mountain, Forest) are unlimited and go in "basicLands", not in "cards".
- Respect the format's copy limit. Aim for a sensible mana curve and land count.
- If the collection can't fill ${f.size} cards in those colors, use the best available and explain the shortfall in "notes".

THE PLAYER'S COLLECTION (qty x name | cost | type | P/T | text):
${list}

Reply with ONLY this JSON:
{"deckName":"short evocative name","archetype":"e.g. Mono-Red Aggro","colors":["R"],${S.fmt === "commander" ? '"commander":"exact card name",' : ""}
"summary":"2 sentences on how the deck wins",
"cards":[{"name":"exact name from collection","qty":4,"why":"under 12 words"}],
"basicLands":{"Plains":0,"Island":0,"Swamp":0,"Mountain":0,"Forest":0},
"howToPlay":["3-5 short tips for playing the deck"],
"notes":"shortfalls or upgrade ideas, or empty string"}`;
  $("#btnBuild").disabled = true; $("#buildStatus").hidden = false; $("#buildStatusTxt").textContent = "Claude is building your deck… this can take up to a minute";
  buildCtl = new AbortController();
  try {
    const res = await askClaudeJSON(prompt, 8000, false, buildCtl.signal);
    S.deck = validateDeck(res, S.fmt); S.deck.builtBy = "Claude"; S.deck.from = S.buildFrom === "all" ? "all collections" : colName(S.buildFrom); S.deck.fromId = S.buildFrom;
    renderDeck(); $("#deckOut").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (e && e.name === "AbortError") {}
    else {
      const d = DeckBuilder.build(poolForBuild(), { format: S.fmt, colors: [...S.colors], style });
      S.deck = finishDeck(d, S.fmt); S.deck.fixes.unshift(claudeErr(e) + " The built-in builder made this deck instead.");
      renderDeck();
    }
  } finally { $("#btnBuild").disabled = false; $("#buildStatus").hidden = true; buildCtl = null; }
};
function finishDeck(d, fmt) { return Object.assign({ fixes: [], fmt, saved: false }, d, { fmt, fixes: [], from: S.buildFrom === "all" ? "all collections" : colName(S.buildFrom), fromId: S.buildFrom }); }
function validateDeck(res, fmt) {
  const f = FORMATS[fmt]; const fixes = []; const OWN = merged(S.buildFrom);
  const cards = []; const seen = {};
  res = res || {}; res.basicLands = res.basicLands || {};
  for (const c of Array.isArray(res.cards) ? res.cards : []) {
    if (!c || !c.name) continue; const k = keyOf(c.name);
    if (BASIC_SET.has(k)) { const bn = Object.values(BASIC_NAMES).find(n => keyOf(n) === k) || c.name; res.basicLands[bn] = (+res.basicLands[bn] || 0) + (+c.qty || 0); continue; }
    const own = OWN[k] || OWN[keyOf((matcher && matcher.canonical(c.name)) || "")]; let q = Math.max(1, parseInt(c.qty, 10) || 1);
    if (!own) { fixes.push(`Removed ${c.name}: not in your collection.`); continue; }
    const ok = keyOf(own.name); const already = seen[ok] || 0; const cap = Math.min(own.qty, f.maxCopies) - already;
    if (cap <= 0) continue;
    if (q > cap) { fixes.push(`${own.name}: cut to ${cap} (you own ${own.qty}).`); q = cap; }
    seen[ok] = already + q;
    const ci = info(own.name) || {};
    cards.push({ name: own.name, qty: q, type: ci.t || "", manaCost: ci.c || "", cmc: ci.v || 0, colors: colorsOf(ci), why: c.why || "" });
  }
  if (fmt === "commander" && res.commander) { const ck = keyOf(res.commander); if (!cards.some(c => keyOf(c.name) === ck) && OWN[ck]) { const ci = info(OWN[ck].name) || {}; cards.unshift({ name: OWN[ck].name, qty: 1, type: ci.t || "", manaCost: ci.c || "", cmc: ci.v || 0, colors: colorsOf(ci), why: "Your commander" }); } }
  const lands = {}; for (const [n, v] of Object.entries(res.basicLands)) { const q = parseInt(v, 10) || 0; if (q > 0) lands[n] = q; }
  let total = cards.reduce((a, c) => a + c.qty, 0) + Object.values(lands).reduce((a, b) => a + b, 0);
  const deckColors = (Array.isArray(res.colors) && res.colors.length ? res.colors : [...new Set(cards.flatMap(c => c.colors))]).filter(c => BASIC_NAMES[c]);
  if (total < f.size && deckColors.length) { const add = f.size - total; let i = 0; for (let n = 0; n < add; n++) { const bn = BASIC_NAMES[deckColors[i++ % deckColors.length]]; lands[bn] = (lands[bn] || 0) + 1; } fixes.push(`Added ${add} basic land${add > 1 ? "s" : ""} to reach ${f.size} cards.`); total = f.size; }
  if (total > f.size) fixes.push(`The list has ${total} cards, ${total - f.size} over the ${f.size}-card target. Trim your weakest cards.`);
  return { name: res.deckName || "Untitled deck", archetype: res.archetype || "", summary: res.summary || "", commander: res.commander || "", cards, lands, howToPlay: Array.isArray(res.howToPlay) ? res.howToPlay : [], notes: res.notes || "", fixes, fmt, total, saved: false };
}
const GROUP_ORDER = [["creature", "Creatures"], ["planeswalker", "Planeswalkers"], ["battle", "Battles"], ["instant", "Instants"], ["sorcery", "Sorceries"], ["artifact", "Artifacts"], ["enchantment", "Enchantments"], ["other", "Other"], ["land", "Lands"]];
function curveSVG(cards) {
  const b = [0, 0, 0, 0, 0, 0, 0, 0];
  cards.forEach(c => { if (mainType(c.type) === "land") return; b[Math.min(7, Math.max(0, Math.round(c.cmc || 0)))] += c.qty; });
  const max = Math.max(1, ...b); const W = 320, H = 120, pad = 22, bw = (W - 16) / 8;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mana curve: ${b.map((v, i) => `${v} at ${i === 7 ? "7+" : i}`).join(", ")}">`;
  s += `<line x1="8" y1="${H - pad}" x2="${W - 8}" y2="${H - pad}" stroke="var(--line)"/>`;
  b.forEach((v, i) => { const h = (H - pad - 18) * v / max; const x = 8 + i * bw + 5;
    s += `<rect x="${x}" y="${H - pad - h}" width="${bw - 10}" height="${h}" rx="3" fill="var(--accent)"/>`;
    if (v) s += `<text x="${x + (bw - 10) / 2}" y="${H - pad - h - 5}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" fill="var(--ink)">${v}</text>`;
    s += `<text x="${x + (bw - 10) / 2}" y="${H - 6}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" fill="var(--muted)">${i === 7 ? "7+" : i}</text>`; });
  return s + "</svg>";
}
function deckText(d) {
  const lines = [];
  if (d.commander) { const c = d.cards.find(x => keyOf(x.name) === keyOf(d.commander)); lines.push("Commander", "1 " + (c ? c.name : d.commander), "", "Deck"); }
  else lines.push("Deck");
  d.cards.filter(c => !d.commander || keyOf(c.name) !== keyOf(d.commander)).forEach(c => lines.push(`${c.qty} ${c.name}`));
  Object.entries(d.lands).forEach(([n, q]) => lines.push(`${q} ${n}`));
  return lines.join("\n");
}
/* ---------- leftovers: cards you own that the deck doesn't use ---------- */
const COLOR_GROUPS = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["M", "Multicolor"], ["C", "Colorless"], ["L", "Lands"], ["?", "Unknown color"]];
function colorWords(ci) { if (!ci) return "Unknown"; const cs = colorsOf(ci); if (cs.length) return cs.map(c => COLOR_NAMES[c]).join(", "); return mainType(ci.t) === "land" ? "Land" : "Colorless"; }
function leftovers(d) {
  const scope = d.fromId && (d.fromId === "all" || S.cols[d.fromId]) ? d.fromId : "all";
  const own = merged(scope), used = {};
  for (const c of d.cards) used[keyOf(c.name)] = (used[keyOf(c.name)] || 0) + c.qty;
  const byGroup = {};
  for (const [k, c] of Object.entries(own)) {
    if (BASIC_SET.has(k)) continue;
    const left = c.qty - (used[k] || 0); if (left <= 0) continue;
    const ci = info(c.name); const cs = ci ? colorsOf(ci) : [];
    const g = !ci ? "?" : cs.length > 1 ? "M" : cs.length === 1 ? cs[0] : mainType(ci.t) === "land" ? "L" : "C";
    (byGroup[g] = byGroup[g] || []).push({ name: c.name, qty: left, cost: ci ? ci.c : "", type: ci ? ci.t : "", cmc: ci ? ci.v : 0, colors: colorWords(ci) });
  }
  const groups = COLOR_GROUPS.filter(([g]) => byGroup[g]).map(([g, label]) => { const cards = byGroup[g].sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name)); return { label, cards, n: cards.reduce((a, c) => a + c.qty, 0) }; });
  return { groups, total: groups.reduce((a, g) => a + g.n, 0), from: scope === "all" ? "all collections" : colName(scope) };
}
// Plain "quantity name" lines (sorted by color) so deck sites such as Draftsim, Arena and Moxfield can import it.
function leftoverText(d, lo) {
  const out = [];
  for (const g of lo.groups) for (const c of g.cards) out.push(`${c.qty} ${c.name}`);
  return out.join("\n");
}
// A deck's value: owned copies of each card, cheapest recorded printings first.
function deckValueHTML(d) {
  const own = merged(d.fromId && S.cols[d.fromId] ? d.fromId : "all");
  let v = 0, missing = 0;
  for (const c of d.cards) {
    if (BASIC_SET.has(keyOf(c.name))) continue;
    const o = own[keyOf(c.name)], prices = [];
    for (const cp of o ? copiesOf(o) : []) { const p = copyPrice(c.name, cp.key, cp.foil); prices.push(p ? p.v : null); }
    const g = copyPrice(c.name); while (prices.length < c.qty) prices.push(g ? g.v : null);
    prices.sort((p, q) => (p ?? Infinity) - (q ?? Infinity));
    for (const p of prices.slice(0, c.qty)) { if (p == null) missing++; else v += p; }
  }
  if (!v && !missing) return "";
  return `<p class="small muted">Deck value ≈ <b>${fmtEur(v)}</b>${missing ? ` · ${missing} card${missing === 1 ? "" : "s"} without a price` : ""} · Cardmarket prices via Scryfall</p>`;
}
// A card name in a deck list: tappable (opens the card) when it's in your collection.
let ownedNow = {};   // filled when a deck is drawn
function cardLink(name) {
  const k = keyOf(name);
  return ownedNow[k] ? `<button class="nm dlink" data-card="${esc(k)}"><b>${esc(name)}</b></button>` : `<span class="nm"><b>${esc(name)}</b></span>`;
}
$("#deckOut").addEventListener("click", e => { const b = e.target.closest("[data-card]"); if (b) openCard(b.dataset.card); });
function renderDeck() {
  const d = S.deck; const out = $("#deckOut"); if (!d) { out.innerHTML = ""; return; }
  ownedNow = merged("all");
  const groups = {}; d.cards.forEach(c => { const g = mainType(c.type); (groups[g] = groups[g] || []).push(c); });
  const landCount = Object.values(d.lands).reduce((a, b) => a + b, 0) + (groups.land || []).reduce((a, c) => a + c.qty, 0);
  const creatures = (groups.creature || []).reduce((a, c) => a + c.qty, 0);
  const nonland = d.cards.filter(c => mainType(c.type) !== "land");
  const nq = nonland.reduce((a, c) => a + c.qty, 0);
  const avg = nq ? (nonland.reduce((a, c) => a + c.cmc * c.qty, 0) / nq).toFixed(1) : "–";
  let html = `<div class="panel">
    <div class="deckhead"><span class="arch">${esc(d.archetype)} · ${FORMATS[d.fmt].label}${d.builtBy ? " · by " + esc(d.builtBy) : ""}</span>${d.from ? `<span class="small muted">From: ${esc(d.from)}</span>` : ""}<label class="field" style="gap:4px"><span class="small muted">Deck name</span><input type="text" id="deckName" class="deckname" value="${esc(d.name)}" maxlength="60" autocomplete="off" autocapitalize="words" aria-label="Deck name"></label>${d.commander ? `<p><b>Commander:</b> ${esc(d.commander)}</p>` : ""}<p class="muted">${esc(d.summary)}</p></div>
    <div class="stats"><div class="stat"><b>${d.total}</b><span>cards</span></div><div class="stat"><b>${landCount}</b><span>lands</span></div><div class="stat"><b>${avg}</b><span>avg mana value</span></div></div>
    ${deckValueHTML(d)}
    <div class="curve"><h3>Mana curve <span class="small">(${creatures} creatures)</span></h3>${curveSVG(d.cards)}</div>
    ${d.fixes && d.fixes.length ? `<ul class="tips" style="color:var(--warn)">${d.fixes.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  </div>`;
  for (const [g, label] of GROUP_ORDER) {
    const list = (groups[g] || []).slice().sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name));
    const basics = g === "land" ? Object.entries(d.lands) : [];
    if (!list.length && !basics.length) continue;
    const n = list.reduce((a, c) => a + c.qty, 0) + basics.reduce((a, [, q]) => a + q, 0);
    html += `<div class="group"><h3>${label} (${n})</h3><div class="list">` +
      list.map(c => `<div class="drow"><span class="q">${c.qty}</span>${cardLink(c.name)}${costHTML(c.manaCost)}${c.why ? `<span class="why">${esc(c.why)}</span>` : ""}</div>`).join("") +
      basics.map(([nm, q]) => `<div class="drow"><span class="q">${q}</span>${cardLink(nm)}<span class="small muted">basic</span></div>`).join("") + `</div></div>`;
  }
  if ((d.howToPlay && d.howToPlay.length) || d.notes) html += `<div class="panel prose">${d.howToPlay.length ? `<h3>How to play it</h3><ul>${d.howToPlay.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}${d.notes ? `<h3>Notes</h3><p>${esc(d.notes)}</p>` : ""}</div>`;
  const lo = leftovers(d);
  html += `<details class="panel" id="leftDeck"><summary>Cards not in this deck (${lo.total})</summary>
    <p class="small muted">Everything you own in ${esc(lo.from)} that this deck doesn't use, grouped by color. Basic lands aren't listed.</p>
    ${lo.groups.length ? lo.groups.map(g => `<div class="group"><h3>${esc(g.label)} (${g.n})</h3><div class="list">${g.cards.map(c => `<div class="drow"><span class="q">${c.qty}</span>${cardLink(c.name)}${costHTML(c.cost)}<span class="why">${esc(c.type || "")}</span></div>`).join("")}</div></div>`).join("") : `<p class="muted">This deck uses every card you own there.</p>`}
    ${lo.groups.length ? `<button id="btnCopyLeft">Copy leftover list</button><p class="small muted">Copies one card per line, sorted by color, ready to import into Draftsim, Arena or Moxfield.</p>` : ""}
  </details>`;
  html += `<div class="row"><button class="primary" id="btnCopyDeck" style="flex:1">Copy deck list</button><button id="btnSaveDeck"${d.saved ? " disabled" : ""}>${d.saved ? "Saved" : "Save deck"}</button></div>
  <p class="small muted">The copied list pastes straight into MTG Arena, Moxfield or Archidekt.</p>`;
  out.innerHTML = `<div class="stack" style="gap:16px">${html}</div>`;
  $("#btnCopyDeck").onclick = () => copyText(deckText(d));
  if ($("#btnCopyLeft")) $("#btnCopyLeft").onclick = () => copyText(leftoverText(d, lo));
  // Renaming: typing updates this deck, and the saved copy if it has been saved.
  let nameTimer = null;
  $("#deckName").addEventListener("input", e => {
    d.name = e.target.value.trim() || "Untitled deck";
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => { const sv = d.id && S.decks.find(x => x.id === d.id); if (sv) { sv.name = d.name; persistDecks(); renderSaved(); } }, 400);
  });
  $("#deckName").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
  $("#btnSaveDeck").onclick = () => { if (d.saved) return; d.name = $("#deckName").value.trim() || d.name; d.saved = true; d.id = "d" + Date.now(); S.decks.unshift(JSON.parse(JSON.stringify(d))); S.decks = S.decks.slice(0, 40); persistDecks(); renderSaved(); renderDeck(); toast("Deck saved"); };
}
function renderSaved() {
  $("#savedBox").hidden = !S.decks.length;
  $("#savedList").innerHTML = S.decks.map((d, i) => `<div class="srow"><div><b>${esc(d.name)}</b><div class="small muted">${esc(d.archetype)} · ${FORMATS[d.fmt] ? FORMATS[d.fmt].label : ""} · ${d.total} cards</div></div><div class="row" style="flex-wrap:nowrap"><button data-open="${i}">Open</button><button class="ghost" data-ren="${i}" aria-label="Rename ${esc(d.name)}">Rename</button><button class="ghost" data-del="${i}" aria-label="Delete ${esc(d.name)}">✕</button></div></div>`).join("");
}
$("#savedList").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.open != null || b.dataset.ren != null) {
    S.deck = JSON.parse(JSON.stringify(S.decks[+(b.dataset.open ?? b.dataset.ren)])); S.deck.saved = true; renderDeck(); $("#deckOut").scrollIntoView({ behavior: "smooth" });
    if (b.dataset.ren != null) setTimeout(() => { const el = $("#deckName"); if (el) { el.focus(); el.select(); } }, 350);
  }
  if (b.dataset.del != null) { S.decks.splice(+b.dataset.del, 1); persistDecks(); renderSaved(); }
});

/* ---------- Claude API ---------- */
async function askClaude(prompt, maxTokens, quick, signal) {
  const key = apiKey(); if (!key) throw { code: "no_key" };
  const models = quick ? [CLAUDE_MODELS[1], CLAUDE_MODELS[0]] : CLAUDE_MODELS;
  let last;
  for (const model of models) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model, max_tokens: maxTokens || 4000, messages: [{ role: "user", content: prompt }] })
    });
    if (r.ok) { const j = await r.json(); return (j.content || []).filter(b => b.type === "text").map(b => b.text).join(""); }
    let body = {}; try { body = await r.json(); } catch (e) {}
    last = { code: "http", status: r.status, message: body && body.error && body.error.message || "" };
    if (r.status !== 404 && !(r.status === 400 && /model/i.test(last.message))) break;   // only try the next model if this one isn't available
  }
  throw last;
}
function parseJSONLoose(t) {
  try { return JSON.parse(t); } catch (e) {}
  const f = /```(?:json)?\s*([\s\S]*?)```/.exec(t); if (f) { try { return JSON.parse(f[1]); } catch (e) {} }
  const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  throw { code: "bad_json" };
}
async function askClaudeJSON(prompt, maxTokens, quick, signal) { return parseJSONLoose(await askClaude(prompt, maxTokens, quick, signal)); }
function claudeErr(e) {
  if (!e) return "Claude couldn't be reached.";
  if (e.code === "no_key") return "Add a Claude API key in Settings first.";
  if (e.code === "bad_json") return "Claude's answer came back garbled.";
  if (e.status === 401) return "Your API key was rejected. Check it in Settings.";
  if (e.status === 403) return "Your API key isn't allowed to do this. Check it in Settings.";
  if (e.status === 429) return "Claude is rate-limiting your key. Wait a minute and try again.";
  if (e.status === 400 && /credit/i.test(e.message)) return "Your Anthropic account is out of credit. Add credit at platform.claude.com → Billing.";
  if (e.status === 529 || e.status >= 500) return "Claude is busy right now. Try again shortly.";
  if (e instanceof TypeError || e.name === "TypeError") return "Couldn't reach Claude. Check your internet connection.";
  return "Claude couldn't build the deck" + (e.message ? ` (${e.message})` : "") + ".";
}

/* ---------- SETTINGS ---------- */
function renderSettings() {
  const k = apiKey();
  $("#apiKey").value = ""; $("#apiKey").placeholder = k ? "Key saved: sk-ant-…" + k.slice(-4) : "sk-ant-…";
  $("#keyStatus").textContent = k ? "A key is saved on this phone." : "No key saved. Decks use the built-in builder.";
  $("#keyStatus").className = "small " + (k ? "okmsg" : "muted");
  renderDbInfo();
  $("#appVersion").textContent = "Version " + APP_VERSION;
  renderPriceInfo(); renderStorage();
  checkOffline();
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { $("#persistStatus").textContent = p ? "This phone has agreed to keep the app's data." : "Tip: opening the app from your Home Screen regularly keeps iOS from clearing its data."; });
}
/* ---------- data freshness ---------- */
// When the card data that ships with the app was built (update when cards.json / prints.json are rebuilt).
const DATA_BUILT = { cards: "2026-10-02", prints: "2026-10-03" };
(() => { const seen = lsGet("mtg.versionSeen", null); if (!seen || seen.v !== APP_VERSION) lsSet("mtg.versionSeen", { v: APP_VERSION, at: Date.now() }); })();
const dateText = t => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
// Calendar days, not 24-hour periods: last night is "yesterday".
const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const ago = t => { const d = Math.round((dayStart(Date.now()) - dayStart(t)) / DAY); return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`; };
const freshness = (t, staleDays) => t ? `${dateText(t)} <span class="${Date.now() - t > staleDays * DAY ? "stale" : "fresh"}">(${ago(t)})</span>` : '<span class="stale">never</span>';
function renderDbInfo() {
  const meta = lsGet("mtg.namesChecked", null), seen = lsGet("mtg.versionSeen", null);
  const extra = extraNames.filter(n => !DB.has(n)).length;
  const newest = PRINTS ? Object.entries(PRINTS.s).filter(([, v]) => v[1] && v[1] <= new Date().toISOString().slice(0, 10)).sort((p, q) => q[1][1].localeCompare(p[1][1]))[0] : null;
  const extraPrintCount = Object.values(extraPrints).reduce((a, l) => a + l.length, 0);
  $("#dbInfo").innerHTML =
    `<dt>App version</dt><dd>${esc(APP_VERSION)}${seen ? ` · on this phone since ${dateText(seen.at)}` : ""}</dd>` +
    // The card list is as current as the newer of: the list built into the app, or your last "Check for new cards".
    `<dt>Card list</dt><dd>${(DB.size + extra).toLocaleString()} cards · up to date as of ${freshness(Math.max(Date.parse(DATA_BUILT.cards), meta || 0), 30)}` +
      `<br><span class="small muted">${DB.size.toLocaleString()} built into the app (${dateText(Date.parse(DATA_BUILT.cards))})${extra ? ` + ${extra.toLocaleString()} new from Scryfall` : ""}</span></dd>` +
    `<dt>Set list</dt><dd>${PRINTS ? `${Object.keys(PRINTS.s).length} sets · built ${freshness(Date.parse(DATA_BUILT.prints), 120)}` : "loads on first use"}${newest ? `<br><span class="small muted">Newest: ${esc(newest[1][0])} (${esc(newest[0])}, ${dateText(Date.parse(newest[1][1]))})</span>` : ""}${extraPrintCount ? `<br><span class="small muted">+ ${extraPrintCount} newer printings from Scryfall</span>` : ""}</dd>` +
    `<dt>New cards check</dt><dd>${freshness(meta, 30)}</dd>` +
    `<dt>Prices</dt><dd>${freshness(PRICES.at || null, 2)}</dd>`;
  if (!PRINTS) loadPrints().then(p => { if (p && !$("#pane-set").hidden) renderDbInfo(); });
}

/* ---------- storage used ---------- */
const fmtBytes = n => n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? Math.round(n / 1e3) + " KB" : n + " B";
async function cacheUsage(match) {
  let bytes = 0, items = 0, opaque = 0;
  try {
    for (const name of await caches.keys()) {
      if (!match(name)) continue;
      const c = await caches.open(name);
      for (const req of await c.keys()) {
        items++;
        const r = await c.match(req); if (!r) continue;
        if (r.type === "opaque") { opaque++; continue; }   // pictures: the browser doesn't reveal their size
        const len = +r.headers.get("content-length");
        bytes += len > 0 ? len : (await r.clone().blob()).size;
      }
    }
  } catch (e) {}
  return { bytes, items, opaque };
}
async function renderStorage() {
  const el = $("#storageInfo"); if (!el) return;
  let local = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("mtg.")) local += (k.length + (localStorage.getItem(k) || "").length) * 2; } } catch (e) {}
  const [app, data, reader, pics] = await Promise.all([
    cacheUsage(n => n.startsWith("binder-v")), cacheUsage(n => n.startsWith("binder-data")),
    cacheUsage(n => n.startsWith("mtg-cdn")), cacheUsage(n => n === "mtg-img")]);
  const picBytes = pics.bytes + pics.opaque * 75e3;   // a card picture is about 75 KB
  const parts = [
    ["Your cards, decks, prices & settings", local, "var(--accent)"],
    ["Card list & set list", data.bytes, "#4a8f6a"],
    ["Text reader (scanner)", reader.bytes, "#5b7fb0"],
    ["App files", app.bytes, "#8a7fa8"],
    [`Card pictures (${pics.items})${pics.opaque ? " · estimate" : ""}`, picBytes, "#b07a5b"]
  ];
  const total = parts.reduce((a, p) => a + p[1], 0);
  el.innerHTML = parts.map(([l, b, c]) => `<dt><span class="sw" style="background:${c}"></span>${esc(l)}</dt><dd>${fmtBytes(b)}</dd>`).join("") + `<dt><b>Total</b></dt><dd><b>${fmtBytes(total)}</b></dd>`;
  $("#storeBar").innerHTML = total ? parts.filter(p => p[1] > 0).map(([l, b, c]) => `<span style="width:${(b / total * 100).toFixed(2)}%;background:${c}" title="${esc(l)}"></span>`).join("") : "";
  let q = "";
  try { const est = await navigator.storage.estimate(); if (est && est.quota) q = `The browser allows this app up to about ${fmtBytes(est.quota)} on this phone.`; } catch (e) {}
  $("#storageQuota").textContent = q;
  $("#btnClearPics").disabled = !pics.items;
}
$("#btnClearPics").onclick = async () => { try { await caches.delete("mtg-img"); } catch (e) {} toast("Saved card pictures cleared"); renderStorage(); };
$("#btnSaveKey").onclick = () => {
  const v = $("#apiKey").value.trim(); if (!v) { $("#keyStatus").textContent = "Paste your key first."; return; }
  if (!/^sk-ant-/.test(v)) { $("#keyStatus").textContent = "That doesn't look like a Claude API key. It should start with sk-ant-."; $("#keyStatus").className = "small err"; return; }
  lsSet("mtg.apiKey", v); S.engine = "claude"; lsSet("mtg.engine", "claude"); renderSettings(); toast("Key saved");
};
$("#btnClearKey").onclick = () => { try { localStorage.removeItem("mtg.apiKey"); } catch (e) {} renderSettings(); toast("Key removed"); };
$("#btnTestKey").onclick = async () => {
  const b = $("#btnTestKey"); b.disabled = true; $("#keyStatus").textContent = "Testing…"; $("#keyStatus").className = "small muted";
  try { const t = await askClaude("Reply with just the word OK.", 10, true); $("#keyStatus").textContent = "The key works."; $("#keyStatus").className = "small okmsg"; }
  catch (e) { $("#keyStatus").textContent = claudeErr(e); $("#keyStatus").className = "small err"; }
  finally { b.disabled = false; }
};
$("#btnUpdateNames").onclick = async () => {
  const b = $("#btnUpdateNames"); b.disabled = true; $("#namesStatus").textContent = "Checking Scryfall…"; $("#namesStatus").className = "small muted";
  try {
    const r = await fetch("https://api.scryfall.com/catalog/card-names", { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const fresh = (j.data || []).filter(n => !DB.has(n) && !(matcher && matcher.isCard(n)));
    extraNames = [...new Set(extraNames.concat(fresh))];
    lsSet("mtg.extraNames", extraNames); lsSet("mtg.namesChecked", Date.now());
    matcher = new CardMatcher.Matcher([...DB.keys()].concat(extraNames.filter(n => !DB.has(n))));
    $("#namesStatus").textContent = fresh.length ? `Added ${fresh.length} new card names.` : "Your card list is up to date.";
    $("#namesStatus").className = "small okmsg"; renderDbInfo();
  } catch (e) { $("#namesStatus").textContent = navigator.onLine ? "Scryfall couldn't be reached. Try again later." : "You're offline. Connect to the internet and try again."; $("#namesStatus").className = "small err"; }
  finally { b.disabled = false; }
};
$("#btnPrices").onclick = async () => {
  const b = $("#btnPrices"); if (!navigator.onLine) { toast("Prices need internet"); return; }
  b.disabled = true; b.textContent = "Updating…";
  await updatePrices(true); b.disabled = false; b.textContent = "Update prices now"; renderPriceInfo(); renderDbInfo(); toast("Prices updated");
};
$("#btnBackup").onclick = () => copyText(collText("all", true) + S.wl.order.filter(id => S.wl.lists[id].items.length).map(id => `\n\n# Wishlist: ${S.wl.lists[id].name}\n` + S.wl.lists[id].items.map(wishLine).join("\n")).join(""));
$("#btnReset").onclick = () => $("#resetConfirm").hidden = false;
$("#noReset").onclick = () => $("#resetConfirm").hidden = true;
$("#yesReset").onclick = () => { ["mtg.cards", "mtg.cols", "mtg.target", "mtg.view", "mtg.buildFrom", "mtg.decks", "mtg.apiKey", "mtg.engine", "mtg.wish", "mtg.wlists"].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} }); S.cols = { main: { name: "My collection", created: Date.now(), cards: {} } }; S.order = ["main"]; S.target = "main"; S.view = "all"; S.buildFrom = "all"; renderColSelects(); S.decks = []; S.wl = { order: ["wmain"], lists: { wmain: { name: "My wishlist", items: [] } }, cur: "wmain" }; S.deck = null; renderHeader(); renderSaved(); renderDeck(); $("#resetConfirm").hidden = true; renderSettings(); toast("Everything erased"); };
async function checkOffline() {
  try {
    const c = await caches.open("mtg-cdn-2"); const hits = await Promise.all([TESS.lib, TESS.worker, TESS.core + TESS.coreFiles[0]].map(u => c.match(u)));
    const ready = hits.every(Boolean);
    $("#offlineStatus").textContent = ready ? "The scanner is saved on this phone and works without internet." : "The scanner downloads the first time you scan (about 5 MB). Download it now if you'll be offline later.";
    $("#btnPrefetch").hidden = ready;
  } catch (e) { $("#offlineStatus").textContent = "Offline storage isn't available in this browser."; }
}
$("#btnPrefetch").onclick = async () => {
  const b = $("#btnPrefetch"); b.disabled = true; b.textContent = "Downloading…";
  try { await Promise.all([TESS.lib, TESS.worker, TESS.core + TESS.coreFiles[0], TESS.core + TESS.coreFiles[1]].map(u => fetch(u, { integrity: sriFor(u) }))); await getOcr(); toast("Scanner ready for offline use"); }
  catch (e) { toast("Download failed. Check your connection."); }
  finally { b.disabled = false; b.textContent = "Download scanner for offline use"; checkOffline(); }
};

/* ---------- install + updates ---------- */
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const ua = navigator.userAgent, isIOS = /iPhone|iPad|iPod/.test(ua), isAndroid = /Android/.test(ua), isSamsung = /SamsungBrowser/.test(ua);
if (!standalone && (isIOS || isAndroid) && !lsGet("mtg.hideInstall", false)) {
  if (isAndroid) $("#installText").innerHTML = isSamsung
    ? "Install: tap <b>≡</b> (menu) → <b>Add page to</b> → <b>Home screen</b>, then open Binder from your Home screen."
    : "Install: tap <b>⋮</b> (menu) → <b>Add to Home screen</b> or <b>Install app</b>, then open Binder from your Home screen.";
  $("#installBanner").hidden = false;
}
// Chrome and Samsung Internet on Android can show their own install prompt.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; $("#btnInstall").hidden = false; if (!lsGet("mtg.hideInstall", false)) $("#installBanner").hidden = false; });
$("#btnInstall").onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); try { await installPrompt.userChoice; } catch (e) {} installPrompt = null; $("#installBanner").hidden = true; };
window.addEventListener("appinstalled", () => { $("#installBanner").hidden = true; });
$("#btnHideInstall").onclick = () => { lsSet("mtg.hideInstall", true); $("#installBanner").hidden = true; };
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    // Apply a new version straight away unless a scan or review is in progress; then offer the button instead.
    const busy = () => S.photos.length || S.review.length || !$("#scanStatus").hidden || !$("#buildStatus").hidden;
    const show = w => { if (!busy()) { w.postMessage("skipWaiting"); return; } $("#updateBanner").hidden = false; $("#btnUpdate").onclick = () => w.postMessage("skipWaiting"); };
    if (reg.waiting && navigator.serviceWorker.controller) show(reg.waiting);
    reg.addEventListener("updatefound", () => { const w = reg.installing; w && w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) show(w); }); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (reloading) return; reloading = true; location.reload(); });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
window.addEventListener("online", renderEngine); window.addEventListener("offline", renderEngine);

/* ---------- boot ---------- */
const savedCols = lsGet("mtg.cols", null);
if (savedCols && savedCols.cols && Array.isArray(savedCols.order) && savedCols.order.length) { S.cols = savedCols.cols; S.order = savedCols.order.filter(id => S.cols[id]); }
else { S.cols = { main: { name: "My collection", created: Date.now(), cards: lsGet("mtg.cards", {}) || {} } }; S.order = ["main"]; }
if (!S.order.length) { S.cols.main = { name: "My collection", created: Date.now(), cards: {} }; S.order = ["main"]; }
// Cards saved by version 1.0 (before collections) go into the first collection, once.
const legacy = lsGet("mtg.cards", null);
if (savedCols && legacy && Object.keys(legacy).length) { const cards = S.cols[S.order[0]].cards; for (const [k, c] of Object.entries(legacy)) { if (cards[k]) cards[k].qty += c.qty; else cards[k] = c; } }
try { localStorage.removeItem("mtg.cards"); } catch (e) {}
S.target = lsGet("mtg.target", S.order[0]); S.view = lsGet("mtg.view", "all"); S.buildFrom = lsGet("mtg.buildFrom", "all");
renderColSelects(); persist();
S.decks = lsGet("mtg.decks", []) || [];
// Wishlists (version 1.11 had a single list in mtg.wish: it becomes "My wishlist").
S.wl = lsGet("mtg.wlists", null);
if (!S.wl || !Array.isArray(S.wl.order) || !S.wl.order.length || !S.wl.lists) {
  S.wl = { order: ["wmain"], lists: { wmain: { name: "My wishlist", items: lsGet("mtg.wish", []) || [] } }, cur: "wmain" };
  persistWish();
}
S.wl.order = S.wl.order.filter(id => S.wl.lists[id]); if (!S.wl.lists[S.wl.cur]) S.wl.cur = S.wl.order[0];
{ const legacyWish = lsGet("mtg.wish", null);   // any single-list wishlist still around joins the first list
  if (Array.isArray(legacyWish) && legacyWish.length && !S.wl.lists[S.wl.order[0]].items.length) { S.wl.lists[S.wl.order[0]].items = legacyWish; persistWish(); } }
try { localStorage.removeItem("mtg.wish"); } catch (e) {}
S.engine = lsGet("mtg.engine", "claude");
S.scanMode = lsGet("mtg.scanMode", "stacked") === "grid" ? "grid" : "stacked"; renderScanMode();
renderHeader(); renderSaved(); renderEngine();
if (!totals().n) $("#layoutTips").open = true;
showTab("coll");   // the app opens on the Collection tab
loadDB();
})();
