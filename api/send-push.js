// ════════════════════════════════════════════════════════════════
//  LootR — /api/send-push  (Fonction serverless Vercel, Node.js)
//  Envoie une VRAIE notification push FCM aux appareils d'un client,
//  même quand l'application est complètement fermée.
//
//  Body attendu (POST JSON) :
//    { userId?: string, token?: string, title: string, body: string, url?: string }
//    - userId  → envoie à tous les appareils de ce client (collection fcmTokens)
//    - token   → envoie à un appareil précis
//    - (aucun) → diffusion à TOUS les appareils (annonces générales)
//
//  ⚙️ Variable d'environnement REQUISE sur Vercel :
//    FIREBASE_SERVICE_ACCOUNT = le contenu JSON complet de votre clé de
//    compte de service Firebase (Console Firebase → Paramètres du projet →
//    Comptes de service → Générer une nouvelle clé privée).
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant (variable d\'environnement Vercel)');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n'); // corrige les retours à la ligne échappés
  }
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    getApp();
    const db = admin.firestore();

    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    payload = payload || {};
    const { userId, token, title, body, url, type } = payload;

    // ── 📧 Envoi email OPTIONNEL (indépendant du push) ──────────────
    // Si le body contient email:{to,subject,html}, on envoie aussi un
    // email via le helper _email.js (Gmail/Resend). Utilisé notamment
    // quand l'admin change le statut d'une commande (livrée, annulée…).
    let emailSent = false;
    if (payload.email && payload.email.to) {
      try {
        const { sendEmail } = require('./_email.js');
        emailSent = await sendEmail(payload.email.to, payload.email.subject || 'LootR', payload.email.html || '');
      } catch (e) { emailSent = false; }
    }
    // Mode "email seul" : pas de push, on répond tout de suite.
    if (payload.emailOnly) return res.status(200).json({ ok: true, emailSent: emailSent });

    // ── Collecte des jetons cibles ──
    let tokens = [];
    if (token) tokens.push(token);
    if (userId) {
      const snap = await db.collection('fcmTokens').where('userId', '==', userId).get();
      snap.forEach(d => { const t = (d.data() && d.data().token) || d.id; if (t) tokens.push(t); });
    }
    if (!userId && !token) {
      const snap = await db.collection('fcmTokens').get(); // diffusion générale
      snap.forEach(d => { const t = (d.data() && d.data().token) || d.id; if (t) tokens.push(t); });
    }
    tokens = Array.from(new Set(tokens));
    if (!tokens.length) return res.status(200).json({ ok: true, sent: 0, note: 'aucun appareil enregistré' });

    // ── Message "data" (construit côté service worker → fiable en arrière-plan) ──
    const base = {
      data: {
        title: String(title || 'LootR'),
        body: String(body || ''),
        url: String(url || '/'),
        type: String(type || ''),
        icon: '/notif-logo.png'
      },
      // Priorité HAUTE pour l'app Android native (WebView / FCM natif)
      android: { priority: 'high' },
      // ⚠️ INDISPENSABLE POUR LE WEB / PWA : le bloc "android" ci-dessus est
      // IGNORÉ par le Web Push. Sans l'en-tête Urgency, le navigateur reçoit
      // la notif en priorité « normale » → le téléphone (mode veille / Doze /
      // navigateur fermé) la MET EN FILE et ne l'affiche qu'à la réouverture
      // de l'app. C'était la cause du « reçu seulement quand j'ouvre l'app ».
      webpush: {
        headers: {
          Urgency: 'high',   // livraison immédiate même quand l'appareil dort
          TTL: '86400'       // garde le message 24 h si l'appareil est hors ligne
        },
        fcmOptions: { link: String(url || '/') }
      }
    };

    let success = 0, failure = 0; const stale = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const resp = await admin.messaging().sendEachForMulticast(Object.assign({}, base, { tokens: batch }));
      success += resp.successCount; failure += resp.failureCount;
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = (r.error && r.error.code) || '';
          if (code.indexOf('registration-token-not-registered') >= 0 || code.indexOf('invalid-argument') >= 0) {
            stale.push(batch[idx]);
          }
        }
      });
    }
    // Nettoyage des jetons expirés
    await Promise.all(stale.map(t => db.collection('fcmTokens').doc(t).delete().catch(() => {})));

    return res.status(200).json({ ok: true, sent: success, failed: failure, cleaned: stale.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
