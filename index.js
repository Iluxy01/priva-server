require('dotenv').config();
const http = require('http');
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
app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/chats', chatsRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

setupWebSocket(server);

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 PrivaChat server running on port ${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
