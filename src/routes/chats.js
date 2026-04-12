const router = require('express').Router();
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/chats — список чатов пользователя
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         c.id, c.type, c.name, c.avatar_url, c.created_at,
         json_agg(json_build_object(
           'id', u.id, 'username', u.username,
           'display_name', u.display_name, 'avatar_url', u.avatar_url,
           'last_seen', u.last_seen, 'public_key', u.public_key
         )) AS members
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       JOIN chat_members cm2 ON cm2.chat_id = c.id
       JOIN users u ON u.id = cm2.user_id
       WHERE cm.user_id = $1
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [req.userId]
    );
    res.json({ chats: result.rows });
  } catch (err) {
    console.error('Get chats error:', err);
    res.status(500).json({ error: 'Failed to get chats' });
  }
});

// POST /api/chats/direct — создать личный чат
router.post('/direct', authMiddleware, async (req, res) => {
  const { target_user_id } = req.body;
  if (!target_user_id) return res.status(400).json({ error: 'target_user_id required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Проверяем, нет ли уже такого чата
    const existing = await client.query(
      `SELECT c.id FROM chats c
       JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
       JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
       WHERE c.type = 'direct'`,
      [req.userId, target_user_id]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({ chat_id: existing.rows[0].id, already_exists: true });
    }

    // Создаём чат
    const chatResult = await client.query(
      `INSERT INTO chats (type, created_by) VALUES ('direct', $1) RETURNING id`,
      [req.userId]
    );
    const chatId = chatResult.rows[0].id;

    // Добавляем обоих участников
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
      [chatId, req.userId, target_user_id]
    );

    await client.query('COMMIT');
    res.status(201).json({ chat_id: chatId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create direct chat error:', err);
    res.status(500).json({ error: 'Failed to create chat' });
  } finally {
    client.release();
  }
});

// POST /api/chats/group — создать группу
router.post('/group', authMiddleware, async (req, res) => {
  const { name, member_ids } = req.body;
  if (!name || !member_ids || !Array.isArray(member_ids)) {
    return res.status(400).json({ error: 'name and member_ids array required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const chatResult = await client.query(
      `INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
      [name, req.userId]
    );
    const chatId = chatResult.rows[0].id;

    // Добавляем создателя как admin + участников
    const allMembers = [req.userId, ...member_ids.filter(id => id !== req.userId)];
    for (const memberId of allMembers) {
      const role = memberId === req.userId ? 'admin' : 'member';
      await client.query(
        'INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)',
        [chatId, memberId, role]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ chat_id: chatId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create group chat error:', err);
    res.status(500).json({ error: 'Failed to create group' });
  } finally {
    client.release();
  }
});

// GET /api/chats/:id/members — участники чата
router.get('/:id/members', authMiddleware, async (req, res) => {
  try {
    // Проверяем, является ли пользователь участником
    const member = await pool.query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (member.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.public_key, 
              u.last_seen, cm.role
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = $1`,
      [req.params.id]
    );
    res.json({ members: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get members' });
  }
});

// POST /api/chats/:id/members — добавить участника в группу
router.post('/:id/members', authMiddleware, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    // Проверяем что текущий пользователь — admin
    const admin = await pool.query(
      `SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND role = 'admin'`,
      [req.params.id, req.userId]
    );
    if (admin.rows.length === 0) return res.status(403).json({ error: 'Not an admin' });

    await pool.query(
      'INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, user_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add member' });
  }
});

module.exports = router;
