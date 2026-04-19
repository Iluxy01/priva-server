const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

// Map: userId (string) → Set of WebSocket connections
const clients = new Map();

// ── Лимит сообщений: не более 30 типа 'message' за 10 секунд на пользователя ──
const msgRateLimits = new Map(); // userId → { count, resetAt }

function checkMessageRateLimit(userId) {
  const now = Date.now();
  let entry = msgRateLimits.get(userId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + 10_000 };
    msgRateLimits.set(userId, entry);
  }
  entry.count++;
  return entry.count <= 30;
}

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // ── Шаг 1: ждём первое сообщение с токеном ─────────────────────────────
    // Токен больше не передаётся в URL (не попадает в логи сервера).
    // Клиент обязан прислать { type: "auth", token: "..." } в течение 5 секунд.

    let userId;

    const authTimeout = setTimeout(() => {
      ws.close(4001, 'Auth timeout');
    }, 5000);

    ws.once('message', async (data) => {
      // Разбираем первое сообщение
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        clearTimeout(authTimeout);
        ws.close(4001, 'Invalid auth message');
        return;
      }

      if (msg.type !== 'auth' || !msg.token) {
        clearTimeout(authTimeout);
        ws.close(4001, 'Expected auth message');
        return;
      }

      // Проверяем JWT
      try {
        const payload = jwt.verify(msg.token, process.env.JWT_SECRET);
        userId = String(payload.userId);
      } catch {
        clearTimeout(authTimeout);
        ws.close(4001, 'Unauthorized');
        return;
      }

      clearTimeout(authTimeout);

      // ── Регистрируем соединение ───────────────────────────────────────────
      if (!clients.has(userId)) clients.set(userId, new Set());
      clients.get(userId).add(ws);

      // Обновляем last_seen + уведомляем контакты
      await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
      broadcastPresence(userId, 'online');

      console.log(`✅ User ${userId} connected (${clients.get(userId).size} connections)`);

      // Сообщаем клиенту: аутентификация прошла
      safeSend(ws, { type: 'auth_ok' });

      // ── Шаг 2: обрабатываем обычные сообщения ────────────────────────────
      ws.on('message', async (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return; // Игнорируем невалидный JSON
        }

        switch (msg.type) {

          // ── Ретрансляция сообщения (НЕ сохраняется на сервере) ──────────
          case 'message': {
            // Rate limiting: не более 30 сообщений за 10 секунд
            if (!checkMessageRateLimit(userId)) {
              safeSend(ws, { type: 'error', code: 'rate_limit', message: 'Too many messages' });
              break;
            }

            const { chat_id, temp_id, encrypted_content, media_type, iv, recipient_ids } = msg;

            if (!chat_id || encrypted_content === undefined || encrypted_content === null || !Array.isArray(recipient_ids)) break;

            // Проверяем, что отправитель — участник чата
            const memberCheck = await pool.query(
              `SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
              [chat_id, userId]
            );
            if (!memberCheck.rows[0]) break;

            const envelope = {
              type: 'message',
              chat_id,
              temp_id,
              sender_id: userId,
              encrypted_content,
              media_type: media_type || 'text',
              iv,
              sent_at: new Date().toISOString(),
            };

            // Проверяем, что все recipient_ids — реальные участники чата
            const memberRows = await pool.query(
              `SELECT user_id FROM chat_members WHERE chat_id = $1`,
              [chat_id]
            );
            const chatMemberIds = new Set(memberRows.rows.map(r => String(r.user_id)));

            // Доставляем только верифицированным участникам
            let delivered = false;
            for (const rid of recipient_ids) {
              if (String(rid) === userId) continue;
              if (!chatMemberIds.has(String(rid))) continue;
              delivered = sendToUser(String(rid), envelope) || delivered;
            }

            // ACK отправителю
            safeSend(ws, {
              type: 'message_ack',
              temp_id,
              chat_id,
              delivered,
              sent_at: envelope.sent_at,
            });
            break;
          }

          // ── Индикатор печати ─────────────────────────────────────────────
          case 'typing': {
            const { chat_id, recipient_ids, is_typing } = msg;
            if (!chat_id || !Array.isArray(recipient_ids)) break;

            for (const rid of recipient_ids) {
              if (String(rid) === userId) continue;
              sendToUser(String(rid), {
                type: 'typing',
                chat_id,
                sender_id: userId,
                is_typing: !!is_typing,
              });
            }
            break;
          }

          // ── Уведомление о прочтении ──────────────────────────────────────
          case 'read': {
            const { chat_id, up_to_temp_id, sender_id } = msg;
            if (!chat_id || !sender_id) break;

            sendToUser(String(sender_id), {
              type: 'read',
              chat_id,
              reader_id: userId,
              up_to_temp_id,
            });
            break;
          }

          // ── Ping / keepalive ─────────────────────────────────────────────
          case 'ping':
            safeSend(ws, { type: 'pong' });
            break;
        }
      });

      // ── Отключение ─────────────────────────────────────────────────────────
      ws.on('close', async () => {
        msgRateLimits.delete(userId);

        const conns = clients.get(userId);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) {
            clients.delete(userId);
            await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
            broadcastPresence(userId, 'offline');
            console.log(`👋 User ${userId} disconnected`);
          }
        }
      });

      ws.on('error', (err) => console.error(`WS error for user ${userId}:`, err));
    });

    // Если соединение закрылось до аутентификации — очищаем таймаут
    ws.on('close', () => clearTimeout(authTimeout));
    ws.on('error', (err) => {
      clearTimeout(authTimeout);
      console.error('WS pre-auth error:', err);
    });
  });

  // ── Heartbeat: закрываем мёртвые соединения каждые 30 секунд ──────────────
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) ws.terminate();
    });
  }, 30_000);

  console.log('🔌 WebSocket server ready at /ws');
  return wss;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendToUser(userId, payload) {
  const conns = clients.get(userId);
  if (!conns || conns.size === 0) return false;
  const json = JSON.stringify(payload);
  conns.forEach((ws) => safeSendRaw(ws, json));
  return true;
}

function safeSend(ws, payload) {
  safeSendRaw(ws, JSON.stringify(payload));
}

function safeSendRaw(ws, json) {
  if (ws.readyState === WebSocket.OPEN) ws.send(json);
}

async function broadcastPresence(userId, status) {
  try {
    const result = await pool.query(
      `SELECT DISTINCT cm.user_id
       FROM chat_members cm
       JOIN chat_members cm2 ON cm2.chat_id = cm.chat_id AND cm2.user_id = $1
       WHERE cm.user_id != $1`,
      [userId]
    );
    const payload = { type: 'presence', user_id: userId, status, at: new Date().toISOString() };
    for (const row of result.rows) {
      sendToUser(String(row.user_id), payload);
    }
  } catch (err) {
    console.error('broadcastPresence error:', err);
  }
}

module.exports = { setupWebSocket };
