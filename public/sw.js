// Minimal service worker: exists solely to receive Web Push events and show
// a system notification, even when the app tab isn't open/focused.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Lunch Buddy', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Lunch Buddy', {
      body: data.body || '',
      tag: 'lunch-buddy-notification',
      renotify: true
    })
  );
});

// Clicking the notification focuses an existing tab if one's open, else opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
