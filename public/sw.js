const CACHE_VERSION = 'sales-manager-pwa-v5';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon-192.png',
  './favicon-512.png',
  './favicon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
        if (request.mode === 'navigate') {
          return (await caches.match('./index.html')) || Response.error();
        }
        return Response.error();
      }),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = {};
    }
  }
  const title = payload.title || 'Nouveau message';
  const body = payload.body || 'Vous avez recu un message.';
  const url = payload.url || './';
  const assetBase = self.registration && self.registration.scope ? self.registration.scope : './';

  // Optional debug: send a message to any open client so we can confirm
  // that the SW received the push even if the OS hides notifications.
  const broadcastDebugMessage = async () => {
    try {
      const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        client.postMessage({ type: 'SM_PUSH_DEBUG', title, body, url });
      }
    } catch {
      // ignore
    }
  };

  event.waitUntil(
    Promise.all([
      broadcastDebugMessage(),
      self.registration.showNotification(title, {
        body,
        // Use absolute-with-scope URLs to avoid path issues on GitHub Pages base path.
        icon: `${assetBase}favicon-192.png`,
        badge: `${assetBase}favicon-192.png`,
        vibrate: [120, 80, 120],
        tag: payload.tag || 'chat-message',
        renotify: true,
        // Keep it visible on desktop if supported.
        requireInteraction: true,
        data: { url },
      }),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) {
            client.navigate(targetUrl);
          }
          return;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
