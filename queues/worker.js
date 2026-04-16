const { Worker } = require('bullmq')
const { connection } = require('./index')
const { query } = require('../db')
const { processOrder } = require('./processors/order')
const { processVisit } = require('./processors/visit')

// ── Circuit Breaker ───────────────────────────────────
let consecutiveFails = 0
let circuitOpen = false
let circuitOpenAt = null
const CIRCUIT_THRESHOLD = 3       // fallos para abrir
const CIRCUIT_PAUSE_MS  = 60000   // pausa 60s

function checkCircuit() {
  if (!circuitOpen) return true
  const elapsed = Date.now() - circuitOpenAt
  if (elapsed > CIRCUIT_PAUSE_MS) {
    circuitOpen = false
    consecutiveFails = 0
    console.log('[WORKER] Circuit breaker cerrado — reanudando')
    return true
  }
  const restante = Math.ceil((CIRCUIT_PAUSE_MS - elapsed) / 1000)
  console.log(`[WORKER] Circuit breaker abierto — esperando ${restante}s`)
  return false
}

function onOdooSuccess() {
  consecutiveFails = 0
}

function onOdooFail() {
  consecutiveFails++
  if (consecutiveFails >= CIRCUIT_THRESHOLD && !circuitOpen) {
    circuitOpen = true
    circuitOpenAt = Date.now()
    console.warn(`[WORKER] ⚠️ Circuit breaker ABIERTO — ${consecutiveFails} fallos consecutivos`)
  }
}

// ── Worker principal ──────────────────────────────────
const worker = new Worker('nexus-outbox', async (job) => {
  const { tipo, clientUuid } = job.data

  // Circuit breaker — si Odoo está fallando, no intentar
  if (!checkCircuit()) {
    throw new Error('Circuit breaker abierto — reintentando después')
  }

  // Marcar como SENDING en PostgreSQL
  await query(
    `UPDATE outbox SET estado = 'SENDING', updated_at = NOW() WHERE client_uuid = $1`,
    [clientUuid]
  )

  try {
    let result

    switch (tipo) {
      case 'ORDER_CREATED':
        result = await processOrder(job, globalOdooPost)
        break
      case 'VISIT_CHECKIN':
      case 'VISIT_CLOSED':
        result = await processVisit(job, globalOdooPost)
        break
      default:
        console.warn(`[WORKER] Tipo desconocido: ${tipo}`)
        return
    }

    onOdooSuccess()
    return result

  } catch (err) {
    onOdooFail()

    // Actualizar retry_count en PostgreSQL
    await query(
      `UPDATE outbox
       SET estado = 'FAILED', retry_count = retry_count + 1,
           error_msg = $1, updated_at = NOW()
       WHERE client_uuid = $2`,
      [err.message, clientUuid]
    )
    throw err  // BullMQ maneja el reintento
  }

}, {
  connection,
  concurrency: 2,          // máx 2 workers simultáneos hacia Odoo
  limiter: {
    max: 2,
    duration: 1000         // máx 2 jobs por segundo
  }
})

// ── Dead Letter Queue ─────────────────────────────────
worker.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    const { clientUuid, tipo } = job.data
    console.error(`[WORKER] 💀 Dead Letter: ${tipo} ${clientUuid} — ${err.message}`)

    await query(
      `UPDATE outbox SET estado = 'DEAD', updated_at = NOW() WHERE client_uuid = $1`,
      [clientUuid]
    )
  }
})

worker.on('completed', (job) => {
  console.log(`[WORKER] ✅ Job completado: ${job.data.tipo} ${job.data.clientUuid}`)
})

worker.on('error', (err) => {
  console.error('[WORKER] Error interno:', err.message)
})

// ── Referencias globales inyectadas desde server.js ──────────
let globalOdooCall = null  // ORM directo (legacy — no usar en processors nuevos)
let globalOdooPost = null  // módulo nexus_mobile (usar siempre)

function setOdooCall(fn) { globalOdooCall = fn }
function setOdooPost(fn) { globalOdooPost = fn }

module.exports = { worker, setOdooCall, setOdooPost }
