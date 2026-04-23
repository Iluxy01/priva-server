'use strict';

const { Pool } = require('pg');
const createLogger = require('../utils/logger');
const log = createLogger('DB');

const config = require('../config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

log.info('Database pool created');

pool.on('error', (err) => {
  log.error(`Pool error: ${err.message}`, err);
});

/**
 * Execute a SQL query.
 * Logs execution time in DEBUG mode.
 * NEVER logs query parameters (may contain sensitive data).
 */
async function query(sql, params) {
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    const duration = Date.now() - start;
    const preview = sql.replace(/\s+/g, ' ').trim().substring(0, 80);
    log.debug(`Query in ${duration}ms: ${preview}`);
    return result;
  } catch (err) {
    log.error(`Query failed: ${err.message}`, err);
    throw err;
  }
}

module.exports = { pool, query };
