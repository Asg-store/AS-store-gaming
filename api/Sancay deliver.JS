// ════════════════════════════════════════════════════════════════
//  ASG Store — /api/sancay-deliver  (Fonction serverless Vercel)
//  Livraison AUTOMATIQUE d'une commande via l'API Sancay Vault.
//
//  Body attendu (POST JSON) : { "orderId": "<id de la commande Firestore>" }
//
//  Fonctionnement :
//    1. Lit la commande orders/{orderId} (via firebase-admin).
//    2. Vérifie qu'elle est payée et pas déjà livrée via Sancay.
//    3. Pour chaque article, lit le produit → son `sancayProductId`
//       (le code type "S4085924" que tu renseignes dans l'admin).
//    4. Appelle Sancay POST /order avec { ref_id, product_id, target }
//       (target = l'ID joueur / Character ID de la commande).
//    5. Interroge GET /order/{ref} quelques fois pour connaître le statut.
//    6. Si tout est livré → commande "delivered" + notification client.
//       Sinon → "sancayStatus: pending" (le webhook ou un nouveau clic finira).
//
//  ⚙️ Variables d'environnement Vercel REQUISES :
//     - FIREBASE_SERVICE_ACCOUNT  (déjà utilisée par send-push.js)
//     - SANCAY_API_KEY            (ta clé SECRÈTE Sancay Vault — NE JAMAIS la mettre dans le code)
//     - SANCAY_BASE_URL           (optionnel, défaut: https://sancayprotocol.co/api/v1)
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

const BASE = (process.env.SANCAY_BASE_URL || 'https://sancayprotocol.co/api/v1').replace(/\/+$/, '');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

// Petit helper fetch JSON avec la clé API Sancay
async function sancay(method, path, body) {
  const res = await fetch(BASE + path, {
    method: method,
    headers: {
      'X-Api-Key': process.env.SANCAY_API_KEY || '',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data: data };
}

// Essaie de lire un statut lisible depuis diverses formes de réponse Sancay
function readStatus(obj) {
  if (!obj) return '';
  const d = obj.data || obj;
  return String(d.status || d.state || d.order_status || '').toLowerCase();
}
const SUCCESS = ['success', 'completed', 'delivered', 'done', 'sukses', 'berhasil'];
const FAILED = ['failed', 'error', 'cancelled', 'canceled', 'refunded', 'gagal'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.SANCAY_API_KEY) return res.status(500).json({ error: 'SANCAY_API_KEY manquant (variable Vercel)' });
    getApp();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    const orderId = (payload && payload.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId requis' });

    const orderRef = db.collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Commande introuvable' });
    const order = snap.data() || {};

    // Sécurités : commande payée, pas déjà livrée via Sancay
    if (order.sancayStatus === 'success') return res.status(200).json({ ok: true, note: 'déjà livrée via Sancay' });
    const paidLike = ['paid', 'delivered', 'processing', 'shipped'];
    if (paidLike.indexOf(order.status) < 0) return res.status(400).json({ error: 'Commande non payée (statut: ' + (order.status || '—') + ')' });

    const target = String(order.playerId || (order.account && (order.account.userId || order.account.konamiId)) || '').trim();
    if (!target) return res.status(400).json({ error: 'ID joueur (target) manquant sur la commande' });

    // Construit la liste des top-ups à passer, depuis les articles + leur mapping produit
    const items = order.items || [];
    const tasks = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let sancayId = it.sancayProductId || '';
      if (!sancayId && it.id) {
        try {
          const p = await db.collection('products').doc(it.id).get();
          if (p.exists) sancayId = (p.data() || {}).sancayProductId || '';
        } catch (e) {}
      }
      if (!sancayId) continue; // article non mappé → on l'ignore
      const qty = Math.max(1, it.qty || 1);
      for (let q = 0; q < qty; q++) {
        tasks.push({ ref_id: orderId + '-' + i + '-' + q, product_id: sancayId, target: target });
      }
    }
    if (!tasks.length) return res.status(400).json({ error: 'Aucun article mappé à Sancay (renseignez le "ID produit Sancay" dans l\'admin)' });

    // 1) Passe les commandes chez Sancay (idempotent grâce à ref_id)
    const refs = [];
    for (let t = 0; t < tasks.length; t++) {
      const r = await sancay('POST', '/order', tasks[t]);
      refs.push({ ref: tasks[t].ref_id, ok: r.ok, status: readStatus(r.data), raw: r.status });
      // si l'API renvoie une erreur "déjà existant", ce n'est pas grave (idempotence)
    }

    // 2) Interroge le statut quelques fois (≈ 12s) pour capter une livraison instantanée
    let allDone = false;
    for (let attempt = 0; attempt < 4 && !allDone; attempt++) {
      await sleep(3000);
      allDone = true;
      for (let k = 0; k < refs.length; k++) {
        if (SUCCESS.indexOf(refs[k].status) >= 0) continue;
        const s = await sancay('GET', '/order/' + encodeURIComponent(refs[k].ref));
        refs[k].status = readStatus(s.data) || refs[k].status;
        if (SUCCESS.indexOf(refs[k].status) < 0) allDone = false;
      }
    }

    const anyFailed = refs.some(r => FAILED.indexOf(r.status) >= 0);
    const allSuccess = refs.every(r => SUCCESS.indexOf(r.status) >= 0);

    // 3) Met à jour la commande + notifie
    const update = {
      sancayRefs: refs.map(r => r.ref),
      sancayLastStatus: refs.map(r => r.status).join(','),
      sancayCheckedAt: FieldValue.serverTimestamp()
    };
    if (allSuccess) {
      update.status = 'delivered';
      update.sancayStatus = 'success';
      update.deliveredAt = FieldValue.serverTimestamp();
    } else if (anyFailed) {
      update.sancayStatus = 'failed';
    } else {
      update.sancayStatus = 'pending';
    }
    await orderRef.set(update, { merge: true });

    // Notification client (in-app) si livrée
    if (allSuccess && order.userId) {
      const ref = 'CMD-' + String(orderId).slice(0, 6).toUpperCase();
      try {
        await db.collection('users').doc(order.userId).collection('notifications').add({
          icon: '✅', title: 'Commande livrée !',
          body: 'Votre recharge (' + ref + ') a été livrée automatiquement sur l\'ID ' + target + '.',
          type: 'order', link: 'payments', refId: orderId, read: false,
          createdAt: FieldValue.serverTimestamp()
        });
      } catch (e) {}
    }

    return res.status(200).json({
      ok: true, orderId: orderId, delivered: allSuccess,
      status: allSuccess ? 'delivered' : (anyFailed ? 'failed' : 'pending'),
      refs: refs
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

