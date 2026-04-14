const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

// Map: userId (string) → Set of WebSocket connections
const clients = new Map();

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // ── Authenticate via token in query string ──────────────────────────────
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    let userId;
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      userId = String(payload.userId);
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Register connection
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(ws);

    // Update last_seen + notify contacts
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
    broadcastPresence(userId, 'online');

    console.log(`✅ User ${userId} connected (${clients.get(userId).size} connections)`);

    // ── Handle incoming messages ────────────────────────────────────────────
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // Ignore malformed JSON
      }

      switch (msg.type) {

        // ── Relay chat message (NOT stored on server) ──────────────────────
        case 'message': {
          const { chat_id, temp_id, encrypted_content, media_type, iv, recipient_ids } = msg;

          if (!chat_id || !encrypted_content || !Array.isArray(recipient_ids)) break;

          // Verify sender is in the chat
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

          // Deliver to all recipients that are online
          let delivered = false;
          for (const rid of recipient_ids) {
            if (String(rid) === userId) continue;
            delivered = sendToUser(String(rid), envelope) || delivered;
          }

          // ACK back to sender
          safeSend(ws, {
            type: 'message_ack',
            temp_id,
            chat_id,
            delivered,
            sent_at: envelope.sent_at,
          });
          break;
        }

        // ── Typing indicator ───────────────────────────────────────────────
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

        // ── Read receipt ───────────────────────────────────────────────────
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

        // ── Ping / keepalive ───────────────────────────────────────────────
        case 'ping':
          safeSend(ws, { type: 'pong' });
          break;
      }
    });

    // ── Disconnect ──────────────────────────────────────────────────────────
    ws.on('close', async () => {
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

  // ── Heartbeat: close dead connections every 30s ──────────────────────────
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) ws.terminate();
    });
  }, 30_000);

  console.log('🔌 WebSocket server ready at /ws');
  return wss;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  // Find users who share a chat with this user
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
