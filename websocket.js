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
      console.log(`[WS] ❌ Unauthorized connection attempt — closing`);
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Register connection
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(ws);

    // Update last_seen + notify contacts
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
    broadcastPresence(userId, 'online');

    console.log(`[WS] ✅ User ${userId} connected (${clients.get(userId).size} connections)`);

    // ── Handle incoming messages ────────────────────────────────────────────
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.warn(`[WS] ⚠️  Malformed JSON from user ${userId} — ignored`);
        return;
      }

      console.log(`[WS] ← user ${userId} sent type="${msg.type}"`);

      switch (msg.type) {

        // ── Relay encrypted chat message (NOT stored on server) ────────────
        case 'message': {
          const {
            chat_id,
            temp_id,
            encrypted_content,
            media_type,
            iv,
            encrypted_keys,   // ← NEW: per-recipient RSA-wrapped AES keys
            recipient_ids,
          } = msg;

          if (!chat_id || !encrypted_content || !Array.isArray(recipient_ids)) {
            console.warn(`[WS] ⚠️  Message from user ${userId} missing required fields — dropped`);
            break;
          }

          // Verify sender is in the chat
          const memberCheck = await pool.query(
            `SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
            [chat_id, userId]
          );
          if (!memberCheck.rows[0]) {
            console.warn(`[WS] ⚠️  User ${userId} not a member of chat ${chat_id} — dropped`);
            break;
          }

          // ── Build relay envelope ─────────────────────────────────────────
          // Server acts as a transparent relay.
          // It passes through encrypted_content, iv, and encrypted_keys.
          // It NEVER sees the plaintext — only ciphertext.
          const envelope = {
            type:              'message',
            chat_id,
            temp_id,
            sender_id:         userId,
            encrypted_content,
            media_type:        media_type || 'text',
            iv:                iv || null,
            encrypted_keys:    encrypted_keys || null,   // ← NEW: relay per-recipient keys
            sent_at:           new Date().toISOString(),
          };

          console.log(
            `[WS] → relaying message chat_id=${chat_id} ` +
            `recipients=[${recipient_ids.join(',')}] ` +
            `has_encrypted_keys=${!!encrypted_keys}`
          );

          // Deliver to all online recipients
          let deliveredCount = 0;
          for (const rid of recipient_ids) {
            if (String(rid) === userId) continue;
            const delivered = sendToUser(String(rid), envelope);
            if (delivered) deliveredCount++;
          }

          console.log(
            `[WS] → message relayed: ${deliveredCount}/${recipient_ids.length - 1} recipients online`
          );

          // ACK back to sender
          safeSend(ws, {
            type:      'message_ack',
            temp_id,
            chat_id,
            delivered: deliveredCount > 0,
            sent_at:   envelope.sent_at,
          });
          break;
        }

        // ── Typing indicator ────────────────────────────────────────────────
        case 'typing': {
          const { chat_id, recipient_ids, is_typing } = msg;
          if (!chat_id || !Array.isArray(recipient_ids)) break;

          for (const rid of recipient_ids) {
            if (String(rid) === userId) continue;
            sendToUser(String(rid), {
              type:      'typing',
              chat_id,
              sender_id: userId,
              is_typing: !!is_typing,
            });
          }
          break;
        }

        // ── Read receipt ────────────────────────────────────────────────────
        case 'read': {
          const { chat_id, up_to_temp_id, sender_id } = msg;
          if (!chat_id || !sender_id) break;

          console.log(`[WS] → read receipt chat_id=${chat_id} from user ${userId} to user ${sender_id}`);
          sendToUser(String(sender_id), {
            type:          'read',
            chat_id,
            reader_id:     userId,
            up_to_temp_id,
          });
          break;
        }

        // ── Ping / keepalive ────────────────────────────────────────────────
        case 'ping':
          safeSend(ws, { type: 'pong' });
          break;

        default:
          console.warn(`[WS] ⚠️  Unknown message type "${msg.type}" from user ${userId}`);
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
          console.log(`[WS] 👋 User ${userId} disconnected`);
        } else {
          console.log(`[WS] User ${userId} still has ${conns.size} connection(s)`);
        }
      }
    });

    ws.on('error', (err) => {
      console.error(`[WS] ❌ Error for user ${userId}:`, err);
    });
  });

  // ── Heartbeat: close dead connections every 30s ──────────────────────────
  setInterval(() => {
    let terminated = 0;
    wss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.terminate();
        terminated++;
      }
    });
    if (terminated > 0) {
      console.log(`[WS] Heartbeat: terminated ${terminated} dead connection(s)`);
    }
  }, 30_000);

  console.log('[WS] 🔌 WebSocket server ready at /ws');
  return wss;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendToUser(userId, payload) {
  const conns = clients.get(userId);
  if (!conns || conns.size === 0) return false;
  const json = JSON.stringify(payload);
  let sent = 0;
  conns.forEach((ws) => {
    if (safeSendRaw(ws, json)) sent++;
  });
  return sent > 0;
}

function safeSend(ws, payload) {
  safeSendRaw(ws, JSON.stringify(payload));
}

function safeSendRaw(ws, json) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(json);
    return true;
  }
  return false;
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
    const payload = {
      type:    'presence',
      user_id: userId,
      status,
      at:      new Date().toISOString(),
    };
    let notified = 0;
    for (const row of result.rows) {
      if (sendToUser(String(row.user_id), payload)) notified++;
    }
    console.log(
      `[WS] broadcastPresence userId=${userId} status=${status} → notified ${notified} users`
    );
  } catch (err) {
    console.error('[WS] broadcastPresence error:', err);
  }
}

module.exports = { setupWebSocket };