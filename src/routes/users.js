'use strict';

const express = require('express');
const { query } = require('../db/pool');
const authMiddleware = require('../middleware/auth');
const createLogger = require('../utils/logger');
const log = createLogger('Users');

const router = express.Router();

// GET /api/users/:username
router.get('/:username', authMiddleware, async (req, res) => {
  const { username } = req.params;

  log.debug(`User lookup: username=${username} by userId=${req.userId}`);

  try {
    const result = await query(
      `SELECT id, username, public_key_x25519, public_key_ed25519
       FROM users WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      log.warn(`User lookup: username=${username} not found`);
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    return res.json({
      userId:          user.id,
      username:        user.username,
      publicKeyX25519: user.public_key_x25519,
      publicKeyEd25519: user.public_key_ed25519,
    });
  } catch (err) {
    log.error('User lookup error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
