const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const router = express.Router();

// ── Register ────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, display_name, password, public_key } = req.body;

  // Basic validation
  if (!username || !display_name || !password) {
    return res.status(400).json({ error: 'username, display_name and password are required' });
  }
  if (!/^[a-z0-9_.]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'username must be 3–32 chars: a-z, 0-9, _ or .' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, public_key)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, display_name, public_key, avatar_url, status, created_at`,
      [username.toLowerCase(), display_name, hash, public_key || null]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '90d' });

    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Login ────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username.toLowerCase()]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update last_seen
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '90d' });

    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
