/* Offline support: keeps the app, card list and text reader on the phone. */
const VERSION = "binder-v1.0.0";
const APP = ["./", "index.html", "app.js", "matcher.js", "builder.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png", "cards.json", "eng.traineddata.gz"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP)));
});
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("binder-") && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: false });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") c.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache calls to Claude or Scryfall's search API.
  if (url.hostname === "api.anthropic.com") return;
  if (url.hostname === "api.scryfall.com" && !url.searchParams.has("format")) return;
  // Text reader files and fonts: keep a copy once downloaded.
  if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(cacheFirst(req, "mtg-cdn")); return;
  }
  // Card pictures: keep the ones you've looked at.
  if (url.hostname === "api.scryfall.com" || url.hostname.endsWith("scryfall.io")) {
    e.respondWith(cacheFirst(req, "mtg-img")); return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await c.match("index.html") : null);
      if (hit) return hit;
      try { return await fetch(req); } catch (err) { return new Response("Offline", { status: 503 }); }
    })());
  }
});
