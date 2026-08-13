// ════════════════════════════════════════════════════════════════
//  LootR — /api/paytech-ipn  (webhook PayTech : crédite le portefeuille)
//
//  PayTech appelle cette URL quand un paiement est confirmé.
//  On vérifie l'authenticité (sha256 des clés), puis on crédite le
//  portefeuille du client — UNE SEULE FOIS (anti-doublon via ref_command).
//
//  ⚠️ Dans le tableau de bord PayTech, mettre l'IPN URL :
//        https://lootr.cc/api/paytech-ipn
//  Env Vercel REQUISES : PAYTECH_API_KEY, PAYTECH_API_SECRET, FIREBASE_SERVICE_ACCOUNT
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const crypto = require('crypto');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const API_KEY = process.env.PAYTECH_API_KEY;
    const API_SECRET = process.env.PAYTECH_API_SECRET;
    if (!API_KEY || !API_SECRET) return res.status(500).json({ error: 'PayTech non configuré' });

    // PayTech envoie du form-urlencoded ou du JSON selon la config
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = require('querystring').parse(b); } }
    b = b || {};

    const typeEvent = b.type_event || '';
    const refCommand = b.ref_command || '';
    const keyHash = b.api_key_sha256 || '';
    const secretHash = b.api_secret_sha256 || '';

    // 1) Authenticité : les hash doivent correspondre à NOS clés
    if (sha256(API_KEY) !== keyHash || sha256(API_SECRET) !== secretHash) {
      return res.status(401).json({ error: 'Signature invalide' });
    }
    // 2) On ne traite que les ventes complétées
    if (typeEvent !== 'sale_complete') return res.status(200).json({ ok: true, ignored: typeEvent });
    if (!refCommand) return res.status(400).json({ error: 'ref_command manquant' });

    getApp();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;
    const payRef = db.collection('paytechPayments').doc(refCommand);

    // 3) Traitement atomique + anti-doublon
    let credited = 0, target = '', kind = '', paidOrderId = '';
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(payRef);
      const d = snap.exists ? (snap.data() || {}) : {};
      if (d.status === 'credited' || d.status === 'paid') return;   // déjà traité

      // uid / montant / but / commande (depuis notre enregistrement, sinon custom_field)
      let uid = d.uid, amountEur = +d.amountEur || 0, purpose = d.purpose || 'wallet', orderId = d.orderId || '';
      if (!uid || !amountEur) {
        try { const cf = JSON.parse(b.custom_field || '{}'); uid = uid || cf.uid; amountEur = amountEur || (+cf.amountEur || 0); purpose = purpose || cf.purpose; orderId = orderId || cf.orderId; } catch (e) {}
      }
      if (!uid) throw new Error('Données de paiement incomplètes');

      if (purpose === 'order' && orderId) {
        // 💳 Paiement d'une COMMANDE → on la passe en "payée" (la livraison auto se fait ensuite)
        tx.set(db.collection('orders').doc(orderId), {
          status: 'paid', paymentMethod: 'PayTech', paymentRef: refCommand, paidAt: FieldValue.serverTimestamp()
        }, { merge: true });
        tx.set(payRef, { status: 'paid', paymentMethod: b.payment_method || '', creditedAt: FieldValue.serverTimestamp() }, { merge: true });
        kind = 'order'; paidOrderId = orderId; target = uid;
      } else {
        // 💰 Recharge du PORTEFEUILLE
        if (amountEur <= 0) throw new Error('Montant invalide');
        tx.set(db.collection('users').doc(uid), { walletBalance: FieldValue.increment(amountEur) }, { merge: true });
        tx.set(db.collection('users').doc(uid).collection('walletHistory').doc(), {
          amount: amountEur, type: 'credit', note: 'Recharge PayTech', method: 'PayTech',
          ref: refCommand, createdAt: FieldValue.serverTimestamp()
        });
        tx.set(payRef, { status: 'credited', paymentMethod: b.payment_method || '', clientPhone: b.client_phone || '', creditedAt: FieldValue.serverTimestamp() }, { merge: true });
        kind = 'wallet'; credited = amountEur; target = uid;
      }
    });

    // 4) Après paiement d'une commande : déclenche la livraison automatique (FlashTopup)
    if (kind === 'order' && paidOrderId) {
      try {
        const base = (process.env.PUBLIC_BASE_URL || 'https://lootr.cc').replace(/\/+$/, '');
        await fetch(base + '/api/flashtopup-deliver', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: paidOrderId })
        }).catch(() => {});
      } catch (e) {}
    }
    // 5) Notifie le client
    if (target) {
      try {
        const note = (kind === 'order')
          ? { icon: '✅', title: 'Paiement reçu', body: 'Votre commande est payée (PayTech). Livraison en cours.', type: 'order', link: 'orders' }
          : { icon: '💰', title: 'Portefeuille rechargé', body: 'Votre recharge de ' + credited.toFixed(2) + ' € (PayTech) a été créditée.', type: 'wallet', link: 'wallet' };
        note.read = false; note.createdAt = FieldValue.serverTimestamp();
        await db.collection('users').doc(target).collection('notifications').add(note);
        // 📲 Push téléphone (même app fermée)
        try {
          const snap = await db.collection('fcmTokens').where('userId', '==', target).get();
          const tokens = []; snap.forEach(function (dd) { const t = (dd.data() && dd.data().token) || dd.id; if (t) tokens.push(t); });
          if (tokens.length) {
            await admin.messaging().sendEachForMulticast({
              notification: { title: (note.icon || '🔔') + ' ' + note.title, body: note.body },
              data: { title: note.title, body: note.body, url: '/' },
              android: { priority: 'high' },
              tokens: Array.from(new Set(tokens))
            });
          }
        } catch (e) {}
      } catch (e) {}
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
