const express = require('express');
const { pool } = require('./db');
const { authenticate } = require('./middleware');

const router = express.Router();

// ── Get my chats ──────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.type, c.name, c.created_at,
              json_agg(
                json_build_object(
                  'id', u.id,
                  'username', u.username,
                  'display_name', u.display_name,
                  'avatar_url', u.avatar_url,
                  'public_key', u.public_key,
                  'last_seen', u.last_seen
                )
              ) AS members
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $1
       JOIN users u ON u.id = cm.user_id
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Create direct chat ─────────────────────────────────────────────────────────
router.post('/direct', authenticate, async (req, res) => {
  const { target_user_id } = req.body;

  if (!target_user_id) return res.status(400).json({ error: 'target_user_id required' });
  if (target_user_id === req.userId) return res.status(400).json({ error: 'Cannot chat with yourself' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if direct chat already exists between these two users
    const existing = await client.query(
      `SELECT c.id FROM chats c
       JOIN chat_members a ON a.chat_id = c.id AND a.user_id = $1
       JOIN chat_members b ON b.chat_id = c.id AND b.user_id = $2
       WHERE c.type = 'direct'
       LIMIT 1`,
      [req.userId, target_user_id]
    );

    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.json({ id: existing.rows[0].id, existing: true });
    }

    const chat = await client.query(
      `INSERT INTO chats (type, created_by) VALUES ('direct', $1) RETURNING *`,
      [req.userId]
    );
    const chatId = chat.rows[0].id;

    await client.query(
      `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [chatId, req.userId, target_user_id]
    );

    await client.query('COMMIT');
    res.status(201).json({ id: chatId, type: 'direct' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── Create group chat ──────────────────────────────────────────────────────────
router.post('/group', authenticate, async (req, res) => {
  const { name, member_ids } = req.body;

  if (!name) return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(member_ids) || member_ids.length < 1) {
    return res.status(400).json({ error: 'member_ids must be an array with at least 1 member' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const chat = await client.query(
      `INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2) RETURNING *`,
      [name, req.userId]
    );
    const chatId = chat.rows[0].id;

    // Add creator + all members (deduplicated)
    const allMembers = [...new Set([req.userId, ...member_ids])];
    for (const uid of allMembers) {
      const role = uid === req.userId ? 'admin' : 'member';
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)`,
        [chatId, uid, role]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: chatId, type: 'group', name });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── Add member to group ────────────────────────────────────────────────────────
router.post('/:chatId/members', authenticate, async (req, res) => {
  const { user_id } = req.body;
  const chatId = parseInt(req.params.chatId);

  try {
    // Only admins can add members
    const adminCheck = await pool.query(
      `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [chatId, req.userId]
    );
    if (!adminCheck.rows[0] || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can add members' });
    }

    await pool.query(
      `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [chatId, user_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
