self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const url = data.url || 'https://glosso.ink/notifications';
  event.waitUntil(self.registration.showNotification(data.title || 'Glosso', {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: url,
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || event.notification.tag || 'https://glosso.ink/notifications';
  const redirect = '/open?url=' + encodeURIComponent(target);
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      if (clientList.length > 0) {
        return clientList[0].navigate(redirect).then((client) => client.focus());
      }
      return clients.openWindow(redirect);
    })
  );
});
