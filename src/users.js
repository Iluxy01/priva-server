const express = require('express');
const { pool } = require('./db');
const { authenticate } = require('./middleware');

const router = express.Router();

// ── Search users ─────────────────────────────────────────────────────────────
router.get('/search', authenticate, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, status, public_key, last_seen
       FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $1)
         AND id != $2
       LIMIT 20`,
      [`%${q}%`, req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Get my profile ────────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, status, public_key, created_at, last_seen
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Update profile ────────────────────────────────────────────────────────────
router.patch('/me', authenticate, async (req, res) => {
  const { display_name, status, avatar_url, public_key } = req.body;

  const fields = [];
  const values = [];
  let i = 1;

  if (display_name !== undefined) { fields.push(`display_name = $${i++}`); values.push(display_name); }
  if (status !== undefined)       { fields.push(`status = $${i++}`);       values.push(status); }
  if (avatar_url !== undefined)   { fields.push(`avatar_url = $${i++}`);   values.push(avatar_url); }
  if (public_key !== undefined)   { fields.push(`public_key = $${i++}`);   values.push(public_key); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.userId);
  try {
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, username, display_name, avatar_url, status, public_key`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Get user by username (for chat creation) ──────────────────────────────────
router.get('/:username', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, status, public_key, last_seen
       FROM users WHERE username = $1`,
      [req.params.username.toLowerCase()]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
