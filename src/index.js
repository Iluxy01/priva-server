'use strict';

const config = require('./config');
const createLogger = require('./utils/logger');
const { httpStream } = require('./utils/logger');
const log = createLogger('Server');

const express = require('express');
const morgan  = require('morgan');
const cors    = require('cors');
const http    = require('http');

const { runMigrations } = require('./db/migrate');
const { authLimiter }   = require('./middleware/rateLimit');
const authRoutes        = require('./routes/auth');
const usersRoutes       = require('./routes/users');

async function start() {
  log.info('Starting Secure Messenger Server v1.0.0');
  log.info(`Environment: ${config.NODE_ENV}`);

  // Run migrations
  log.info('Running database migrations...');
  await runMigrations();

  const app = express();

  // HTTP request logging via morgan → our logger
  app.use(morgan('combined', { stream: httpStream }));
  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    log.debug('[Health] Health check');
    res.json({
      status:    'ok',
      uptime:    process.uptime(),
      env:       config.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  // Routes
  app.use('/api/auth',  authLimiter, authRoutes);
  app.use('/api/users', usersRoutes);

  // Global error handler
  app.use((err, req, res, next) => {
    log.error(`Unhandled error: ${err.message}`, err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = http.createServer(app);

  const port = parseInt(config.PORT, 10);
  server.listen(port, () => {
    log.info(`HTTP server listening on port ${port}`);
  });

  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason}`, reason instanceof Error ? reason : new Error(String(reason)));
  });

  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}`, err);
    process.exit(1);
  });

  return server;
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
