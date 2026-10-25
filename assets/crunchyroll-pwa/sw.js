// SPDX-License-Identifier: Apache-2.0
const CACHE_PREFIX = "bun-crunchyroll-shortcut-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHELL_PATHS = new Set([
  "/pwa/",
  "/pwa/index.html",
  "/pwa/app.js",
  "/pwa/styles.css",
  "/pwa/locales.js",
  "/pwa/manifest.webmanifest",
  "/pwa/icons/icon192.png",
  "/pwa/icons/icon512.png",
]);
self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const path of SHELL_PATHS) {
        const request = new Request(new URL(path, self.location.origin), {
          cache: "reload",
          credentials: "omit",
        });
        const response = await fetch(request);
        if (!response.ok || response.redirected || response.type !== "basic")
          throw new Error("Local shell asset unavailable");
        await cache.put(request, response);
      }
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.search ||
    !SHELL_PATHS.has(url.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cached = await (await caches.open(CACHE_NAME)).match(url.href);
      return cached || fetch(event.request);
    })(),
  );
});
