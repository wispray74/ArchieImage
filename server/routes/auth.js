const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib' });

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user   = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Email atau password salah' });

    if (user.expires_at && new Date(user.expires_at) < new Date())
      return res.status(403).json({ error: 'Akun expired. Hubungi admin.' });

    req.session.user = { id: user.id, email: user.email, role: user.role, expires_at: user.expires_at || null };
    res.json({ role: user.role });
  } catch (err) {
    console.error('[Login]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.post('/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

router.post('/setup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib' });

    const count = await db.query('SELECT COUNT(*) FROM users');
    if (parseInt(count.rows[0].count) > 0)
      return res.status(403).json({ error: 'Setup sudah dilakukan. Silakan login.' });

    const hashed = await bcrypt.hash(password, 12);
    await db.query(
      'INSERT INTO users (email, password, role) VALUES ($1, $2, $3)',
      [email, hashed, 'admin']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Setup]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;
