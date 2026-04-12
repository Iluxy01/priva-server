const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Initialize tables on first run
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        username    VARCHAR(32) UNIQUE NOT NULL,
        display_name VARCHAR(64) NOT NULL,
        password_hash TEXT NOT NULL,
        public_key  TEXT,
        avatar_url  TEXT,
        status      VARCHAR(128) DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        last_seen   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chats (
        id          SERIAL PRIMARY KEY,
        type        VARCHAR(8) NOT NULL CHECK (type IN ('direct', 'group')),
        name        VARCHAR(128),
        created_by  INTEGER REFERENCES users(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id     INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        joined_at   TIMESTAMPTZ DEFAULT NOW(),
        role        VARCHAR(16) DEFAULT 'member',
        PRIMARY KEY (chat_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    `);
    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
