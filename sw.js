// Herd Book service worker: keeps the app on the phone so it opens with no signal.
const CACHE = 'herdbook-v26';
const OCR = 'herdbook-ocr-1';   // the collar scanner: big, rarely changes, kept across app updates
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './qrcode.js', './xlsx.mini.min.js', './jsqr.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== OCR).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const font = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== self.location.origin && !font) return;   // sync calls go straight to Google

  if (req.mode === 'navigate') {
    // Try the network briefly for updates; fall back to the copy on the phone.
    e.respondWith((async () => {
      const cached = await caches.match('./index.html');
      try {
        const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), cached ? 2500 : 20000))]);
        if (res && res.ok) { const c = await caches.open(CACHE); c.put('./index.html', res.clone()); }
        return res;
      } catch { return cached || Response.error(); }
    })());
    return;
  }
  if (url.origin === self.location.origin && url.pathname.includes('/ocr/')) {
    e.respondWith(caches.open(OCR).then(async c => (await c.match(req)) || fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; })));
    return;
  }
  // Everything else: phone copy first, refresh it in the background.
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: !font });
    const net = fetch(req).then(async res => {
      if (res && (res.ok || res.type === 'opaque')) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    }).catch(() => hit);
    return hit || net;
  })());
});
