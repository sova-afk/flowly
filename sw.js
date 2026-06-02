const CACHE = 'flowly-v3';
const FILES = ['index.html', 'styles.css', 'app.js', 'manifest.json', 'version.json', 'icon-192.png', 'icon-512.png', 'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300;1,9..40,400&display=swap'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(FILES))
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (url.startsWith('https://fonts.gstatic.com/')) {
    e.respondWith(
      caches.open(CACHE).then((cache) => {
        return cache.match(e.request).then((r) => {
          return r || fetch(e.request).then((res) => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
