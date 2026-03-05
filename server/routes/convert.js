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
  if (buffer[0] === 0x78 && (buffer[1] === 0x9C || buffer[1] === 0xDA || buffer[1] === 0x01)) {
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
  if (step1.status === 403) throw new Error('API key tidak punya permission "Legacy APIs" (legacy-asset:manage)');
  if (step1.status === 404) throw new Error('Asset tidak ditemukan');
  if (!step1.ok) throw new Error(`Step1 HTTP ${step1.status}`);

  const meta   = await step1.json();
  const cdnUrl = meta?.location;
  if (!cdnUrl) throw new Error('CDN URL tidak ada: ' + JSON.stringify(meta));

  const step2 = await fetch(cdnUrl, {
    headers: { 'User-Agent': 'Roblox/WinInet', 'Accept': '*/*', 'Accept-Encoding': 'identity' },
    redirect: 'follow'
  });
  if (!step2.ok) throw new Error(`Step2 CDN HTTP ${step2.status}`);

  const raw = Buffer.from(await step2.arrayBuffer());
  return maybeDecompress(raw);
}

function parseTextureId(buffer) {
  const text = buffer.toString('utf8');

  // <uri>rbxassetid://ID</uri>  — Open Cloud / format baru
  let m = text.match(/<uri>\s*rbxassetid:\/\/(\d+)\s*<\/uri>/i);
  if (m) return m[1];

  // <url>rbxassetid://ID</url>  — format lama
  m = text.match(/<url>\s*rbxassetid:\/\/(\d+)\s*<\/url>/i);
  if (m) return m[1];

  // name="Texture" ... rbxassetid://ID
  m = text.match(/name=["']Texture["'][\s\S]{0,400}?rbxassetid:\/\/(\d+)/i);
  if (m) return m[1];

  // Semua rbxassetid di dokumen
  const all = [...text.matchAll(/rbxassetid:\/\/(\d+)/gi)].map(x => x[1]);
  if (all.length) return all[0];

  return null;
}

// ── GET /user/convert/debug/:assetId ─────────────────────────
router.get('/debug/:assetId', requireAuth, async (req, res) => {
  try {
    const { assetId } = req.params;
    const { account_id } = req.query;
    if (!account_id) return res.status(400).json({ error: 'Tambah ?account_id=ID_AKUN_ROBLOX' });

    const acc = await db.query(
      'SELECT api_key_encrypted FROM roblox_accounts WHERE id=$1 AND user_id=$2',
      [account_id, req.session.user.id]
    );
    if (!acc.rows.length) return res.status(403).json({ error: 'Account tidak ditemukan' });

    const apiKey = decrypt(acc.rows[0].api_key_encrypted).trim();
    const buffer = await fetchRaw(assetId, apiKey);
    const text   = buffer.toString('utf8');
    const hex16  = buffer.slice(0, 16).toString('hex');
    const parsed = parseTextureId(buffer);

    res.json({
      asset_id:         assetId,
      size_bytes:       buffer.length,
      first_16_hex:     hex16,
      is_xml:           text.trimStart().startsWith('<'),
      is_binary:        buffer[0] === 0x3C && buffer[1] === 0x72, // <r = roblox binary
      parsed_image_id:  parsed,
      first_800_text:   text.slice(0, 800),
      all_rbxassetids:  [...text.matchAll(/rbxassetid:\/\/(\d+)/gi)].map(m => m[1]),
      all_numbers_8plus:[...text.matchAll(/\b(\d{8,})\b/g)].map(m => m[1]).slice(0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /user/convert/decal-to-image ────────────────────────
router.post('/decal-to-image', requireAuth, async (req, res) => {
  try {
    const { items, roblox_account_id } = req.body;

    if (!roblox_account_id)
      return res.status(400).json({ error: 'Pilih Roblox account' });
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'items wajib berupa array' });
    if (items.length > MAX_BATCH)
      return res.status(400).json({ error: `Maksimal ${MAX_BATCH} item` });

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

        // Cek error response
        if (head.startsWith('<!') || head.startsWith('<html'))
          throw new Error('Dapat HTML error — API key mungkin tidak valid');
        if (head.startsWith('{')) {
          const j = JSON.parse(text);
          throw new Error(j?.errors?.[0]?.message || 'Roblox API error');
        }

        const imageId = parseTextureId(buffer);

        if (!imageId) {
          // Log raw untuk debugging
          console.error(`[Convert] Parse gagal untuk ${decalId}. Size: ${buffer.length}. Head: ${text.slice(0, 200)}`);
          results.push({ decal_id: decalId, name, image_id: null, error: 'TextureId tidak ditemukan. Cek log Railway.' });
        } else {
          console.log(`[Convert] ${decalId} → Image ID: ${imageId}`);
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
