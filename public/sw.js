const CACHE_NAME = 'financial-app-cache-v37';
const urlsToCache = [
  '/',
  '/about',
  '/privacy',
  '/css/style.css',
  '/js/main.js',
  '/js/site-pages.js',
  '/js/accounts.js',
  '/images/finalyze-mobile-qr.png',
  '/images/finalyze-telegram-qr.png',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .catch(err => console.error('Failed to cache', err))
  );
});

self.addEventListener('fetch', event => {
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  const url = new URL(event.request.url);
  const isAppShell = url.origin === location.origin &&
    (url.pathname === '/' || url.pathname === '/about' || url.pathname === '/privacy' || url.pathname.endsWith('.html') ||
     url.pathname.endsWith('.css') || url.pathname.endsWith('.js'));

  if (isAppShell) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    event.respondWith(
      caches.match(event.request)
        .then(response => response || fetch(event.request))
    );
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

function notificationUrl(value) {
  try {
    const url = new URL(value || '/', self.location.origin);
    if(url.origin === self.location.origin && url.pathname === '/') return url.href;
  } catch {}
  return `${self.location.origin}/`;
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(typeof data.title === 'string' ? data.title.slice(0,120) : 'Finalyze.AI 공시 알림', {
    body:typeof data.body === 'string' ? data.body.slice(0,500) : '관심 기업의 새 공시를 확인해보세요.',
    icon:'/icons/icon-192x192.png',badge:'/icons/icon-96x96.png',
    tag:typeof data.tag === 'string' ? data.tag.slice(0,100) : 'finalyze-disclosure',
    data:{ url:notificationUrl(data.url) }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = notificationUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type:'window',includeUncontrolled:true });
    for(const client of windows) {
      if(new URL(client.url).origin === self.location.origin && 'navigate' in client) {
        try { const target = await client.navigate(url); if(target) return target.focus(); } catch {}
      }
    }
    return self.clients.openWindow(url);
  })());
});
