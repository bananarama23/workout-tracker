const SW_VERSION = 'wt-shell-v153-nutrition-insight-date-safe';
const SHELL_CACHE = `wt-shell-${SW_VERSION}`;
const WT_BLOCK_PUBLIC_GITHUB_PAGES = /\.github\.io$/i.test((self.location && self.location.hostname) || '');
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

function wtBlockedGithubPagesResponse() {
  return new Response('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex,nofollow"><title>Workout Tracker</title><style>html,body{margin:0;min-height:100%;background:#07090c;color:#ecf0f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;}main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px;text-align:center;}section{max-width:420px;}h1{font-size:1.35rem;margin:0 0 10px;}p{color:#8a95a8;line-height:1.5;margin:0;}</style></head><body><main><section><h1>Private app moved</h1><p>This GitHub Pages address no longer serves the Workout Tracker. Open the Cloudflare-protected app instead.</p></section></main></body></html>', {
    status: 410,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (WT_BLOCK_PUBLIC_GITHUB_PAGES) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.skipWaiting();
      return;
    }
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
    await Promise.all(keys.map((k) => (WT_BLOCK_PUBLIC_GITHUB_PAGES || (k.startsWith('wt-shell-') && k !== SHELL_CACHE)) ? caches.delete(k) : Promise.resolve()));
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
  if (WT_BLOCK_PUBLIC_GITHUB_PAGES) {
    event.respondWith(wtBlockedGithubPagesResponse());
    return;
  }
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
