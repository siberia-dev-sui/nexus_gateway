const { Pool } = require('pg')
const Redis = require('ioredis')

// ─────────────────────────────────────────
// PostgreSQL
// ─────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
})

pool.on('error', (err) => {
  console.error('[PostgreSQL] Unexpected error:', err.message)
})

// ─────────────────────────────────────────
// Redis
// ─────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false
})

redis.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message)
})

redis.on('connect', () => {
  console.log('[Redis] Connected')
})

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────
async function query(sql, params) {
  const client = await pool.connect()
  try {
    const result = await client.query(sql, params)
    return result
  } finally {
    client.release()
  }
}

async function testConnections() {
  try {
    await query('SELECT 1')
    console.log('[PostgreSQL] Connected')
  } catch (err) {
    console.error('[PostgreSQL] Connection failed:', err.message)
    throw err
  }

  try {
    await redis.ping()
    console.log('[Redis] Ping OK')
  } catch (err) {
    console.error('[Redis] Ping failed:', err.message)
    throw err
  }
}

module.exports = { pool, redis, query, testConnections }
