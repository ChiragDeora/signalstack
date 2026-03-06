// ============================================
// SignalStack Service Worker
// ============================================
// Handles push notifications and basic caching
// for PWA "Add to Home Screen" support.

const CACHE_NAME = 'signalstack-v2';

// Install: cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/signalstack-logo.png',
      ]);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first strategy (app relies on live data)
self.addEventListener('fetch', (event) => {
  // Skip non-GET and API/socket requests
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for offline fallback
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache when offline
        return caches.match(event.request);
      })
  );
});

// Push notification received
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch {
    const text = event.data ? event.data.text() : '';
    data = { title: 'SignalStack', body: text || 'New alert' };
  }

  const title = (data.title && String(data.title)) || 'SignalStack Alert';
  const tag = (data.tag && String(data.tag)) || 'signalstack-alert';
  const isTest = tag === 'signalstack-test';
  const options = {
    body: (data.body && String(data.body)) || 'EMA crossover detected',
    icon: '/signalstack-logo.png',
    badge: '/signalstack-logo.png',
    tag: tag,
    vibrate: [200, 100, 200],
    renotify: true,
    requireInteraction: isTest,
    silent: false,
    data: {
      url: (data.url && String(data.url)) || '/',
    },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch((err) => {
      console.error('SignalStack SW: showNotification failed', err);
    })
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return self.clients.openWindow(urlToOpen);
    })
  );
});
