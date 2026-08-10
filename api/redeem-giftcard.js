// ════════════════════════════════════════════════════════════════
//  LootR — /api/redeem-giftcard  (Fonction serverless Vercel)
//  Échange une carte cadeau de façon SÉCURISÉE, côté serveur.
//
//  Pourquoi côté serveur ?
//    Avant, l'app cliente lisait la carte, la marquait « utilisée » et
//    créditait elle-même le portefeuille. Un utilisateur technique
//    pouvait donc se créditer sans carte, ou réutiliser un code.
//    Ici, firebase-admin ignore les règles Firestore : le client ne
//    touche plus jamais à `giftcards` ni à `walletBalance`.
//
//  Sécurité :
//    - Vérifie le jeton d'identité Firebase (Authorization: Bearer <idToken>)
//      → on connaît le vrai uid, impossible de se faire passer pour un autre.
//    - Transaction atomique : une carte ne peut être utilisée qu'UNE fois.
//
//  Body (POST JSON) : { code: string }
//  Header REQUIS    : Authorization: Bearer <Firebase ID token>
//  Env REQUISE      : FIREBASE_SERVICE_ACCOUNT (déjà présente sur Vercel)
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant (variable Vercel)');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  }
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    getApp();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    // 1) Authentification : vérifier le jeton Firebase
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Non authentifié' });
    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(m[1]);
      uid = decoded.uid;
    } catch (e) {
      return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    }
    if (!uid) return res.status(401).json({ error: 'Non authentifié' });

    // 2) Code
    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    const code = ((payload && payload.code) || '').toString().trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Entrez un code.' });

    // 3) Échange atomique : la carte ne peut être utilisée qu'une fois
    const cardRef = db.collection('giftcards').doc(code);
    const userRef = db.collection('users').doc(uid);

    let value = 0;
    await db.runTransaction(async (tx) => {
      const cardSnap = await tx.get(cardRef);
      if (!cardSnap.exists) throw new Error('__INVALID__');
      const g = cardSnap.data() || {};
      if (g.redeemed === true) throw new Error('__USED__');
      value = +g.value || 0;
      if (value <= 0) throw new Error('__INVALID__');

      tx.set(cardRef, {
        redeemed: true,
        redeemedBy: uid,
        redeemedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(userRef, {
        walletBalance: FieldValue.increment(value)
      }, { merge: true });
    });

    return res.status(200).json({ ok: true, value: value });
  } catch (e) {
    if (e && e.message === '__INVALID__') return res.status(200).json({ error: 'Code invalide.' });
    if (e && e.message === '__USED__')    return res.status(200).json({ error: 'Code déjà utilisé.' });
    return res.status(500).json({ error: e.message });
  }
};

