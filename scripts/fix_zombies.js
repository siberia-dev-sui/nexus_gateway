// Limpia eventos zombie del outbox y los re-encola en BullMQ.
// Ejecutar una sola vez: docker exec nexus_gateway node scripts/fix_zombies.js
require('dotenv').config()
const { query } = require('../db')
const { addToQueue } = require('../queues/index')

async function main() {
  console.log('[FIX_ZOMBIES] Iniciando limpieza...')

  // 1. PAYMENT_RECORDED SENDING/FAILED → DEAD
  // Lenn eliminó el processor en commit 031c8d7 — estos nunca se procesarán.
  const payments = await query(
    `UPDATE outbox
     SET estado = 'DEAD',
         error_msg = 'Processor PAYMENT_RECORDED eliminado (commit 031c8d7) — no será procesado'
     WHERE tipo = 'PAYMENT_RECORDED' AND estado IN ('SENDING', 'FAILED')
     RETURNING client_uuid`
  )
  console.log(`[FIX_ZOMBIES] PAYMENT_RECORDED → DEAD: ${payments.rowCount}`)

  // 2. ORDER_CREATED / VISIT_CLOSED SENDING → PENDING + re-encolar
  // Quedaron en SENDING cuando Docker rebuildeó y BullMQ perdió los jobs.
  const stalled = await query(
    `UPDATE outbox
     SET estado = 'PENDING', retry_count = 0, error_msg = NULL
     WHERE tipo IN ('ORDER_CREATED', 'VISIT_CHECKIN', 'VISIT_CLOSED') AND estado = 'SENDING'
     RETURNING client_uuid, tipo, payload, vendedor_id`
  )
  console.log(`[FIX_ZOMBIES] SENDING → PENDING: ${stalled.rowCount}`)

  for (const row of stalled.rows) {
    try {
      await addToQueue(row.tipo, row.payload, row.client_uuid)
      console.log(`[FIX_ZOMBIES] Re-encolado: ${row.tipo} ${row.client_uuid}`)
    } catch (e) {
      console.error(`[FIX_ZOMBIES] Error al re-encolar ${row.client_uuid}: ${e.message}`)
    }
  }

  const totals = await query(
    `SELECT estado, COUNT(*) FROM outbox GROUP BY estado ORDER BY estado`
  )
  console.log('[FIX_ZOMBIES] Estado final del outbox:')
  totals.rows.forEach(r => console.log(`  ${r.estado}: ${r.count}`))

  console.log('[FIX_ZOMBIES] Completado')
  process.exit(0)
}

main().catch(e => { console.error('[FIX_ZOMBIES] Fatal:', e); process.exit(1) })
