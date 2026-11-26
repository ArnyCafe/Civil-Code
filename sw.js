// 離線快取：程式檔採「先網路後快取」，確保更新；離線時使用快取
const CACHE = 'law-notes-v2';
const CORE = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/diff.js',
  'js/ink.js',
  'js/xref.js',
  'data/laws.json',
  'data/xref.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'data/law/osh.json',
  'data/extra/osh.json',
  'data/law/osh-r.json',
  'data/law/osh-fac.json',
  'data/law/osh-mgmt.json',
  'data/law/osh-edu.json',
  'data/law/osh-health.json',
  'data/law/osh-cons.json',
  'data/law/lsa.json',
  'data/law/lsa-r.json',
  'data/law/lia.json',
  'data/law/oia.json',
  'data/law/gee.json',
  'data/law/apa.json',
  'data/law/crim.json',
  'data/civil.json',
  'data/rulings.json',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
