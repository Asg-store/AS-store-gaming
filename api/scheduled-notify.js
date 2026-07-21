// ════════════════════════════════════════════════════════════════
//  ASG Store — /api/scheduled-notify   (CRON Vercel)
//
//  C'est LA pièce qui manquait : l'admin programme une notification
//  (collection Firestore « scheduledNotifs »), mais PERSONNE ne venait
//  la lire ni l'envoyer. Ce fichier est le « réveil » qui tourne
//  automatiquement et envoie les notifications arrivées à échéance.
//
//  Déclenché par Vercel Cron (voir vercel.json) toutes les 5 minutes.
//  Peut aussi être appelé à la main : /api/scheduled-notify
//
//  ⚙️ Variable d'environnement requise :
//     FIREBASE_SERVICE_ACCOUNT = JSON de la clé de compte de service
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  }
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

module.exports = async (req, res) => {
  try {
    getApp();
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();

    // Notifications dues : pas encore envoyées ET sendAt <= maintenant
    const snap = await db.collection('scheduledNotifs')
      .where('sent', '==', false)
      .where('sendAt', '<=', now)
      .limit(20)
      .get();

    if (snap.empty) {
      return res.status(200).json({ ok: true, due: 0, note: 'aucune notification à envoyer' });
    }

    // Tous les appareils enregistrés (diffusion générale)
    const tokSnap = await db.collection('fcmTokens').get();
    let tokens = [];
    tokSnap.forEach(d => {
      const t = (d.data() && d.data().token) || d.id;
      if (t) tokens.push(t);
    });
    tokens = Array.from(new Set(tokens));

    const results = [];

    for (const doc of snap.docs) {
      const n = doc.data() || {};
      let sentCount = 0;
      const stale = [];

      if (tokens.length) {
        const base = {
          notification: { title: n.title || 'ASG Store', body: n.body || '' },
          data: { type: 'scheduled', notifId: doc.id },
          webpush: {
            notification: { icon: '/icon-192.png', badge: '/notif-badge.png' },
            fcmOptions: { link: 'https://as-store-gaming.vercel.app/' }
          }
        };
        for (let i = 0; i < tokens.length; i += 500) {
          const batch = tokens.slice(i, i + 500);
          const resp = await admin.messaging().sendEachForMulticast(
            Object.assign({}, base, { tokens: batch })
          );
          sentCount += resp.successCount;
          resp.responses.forEach((r, idx) => {
            if (!r.success) {
              const code = (r.error && r.error.code) || '';
              if (code.indexOf('registration-token-not-registered') >= 0 ||
                  code.indexOf('invalid-argument') >= 0) stale.push(batch[idx]);
            }
          });
        }
        // Nettoyage des jetons morts
        await Promise.all(stale.map(t =>
          db.collection('fcmTokens').doc(t).delete().catch(() => {})
        ));
      }

      // Marquée comme envoyée, même si 0 appareil (sinon boucle infinie)
      await doc.ref.set({
        sent: true,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        sentCount: sentCount
      }, { merge: true });

      results.push({ id: doc.id, title: n.title || '', sent: sentCount });
    }

    return res.status(200).json({ ok: true, due: snap.size, devices: tokens.length, results });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};

