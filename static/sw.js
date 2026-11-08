/* NBAViz service worker.
   Pages and data always come from the network first, so numbers are never
   stale; the last good copy is used only when the Pi can't be reached.
   Logos and headshots are cached (they rarely change). Bump CACHE to reset. */

var CACHE = 'nbaviz-v2';

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (n) { if (n !== CACHE) return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

/* Store a response, dropping older ?v= versions of the same static file. */
function store(request, resp) {
  var url = new URL(request.url);
  return caches.open(CACHE).then(function (c) {
    var prune = url.pathname.indexOf('/static/') !== 0 ? Promise.resolve() : c.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        var ku = new URL(k.url);
        if (ku.pathname === url.pathname && ku.search !== url.search) return c.delete(k);
      }));
    });
    return prune.then(function () { return c.put(request, resp); });
  });
}

function networkFirst(request) {
  return fetch(request).then(function (resp) {
    if (resp.ok) store(request, resp.clone());
    return resp;
  }).catch(function () {
    return caches.match(request, { ignoreSearch: request.mode === 'navigate' });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    return hit || fetch(request).then(function (resp) {
      if (resp.ok) store(request, resp.clone());
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
