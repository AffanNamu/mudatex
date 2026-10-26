// Keeps the console's pages available when the connection drops, so a till can carry on selling cash offline (ADR 002).
// It stores only this site's own files. It never stores API replies: those are handled by the till's own offline database.
const CACHE = 'mudatex-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// The first visit loads the app before this worker is in charge, so the page tells the worker which files it used.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'precache' && Array.isArray(event.data.urls)) event.waitUntil(precache(event.data.urls));
});
async function precache(urls) {
  const cache = await caches.open(CACHE);
  for (const u of urls) {
    try {
      const url = new URL(u, self.location.origin);
      if (url.origin !== self.location.origin || url.pathname === '/sw.js') continue;
      const res = await fetch(url);
      if (res.ok) await cache.put(url.pathname === '/' ? '/index.html' : url, res);
    } catch { /* a file that cannot be fetched now is simply not stored */ }
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/sw.js') return;

  // Pages: the network when there is one (always the latest), else the last copy of the app.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put('/index.html', res.clone());
        return res;
      } catch {
        return (await cache.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  // Built files have a fingerprint in their name, so a stored copy is always right.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Settings and everything else: the network first, the stored copy when offline.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req)) || Response.error();
    }
  })());
});
