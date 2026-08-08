// ════════════════════════════════════════════════════════════════
//  OUTIL DE TEST — /api/flashtopup-checkid-test
//  Affiche la réponse BRUTE de FlashTopup /check-id pour diagnostiquer.
//  Usage (navigateur) :
//    /api/flashtopup-checkid-test?id=51992817797&code=pubgm
//    (ajoute &server=XX si le jeu demande un server_id)
//  ⚠️ Supprime ce fichier après diagnostic.
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');

let _ftAgent = null;
function _buildFtAgent(proxy) {
  const { ProxyAgent } = require('undici');
  const u = new URL(proxy);
  const cfg = { uri: u.protocol + '//' + u.host };
  if (u.username || u.password) {
    const cred = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
    cfg.token = 'Basic ' + Buffer.from(cred).toString('base64');
  }
  return new ProxyAgent(cfg);
}
async function doFetch(url, opts) {
  const proxy = process.env.FT_PROXY_URL;
  if (proxy) {
    const { fetch: uFetch } = require('undici');
    if (!_ftAgent) _ftAgent = _buildFtAgent(proxy);
    return uFetch(url, Object.assign({}, opts, { dispatcher: _ftAgent }));
  }
  return fetch(url, opts);
}
const BASE = (process.env.FLASHTOPUP_BASE_URL || 'https://api.flashtopup.com/api/reseller/v2').replace(/\/+$/, '');
const SANDBOX = String(process.env.FLASHTOPUP_SANDBOX || '').toLowerCase() === 'true';

async function ftPost(endpoint, body) {
  const url = BASE + endpoint;
  const path = new URL(url).pathname;
  const rawBody = JSON.stringify(body || {});
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(12).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = 'POST\n' + path + '\n' + ts + '\n' + nonce + '\n' + bodyHash;
  const signature = crypto.createHmac('sha256', process.env.FLASHTOPUP_API_KEY || '').update(canonical).digest('hex');
  const headers = {
    'X-FT-API-ID': process.env.FLASHTOPUP_API_ID || '',
    'X-FT-Timestamp': ts, 'X-FT-Nonce': nonce, 'X-FT-Signature': signature,
    'Content-Type': 'application/json', 'Accept': 'application/json'
  };
  if (SANDBOX) headers['X-FT-Sandbox'] = 'true';
  const res = await doFetch(url, { method: 'POST', headers: headers, body: rawBody });
  let json = null, text = '';
  try { text = await res.text(); json = JSON.parse(text); } catch (e) {}
  return { http: res.status, json: json, text: text, sentBody: body };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  try {
    const q = req.query || {};
    const id = (q.id || '').toString().trim();
    const code = (q.code || 'pubgm').toString().trim();
    const server = (q.server || '').toString().trim();
    if (!id) return res.status(200).send('Ajoute ?id=TON_ID&code=pubgm  (ex: /api/flashtopup-checkid-test?id=51992817797&code=pubgm)');
    const body = { validation_code: code, user_id: id };
    if (server) body.server_id = server;
    const r = await ftPost('/check-id', body);
    res.status(200).send(
      '=== REQUÊTE ENVOYÉE ===\n' + JSON.stringify(r.sentBody, null, 2) +
      '\n\n=== HTTP ' + r.http + ' ===\n\n=== RÉPONSE FLASHTOPUP ===\n' +
      (r.json ? JSON.stringify(r.json, null, 2) : r.text)
    );
  } catch (e) {
    res.status(200).send('Erreur : ' + (e && e.message));
  }
};
