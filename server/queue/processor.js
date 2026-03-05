const db       = require('../db');
const robloxSvc = require('../services/roblox');
const fs        = require('fs');

const CONCURRENT_WORKERS = parseInt(process.env.QUEUE_WORKERS  || '3');
const POLL_INTERVAL_MS   = parseInt(process.env.QUEUE_POLL_MS  || '2000');
const ROBLOX_RETRY_DELAY = parseInt(process.env.ROBLOX_RETRY_MS || '5000');

let activeWorkers = 0;

function deleteFile(fp) {
  try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
}

async function claimNextJob() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT uj.*, ra.api_key_encrypted, ra.roblox_user_id
      FROM upload_jobs uj
      JOIN roblox_accounts ra ON ra.id = uj.roblox_account_id
      WHERE uj.status = 'waiting'
      ORDER BY uj.created_at ASC
      LIMIT 1
      FOR UPDATE OF uj SKIP LOCKED
    `);
    if (!result.rows.length) { await client.query('ROLLBACK'); return null; }
    const job = result.rows[0];
    await client.query(`UPDATE upload_jobs SET status='processing', updated_at=NOW() WHERE id=$1`, [job.id]);
    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runJob(job) {
  console.log(`[Worker] Job #${job.id} start: "${job.title}" | active: ${activeWorkers}/${CONCURRENT_WORKERS}`);
  try {
    let assetId;
    try {
      assetId = await robloxSvc.uploadImage(
        job.original_filename, job.title,
        job.group_id, job.api_key_encrypted, job.roblox_user_id
      );
    } catch (err) {
      if (/429|rate|limit|throttle/i.test(err.message)) {
        console.warn(`[Worker] Job #${job.id} rate limited, retry in ${ROBLOX_RETRY_DELAY}ms`);
        await new Promise(r => setTimeout(r, ROBLOX_RETRY_DELAY));
        assetId = await robloxSvc.uploadImage(
          job.original_filename, job.title,
          job.group_id, job.api_key_encrypted, job.roblox_user_id
        );
      } else throw err;
    }

    await db.query(
      `UPDATE upload_jobs SET status='uploaded', asset_id=$1, updated_at=NOW() WHERE id=$2`,
      [assetId, job.id]
    );
    console.log(`[Worker] Job #${job.id} done ✓ Asset: ${assetId}`);
    deleteFile(job.original_filename);

  } catch (err) {
    console.error(`[Worker] Job #${job.id} failed:`, err.message);
    await db.query(
      `UPDATE upload_jobs SET status='failed', error_message=$1, updated_at=NOW() WHERE id=$2`,
      [err.message.slice(0, 500), job.id]
    );
  }
}

async function spawnWorker() {
  let job;
  try { job = await claimNextJob(); }
  catch (err) { console.error('[Queue] DB error:', err.message); return; }
  if (!job) return;

  activeWorkers++;
  try { await runJob(job); }
  finally { activeWorkers--; }
}

async function tick() {
  const slots = CONCURRENT_WORKERS - activeWorkers;
  if (slots <= 0) return;
  await Promise.all(Array.from({ length: slots }, () => spawnWorker()));
}

function startQueue() {
  console.log(`[Queue] Started — ${CONCURRENT_WORKERS} workers, poll ${POLL_INTERVAL_MS}ms`);
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startQueue };
