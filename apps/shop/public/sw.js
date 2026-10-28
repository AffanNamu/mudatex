// Makes the shop feel like an app: quick repeat visits, and a friendly page instead of a browser error when the line drops.
// It stores only this site's own pictures and built files. It never stores accounts, baskets, orders or API replies.
const STATIC = 'mudatex-shop-static-v1';
const PAGES = 'mudatex-shop-pages-v1';
const OFFLINE = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGES).then((c) => c.add(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== STATIC && k !== PAGES) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/sw.js') return;
  // Anything private stays out of the cache.
  if (/^\/(account|checkout|orders|login|trade|cart)(\/|$)/.test(url.pathname) || url.pathname.startsWith('/api/')) {
    if (req.mode === 'navigate') event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE)) || Response.error()));
    return;
  }
  // Built files are fingerprinted, so a stored copy is always right.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  // Public pages: the network first, the last copy if the line is down, else the offline page.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(PAGES)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || (await caches.match(OFFLINE)) || Response.error();
      }
    })());
  }
});
