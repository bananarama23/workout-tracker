const SW_VERSION = 'wt-shell-v116-backend-capability-gate';
const SHELL_CACHE = `wt-shell-${SW_VERSION}`;
const OFFLINE_URLS = [
  './',
  './index.html',
  './PLUSULTRAINDEX%20copy%204.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './favicon.ico'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(OFFLINE_URLS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res);
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
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

function isSensitiveRequest(reqUrl) {
  try {
    const u = new URL(reqUrl);
    const p = (u.pathname || '').toLowerCase();
    const q = (u.search || '').toLowerCase();
    if (q.includes('token=') || q.includes('apikey=') || q.includes('api_key=') || q.includes('bridge_token=')) return true;
    if (p === '/health' || p.includes('/health/') || p.includes('/calendar') || p.includes('/auth') || p.includes('/token')) return true;
    if (p.startsWith('/v1/') || p.includes('/v1/chat') || p.includes('/v1/messages')) return true;
    if (u.hostname.includes('workers.dev') || u.hostname.includes('script.google.com') || u.hostname.includes('googleapis.com')) return true;
    if (u.hostname.includes('generativelanguage.googleapis.com') || u.hostname.includes('api.anthropic.com') || u.hostname.includes('api.openai.com')) return true;
    return false;
  } catch (_) {
    return true;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isSensitiveRequest(req.url)) {
    event.respondWith(fetch(req));
    return;
  }

  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req).then((res) => {
        const cpy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(req, cpy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html') || caches.match('./PLUSULTRAINDEX%20copy%204.html') || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (url.origin === location.origin) {
          const cpy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, cpy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
