// Service worker da IAgenda: só mostra os avisos que o agenda-web manda (push.ts).
// No iPhone o push só funciona com o site aberto pela Tela de Início (iOS 16.4+).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { texto: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'IAgenda', {
    body: d.texto || '',
    tag: d.tag || 'agenda',
    icon: '/icone-192.png',
    badge: '/icone-192.png',
    data: { url: d.url || '/' },
  }));
});

// Tocar no aviso: se a agenda já está aberta, vai para o dia; senão abre.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((abertas) => {
    for (const c of abertas) if ('focus' in c) { c.postMessage({ abrir: url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
