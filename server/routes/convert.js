const express = require('express');
const router  = express.Router();
const { fetch } = require('undici');
const zlib    = require('zlib');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { decrypt }     = require('../services/crypto');

const MAX_BATCH = 50;
const DELAY_MS  = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function maybeDecompress(buffer) {
  if (buffer[0] === 0x1F && buffer[1] === 0x8B) {
    try { return zlib.gunzipSync(buffer); } catch {}
  }
  if (buffer[0] === 0x78) {
    try { return zlib.inflateSync(buffer); } catch {}
  }
  return buffer;
}

async function fetchRaw(assetId, apiKey) {
  const step1 = await fetch(
    `https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`,
    { headers: { 'x-api-key': apiKey, 'Accept': 'application/json' }, redirect: 'follow' }
  );
  if (step1.status === 401) throw new Error('API key tidak valid atau kadaluarsa');
  if (step1.status === 403) throw new Error('API key tidak punya permission Legacy APIs (legacy-asset:manage)');
  if (step1.status === 404) throw new Error('Asset tidak ditemukan');
  if (!step1.ok) throw new Error(`Step1 HTTP ${step1.status}`);

  const meta   = await step1.json();
  const cdnUrl = meta && meta.location;
  if (!cdnUrl) throw new Error('CDN URL tidak ada: ' + JSON.stringify(meta));

  const step2 = await fetch(cdnUrl, {
    headers: { 'User-Agent': 'Roblox/WinInet', 'Accept': '*/*', 'Accept-Encoding': 'identity' },
    redirect: 'follow'
  });
  if (!step2.ok) throw new Error('Step2 CDN HTTP ' + step2.status);

  const raw = Buffer.from(await step2.arrayBuffer());
  return maybeDecompress(raw);
}

function parseTextureId(buffer) {
  const text = buffer.toString('utf8');

  // Format 1: rbxassetid://12345
  let m = text.match(/rbxassetid:\/\/(\d+)/i);
  if (m) return m[1];

  // Format 2: http://www.roblox.com/asset/?id=12345
  m = text.match(/roblox\.com\/asset\/\?id=(\d+)/i);
  if (m) return m[1];

  // Format 3: <url> atau <uri> berisi angka saja
  m = text.match(/<(?:url|uri)>\s*(\d{6,})\s*<\/(?:url|uri)>/i);
  if (m) return m[1];

  // Format 4: angka 10+ digit (asset ID modern) di mana saja
  const big = text.match(/\b(\d{10,})\b/);
  if (big) return big[1];

  return null;
}

// ── GET /user/convert/debug/:assetId ────────────────────────
router.get('/debug/:assetId', requireAuth, async (req, res) => {
  try {
    const assetId    = req.params.assetId;
    const account_id = req.query.account_id;
    if (!account_id) return res.status(400).json({ error: 'Tambah ?account_id=ID_AKUN' });

    const acc = await db.query(
      'SELECT api_key_encrypted FROM roblox_accounts WHERE id=$1 AND user_id=$2',
      [account_id, req.session.user.id]
    );
    if (!acc.rows.length) return res.status(403).json({ error: 'Account tidak ditemukan' });

    const apiKey = decrypt(acc.rows[0].api_key_encrypted).trim();
    const buffer = await fetchRaw(assetId, apiKey);
    const text   = buffer.toString('utf8');

    res.json({
      asset_id:        assetId,
      size_bytes:      buffer.length,
      first_16_hex:    buffer.slice(0, 16).toString('hex'),
      parsed_image_id: parseTextureId(buffer),
      full_text:       text,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /user/convert/decal-to-image ───────────────────────
router.post('/decal-to-image', requireAuth, async (req, res) => {
  try {
    const { items, roblox_account_id } = req.body;

    if (!roblox_account_id)
      return res.status(400).json({ error: 'Pilih Roblox account' });
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'items wajib berupa array' });
    if (items.length > MAX_BATCH)
      return res.status(400).json({ error: 'Maksimal ' + MAX_BATCH + ' item' });

    const acc = await db.query(
      'SELECT api_key_encrypted FROM roblox_accounts WHERE id=$1 AND user_id=$2',
      [roblox_account_id, req.session.user.id]
    );
    if (!acc.rows.length)
      return res.status(403).json({ error: 'Roblox account tidak ditemukan' });

    const apiKey  = decrypt(acc.rows[0].api_key_encrypted).trim();
    const results = [];

    for (const item of items) {
      const decalId = String(item.id).trim();
      const name    = String(item.name || '').trim();

      if (!/^\d+$/.test(decalId)) {
        results.push({ decal_id: decalId, name, image_id: null, error: 'ID tidak valid' });
        continue;
      }

      try {
        const buffer  = await fetchRaw(decalId, apiKey);
        const text    = buffer.toString('utf8');
        const head    = text.slice(0, 80).toLowerCase().trimStart();

        if (head.startsWith('<!') || head.startsWith('<html'))
          throw new Error('Dapat HTML error — API key mungkin tidak valid');
        if (head.startsWith('{')) {
          try {
            const j = JSON.parse(text);
            throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'Roblox API error');
          } catch(e) { throw e; }
        }

        const imageId = parseTextureId(buffer);

        if (!imageId) {
          console.error('[Convert] Parse gagal', decalId, '| size:', buffer.length, '| head:', text.slice(0, 300));
          results.push({ decal_id: decalId, name, image_id: null, error: 'TextureId tidak ditemukan. Cek Railway logs.' });
        } else {
          console.log('[Convert]', decalId, '->', imageId);
          results.push({ decal_id: decalId, name, image_id: imageId, error: null });
        }
      } catch (err) {
        results.push({ decal_id: decalId, name, image_id: null, error: err.message });
      }

      await sleep(DELAY_MS);
    }

    const ok   = results.filter(function(r) { return r.image_id; });
    const fail = results.filter(function(r) { return !r.image_id; });
    res.json({ results, ok_count: ok.length, fail_count: fail.length });

  } catch (err) {
    console.error('[Convert]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;
