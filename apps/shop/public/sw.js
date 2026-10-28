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

// Order updates pushed to the phone. The message is short and carries only a link back to the order.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* a plain-text push */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Your order', {
    body: data.body || 'There is an update on your order.',
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: data.tag, data: { url: data.url || '/account/orders' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/account/orders', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if ('focus' in c) { await c.focus(); if ('navigate' in c) await c.navigate(url); return; }
    await clients.openWindow(url);
  })());
});
