// ════════════════════════════════════════════════════════════════
//  ASG Store — /api/flashtopup-checkid
//  Vérifie un ID joueur (PUBG, etc.) via FlashTopup /check-id et renvoie
//  le PSEUDO du joueur → affichage "✅ Nom : XXXX" côté client.
//
//  Body (POST JSON) : { "userId":"...", "validationCode":"pubgm", "serverId":"" }
//  Réponse          : { "ok":true, "name":"Pseudo" }  ou  { "ok":false, "error":"..." }
//
//  Variables Vercel : FLASHTOPUP_API_ID, FLASHTOPUP_API_KEY,
//                     FT_PROXY_URL (proxy à IP fixe), FLASHTOPUP_SANDBOX (opt.)
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
  let json = null; try { json = await res.json(); } catch (e) {}
  return { http: res.status, json: json };
}

function pick(o, keys) { for (var i = 0; i < keys.length; i++) { var k = keys[i]; if (o && o[k] != null && o[k] !== '') return o[k]; } return ''; }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  try {
    if (!process.env.FLASHTOPUP_API_ID || !process.env.FLASHTOPUP_API_KEY) {
      return res.status(200).json({ ok: false, error: 'Config manquante' });
    }
    let p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
    const userId = String((p && p.userId) || '').trim();
    const validationCode = String((p && p.validationCode) || '').trim();
    const serverId = String((p && p.serverId) || '').trim();
    if (!userId || !validationCode) return res.status(200).json({ ok: false, error: 'userId / validationCode requis' });

    const body = { validation_code: validationCode, user_id: userId };
    if (serverId) body.server_id = serverId;

    const r = await ftPost('/check-id', body);
    const j = r.json || {};
    const ok = j.success === true || (j.data && (j.success !== false));
    const d = j.data || j;
    const name = pick(d, ['username', 'name', 'nickname', 'player_name', 'user_name', 'ign', 'nick']);
    if (ok && name) return res.status(200).json({ ok: true, name: String(name) });
    const msg = (j.error && j.error.message) || j.message || 'ID introuvable';
    return res.status(200).json({ ok: false, error: String(msg).slice(0, 160) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: (e && e.message) ? e.message.slice(0, 160) : 'Erreur' });
  }
};

