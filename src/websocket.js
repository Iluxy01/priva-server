const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

// Map: userId (string) → Set of WebSocket connections
const clients = new Map();

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    let userId;
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      userId = String(payload.userId);
    } catch (e) {
      console.warn(`[WS] Auth rejected — ${e.message}`);
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Native WS heartbeat marker
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(ws);

    try {
      await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
      broadcastPresence(userId, 'online');
    } catch (dbErr) {
      console.error(`[WS] DB error on connect user ${userId}:`, dbErr.message);
    }

    console.log(`[WS] CONNECT  user=${userId}  sessions=${clients.get(userId).size}`);

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch { console.warn(`[WS] Malformed JSON from user ${userId}`); return; }

      switch (msg.type) {

        case 'message': {
          const { chat_id, temp_id, encrypted_content, media_type, iv, keys, recipient_ids } = msg;
          if (!chat_id || !encrypted_content || !Array.isArray(recipient_ids)) {
            console.warn(`[WS] MSG_RELAY user=${userId} chat=${chat_id} — missing fields, dropped`);
            break;
          }
          let memberCheck;
          try {
            memberCheck = await pool.query(
              'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
              [chat_id, userId]
            );
          } catch (dbErr) {
            console.error(`[WS] DB membership check error user=${userId}:`, dbErr.message);
            break;
          }
          if (!memberCheck.rows[0]) {
            console.warn(`[WS] MSG_RELAY user=${userId} not member of chat=${chat_id} — blocked`);
            break;
          }
          const sentAt = new Date().toISOString();
          const envelope = {
            type: 'message', chat_id, temp_id, sender_id: userId,
            encrypted_content, media_type: media_type || 'text', iv, keys, sent_at: sentAt,
          };
          let deliveredCount = 0;
          for (const rid of recipient_ids) {
            if (String(rid) === userId) continue;
            if (sendToUser(String(rid), envelope)) deliveredCount++;
          }
          console.log(`[WS] MSG_RELAY chat=${chat_id} from=${userId} to=[${recipient_ids.join(',')}] delivered=${deliveredCount}`);
          safeSend(ws, { type: 'message_ack', temp_id, chat_id, delivered: deliveredCount > 0, sent_at: sentAt });
          break;
        }

        case 'typing': {
          const { chat_id, recipient_ids, is_typing } = msg;
          if (!chat_id || !Array.isArray(recipient_ids)) break;
          for (const rid of recipient_ids) {
            if (String(rid) !== userId) sendToUser(String(rid), { type: 'typing', chat_id, sender_id: userId, is_typing: !!is_typing });
          }
          break;
        }

        case 'read': {
          const { chat_id, up_to_temp_id, sender_id } = msg;
          if (!chat_id || !sender_id) break;
          sendToUser(String(sender_id), { type: 'read', chat_id, reader_id: userId, up_to_temp_id });
          break;
        }

        case 'ping':
          safeSend(ws, { type: 'pong' });
          break;

        default:
          console.warn(`[WS] Unknown type '${msg.type}' from user ${userId}`);
      }
    });

    ws.on('close', async (code) => {
      const conns = clients.get(userId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) {
          clients.delete(userId);
          try {
            await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
            broadcastPresence(userId, 'offline');
          } catch (dbErr) {
            console.error(`[WS] DB error on disconnect user=${userId}:`, dbErr.message);
          }
          console.log(`[WS] DISCONNECT user=${userId} code=${code}`);
        } else {
          console.log(`[WS] DISCONNECT user=${userId} code=${code} (${conns.size} sessions remain)`);
        }
      }
    });

    ws.on('error', (err) => console.error(`[WS] Socket error user=${userId}:`, err.message));
  });

  // ── Native WS heartbeat: server pings all clients every 25s ──────────────
  // protocol-level ping/pong — client responds automatically, no app code needed.
  // Clients that don't pong get terminated → Flutter reconnect kicks in.
  setInterval(() => {
    let alive = 0, terminated = 0;
    wss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) { ws.terminate(); terminated++; return; }
      if (!ws.isAlive) { ws.terminate(); terminated++; return; }
      ws.isAlive = false;
      ws.ping();
      alive++;
    });
    if (terminated > 0) {
      console.log(`[WS] HEARTBEAT alive=${alive} terminated=${terminated}`);
    }
  }, 25_000);

  console.log('[WS] WebSocket server ready at /ws');
  return wss;
}

function sendToUser(userId, payload) {
  const conns = clients.get(userId);
  if (!conns || conns.size === 0) return false;
  const json = JSON.stringify(payload);
  conns.forEach((ws) => safeSendRaw(ws, json));
  return true;
}

function safeSend(ws, payload) { safeSendRaw(ws, JSON.stringify(payload)); }

function safeSendRaw(ws, json) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(json); }
    catch (err) { console.error('[WS] safeSendRaw error:', err.message); }
  }
}

async function broadcastPresence(userId, status) {
  try {
    const result = await pool.query(
      `SELECT DISTINCT cm.user_id FROM chat_members cm
       JOIN chat_members cm2 ON cm2.chat_id = cm.chat_id AND cm2.user_id = $1
       WHERE cm.user_id != $1`,
      [userId]
    );
    const payload = { type: 'presence', user_id: userId, status, at: new Date().toISOString() };
    let notified = 0;
    for (const row of result.rows) if (sendToUser(String(row.user_id), payload)) notified++;
    console.log(`[WS] PRESENCE user=${userId} status=${status} notified=${notified}`);
  } catch (err) {
    console.error('[WS] broadcastPresence error:', err.message);
  }
}

module.exports = { setupWebSocket };
