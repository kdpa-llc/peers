// Service worker: cache the app shell so the installed app opens instantly. Data is never
// cached: /api is always network-only (TECHNICAL.md §12).
const VERSION = "peers-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(["/", "/web/styles/tokens.css", "/web/styles/app.css"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.searchParams.has("pair")) return;
  // Network first, so a running server always serves the current client; the cache only
  // covers the moment the computer running Peers is unreachable.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && (url.pathname === "/" || url.pathname.startsWith("/web/") || url.pathname.startsWith("/src/vault/"))) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/"))),
  );
});
