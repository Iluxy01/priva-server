'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('./pool');
const createLogger = require('../utils/logger');
const log = createLogger('Migrate');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations() {
  // Ensure tracking table exists
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let applied = 0;

  for (const file of files) {
    const { rows } = await query(
      'SELECT name FROM schema_migrations WHERE name = $1',
      [file]
    );

    if (rows.length > 0) {
      log.debug(`Already applied: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    log.info(`Running: ${file}`);

    await query(sql);
    await query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);

    log.info(`Applied: ${file}`);
    applied++;
  }

  log.info(`All migrations up to date (${applied} applied)`);
}

module.exports = { runMigrations };
