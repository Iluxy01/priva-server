const router = require('express').Router();
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/users/search?q=username
router.get('/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, status, last_seen
       FROM users
       WHERE username ILIKE $1 AND id != $2
       LIMIT 20`,
      [`%${q}%`, req.userId]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/users/me — текущий пользователь
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, display_name, public_key, avatar_url, status, last_seen, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// GET /api/users/:id — профиль по ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, display_name, public_key, avatar_url, status, last_seen FROM users WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PUT /api/users/me — обновить профиль
router.put('/me', authMiddleware, async (req, res) => {
  const { display_name, status, avatar_url } = req.body;

  const updates = [];
  const values = [];
  let idx = 1;

  if (display_name) { updates.push(`display_name = $${idx++}`); values.push(display_name); }
  if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
  if (avatar_url !== undefined) { updates.push(`avatar_url = $${idx++}`); values.push(avatar_url); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.userId);
  try {
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} 
       RETURNING id, username, display_name, avatar_url, status`,
      values
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = router;
