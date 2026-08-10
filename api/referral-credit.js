// ════════════════════════════════════════════════════════════════
//  LootR — /api/referral-credit  (Fonction serverless Vercel)
//  Crédite le PARRAIN (et le filleul) en points quand un nouvel
//  utilisateur s'inscrit via un lien d'invitation ?ref=<uid>.
//  Envoie aussi une notification (in-app + push FCM) au parrain.
//
//  Body attendu (POST JSON) : { newUserId: string }
//
//  Fonctionnement :
//    1. Lit le document referrals/{newUserId} (créé côté client à
//       l'inscription) → en tire le referrerId.
//    2. Idempotent : si déjà "credited", ne fait rien (évite le double crédit).
//    3. Crédite le parrain de `perReferral` points + referralCount +1.
//       Crédite aussi le filleul du même bonus de bienvenue-parrainage.
//    4. Écrit une notification dans users/{referrerId}/notifications.
//    5. Envoie une vraie push FCM au parrain (appareils enregistrés).
//
//  perReferral = round(inviteReward / inviteGoal)  (défaut 500/10 = 50)
//  réglable via config/shop → inviteReward, inviteGoal.
//
//  ⚙️ Variable d'environnement REQUISE sur Vercel (déjà utilisée par
//     send-push.js) : FIREBASE_SERVICE_ACCOUNT
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant (variable d\'environnement Vercel)');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
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
    const FieldValue = admin.firestore.FieldValue;

    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    const newUserId = (payload && payload.newUserId || '').trim();
    if (!newUserId) return res.status(400).json({ error: 'newUserId requis' });

    // 1) Document de parrainage
    const refRef = db.collection('referrals').doc(newUserId);
    const refSnap = await refRef.get();
    if (!refSnap.exists) return res.status(200).json({ ok: true, note: 'aucun parrainage pour ce filleul' });
    const ref = refSnap.data() || {};
    const referrerId = ref.referrerId;
    if (!referrerId || referrerId === newUserId) {
      return res.status(200).json({ ok: true, note: 'parrain invalide' });
    }
    // 2) Idempotence : déjà crédité ?
    if (ref.status === 'credited') {
      return res.status(200).json({ ok: true, note: 'déjà crédité' });
    }

    // 3) Récompense par filleul (config/shop → inviteReward / inviteGoal)
    let inviteReward = 500, inviteGoal = 10;
    try {
      const cfg = await db.collection('config').doc('shop').get();
      const c = (cfg.exists && cfg.data()) || {};
      if (+c.inviteReward > 0) inviteReward = +c.inviteReward;
      if (+c.inviteGoal   > 0) inviteGoal   = +c.inviteGoal;
    } catch (e) {}
    const perReferral = Math.max(1, Math.round(inviteReward / inviteGoal));

    // Nom du filleul (pour la notif du parrain)
    let friendName = 'Un ami';
    try {
      const nu = await db.collection('users').doc(newUserId).get();
      const d = (nu.exists && nu.data()) || {};
      friendName = d.displayName || d.name || (d.email ? String(d.email).split('@')[0] : 'Un ami');
    } catch (e) {}

    // 4) Crédit atomique parrain + filleul + verrouillage du doc parrainage
    const referrerRef = db.collection('users').doc(referrerId);
    const newUserRef  = db.collection('users').doc(newUserId);
    let referrerCount = 0;
    await db.runTransaction(async (tx) => {
      const rSnap = await tx.get(refRef);
      if ((rSnap.data() || {}).status === 'credited') return; // double sécurité
      const rp = await tx.get(referrerRef);
      const np = await tx.get(newUserRef);
      const rPts = ((rp.data() || {}).points) || 0;
      const rCnt = ((rp.data() || {}).referralCount) || 0;
      const nPts = ((np.data() || {}).points) || 0;
      referrerCount = rCnt + 1;

      tx.set(referrerRef, {
        points: rPts + perReferral,
        referralCount: rCnt + 1,
        loyaltyXP: FieldValue.increment(perReferral)
      }, { merge: true });

      tx.set(newUserRef, { points: nPts + perReferral }, { merge: true });

      tx.set(refRef, {
        status: 'credited',
        pointsAwarded: perReferral,
        referrerCountAfter: rCnt + 1,
        creditedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    // 5) Notification in-app pour le PARRAIN
    const goalReached = (referrerCount % inviteGoal === 0);
    const notifTitle = '🎉 Parrainage réussi !';
    const notifBody = friendName + ' vient de s\'inscrire avec votre lien. Vous gagnez +' +
      perReferral + ' points ⭐ (' + referrerCount + ' ami' + (referrerCount > 1 ? 's' : '') + ' invité' +
      (referrerCount > 1 ? 's' : '') + ')' + (goalReached ? ' — objectif atteint, bravo !' : '') + '.';
    try {
      await db.collection('users').doc(referrerId).collection('notifications').add({
        icon: '🎁', title: notifTitle, body: notifBody,
        type: 'referral', link: 'invite', refId: newUserId, promoCode: '',
        read: false, createdAt: FieldValue.serverTimestamp()
      });
    } catch (e) {}

    // 6) Push FCM vers les appareils du parrain (si app fermée)
    let pushed = 0;
    try {
      const toks = [];
      const snap = await db.collection('fcmTokens').where('userId', '==', referrerId).get();
      snap.forEach(d => { const t = (d.data() && d.data().token) || d.id; if (t) toks.push(t); });
      const uniq = Array.from(new Set(toks));
      if (uniq.length) {
        const resp = await admin.messaging().sendEachForMulticast({
          data: { title: notifTitle, body: notifBody, url: '/', icon: '/notif-logo.png' },
          android: { priority: 'high' },
          tokens: uniq
        });
        pushed = resp.successCount;
      }
    } catch (e) {}

    return res.status(200).json({
      ok: true, referrerId: referrerId, pointsAwarded: perReferral,
      referralCount: referrerCount, pushed: pushed
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
