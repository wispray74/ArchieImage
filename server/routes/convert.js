const express = require('express');
const router  = express.Router();
const { fetch } = require('undici');
const zlib    = require('zlib');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { decrypt }     = require('../services/crypto');

const MAX_BATCH = 50;
const DELAY_MS  = 300; // jeda antar request supaya tidak rate limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function maybeDecompress(buffer) {
  if (buffer[0] === 0x1F && buffer[1] === 0x8B) {
    try { return zlib.gunzipSync(buffer); } catch {}
  }
  return buffer;
}

// Fetch raw asset bytes via Open Cloud Asset Delivery API
async function fetchRaw(assetId, apiKey) {
  const step1 = await fetch(
    `https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`,
    { headers: { 'x-api-key': apiKey, 'Accept': 'application/json' }, redirect: 'follow' }
  );

  if (step1.status === 401) throw new Error('API key tidak valid atau kadaluarsa');
  if (step1.status === 403) throw new Error('API key tidak punya permission "Legacy APIs". Tambah legacy-asset:manage di credentials.');
  if (step1.status === 404) throw new Error('Asset tidak ditemukan');
  if (!step1.ok) throw new Error(`HTTP ${step1.status}`);

  const meta   = await step1.json();
  const cdnUrl = meta?.location;
  if (!cdnUrl) throw new Error('CDN URL tidak ada di response');

  const step2 = await fetch(cdnUrl, {
    headers: { 'User-Agent': 'Roblox/WinInet', 'Accept': '*/*', 'Accept-Encoding': 'identity' },
    redirect: 'follow'
  });
  if (!step2.ok) throw new Error(`CDN error HTTP ${step2.status}`);

  let buf = Buffer.from(await step2.arrayBuffer());
  return maybeDecompress(buf);
}

// Parse Image ID dari XML Decal.
// Roblox lama: <url>rbxassetid://ID</url>
// Roblox baru: <uri>rbxassetid://ID</uri>
function parseTextureId(buffer) {
  const text = buffer.toString('utf8');

  // format baru: <uri>
  let m = text.match(/<uri>rbxassetid:\/\/(\d+)<\/uri>/i);
  if (m) return m[1];

  // format lama: <url>
  m = text.match(/<url>rbxassetid:\/\/(\d+)<\/url>/i);
  if (m) return m[1];

  // name="Texture" diikuti rbxassetid
  m = text.match(/name="Texture"[\s\S]{0,300}?rbxassetid:\/\/(\d+)/i);
  if (m) return m[1];

  // ambil semua rbxassetid, return yang pertama
  const all = [...text.matchAll(/rbxassetid:\/\/(\d+)/gi)].map(x => x[1]);
  if (all.length) return all[0];

  return null;
}

// Cek apakah buffer adalah error HTML atau JSON
function checkForError(buffer) {
  const head = buffer.slice(0, 64).toString('utf8').toLowerCase().trimStart();
  if (head.startsWith('<!') || head.startsWith('<html')) throw new Error('Dapat HTML error page — API key mungkin tidak valid');
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      const j = JSON.parse(buffer.toString());
      throw new Error(j?.errors?.[0]?.message || 'Roblox API error');
    } catch (e) { if (e.message !== 'Roblox API error') throw e; }
  }
}

// ── POST /user/convert/decal-to-image ────────────────────────
router.post('/decal-to-image', requireAuth, async (req, res) => {
  try {
    let { items, roblox_account_id } = req.body;
    // items = [{ id: "123456", name: "Asah Golok" }, ...]

    if (!roblox_account_id)
      return res.status(400).json({ error: 'Pilih Roblox account' });
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'items wajib berupa array' });
    if (items.length > MAX_BATCH)
      return res.status(400).json({ error: `Maksimal ${MAX_BATCH} item per batch` });

    // Ambil & dekripsi API key
    const accResult = await db.query(
      'SELECT api_key_encrypted FROM roblox_accounts WHERE id = $1 AND user_id = $2',
      [roblox_account_id, req.session.user.id]
    );
    if (!accResult.rows.length)
      return res.status(403).json({ error: 'Roblox account tidak ditemukan' });

    const apiKey  = decrypt(accResult.rows[0].api_key_encrypted).trim();
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
        checkForError(buffer);
        const imageId = parseTextureId(buffer);

        if (!imageId) {
          results.push({ decal_id: decalId, name, image_id: null, error: 'TextureId tidak ditemukan (bukan Decal?)' });
        } else {
          results.push({ decal_id: decalId, name, image_id: imageId, error: null });
        }
      } catch (err) {
        results.push({ decal_id: decalId, name, image_id: null, error: err.message });
      }

      await sleep(DELAY_MS);
    }

    const ok   = results.filter(r => r.image_id);
    const fail = results.filter(r => !r.image_id);
    res.json({ results, ok_count: ok.length, fail_count: fail.length });

  } catch (err) {
    console.error('[Convert]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;

// ── GET /user/convert/debug/:assetId ─────────────────────────
// Lihat raw content asset untuk debug parsing
router.get('/debug/:assetId', requireAuth, async (req, res) => {
  try {
    const assetId = req.params.assetId;
    const robloxAccId = req.query.account_id;
    if (!robloxAccId) return res.status(400).json({ error: 'Tambah ?account_id=ID' });

    const accResult = await db.query(
      'SELECT api_key_encrypted FROM roblox_accounts WHERE id = $1 AND user_id = $2',
      [robloxAccId, req.session.user.id]
    );
    if (!accResult.rows.length) return res.status(403).json({ error: 'Account tidak ditemukan' });
    const apiKey = decrypt(accResult.rows[0].api_key_encrypted).trim();

    const buffer = await fetchRaw(assetId, apiKey);
    const text   = buffer.toString('utf8');

    res.json({
      asset_id:       assetId,
      size_bytes:     buffer.length,
      first_16_hex:   buffer.slice(0, 16).toString('hex'),
      first_500_text: text.slice(0, 500),
      all_rbxassetids: [...text.matchAll(/rbxassetid:\/\/(\d+)/gi)].map(m => m[1]),
      all_numbers_6plus: [...text.matchAll(/\b(\d{6,})\b/g)].map(m => m[1]).slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
