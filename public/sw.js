// PharmaTools service worker: caches the static app shell only.
// API responses, QR verification pages and Wallet endpoints contain patient
// data and are never cached.
const VERSION = 'pharmatools-v1';
const SHELL = [
  '/', '/index.html', '/claim.html', '/card.html', '/manifest.webmanifest',
  '/css/app.css', '/css/card.css', '/css/print-id1.css', '/css/print-a4.css',
  '/js/core.js', '/js/app.js', '/js/cardRender.js', '/js/claim.js', '/js/webcard.js', '/js/patientI18n.js', '/js/platform.js',
  '/shared/clinical.js', '/shared/cardText.js',
  '/fonts/sarabun-thai-400-normal.woff2', '/fonts/sarabun-thai-600-normal.woff2', '/fonts/sarabun-thai-700-normal.woff2',
  '/fonts/sarabun-latin-400-normal.woff2', '/fonts/sarabun-latin-600-normal.woff2', '/fonts/sarabun-latin-700-normal.woff2',
  '/icons/icon-192.png', '/icons/icon-512.png',
];
const NEVER_CACHE = /^\/(api|v|wallet)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || NEVER_CACHE.test(url.pathname)) return;
  // Network first so updates land immediately; fall back to the cached shell offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && (SHELL.includes(url.pathname) || url.pathname === '/claim' || url.pathname === '/card')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match(url.pathname === '/card' ? '/card.html' : url.pathname === '/claim' ? '/claim.html' : '/index.html'))),
  );
});
