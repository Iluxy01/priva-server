'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/pool');
const { signAccess, signRefresh, verifyRefresh } = require('../utils/jwt');
const createLogger = require('../utils/logger');
const log = createLogger('Auth');

const router = express.Router();

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, password, publicKeyX25519, publicKeyEd25519 } = req.body;

  // Validate input
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–32 chars: a-z, 0-9, _' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!publicKeyX25519 || !publicKeyEd25519) {
    return res.status(400).json({ error: 'Public keys are required' });
  }

  log.info(`Registration attempt: username=${username}`);

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (username, password_hash, public_key_x25519, public_key_ed25519)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, passwordHash, publicKeyX25519, publicKeyEd25519]
    );

    const userId = result.rows[0].id;
    log.info(`User registered: id=${userId} username=${username}`);

    const accessToken  = signAccess(userId);
    const refreshToken = signRefresh(userId);

    return res.status(201).json({ accessToken, refreshToken, userId });
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation
      log.warn(`Registration failed: username ${username} already taken`);
      return res.status(409).json({ error: 'Username already taken' });
    }
    log.error('Registration error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  log.info(`Login attempt: username=${username}`);

  try {
    const result = await query(
      'SELECT id, password_hash FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      log.warn(`Login failed: username=${username} not found`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      log.warn(`Login failed: invalid password for username=${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last_seen
    await query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);

    log.info(`Login successful: userId=${user.id}`);

    const accessToken  = signAccess(user.id);
    const refreshToken = signRefresh(user.id);

    return res.json({ accessToken, refreshToken, userId: user.id });
  } catch (err) {
    log.error('Login error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const payload = verifyRefresh(refreshToken);
    const userId = payload.userId;

    // Update last_seen
    await query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);

    log.info(`Token refreshed: userId=${userId}`);

    const newAccessToken  = signAccess(userId);
    const newRefreshToken = signRefresh(userId);

    return res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // Stateless — client just discards tokens
  return res.json({ status: 'ok' });
});

module.exports = router;
