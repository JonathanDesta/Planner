const CACHE = "day-campus-v2-0-3-weekday";
const BASE = new URL("./", self.location.href).pathname;
const FILES = [
  "./",
  "index.html",
  "styles.css",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "js/app.js",
  "js/dates.js",
  "js/state.js",
  "js/routines.js",
  "js/calendar.js",
  "js/travel.js",
  "js/facilities.js",
  "js/timeline.js",
  "js/workout.js",
  "js/cloud-sync.js",
  "js/google-auth.js",
];
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(FILES.map((url) => new Request(url, { cache: "reload" }))),
      ),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE")
    event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                (key.startsWith("day-campus-") || /^day-v\d+$/.test(key)) &&
                key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(BASE)
  )
    return;
  event.respondWith(
    caches
      .open(CACHE)
      .then(
        async (cache) =>
          (await cache.match(event.request, { ignoreSearch: true })) ||
          fetch(event.request),
      ),
  );
});
