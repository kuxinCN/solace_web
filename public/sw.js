// Solace Service Worker - PWA 离线支持与秒开缓存
const CACHE_NAME = "solace-pwa-v1";
const STATIC_ASSETS = [
  "/logo.png",
  "/solace-wordmark.png",
  "/favicon.ico",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 1. API 接口、安装向导与第三方外链不走静态缓存，保证实时性与安全性
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/install") ||
    event.request.method !== "GET"
  ) {
    return;
  }

  // 2. 静态图标与资源优先使用缓存（Stale-While-Revalidate）
  if (
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".ico") ||
    url.pathname.endsWith(".woff2") ||
    url.pathname === "/manifest.json"
  ) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseToCache);
              });
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 3. 页面路由走 Network-First（保证最新状态），网络不可用时降级缓存
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

