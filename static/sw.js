// 最小 Service Worker：仅满足 PWA 安装条件，网络请求全部直通（不缓存）。
// 局域网应用必须保证每次都拿到最新前端资源，任何缓存策略都可能造成模块图版本错乱。
self.addEventListener("install", (event) => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return
  }
  event.respondWith(fetch(event.request))
})
