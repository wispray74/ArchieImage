const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get('/users', async (req, res) => {
  const result = await db.query('SELECT id, email, role, expires_at, created_at FROM users ORDER BY created_at DESC');
  res.json(result.rows);
});

router.post('/users', async (req, res) => {
  try {
    const { email, password, role, expires_at } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib' });
    const hashed = await bcrypt.hash(password, 12);
    await db.query(
      'INSERT INTO users (email, password, role, expires_at) VALUES ($1, $2, $3, $4)',
      [email, hashed, role || 'user', expires_at || null]
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password wajib' });
    const hashed = await bcrypt.hash(password, 12);
    await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/users/:id/set-expiry', async (req, res) => {
  try {
    const { expires_at, days } = req.body;
    let expiry = null;
    if (days && parseInt(days) > 0) {
      expiry = new Date();
      expiry.setDate(expiry.getDate() + parseInt(days));
    } else if (expires_at) {
      expiry = new Date(expires_at);
    }
    await db.query('UPDATE users SET expires_at = $1 WHERE id = $2', [expiry, req.params.id]);
    res.json({ success: true, expires_at: expiry });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/users/:id', async (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id)
    return res.status(400).json({ error: 'Tidak bisa hapus diri sendiri' });
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

router.get('/jobs', async (req, res) => {
  const result = await db.query(`
    SELECT uj.id, uj.title, uj.original_name, uj.status, uj.asset_id, uj.error_message, uj.created_at,
           u.email as user_email, ra.account_name
    FROM upload_jobs uj
    JOIN users u ON u.id = uj.user_id
    LEFT JOIN roblox_accounts ra ON ra.id = uj.roblox_account_id
    ORDER BY uj.created_at DESC LIMIT 500
  `);
  res.json(result.rows);
});

router.post('/reset-jobs', async (req, res) => {
  try {
    await db.query(`UPDATE upload_jobs SET status='waiting', error_message=NULL, updated_at=NOW() WHERE status='processing'`);
    const result = await db.query(`SELECT COUNT(*) FROM upload_jobs WHERE status='waiting'`);
    res.json({ success: true, waiting_count: parseInt(result.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/jobs/all', async (req, res) => {
  try {
    const r = await db.query('DELETE FROM upload_jobs RETURNING id');
    res.json({ success: true, deleted: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
