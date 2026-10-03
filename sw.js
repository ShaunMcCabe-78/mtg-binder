/* Offline support: keeps the app, card list and text reader on the phone.
   App files are re-downloaded on each version; the big data files live in their own cache and are kept across updates. */
const VERSION = "binder-v1.5.0";
const DATA_CACHE = "binder-data-1";   // bump only when cards.json or the reader data changes
const APP = ["./", "index.html", "app.js", "matcher.js", "namebars.js", "builder.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
const DATA = ["cards.json", "eng.traineddata.gz"];

// Always fetch fresh copies (skip the browser's HTTP cache) when installing a new version.
const fresh = u => new Request(u, { cache: "reload" });

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const app = await caches.open(VERSION);
    await app.addAll(APP.map(fresh));
    const data = await caches.open(DATA_CACHE);
    for (const u of DATA) if (!(await data.match(u))) await data.add(fresh(u));
  })());
});
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith("binder-v") && k !== VERSION) || (k.startsWith("binder-data") && k !== DATA_CACHE)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") c.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "api.anthropic.com") return;
  if (url.hostname === "api.scryfall.com" && !url.searchParams.has("format")) return;
  if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(cacheFirst(req, "mtg-cdn")); return;
  }
  if (url.hostname === "api.scryfall.com" || url.hostname.endsWith("scryfall.io")) {
    e.respondWith(cacheFirst(req, "mtg-img")); return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const file = url.pathname.split("/").pop();
      const cacheName = DATA.includes(file) ? DATA_CACHE : VERSION;
      const c = await caches.open(cacheName);
      const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await c.match("index.html") : null);
      if (hit) return hit;
      try { return await fetch(req); } catch (err) { return new Response("Offline", { status: 503 }); }
    })());
  }
});
