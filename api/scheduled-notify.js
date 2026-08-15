// ════════════════════════════════════════════════════════════════
//  LootR — /api/scheduled-notify   (CRON Vercel)
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

    // Notifications dues : pas encore envoyées (filtre simple → PAS besoin d'index composite Firebase).
    // On filtre ensuite « sendAt <= maintenant » directement dans le code.
    const snap = await db.collection('scheduledNotifs')
      .where('sent', '==', false)
      .limit(50)
      .get();

    // Ne garder que celles réellement arrivées à échéance (sendAt <= now)
    const dueDocs = snap.docs.filter(doc => {
      const sa = (doc.data() || {}).sendAt;
      const ms = sa && sa.toMillis ? sa.toMillis() : 0;
      return ms && ms <= now.toMillis();
    });

    // Compte les appareils abonnés (toujours, même sans notif due → affichage admin correct)
    const tokSnap = await db.collection('fcmTokens').get();
    let tokens = [];
    tokSnap.forEach(d => {
      const t = (d.data() && d.data().token) || d.id;
      if (t) tokens.push(t);
    });
    tokens = Array.from(new Set(tokens));

    if (!dueDocs.length) {
      return res.status(200).json({ ok: true, due: 0, devices: tokens.length, note: 'aucune notification à envoyer' });
    }

    const results = [];

    for (const doc of dueDocs) {
      const n = doc.data() || {};
      let sentCount = 0;
      const stale = [];

      if (tokens.length) {
        const base = {
          // ── Message "data" (construit côté service worker → fiable en arrière-plan) ──
          data: {
            title: String(n.title || 'LootR'),
            body: String(n.body || ''),
            url: '/',
            icon: '/notif-logo.png',
            type: 'scheduled',
            notifId: doc.id
          },
          android: { priority: 'high' },
          // ⚠️ INDISPENSABLE POUR LE WEB / PWA : sans l'en-tête Urgency, le téléphone
          // (mode veille / app fermée) met la notif en file et ne l'affiche qu'à la
          // réouverture. Urgency high = livraison immédiate même appareil endormi.
          webpush: {
            headers: { Urgency: 'high', TTL: '86400' },
            fcmOptions: { link: 'https://lootr.cc/' }
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

    return res.status(200).json({ ok: true, due: dueDocs.length, devices: tokens.length, results });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
