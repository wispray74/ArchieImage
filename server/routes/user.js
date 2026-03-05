const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const crypto   = require('crypto');
const db       = require('../db');
const { requireAuth } = require('../middleware/auth');
const { encrypt }     = require('../services/crypto');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const name = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    cb(null, name + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('Format tidak didukung. Gunakan PNG/JPG/GIF/BMP/WEBP'));
  }
});

router.get('/roblox-accounts', requireAuth, async (req, res) => {
  const result = await db.query(
    'SELECT id, account_name, roblox_user_id, created_at FROM roblox_accounts WHERE user_id = $1 ORDER BY created_at DESC',
    [req.session.user.id]
  );
  res.json(result.rows);
});

router.post('/roblox-accounts', requireAuth, async (req, res) => {
  try {
    const { account_name, api_key, roblox_user_id } = req.body;
    if (!account_name || !api_key || !roblox_user_id)
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    const apiKeyEnc = encrypt(api_key.trim());
    await db.query(
      'INSERT INTO roblox_accounts (user_id, account_name, api_key_encrypted, roblox_user_id) VALUES ($1, $2, $3, $4)',
      [req.session.user.id, account_name.trim(), apiKeyEnc, roblox_user_id]
    );
    res.json({ success: true, account_name: account_name.trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/roblox-accounts/:id', requireAuth, async (req, res) => {
  await db.query('DELETE FROM roblox_accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
  res.json({ success: true });
});

router.get('/jobs', requireAuth, async (req, res) => {
  const result = await db.query(
    `SELECT id, title, original_name, status, asset_id, error_message, created_at, updated_at
     FROM upload_jobs WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.session.user.id]
  );
  res.json(result.rows);
});

// Export Lua table untuk job yang sudah uploaded
router.get('/export-lua', requireAuth, async (req, res) => {
  const { group_id } = req.query;
  let query = `SELECT asset_id, original_name FROM upload_jobs WHERE user_id = $1 AND status = 'uploaded'`;
  const params = [req.session.user.id];
  if (group_id) { query += ` AND group_id = $2`; params.push(group_id); }
  query += ` ORDER BY created_at DESC`;
  const result = await db.query(query, params);
  res.json(result.rows);
});

router.post('/upload', requireAuth, upload.array('files', 50), async (req, res) => {
  try {
    const { roblox_account_id, group_id } = req.body;
    if (!roblox_account_id || !req.files?.length)
      return res.status(400).json({ error: 'Pilih akun Roblox dan minimal 1 file' });

    const accountCheck = await db.query(
      'SELECT id FROM roblox_accounts WHERE id = $1 AND user_id = $2',
      [roblox_account_id, req.session.user.id]
    );
    if (!accountCheck.rows.length) return res.status(403).json({ error: 'Account not found' });

    const jobs = [];
    for (const file of req.files) {
      const originalName = path.basename(file.originalname, path.extname(file.originalname));
      const result = await db.query(
        `INSERT INTO upload_jobs (user_id, roblox_account_id, group_id, title, original_filename, original_name)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.session.user.id, roblox_account_id, group_id || null, originalName, file.path, originalName]
      );
      jobs.push(result.rows[0].id);
    }
    res.json({ success: true, job_ids: jobs, count: jobs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
