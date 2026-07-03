// Day — Life Manager service worker.
// Bump CACHE_VERSION on every deploy so old caches are purged and the new build
// reaches the installed PWA without a reinstall.
const CACHE_VERSION = "day-v16";

// App shell precached on install. index.html and the JS modules are fetched
// network-first below, so a stale copy here is only ever an offline fallback.
const SHELL = [
  "./",
  "./index.html",
  "./WORKFLOW.md",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./js/state.js",
  "./js/routines.js",
  "./js/workout.js",
  "./js/calendar.js",
  "./js/travel.js",
  "./js/timeline.js",
  "./js/app.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache API writes

  const url = new URL(req.url);

  // Never touch external APIs / sign-in / calendar / maps — always go to network.
  if (/(googleapis\.com|accounts\.google\.com|gstatic\.com|nominatim\.openstreetmap\.org|router\.project-osrm\.org|api\.tomtom\.com|office365\.com|office\.com|outlook\.com|live\.com|maps\.googleapis\.com)/.test(url.host)) {
    return;
  }

  // Same-origin app code (index.html + js modules): network-first so deploys
  // propagate without a reinstall; fall back to cache when offline.
  const isAppCode =
    req.mode === "navigate" ||
    (url.origin === self.location.origin && /\.(html|js)$/.test(url.pathname)) ||
    (url.origin === self.location.origin && /\/$/.test(url.pathname));

  if (isAppCode) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          const key = req.mode === "navigate" ? "./index.html" : req;
          caches.open(CACHE_VERSION).then((c) => c.put(key, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match("./index.html")).then((r) => r || caches.match("./"))
        )
    );
    return;
  }

  // Everything else (icons, third-party libs): cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
