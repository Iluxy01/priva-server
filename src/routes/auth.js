const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken } = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, display_name, password, public_key } = req.body;

  // Валидация
  if (!username || !display_name || !password) {
    return res.status(400).json({ error: 'username, display_name and password are required' });
  }

  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return res.status(400).json({
      error: 'Username: only lowercase letters, numbers, underscore. 3-32 chars.'
    });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, public_key)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, display_name, public_key, avatar_url, status, created_at`,
      [username, display_name, hash, public_key || null]
    );

    const user = result.rows[0];
    const token = signToken(user.id, user.username);

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Обновляем last_seen
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);

    const token = signToken(user.id, user.username);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        public_key: user.public_key,
        avatar_url: user.avatar_url,
        status: user.status
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/update-public-key
const { authMiddleware } = require('../middleware/auth');
router.post('/update-public-key', authMiddleware, async (req, res) => {
  const { public_key } = req.body;
  if (!public_key) return res.status(400).json({ error: 'public_key required' });

  try {
    await pool.query(
      'UPDATE users SET public_key = $1 WHERE id = $2',
      [public_key, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update key' });
  }
});

module.exports = router;
