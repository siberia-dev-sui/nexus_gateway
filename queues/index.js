const { Queue, QueueEvents } = require('bullmq')

const connection = {
  host: process.env.REDIS_HOST || 'nexus_redis',
  port: 6379,
  password: process.env.REDIS_PASSWORD
}

// Cola única con prioridades
const outboxQueue = new Queue('nexus-outbox', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 30000  // 30s → 60s → 120s → 300s → 600s
    },
    removeOnComplete: { count: 100 },  // mantener últimos 100 completados
    removeOnFail: false                 // mantener fallidos para debug
  }
})

const queueEvents = new QueueEvents('nexus-outbox', { connection })

// Prioridades por tipo de evento
const PRIORITY = {
  ORDER_CREATED:      10,  // P0 crítico
  PAYMENT_RECORDED:   10,  // P0 crítico
  VISIT_CHECKIN:       7,  // P1 alto
  VISIT_CLOSED:        7,  // P1 alto
  PHOTO_UPLOADED:      3   // P3 background
}

async function addToQueue(tipo, payload, clientUuid) {
  const priority = PRIORITY[tipo] || 5

  return outboxQueue.add(tipo, { tipo, payload, clientUuid }, {
    jobId: clientUuid,     // idempotencia — mismo UUID no se encola dos veces
    priority
  })
}

module.exports = { outboxQueue, queueEvents, addToQueue, connection }
