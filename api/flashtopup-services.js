// ════════════════════════════════════════════════════════════════
//  ASG Store — /api/flashtopup-services  (OUTIL de diagnostic)
//  Liste les vrais `service_code` de ton catalogue FlashTopup, pour
//  remplir correctement le champ "Code service FlashTopup" des produits.
//
//  Utilisation (dans le navigateur) :
//    /api/flashtopup-services              → liste tous les produits (id, code, nom)
//    /api/flashtopup-services?q=pubg       → + la liste des service_code du/des jeu(x) filtrés
//
//  Utilise les MÊMES variables Vercel que flashtopup-deliver.js
//  (FLASHTOPUP_API_ID, FLASHTOPUP_API_KEY, FT_PROXY_URL, FLASHTOPUP_SANDBOX).
//  ⚠️ Supprime ce fichier une fois tes produits mappés.
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// Proxy à IP fixe (identique à flashtopup-deliver.js)
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

// Appel GET signé (corps vide ; la query n'est PAS signée — règle FlashTopup)
async function ftGet(path, query) {
  const url = BASE + path + (query ? ('?' + query) : '');
  const signPath = new URL(BASE + path).pathname; // /api/reseller/v2/xxx (sans query)
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(12).toString('hex');
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const canonical = 'GET\n' + signPath + '\n' + ts + '\n' + nonce + '\n' + bodyHash;
  const signature = crypto.createHmac('sha256', process.env.FLASHTOPUP_API_KEY || '').update(canonical).digest('hex');
  const headers = {
    'X-FT-API-ID': process.env.FLASHTOPUP_API_ID || '',
    'X-FT-Timestamp': ts, 'X-FT-Nonce': nonce, 'X-FT-Signature': signature,
    'Accept': 'application/json'
  };
  if (SANDBOX) headers['X-FT-Sandbox'] = 'true';
  const res = await doFetch(url, { method: 'GET', headers: headers });
  let json = null; try { json = await res.json(); } catch (e) {}
  const ok = res.status < 400 && json && json.success !== false;
  return { http: res.status, ok: ok, data: (json && json.data) || null, raw: json };
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function pick(o, keys) { for (var i = 0; i < keys.length; i++) { var k = keys[i]; if (o && o[k] != null && o[k] !== '') return o[k]; } return ''; }
function asArray(d) { if (Array.isArray(d)) return d; if (d && Array.isArray(d.items)) return d.items; if (d && Array.isArray(d.data)) return d.data; return []; }

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    if (!process.env.FLASHTOPUP_API_ID || !process.env.FLASHTOPUP_API_KEY) {
      return res.status(500).send('<p>FLASHTOPUP_API_ID / FLASHTOPUP_API_KEY manquants sur Vercel.</p>');
    }
    const q = ((req.query && req.query.q) || '').toString().toLowerCase().trim();

    const prod = await ftGet('/products', 'per_page=500');
    if (!prod.ok) {
      return res.status(200).send('<pre style="white-space:pre-wrap">Réponse /products (HTTP ' + esc(prod.http) + ') :\n' + esc(JSON.stringify(prod.raw, null, 2)) + '</pre>');
    }
    const products = asArray(prod.data);

    let html = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlashTopup service_code</title>'
      + '<style>body{font-family:system-ui,Arial;margin:14px;background:#0f1420;color:#e7ecf5}h1{font-size:17px}h2{font-size:15px;margin:18px 0 6px;color:#4dd0ff}table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:8px}th,td{border:1px solid #2a3550;padding:6px 8px;text-align:left}th{background:#182238}code{background:#1c2740;padding:2px 6px;border-radius:6px;color:#ffd166;user-select:all}.m{color:#8aa}</style></head><body>';
    html += '<h1>🔎 FlashTopup — copie le <code>service_code</code> exact</h1>';

    if (!q) {
      html += '<p class="m">' + products.length + ' produit(s). Ajoute <code>?q=pubg</code> à l\'URL pour voir les service_code d\'un jeu.</p>';
      html += '<table><tr><th>Produit</th><th>product_id</th><th>product_code</th></tr>';
      for (var i = 0; i < products.length; i++) {
        var p = products[i];
        html += '<tr><td>' + esc(pick(p, ['name', 'title', 'product_name'])) + '</td><td>' + esc(pick(p, ['id', 'product_id'])) + '</td><td><code>' + esc(pick(p, ['code', 'product_code'])) + '</code></td></tr>';
      }
      html += '</table>';
    } else {
      const matched = products.filter(function (p) {
        return (pick(p, ['name', 'title', 'product_name']) + ' ' + pick(p, ['code', 'product_code'])).toLowerCase().indexOf(q) >= 0;
      }).slice(0, 4);
      if (!matched.length) html += '<p class="m">Aucun produit ne correspond à « ' + esc(q) + ' ».</p>';
      for (var j = 0; j < matched.length; j++) {
        var pr = matched[j];
        var pid = pick(pr, ['id', 'product_id']);
        var pcode = pick(pr, ['code', 'product_code']);
        html += '<h2>' + esc(pick(pr, ['name', 'title', 'product_name'])) + ' <span class="m">(id ' + esc(pid) + ' · ' + esc(pcode) + ')</span></h2>';
        var sv = await ftGet('/services', 'product_id=' + encodeURIComponent(pid));
        var services = asArray(sv.data);
        if (!services.length) { sv = await ftGet('/services', 'product_code=' + encodeURIComponent(pcode)); services = asArray(sv.data); }
        if (!services.length) {
          html += '<pre class="m" style="white-space:pre-wrap">Aucun service (HTTP ' + esc(sv.http) + ') :\n' + esc(JSON.stringify(sv.raw, null, 2)).slice(0, 800) + '</pre>';
          continue;
        }
        html += '<table><tr><th>Service</th><th>service_code (à copier)</th><th>Prix</th><th>Statut</th></tr>';
        for (var k = 0; k < services.length; k++) {
          var s = services[k];
          html += '<tr><td>' + esc(pick(s, ['name', 'title', 'service_name'])) + '</td><td><code>' + esc(pick(s, ['service_code', 'code'])) + '</code></td><td>' + esc(pick(s, ['your_price', 'price', 'base_price'])) + '</td><td>' + esc(pick(s, ['status', 'state', 'active'])) + '</td></tr>';
        }
        html += '</table>';
      }
    }
    html += '<p class="m">⚠️ Supprime <b>api/flashtopup-services.js</b> une fois tes produits mappés.</p></body></html>';
    res.status(200).send(html);
  } catch (e) {
    res.status(500).send('<pre style="white-space:pre-wrap">' + esc(e.message) + '</pre>');
  }
};

