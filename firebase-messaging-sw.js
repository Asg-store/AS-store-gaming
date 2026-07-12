/* ════════════════════════════════════════════════════════════════
   ASG Store — Service Worker des notifications push (FCM)
   Ce fichier DOIT être à la racine du site (même niveau que index.html),
   accessible à l'adresse : https://VOTRE-SITE.netlify.app/firebase-messaging-sw.js
   C'est lui qui affiche la notification dans la barre du téléphone
   QUAND L'APP EST FERMÉE ou en arrière-plan (comme WhatsApp / Telegram / TikTok).
   ════════════════════════════════════════════════════════════════ */

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDsWdTbAm4q1FC5opeKXFFd_PaqlnbdMHw",
  authDomain: "shop-7ddd7.firebaseapp.com",
  projectId: "shop-7ddd7",
  storageBucket: "shop-7ddd7.firebasestorage.app",
  messagingSenderId: "744435807868",
  appId: "1:744435807868:web:44c7b0b27e15cb00f43bf9"
});

var messaging = firebase.messaging();

// ── Notification reçue alors que l'app est FERMÉE / en arrière-plan ──
// Le serveur (send-push) envoie un message "data" → on construit la notif ici.
messaging.onBackgroundMessage(function(payload){
  // On accepte les deux formats : message "data" (envoyé par send-push) ET "notification"
  var data = (payload && payload.data) || {};
  var n    = (payload && payload.notification) || {};
  var title = data.title || n.title || '📢 ASG Store';
  var body  = data.body  || n.body  || 'Vous avez une nouvelle notification';
  var image = data.image || n.image || undefined;

  // Tag UNIQUE → les notifications s'empilent au lieu de s'écraser entre elles
  // (sauf si le serveur impose volontairement un tag pour remplacer la précédente)
  var tag = data.tag || ('asg-' + Date.now());

  var options = {
    body: body,
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    image: image,
    vibrate: [200, 100, 200, 100, 200],   // vibration plus franche
    tag: tag,
    renotify: true,
    requireInteraction: true,             // la notif reste affichée tant qu'on ne la touche pas
    silent: false,
    timestamp: Date.now(),
    actions: [
      { action: 'open', title: '👀 Ouvrir' },
      { action: 'close', title: '✖ Fermer' }
    ],
    data: { url: data.url || n.click_action || '/' }
  };
  return self.registration.showNotification(title, options);
});

// ── Au clic sur la notification : ouvrir / réactiver l'app ──
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  if (event.action === 'close') return;   // bouton « Fermer » → on ne fait rien
  var target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) { try { c.navigate(target); } catch(e) {} return c.focus(); }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// Activation immédiate du nouveau SW (pas besoin de fermer tous les onglets)
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
