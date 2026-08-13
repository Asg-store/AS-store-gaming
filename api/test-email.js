// ════════════════════════════════════════════════════════════════
//  LootR — /api/test-email  (OUTIL DE DIAGNOSTIC — à supprimer après)
//
//  But : comprendre POURQUOI les emails ne partent pas. Contrairement au
//  code de production (qui cache les erreurs avec try/catch vides), CE
//  fichier RENVOIE l'erreur exacte de Resend et/ou Gmail.
//
//  Utilisation (dans le navigateur) :
//    https://TON-SITE.vercel.app/api/test-email?to=TON_EMAIL@gmail.com
//
//  Il essaie Resend PUIS Gmail et affiche le résultat détaillé de chacun.
//  ⚠️ Supprime ce fichier une fois le problème réglé (il est public).
// ════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const to = (req.query && req.query.to) || '';
  const report = {
    destinataire: to || '(manquant — ajoute ?to=ton@email.com dans l\'URL)',
    variables_detectees: {
      RESEND_API_KEY: !!process.env.RESEND_API_KEY,
      RESEND_FROM: process.env.RESEND_FROM || process.env.MAIL_FROM || '(non défini → onboarding@resend.dev)',
      GMAIL_USER: process.env.GMAIL_USER || '(non défini)',
      GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD ? '(défini)' : '(non défini)'
    },
    resend: null,
    gmail: null,
    conclusion: ''
  };

  if (!to) { res.status(400); return res.end(JSON.stringify(report, null, 2)); }

  // ── 1) Test RESEND ──────────────────────────────────────────────
  if (process.env.RESEND_API_KEY) {
    try {
      const from = process.env.RESEND_FROM || process.env.MAIL_FROM || 'LootR <onboarding@resend.dev>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from, to: to, subject: 'Test LootR (Resend)', html: '<p>✅ Test Resend réussi depuis LootR.</p>' })
      });
      let body = null; try { body = await r.json(); } catch (e) { body = null; }
      report.resend = { statut_http: r.status, ok: r.ok, from_utilise: from, reponse: body };
    } catch (e) {
      report.resend = { erreur: (e && e.message) || String(e) };
    }
  } else {
    report.resend = { ignore: 'RESEND_API_KEY non configuré' };
  }

  // ── 2) Test GMAIL (secours) ─────────────────────────────────────
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    try {
      const nodemailer = require('nodemailer');
      const transport = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') }
      });
      const from = process.env.MAIL_FROM || ('LootR <' + process.env.GMAIL_USER + '>');
      const info = await transport.sendMail({ from: from, to: to, subject: 'Test LootR (Gmail)', html: '<p>✅ Test Gmail réussi depuis LootR.</p>' });
      report.gmail = { ok: true, messageId: info.messageId, accepted: info.accepted };
    } catch (e) {
      report.gmail = { ok: false, erreur: (e && e.message) || String(e) };
    }
  } else {
    report.gmail = { ignore: 'GMAIL_USER / GMAIL_APP_PASSWORD non configurés' };
  }

  // ── 3) Conclusion lisible ───────────────────────────────────────
  const resendOk = report.resend && report.resend.ok;
  const gmailOk = report.gmail && report.gmail.ok;
  if (resendOk || gmailOk) {
    report.conclusion = '✅ Au moins un service a accepté l\'email. Vérifie ta boîte de réception ET le dossier SPAM. Si tu ne reçois rien malgré un "ok", le problème est la réputation de l\'expéditeur (domaine non vérifié → spam).';
  } else {
    let msg = '❌ Aucun service n\'a pu envoyer. ';
    if (report.resend && report.resend.reponse && report.resend.reponse.message) {
      msg += 'Resend dit : "' + report.resend.reponse.message + '". ';
    }
    if (report.gmail && report.gmail.erreur) {
      msg += 'Gmail dit : "' + report.gmail.erreur + '". ';
    }
    msg += 'Causes fréquentes : (1) domaine Resend non vérifié → utilise onboarding@resend.dev le temps du test ; (2) mot de passe Gmail = mot de passe normal au lieu d\'un "mot de passe d\'application" (nécessite la validation en 2 étapes).';
    report.conclusion = msg;
  }

  res.status(200);
  res.end(JSON.stringify(report, null, 2));
};

