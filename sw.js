// Patro service worker: lets the app open offline and install to the home screen.
// Pages load network-first (so updates show straight away), everything else cache-first.
// Supabase requests are never cached.
const CACHE = "patro-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "favicon.svg", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;

  // the app's own files: network first so updates arrive at once, cached copy when offline
  if (req.mode === "navigate" || url.origin === location.origin) {
    const key = req.mode === "navigate" ? "index.html" : req;
    e.respondWith(
      fetch(req)
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return res; })
        .catch(() => caches.match(key, { ignoreSearch: true }))
    );
    return;
  }

  // pinned library and font files never change: cache first
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && /jsdelivr|gstatic|googleapis/.test(url.hostname)) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});
