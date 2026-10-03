(function () {
"use strict";
const APP_VERSION = "1.6.1";
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
  coreFiles: ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"]
};
const CLAUDE_MODELS = ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"];

/* ---------- state + storage ---------- */
const S = { scanMode: "stacked", cols: {}, order: [], target: "main", view: "all", buildFrom: "all", decks: [], photos: [], review: [], leftovers: [], fmt: "casual", colors: new Set(), filter: new Set(), deck: null, engine: "claude" };
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
      const m = out[k] || (out[k] = { name: c.name, qty: 0, added: 0, where: {} });
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
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600); }
async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); toast("Copied"); }
  catch (e) { const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Copied"); } catch (_) { toast("Select and copy the text manually"); } ta.remove(); }
}
function suggHTML(list, attr) { return list.map(n => `<button data-${attr}="${esc(n)}">${esc(n)}</button>`).join(""); }

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  ["scan", "coll", "deck", "set"].forEach(n => $("#pane-" + n).hidden = n !== name);
  renderColSelects();
  if (name === "coll") renderColl();
  if (name === "deck") renderEngine();
  if (name === "set") renderSettings();
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function renderHeader() { const t = totals(); $("#hdrCount").textContent = `${t.n} card${t.n === 1 ? "" : "s"} · ${t.u} unique`; }

/* ---------- collection changes ---------- */
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
    byCol[id] = (byCol[id] || 0) + c.qty;
  }
  persist(); renderHeader(); renderColSelects();
  fetchMissingDetails(items.map(i => i.name));
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
function loadScript(src) { return new Promise((res, rej) => { if (window.Tesseract) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load the text reader")); document.head.appendChild(s); }); }
async function blobUrlFor(url, suffix) {
  const r = await fetch(url); if (!r.ok) throw new Error("Download failed (" + r.status + ")");
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
  const found = new Map(); const leftovers = new Set(); const notes = []; let hint = null;
  try {
    let worker;
    try { worker = await getOcr(); } catch (e) { throw { code: "ocr_load", message: String(e && e.message || e) }; }
    try { await worker.setParameters({ tessedit_pageseg_mode: "11" }); } catch (e) {}
    const scanner = S.scanMode === "grid" ? ScanGrid : ScanStacked;
    for (let i = 0; i < S.photos.length; i++) {
      const lbl = S.photos.length > 1 ? `Photo ${i + 1} of ${S.photos.length}` : (S.scanMode === "grid" ? "Grid" : "Stack");
      // Everything a scanner needs: the reader, the card list, and a way to report progress or stop.
      const ctx = {
        worker, matcher, psm: 11,
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
      if (res.grid && !res.hint) notes.push(`${S.photos.length > 1 ? `Photo ${i + 1}: ` : ""}found a grid of ${res.grid.rows} × ${res.grid.cols}.`);
      if (res.hint) hint = res.hint;
      for (const c of res.cards) { const f = found.get(c.name); if (f) { f.qty += c.qty; f.score = Math.min(f.score, c.score); } else found.set(c.name, { name: c.name, qty: c.qty, score: c.score }); }
      res.leftovers.forEach(l => leftovers.add(l));
    }
    S.review = [...found.values()].map(c => ({ name: c.name, qty: c.qty, low: c.score < 0.95 }));
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
    const sug = !known && matcher ? matcher.suggest(c.name, 3) : [];
    const ci = info(c.name);
    return `<div class="crow rv">
      <input class="nm-edit" type="text" id="rv-${i}" data-i="${i}" value="${esc(c.name)}" aria-label="Card name" autocomplete="off">
      <div class="meta">${ci ? costHTML(ci.c) + `<span>${esc(ci.t)}</span>` : ""}${!known ? '<span class="badge bad">unknown</span>' : c.low ? '<span class="badge low">check</span>' : ""}${c.col && c.col !== S.target ? `<span class="badge ex">→ ${esc(colName(c.col))}</span>` : ""}<button class="ghost small" data-rm="${i}">Remove</button></div>
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
  S.review[i].name = e.target.value; S.review[i].low = false;
  clearTimeout(reviewEditTimer);
  reviewEditTimer = setTimeout(() => { const pos = e.target.selectionStart; renderReview(); const el = $("#rv-" + i); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (_) {} } }, 700);
});
$("#reviewList").addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.inc != null) S.review[t.dataset.inc].qty++;
  else if (t.dataset.dec != null) { const c = S.review[t.dataset.dec]; c.qty = Math.max(1, c.qty - 1); }
  else if (t.dataset.rm != null) S.review.splice(+t.dataset.rm, 1);
  else if (t.dataset.fix != null) { S.review[t.dataset.fix].name = t.dataset.name; S.review[t.dataset.fix].low = false; }
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
  const items = S.review.filter(c => c.name.trim()).map(c => ({ name: (matcher && matcher.canonical(c.name)) || c.name.trim(), qty: c.qty, col: c.col }));
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
  const items = []; let col = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    const h = /^#+\s*collection:\s*(.+)$/i.exec(line);
    if (h) { col = newCollection(h[1]); continue; }
    if (!line || line.startsWith("#") || /^(deck|sideboard|commander|companion|maybeboard|about|name .*)$/i.test(line)) continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    let qty = 1, name = line; if (m) { qty = parseInt(m[1], 10) || 1; name = m[2]; }
    name = name.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/\s*\([A-Z0-9]{2,6}\)\s*\S*\s*(\*F\*)?$/, "").replace(/^[-•*]\s*/, "").trim();
    if (!name) continue;
    const can = matcher && (matcher.canonical(name) || (matcher.matchLine(name) || {}).name);
    items.push({ name: can || name, qty, low: !can || keyOf(can) !== keyOf(name), col: col || undefined });
  }
  if (!items.length) return;
  for (const it of items) { const ex = S.review.find(r => r.name === it.name && r.col === it.col); if (ex) ex.qty += it.qty; else S.review.push(it); }
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
  const t = totals(view); $("#collSummary").textContent = `${t.n} cards · ${t.u} unique`;
  renderManage();
  if (!all.length) {
    body.innerHTML = view === "all" && !totals().n ? `<div class="empty"><h2>No cards yet</h2>
      <ol><li>On <b>Scan</b>, pick or create the collection to save to.</li><li>Photograph a stack of cards, check the names, then add them.</li><li>Open <b>Deck</b> to build from what you own.</li></ol>
      <div class="row"><button class="primary" id="goScan">Scan cards</button></div></div>`
      : `<div class="empty"><h2>${esc(colName(view))} is empty</h2><p class="muted">Choose it under <b>Saving to</b> on the Scan tab, then scan or type cards in.</p><div class="row"><button class="primary" id="goScan">Scan into ${esc(colName(view))}</button></div></div>`;
    $("#goScan").onclick = () => { if (view !== "all") { S.target = view; persist(); renderColSelects(); } showTab("scan"); }; return;
  }
  const q = keyOf($("#collSearch").value); const sort = $("#collSort").value;
  let rows = all.filter(([k, c]) => { const ci = info(c.name) || {}; return (!q || k.includes(q) || (ci.t || "").toLowerCase().includes(q) || (ci.o || "").toLowerCase().includes(q)) && (!S.filter.size || S.filter.has(colorBucket(c.name))); });
  const mv = c => (info(c.name) || {}).v || 0;
  rows.sort((a, b) => sort === "cmc" ? (mv(a[1]) - mv(b[1])) || a[0].localeCompare(b[0]) : sort === "qty" ? (b[1].qty - a[1].qty) || a[0].localeCompare(b[0]) : sort === "added" ? (b[1].added || 0) - (a[1].added || 0) : a[0].localeCompare(b[0]));
  const single = view !== "all";
  body.innerHTML = rows.length ? `<div class="list">${rows.map(([k, c]) => { const ci = info(c.name); const ids = Object.keys(c.where); return `
    <div class="crow">
      <button class="nm" data-open="${esc(k)}">${esc(c.name)}</button>
      <div class="meta">${ci ? costHTML(ci.c) + `<span>${esc(ci.t)}</span>` : '<span class="badge bad">not in card list</span>'}${!single && S.order.length > 1 ? `<span>· ${ids.map(id => esc(colName(id))).join(", ")}</span>` : ""}</div>
      ${single ? `<div class="ctl stepper"><button data-cdec="${esc(k)}" aria-label="Fewer ${esc(c.name)}">−</button><span>${c.qty}</span><button data-cinc="${esc(k)}" aria-label="More ${esc(c.name)}">+</button></div>`
        : `<div class="ctl"><span class="badge" style="font-size:.85rem">×${c.qty}</span></div>`}
    </div>`; }).join("")}</div>` : `<p class="muted">No cards match.</p>`;
}
$("#collBody").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.open) { openCard(b.dataset.open); return; }
  const k = b.dataset.cinc ?? b.dataset.cdec; const col = S.cols[S.view]; if (k == null || !col || !col.cards[k]) return;
  if (b.dataset.cinc != null) col.cards[k].qty++; else { col.cards[k].qty--; if (col.cards[k].qty <= 0) delete col.cards[k]; }
  persist(); renderHeader(); renderColl();
});
// Text backup: one "# Collection:" header per collection, so pasting it back recreates them.
function collText(scope) {
  return (scope === "all" ? S.order : [scope]).filter(id => Object.keys(S.cols[id].cards).length).map(id =>
    `# Collection: ${S.cols[id].name}\n` + Object.values(S.cols[id].cards).sort((a, b) => a.name.localeCompare(b.name)).map(c => `${c.qty} ${c.name}`).join("\n")).join("\n\n");
}
$("#btnCopyColl").onclick = () => copyText(collText(S.view));

/* ---------- managing collections ---------- */
$("#viewSel").onchange = e => { S.view = e.target.value; persist(); $("#delColConfirm").hidden = true; renderColl(); };
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
  for (const [k, c] of Object.entries(from.cards)) { if (to.cards[k]) to.cards[k].qty += c.qty; else to.cards[k] = { ...c }; }
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
  const img = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.name)}&format=image&version=normal`;
  const qty = {}; for (const id of S.order) qty[id] = c.where[id] || 0;
  const whereHTML = () => S.order.map(id => `<div class="wrow"><span>${esc(S.cols[id].name)}</span><div class="stepper"><button data-wdec="${id}" aria-label="Fewer in ${esc(S.cols[id].name)}">−</button><span>${qty[id]}</span><button data-winc="${id}" aria-label="More in ${esc(S.cols[id].name)}">+</button></div></div>`).join("");
  $("#sheet").innerHTML = `<div class="grab"></div>
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><h2 style="min-width:0">${esc(c.name)}</h2><button class="ghost" id="shClose" aria-label="Close">✕</button></div>
    <div class="cardimg" id="shImg">${navigator.onLine ? `<img src="${img}" alt="${esc(c.name)}" loading="lazy">` : "Picture needs internet"}</div>
    ${ci ? `<div class="stack" style="gap:6px"><div class="row">${costHTML(ci.c)}<span class="small muted">mana value ${ci.v}</span></div><b>${esc(ci.t)}${ci.p ? " · " + esc(ci.p) : ""}${ci.l ? " · loyalty " + esc(ci.l) : ""}</b>${ci.o ? `<p class="oracle">${esc(ci.o)}</p>` : ""}</div>` : `<p class="note">This name isn't in the card list. If it's misspelled, rename it below.</p>`}
    <div class="stack" style="gap:6px"><h3>Copies in each collection</h3><div class="where" id="shWhere">${whereHTML()}</div><p class="small muted">To move a copy, take it out of one collection and add it to another.</p></div>
    <label class="field">Rename / correct this card<input type="text" id="shName" value="${esc(c.name)}" autocomplete="off" autocapitalize="words"></label>
    <div class="sugg" id="shSugg"></div>
    <div class="row"><button class="primary" id="shSave" style="flex:1">Save</button><button class="ghost danger" id="shDel">Remove everywhere</button></div>
    <div class="panel" id="shDelConfirm" hidden><p>Remove all ${c.qty} cop${c.qty === 1 ? "y" : "ies"} of ${esc(c.name)} from every collection?</p><div class="row"><button class="primary" id="shYes">Remove</button><button id="shNo">Keep</button></div></div>
    <a class="small" href="https://scryfall.com/search?q=${encodeURIComponent('!"' + c.name + '"')}" target="_blank" rel="noopener">Open on Scryfall</a>`;
  $("#sheetBg").hidden = false;
  const im = $("#shImg img"); if (im) im.onerror = () => { $("#shImg").textContent = "No picture available"; };
  $("#shClose").onclick = closeSheet;
  $("#shWhere").onclick = e => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.winc) qty[b.dataset.winc]++; else if (b.dataset.wdec) qty[b.dataset.wdec] = Math.max(0, qty[b.dataset.wdec] - 1); else return;
    $("#shWhere").innerHTML = whereHTML(); };
  $("#shName").oninput = () => { const v = $("#shName").value; $("#shSugg").innerHTML = matcher && v.trim().length >= 2 && !matcher.isCard(v) ? suggHTML(matcher.suggest(v, 5), "pick") : ""; };
  $("#shSugg").onclick = e => { const b = e.target.closest("button[data-pick]"); if (!b) return; $("#shName").value = b.dataset.pick; $("#shSugg").innerHTML = ""; };
  $("#shSave").onclick = () => {
    const raw = $("#shName").value.trim() || c.name;
    const name = (matcher && matcher.canonical(raw)) || raw; const nk = keyOf(name);
    for (const id of S.order) {
      const cards = S.cols[id].cards; const old = cards[k]; delete cards[k];
      const q = qty[id]; if (q <= 0) continue;
      if (nk !== k && cards[nk]) cards[nk].qty += q;
      else cards[nk] = { name, qty: q, added: old ? old.added : Date.now() };
    }
    if (nk !== k) fetchMissingDetails([name]);
    persist(); renderHeader(); renderColl(); closeSheet(); toast("Saved");
  };
  $("#shDel").onclick = () => $("#shDelConfirm").hidden = false;
  $("#shNo").onclick = () => $("#shDelConfirm").hidden = true;
  $("#shYes").onclick = () => { for (const id of S.order) delete S.cols[id].cards[k]; persist(); renderHeader(); renderColl(); closeSheet(); toast("Removed"); };
}
function closeSheet() { $("#sheetBg").hidden = true; $("#sheet").innerHTML = ""; }
$("#sheetBg").addEventListener("click", e => { if (e.target === $("#sheetBg")) closeSheet(); });

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
function renderDeck() {
  const d = S.deck; const out = $("#deckOut"); if (!d) { out.innerHTML = ""; return; }
  const groups = {}; d.cards.forEach(c => { const g = mainType(c.type); (groups[g] = groups[g] || []).push(c); });
  const landCount = Object.values(d.lands).reduce((a, b) => a + b, 0) + (groups.land || []).reduce((a, c) => a + c.qty, 0);
  const creatures = (groups.creature || []).reduce((a, c) => a + c.qty, 0);
  const nonland = d.cards.filter(c => mainType(c.type) !== "land");
  const nq = nonland.reduce((a, c) => a + c.qty, 0);
  const avg = nq ? (nonland.reduce((a, c) => a + c.cmc * c.qty, 0) / nq).toFixed(1) : "–";
  let html = `<div class="panel">
    <div class="deckhead"><span class="arch">${esc(d.archetype)} · ${FORMATS[d.fmt].label}${d.builtBy ? " · by " + esc(d.builtBy) : ""}</span>${d.from ? `<span class="small muted">From: ${esc(d.from)}</span>` : ""}<label class="field" style="gap:4px"><span class="small muted">Deck name</span><input type="text" id="deckName" class="deckname" value="${esc(d.name)}" maxlength="60" autocomplete="off" autocapitalize="words" aria-label="Deck name"></label>${d.commander ? `<p><b>Commander:</b> ${esc(d.commander)}</p>` : ""}<p class="muted">${esc(d.summary)}</p></div>
    <div class="stats"><div class="stat"><b>${d.total}</b><span>cards</span></div><div class="stat"><b>${landCount}</b><span>lands</span></div><div class="stat"><b>${avg}</b><span>avg mana value</span></div></div>
    <div class="curve"><h3>Mana curve <span class="small">(${creatures} creatures)</span></h3>${curveSVG(d.cards)}</div>
    ${d.fixes && d.fixes.length ? `<ul class="tips" style="color:var(--warn)">${d.fixes.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  </div>`;
  for (const [g, label] of GROUP_ORDER) {
    const list = (groups[g] || []).slice().sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name));
    const basics = g === "land" ? Object.entries(d.lands) : [];
    if (!list.length && !basics.length) continue;
    const n = list.reduce((a, c) => a + c.qty, 0) + basics.reduce((a, [, q]) => a + q, 0);
    html += `<div class="group"><h3>${label} (${n})</h3><div class="list">` +
      list.map(c => `<div class="drow"><span class="q">${c.qty}</span><span class="nm"><b>${esc(c.name)}</b></span>${costHTML(c.manaCost)}${c.why ? `<span class="why">${esc(c.why)}</span>` : ""}</div>`).join("") +
      basics.map(([nm, q]) => `<div class="drow"><span class="q">${q}</span><span class="nm"><b>${esc(nm)}</b></span><span class="small muted">basic</span></div>`).join("") + `</div></div>`;
  }
  if ((d.howToPlay && d.howToPlay.length) || d.notes) html += `<div class="panel prose">${d.howToPlay.length ? `<h3>How to play it</h3><ul>${d.howToPlay.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}${d.notes ? `<h3>Notes</h3><p>${esc(d.notes)}</p>` : ""}</div>`;
  const lo = leftovers(d);
  html += `<details class="panel" id="leftDeck"><summary>Cards not in this deck (${lo.total})</summary>
    <p class="small muted">Everything you own in ${esc(lo.from)} that this deck doesn't use, grouped by color. Basic lands aren't listed.</p>
    ${lo.groups.length ? lo.groups.map(g => `<div class="group"><h3>${esc(g.label)} (${g.n})</h3><div class="list">${g.cards.map(c => `<div class="drow"><span class="q">${c.qty}</span><span class="nm"><b>${esc(c.name)}</b></span>${costHTML(c.cost)}<span class="why">${esc(c.type || "")}</span></div>`).join("")}</div></div>`).join("") : `<p class="muted">This deck uses every card you own there.</p>`}
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
  checkOffline();
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { $("#persistStatus").textContent = p ? "This phone has agreed to keep the app's data." : "Tip: opening the app from your Home Screen regularly keeps iOS from clearing its data."; });
}
function renderDbInfo() {
  const meta = lsGet("mtg.namesChecked", null);
  $("#dbInfo").innerHTML = `<dt>Cards</dt><dd>${(DB.size + extraNames.filter(n => !DB.has(n)).length).toLocaleString()}</dd><dt>Added from Scryfall</dt><dd>${extraNames.filter(n => !DB.has(n)).length.toLocaleString()} new names</dd><dt>Last checked</dt><dd>${meta ? new Date(meta).toLocaleDateString() : "never"}</dd>`;
}
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
$("#btnBackup").onclick = () => copyText(collText("all"));
$("#btnReset").onclick = () => $("#resetConfirm").hidden = false;
$("#noReset").onclick = () => $("#resetConfirm").hidden = true;
$("#yesReset").onclick = () => { ["mtg.cards", "mtg.cols", "mtg.target", "mtg.view", "mtg.buildFrom", "mtg.decks", "mtg.apiKey", "mtg.engine"].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} }); S.cols = { main: { name: "My collection", created: Date.now(), cards: {} } }; S.order = ["main"]; S.target = "main"; S.view = "all"; S.buildFrom = "all"; renderColSelects(); S.decks = []; S.deck = null; renderHeader(); renderSaved(); renderDeck(); $("#resetConfirm").hidden = true; renderSettings(); toast("Everything erased"); };
async function checkOffline() {
  try {
    const c = await caches.open("mtg-cdn"); const hits = await Promise.all([TESS.lib, TESS.worker, TESS.core + TESS.coreFiles[0]].map(u => c.match(u)));
    const ready = hits.every(Boolean);
    $("#offlineStatus").textContent = ready ? "The scanner is saved on this phone and works without internet." : "The scanner downloads the first time you scan (about 5 MB). Download it now if you'll be offline later.";
    $("#btnPrefetch").hidden = ready;
  } catch (e) { $("#offlineStatus").textContent = "Offline storage isn't available in this browser."; }
}
$("#btnPrefetch").onclick = async () => {
  const b = $("#btnPrefetch"); b.disabled = true; b.textContent = "Downloading…";
  try { await Promise.all([TESS.lib, TESS.worker, TESS.core + TESS.coreFiles[0], TESS.core + TESS.coreFiles[1]].map(u => fetch(u))); await getOcr(); toast("Scanner ready for offline use"); }
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
S.engine = lsGet("mtg.engine", "claude");
S.scanMode = lsGet("mtg.scanMode", "stacked") === "grid" ? "grid" : "stacked"; renderScanMode();
renderHeader(); renderSaved(); renderEngine();
if (!totals().n) $("#layoutTips").open = true;
loadDB();
})();
