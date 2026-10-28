const CACHE_NAME = "spendwise-shell-v3";
const PRIVATE_CACHE_PREFIX = "spendwise-private-";
const OFFLINE_USER_KEY = "/__spendwise_offline_user__";
const APP_SHELL = [
  "/offline.html",
  "/manifest.webmanifest",
  "/js/index-CAYczt9A.js",
  "/css/index-CvKw77_8.css",
  "/images/pwa-icon.svg",
  "/images/app-icon-192.png",
  "/images/app-icon-512.png",
  "/images/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(APP_SHELL);
      try {
        await cache.add("/clerk.browser.js");
      } catch (error) {
        console.warn("SpendWise could not pre-cache Clerk for offline use.", error);
      }
      try {
        await cache.add("/npm/@clerk/ui@1/dist/ui.browser.js");
      } catch (error) {
        console.warn("SpendWise could not pre-cache Clerk UI for offline use.", error);
      }
    })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("spendwise-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CLEAR_PRIVATE_DATA") {
    return;
  }
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(PRIVATE_CACHE_PREFIX))
        .map((key) => caches.delete(key))))
      .then(() => caches.open(CACHE_NAME))
      .then((cache) => cache.delete(OFFLINE_USER_KEY)),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith((async () => {
      let response;
      try {
        response = await fetch(request);
      } catch {
        const shellCache = await caches.open(CACHE_NAME);
        const userKey = await shellCache.match(OFFLINE_USER_KEY);
        const userId = userKey ? await userKey.text() : "";
        if (/^[a-f0-9]{64}$/.test(userId)) {
          const userCache = await caches.open(`${PRIVATE_CACHE_PREFIX}${userId}`);
          const cachedResponse = await userCache.match(request);
          if (cachedResponse) {
            const headers = new Headers(cachedResponse.headers);
            headers.set("X-SpendWise-Offline", "true");
            return new Response(cachedResponse.body, {
              status: cachedResponse.status,
              statusText: cachedResponse.statusText,
              headers,
            });
          }
        }
        return new Response(JSON.stringify({ error: "This data is not available offline yet. Reconnect and open it once to save an offline copy." }), {
          status: 503,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const userKey = response.headers.get("X-SpendWise-User");
      if (response.ok && /^[a-f0-9]{64}$/.test(userKey || "")) {
        try {
          const userCache = await caches.open(`${PRIVATE_CACHE_PREFIX}${userKey}`);
          await userCache.put(request, response.clone());
          const shellCache = await caches.open(CACHE_NAME);
          await shellCache.put(OFFLINE_USER_KEY, new Response(userKey));
        } catch (error) {
          console.error("SpendWise could not save a private offline data copy.", error);
        }
      }
      return response;
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/", response.clone());
        }
        return response;
      }).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return await cache.match("/") || await cache.match("/offline.html") || Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/js/")
      || url.pathname.startsWith("/css/")
      || url.pathname.startsWith("/images/")
      || /^\/npm\/@clerk\/ui@1(?:\/|\.)/.test(url.pathname)
      || url.pathname === "/clerk.browser.js"
      || url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            await cache.put(request, response.clone());
          }
          return response;
        } catch (error) {
          return await cache.match(request) || Response.error();
        }
      }),
    );
  }
});
