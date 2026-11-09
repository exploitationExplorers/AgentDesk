/* Only public, same-origin application assets may enter this cache. */
const CACHE = "agentdesk-cloud-shell-v1";
const PUBLIC_PATHS = new Set(["/cloud.html", "/cloud-icon.svg", "/manifest.webmanifest"]);
const isPublicAsset = (url) =>
  PUBLIC_PATHS.has(url.pathname) ||
  /^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css|woff2?|svg|png)$/.test(url.pathname);
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...PUBLIC_PATHS])));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("agentdesk-cloud-shell-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("message", (event) => {
  if (event.data === "activate-update") void self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.search ||
    !isPublicAsset(url)
  )
    return;
  event.respondWith(
    fetch(event.request, { credentials: "omit", cache: "no-cache" })
      .then(async (response) => {
        if (response.ok && response.type === "basic" && !response.headers.has("set-cookie")) {
          const cache = await caches.open(CACHE);
          await cache.put(event.request, response.clone());
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) ?? Response.error()),
  );
});
