/* Firebase Cloud Messaging service worker (optional web push). Config is passed via the ?c= query. */
/* global importScripts, firebase */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const params = new URL(self.location.href).searchParams;
try {
  firebase.initializeApp(JSON.parse(atob(params.get('c') || '')));
  firebase.messaging().onBackgroundMessage((payload) => {
    const n = payload.notification || {};
    self.registration.showNotification(n.title || 'FoodBridge', { body: n.body || '', icon: '/icon.svg', data: payload.fcmOptions || {} });
  });
} catch (e) { /* not configured */ }

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.link || '/'));
});
