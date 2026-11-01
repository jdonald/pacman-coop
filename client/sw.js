// Service worker (template: the build fills in PRECACHE and VERSION).
// Offline-first: the whole app is cached at install time, so launching is
// instant and works with no network. Each deploy gets its own cache whose
// index.html and hashed assets always match. Game traffic (/ws, /health) is
// never intercepted.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `pcoop-${VERSION}`;
const FONT_CACHE = 'pcoop-fonts';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('pcoop-') && k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

const cacheFirst = async (cacheName, req) => {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Google Fonts: cache forever so the HUD font works offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(FONT_CACHE, req).catch(() => Response.error()));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/ws') || url.pathname.endsWith('/health')) return;
  if (req.mode === 'navigate') {
    // Any page URL (e.g. ?room=ABCD) is the same single-page app.
    e.respondWith(
      caches
        .open(CACHE)
        .then((c) => c.match('./'))
        .then((hit) => hit || fetch(req)),
    );
    return;
  }
  e.respondWith(cacheFirst(CACHE, req));
});
