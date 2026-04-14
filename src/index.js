require('dotenv').config();
const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const chatsRouter = require('./routes/chats');
const { setupWebSocket } = require('./websocket');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/chats', chatsRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }));

// ── Global Express error handler ──────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[Express] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

setupWebSocket(server);

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`[Server] 🚀 PrivaChat running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);

    // ── Self-ping to prevent Render free tier from sleeping ──────────────────
    // Render spins down free services after 15 min of HTTP inactivity.
    // We ping our own /health endpoint every 14 minutes to keep it alive.
    // Runs entirely on the server — no client involvement needed.
    const selfUrl = process.env.RENDER_EXTERNAL_URL;
    if (selfUrl) {
      const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
      console.log(`[Keep-alive] Self-ping enabled → ${selfUrl}/health every 14 min`);

      const doPing = () => {
        const lib = selfUrl.startsWith('https') ? https : http;
        const req = lib.get(`${selfUrl}/health`, (res) => {
          console.log(`[Keep-alive] Self-ping OK (HTTP ${res.statusCode})`);
          res.resume(); // consume response body to free memory
        });
        req.on('error', (err) => {
          console.error('[Keep-alive] Self-ping failed:', err.message);
        });
        req.setTimeout(10_000, () => {
          console.warn('[Keep-alive] Self-ping timed out after 10s');
          req.destroy();
        });
      };

      setInterval(doPing, PING_INTERVAL_MS);
    } else {
      console.log('[Keep-alive] RENDER_EXTERNAL_URL not set — self-ping disabled (local dev)');
    }
  });
}).catch((err) => {
  console.error('[Server] ❌ Failed to initialize database:', err);
  process.exit(1);
});

// ── Crash safety: log and survive ────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Process] ⚠️  Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process] ⚠️  Unhandled promise rejection:', reason);
});
