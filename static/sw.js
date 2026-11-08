/* NBAViz service worker.
   Pages and data always come from the network first, so numbers are never
   stale; the last good copy is used only when the Pi can't be reached.
   Logos and headshots are cached (they rarely change). Bump CACHE to reset. */

var CACHE = 'nbaviz-v1';

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (n) { if (n !== CACHE) return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(request) {
  return fetch(request).then(function (resp) {
    if (resp.ok) {
      var copy = resp.clone();
      caches.open(CACHE).then(function (c) { c.put(request, copy); });
    }
    return resp;
  }).catch(function () {
    return caches.match(request, { ignoreSearch: request.mode === 'navigate' });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    return hit || fetch(request).then(function (resp) {
      if (resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(request, copy); });
      }
      return resp;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/img/') === 0) event.respondWith(cacheFirst(req));
  else event.respondWith(networkFirst(req));
});
