function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.session.user.expires_at) {
    if (new Date(req.session.user.expires_at) < new Date()) {
      req.session.destroy();
      return res.status(401).json({ error: 'Akun expired. Hubungi admin.' });
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

module.exports = { requireAuth, requireAdmin };
