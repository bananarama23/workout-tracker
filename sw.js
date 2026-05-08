const SW_VERSION = 'wt-shell-v20-pwa-tap-unlock';
const SHELL_CACHE = `wt-shell-${SW_VERSION}`;
const OFFLINE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(OFFLINE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k.startsWith('wt-shell-') && k !== SHELL_CACHE) ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isSensitiveRequest(reqUrl){
  try{
    const u = new URL(reqUrl);
    const p = (u.pathname || '').toLowerCase();
    const q = (u.search || '').toLowerCase();
    if (q.includes('token=') || q.includes('apikey=') || q.includes('api_key=') || q.includes('bridge_token=')) return true;
    if (p.includes('/health/') || p.includes('/calendar') || p.includes('/auth') || p.includes('/token')) return true;
    if (p.includes('/v1/chat') || p.includes('/v1/messages') || p.includes('/generativelanguage')) return true;
    return false;
  }catch(e){ return true; }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (isSensitiveRequest(req.url)) {
    event.respondWith(fetch(req));
    return;
  }

  // Network-first for script backend calls / dynamic APIs
  if (url.hostname.includes('script.google.com') || url.hostname.includes('googleapis.com')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // HTML/navigation: network-first so old Home Screen shells cannot keep
  // serving stale tap-guard code indefinitely. Offline still falls back cache.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req).then((res) => {
        const cpy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(req, cpy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./') || caches.match('./index.html')))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        const cpy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(req, cpy)).catch(() => {});
        return res;
      });
    })
  );
});
