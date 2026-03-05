const db = require('./db');

async function migrate() {
  console.log('Running migrations...');

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('[migrate] users OK');

    await db.query(`
      CREATE TABLE IF NOT EXISTS roblox_accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        account_name VARCHAR(255) NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        roblox_user_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('[migrate] roblox_accounts OK');

    await db.query(`
      CREATE TABLE IF NOT EXISTS upload_jobs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        roblox_account_id INTEGER REFERENCES roblox_accounts(id) ON DELETE SET NULL,
        group_id BIGINT,
        title VARCHAR(255) NOT NULL,
        original_filename VARCHAR(255),
        original_name VARCHAR(255),
        asset_id BIGINT,
        status VARCHAR(20) DEFAULT 'waiting',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('[migrate] upload_jobs OK');

    await db.query(`ALTER TABLE upload_jobs ADD COLUMN IF NOT EXISTS original_name VARCHAR(255)`).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        key_value VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('[migrate] api_keys OK');

    await db.query(`CREATE INDEX IF NOT EXISTS idx_jobs_user   ON upload_jobs(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON upload_jobs(status)`);

    console.log('Migrations done.');
  } catch (err) {
    console.error('[migrate] FAILED:', err);
    throw err;
  }
}

module.exports = migrate;
