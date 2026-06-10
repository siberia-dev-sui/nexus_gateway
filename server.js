require('dotenv').config()

const fastify = require('fastify')({ logger: true, bodyLimit: 25 * 1024 * 1024 })
const axios = require('axios').create({ proxy: false })
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { query, redis, testConnections } = require('./db')
const { addToQueue } = require('./queues/index')
const { worker, setOdooCall, setOdooPost } = require('./queues/worker')
const { processOrder } = require('./queues/processors/order')
const { processVisit } = require('./queues/processors/visit')
const { syncVendors } = require('./crons/sync_vendors')
const { syncClients } = require('./crons/sync_clients')
const { syncVendorCompanies } = require('./crons/sync_vendor_companies')
const { syncVendorOrders } = require('./crons/sync_vendor_orders')
const { syncStock } = require('./crons/sync_stock')
const { syncProductImages } = require('./crons/sync_product_images')
const { syncPaymentJournals } = require('./crons/sync_payment_journals')
const { backfillVendorSuggestions } = require('./crons/order_suggestions')
const {
  validateAndReserve,
  failReservations,
  releaseActiveReservations,
  applyOdooOrderStateToReservations,
  expireOldReservations,
} = require('./crons/stock_reservations')
const { generateRoutes } = require('./crons/generate_routes')
const {
  seedPriceSyncQueueFromAssignments,
  syncPriceEvents,
  processPriceSyncQueue,
  getVendorPriceBook,
} = require('./crons/sync_price_books')

// ─────────────────────────────────────────
// Odoo client: endpoints NEXUS autenticados por token compartido
// ─────────────────────────────────────────

async function odooPost(path, params = {}) {
  if (!process.env.NEXUS_ADMIN_TOKEN) {
    throw new Error('NEXUS_ADMIN_TOKEN no está configurado')
  }
  try {
    const startedAt = Date.now()
    fastify.log.info(`[ODOO_POST] ${path} iniciando`)
    const res = await axios.post(
      `${process.env.ODOO_URL}${path}`,
      { jsonrpc: '2.0', method: 'call', params },
      {
        headers: { 'X-Nexus-Admin-Token': process.env.NEXUS_ADMIN_TOKEN },
        timeout: 30000,
      }
    )
    fastify.log.info(`[ODOO_POST] ${path} OK ${Date.now() - startedAt}ms`)
    if (res.data.error) {
      const message = res.data.error.data?.message || res.data.error.message || 'Odoo JSON-RPC error'
      throw new Error(message)
    }
    if (res.data.result?.error) {
      throw new Error(res.data.result.error)
    }
    return res.data.result
  } catch (err) {
    fastify.log.error(`[ODOO_POST] ${path} ERROR: ${err.stack || err.message}`)
    throw err
  }
}

async function odooCall() {
  throw new Error('odooCall legacy deshabilitado; usar endpoints NEXUS con X-Nexus-Admin-Token')
}

// ─────────────────────────────────────────
// Plugins
// ─────────────────────────────────────────
fastify.register(require('@fastify/cors'), { origin: true })
fastify.register(require('@fastify/jwt'), { secret: process.env.JWT_SECRET })

/**
 * Valida stock + crea reservas para un ORDER_CREATED. Maneja la extracción
 * de warehouse_id del payload y el fallback de seguridad (sin warehouse_id
 * → no se puede reservar → rechaza).
 */
async function _validateAndReserveOrder({ orderUuid, vendorId, payload }) {
  const warehouseId = parseInt(payload.warehouse_id, 10)
  const lines = Array.isArray(payload.lines) ? payload.lines : []

  if (!warehouseId || Number.isNaN(warehouseId)) {
    return {
      ok: false,
      items: [],
      error: 'missing_warehouse_id',
    }
  }
  if (!lines.length) {
    return { ok: false, items: [], error: 'no_lines' }
  }

  return validateAndReserve({
    orderUuid,
    vendorId,
    warehouseId,
    lines,
  })
}

// Tiempo máximo que un vendedor espera en línea por la creación del pedido
// en Odoo. Si Odoo tarda más, respondemos PROCESSING (la app ya maneja ese
// estado: hace polling de /sync/status) y el procesamiento continúa en
// background — el outbox termina en DONE o FAILED igual que antes.
const ORDER_SOFT_TIMEOUT_MS = 15000

async function runOrderWithSoftTimeout(clientUuid, task) {
  // El manejo de error queda adherido a la promesa ANTES del race: si el
  // timeout gana y processOrder falla después, la reserva se libera y el
  // outbox se marca FAILED igual — sin unhandled rejection.
  const guarded = task.then(
    (r) => ({
      status: r.status || 'DONE',
      odoo_order_id: r.odoo_order_id,
      odoo_order_name: r.odoo_order_name,
    }),
    async (err) => {
      try {
        await failReservations(clientUuid, err.message)
        await query(
          `UPDATE outbox
             SET estado = 'FAILED', retry_count = retry_count + 1,
                 error_msg = $1, updated_at = NOW()
           WHERE client_uuid = $2`,
          [err.message, clientUuid]
        )
      } catch (cleanupErr) {
        fastify.log.error(`[SYNC_PUSH] ORDER_CREATED ${clientUuid}: error en cleanup: ${cleanupErr.message}`)
      }
      fastify.log.error(`[SYNC_PUSH] ORDER_CREATED ${clientUuid}: ${err.stack || err.message}`)
      return { status: 'FAILED', error: err.message }
    }
  )
  return Promise.race([
    guarded,
    new Promise((resolve) => {
      const t = setTimeout(() => {
        fastify.log.warn(`[SYNC_PUSH] ORDER_CREATED ${clientUuid}: Odoo lento (>${ORDER_SOFT_TIMEOUT_MS}ms) — respondiendo PROCESSING, sigue en background`)
        resolve({ status: 'PROCESSING', soft_timeout: true })
      }, ORDER_SOFT_TIMEOUT_MS)
      if (t.unref) t.unref()
    }),
  ])
}

async function verifyToken(request, reply) {
  try {
    await request.jwtVerify()
  } catch (err) {
    reply.send(err)
  }
}

/**
 * Responde con ETag y honra If-None-Match: si el cliente ya tiene esta
 * versión exacta del payload, devuelve 304 sin cuerpo. En los refreshes
 * de la app donde nada cambió (catálogo, price book, clientes), la
 * respuesta pasa de cientos de KB a 0 bytes.
 */
function sendWithEtag(request, reply, payload) {
  const body = JSON.stringify(payload)
  const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`
  reply.header('ETag', etag)
  // nginx degrada el ETag a débil (W/"...") al aplicar gzip, y el cliente
  // devuelve lo que recibió — comparamos sin el prefijo W/.
  const clientTag = String(request.headers['if-none-match'] || '').replace(/^W\//, '')
  if (clientTag === etag) {
    return reply.code(304).send()
  }
  reply.type('application/json; charset=utf-8')
  return reply.send(body)
}

// ─────────────────────────────────────────
// Catalog cache (Redis-backed)
// ─────────────────────────────────────────
const CATALOG_TTL_SEC = 60 * 60 // 1 hora

async function fetchCatalogFromOdoo(productIds = null) {
  const params = productIds?.length ? { product_ids: productIds } : {}
  const result = await odooPost('/nexus/api/v1/catalog', params)
  return result.products
}

function catalogCacheKey(productIds = null) {
  if (!productIds?.length) return 'catalog:products:all'
  const sorted = [...new Set(productIds.map(Number))].sort((a, b) => a - b)
  const hash = crypto.createHash('sha1').update(sorted.join(',')).digest('hex')
  return `catalog:products:${hash}`
}

async function reconcileOrdersFromOdooOrders(orders) {
  if (!Array.isArray(orders) || !orders.length) return

  let stockChanged = false
  for (const order of orders) {
    const uuid = order?.client_order_ref
    try {
      const r = await applyOdooOrderStateToReservations(order, { logger: fastify.log })
      // Si liberamos o marcamos reservas (cancel/sale/done), el stock visible
      // del producto cambió. Marcamos para disparar un stock-delta abajo:
      // así la app NO tiene que esperar al próximo cron para ver el inventario
      // ajustado contra Odoo. (Para cancel, Odoo no movió on-hand pero igual
      // refrescamos por si venía de un sale revertido con pickings.)
      if (r.released > 0 || r.marked > 0) {
        stockChanged = true
      }
    } catch (err) {
      fastify.log.error(`[RESERVATIONS] ${uuid || '?'}: error reconciliando contra Odoo: ${err.message}`)
    }
  }

  // Fire-and-forget: NO await. La respuesta al cliente sale ya; el delta se
  // procesa en background y la siguiente request del cliente verá el stock
  // actualizado. El lock interno de runGatewaySync impide solapamientos.
  if (stockChanged) {
    runGatewaySync('stock-delta')
      .then((res) => fastify.log.info(`[RESERVATIONS] stock-delta auto-disparado tras reconcile: ${JSON.stringify(res)}`))
      .catch((err) => fastify.log.warn(`[RESERVATIONS] stock-delta auto-disparado falló: ${err.message}`))
  }
}

async function reconcileActiveReservationsForVendorWarehouse(vendorNexusUuid, vendorId, warehouseId) {
  const active = await query(
    `SELECT DISTINCT order_uuid
       FROM reservations
      WHERE vendor_id = $1
        AND warehouse_id = $2
        AND status IN ('confirmed', 'deducted_pending_sync')
      ORDER BY order_uuid
      LIMIT 50`,
    [vendorId, warehouseId]
  )

  if (!active.rows.length) return

  // Una sola llamada a Odoo con TODOS los UUIDs (vs N llamadas que era antes).
  // Reduce drásticamente la carga del worker HTTP de Odoo.
  const refs = active.rows.map((r) => String(r.order_uuid))
  try {
    const result = await odooPost('/nexus/api/v1/vendor_orders', {
      vendor_nexus_uuid: vendorNexusUuid,
      client_order_refs: refs,
    })
    await reconcileOrdersFromOdooOrders(result?.orders || [])
  } catch (err) {
    fastify.log.error(`[RESERVATIONS] vendor=${vendorNexusUuid} wh=${warehouseId}: batch reconcile falló (${refs.length} refs): ${err.message}`)
  }
}

async function getCatalog(productIds = null) {
  const key = catalogCacheKey(productIds)
  const cached = await redis.get(key)
  if (cached) return { products: JSON.parse(cached), cached: true }
  const products = await fetchCatalogFromOdoo(productIds)
  await redis.setex(key, CATALOG_TTL_SEC, JSON.stringify(products))
  return { products, cached: false }
}

async function getVendorCatalogProductIds(vendedorId) {
  const result = await query(
    `SELECT DISTINCT pp.product_id
       FROM pricelist_prices pp
       INNER JOIN (
         SELECT DISTINCT cep.company_id, cep.pricelist_id
           FROM cliente_empresa_pricelist cep
           INNER JOIN vendedor_cliente_rel vcr ON vcr.cliente_odoo_id = cep.cliente_odoo_id
          WHERE vcr.vendedor_id = $1
       ) used
         ON used.company_id = pp.company_id
        AND used.pricelist_id = pp.pricelist_id
      ORDER BY pp.product_id ASC`,
    [vendedorId]
  )
  return result.rows.map(row => row.product_id)
}

let priceBookSyncPromise = null

async function runPriceBookSyncCycle(options = {}) {
  if (priceBookSyncPromise) return priceBookSyncPromise

  priceBookSyncPromise = (async () => {
    const seeded = await seedPriceSyncQueueFromAssignments()
    const events = await syncPriceEvents(odooPost)
    const queue = await processPriceSyncQueue(odooPost, {
      limit: options.processAll ? 1000 : (options.limit || 25),
    })
    return {
      seeded,
      queued: events.queued || 0,
      acknowledged: events.acknowledged || 0,
      processed: queue.processed || 0,
      synced: queue.synced || 0,
      skipped: queue.skipped || 0,
      failed: queue.failed || 0,
    }
  })()

  try {
    return await priceBookSyncPromise
  } finally {
    priceBookSyncPromise = null
  }
}

async function requeueOutboxBacklog() {
  const result = await query(
    `SELECT client_uuid, tipo, payload, vendedor_id, estado
       FROM outbox
      WHERE estado = 'PENDING'
         OR (estado = 'SENDING' AND updated_at < NOW() - INTERVAL '5 minutes')
      ORDER BY created_at ASC
      LIMIT 100`
  )

  let queued = 0
  for (const row of result.rows) {
    try {
      await addToQueue(
        row.tipo,
        { ...row.payload, vendedor_id: row.vendedor_id },
        row.client_uuid
      )
      if (row.estado === 'SENDING') {
        await query(
          `UPDATE outbox SET estado = 'PENDING', updated_at = NOW()
            WHERE client_uuid = $1 AND estado = 'SENDING'`,
          [row.client_uuid]
        )
      }
      queued++
    } catch (err) {
      fastify.log.error(`[OUTBOX_REQUEUE] ${row.tipo} ${row.client_uuid}: ${err.message}`)
    }
  }

  return queued
}

let outboxDrainPromise = null

async function drainOutboxBacklog(limit = 20) {
  if (outboxDrainPromise) return outboxDrainPromise

  outboxDrainPromise = (async () => {
    const result = await query(
      `SELECT client_uuid, tipo, payload, vendedor_id
         FROM outbox
        WHERE estado = 'PENDING'
           OR (estado = 'SENDING' AND updated_at < NOW() - INTERVAL '5 minutes')
        ORDER BY
          CASE tipo
            WHEN 'ORDER_CREATED' THEN 0
            WHEN 'VISIT_CHECKIN' THEN 2
            WHEN 'VISIT_CLOSED' THEN 3
            ELSE 3
          END,
          created_at ASC
        LIMIT $1`,
      [limit]
    )

    let processed = 0
    for (const row of result.rows) {
      const claimed = await query(
        `UPDATE outbox
            SET estado = 'SENDING', updated_at = NOW()
          WHERE client_uuid = $1
            AND (estado = 'PENDING'
              OR (estado = 'SENDING' AND updated_at < NOW() - INTERVAL '5 minutes'))
          RETURNING client_uuid`,
        [row.client_uuid]
      )
      if (!claimed.rows.length) continue

      const payload = { ...(row.payload || {}), vendedor_id: row.vendedor_id }
      const job = { data: { tipo: row.tipo, payload, clientUuid: row.client_uuid, vendedor_id: row.vendedor_id } }

      try {
        fastify.log.info(`[OUTBOX_DRAIN] procesando ${row.tipo} ${row.client_uuid}`)

        let task
        if (row.tipo === 'ORDER_CREATED') {
          task = processOrder(job, odooPost)
        } else if (row.tipo === 'VISIT_COMPLETED' || row.tipo === 'VISIT_CHECKIN' || row.tipo === 'VISIT_CLOSED') {
          await query(
            `UPDATE outbox SET estado = 'DONE', odoo_ref = 'local', updated_at = NOW()
              WHERE client_uuid = $1`,
            [row.client_uuid]
          )
          processed++
          continue
        } else {
          await query(
            `UPDATE outbox SET estado = 'FAILED', error_msg = $1, updated_at = NOW()
              WHERE client_uuid = $2`,
            [`Tipo desconocido: ${row.tipo}`, row.client_uuid]
          )
          continue
        }

        await Promise.race([
          task,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout procesando evento de outbox')), 45000)
          }),
        ])
        processed++
      } catch (err) {
        await query(
          `UPDATE outbox
             SET estado = 'FAILED', retry_count = retry_count + 1,
                 error_msg = $1, updated_at = NOW()
           WHERE client_uuid = $2`,
          [err.message, row.client_uuid]
        )
        fastify.log.error(`[OUTBOX_DRAIN] ${row.tipo} ${row.client_uuid}: ${err.stack || err.message}`)
      }
    }
    return processed
  })()

  try {
    return await outboxDrainPromise
  } finally {
    outboxDrainPromise = null
  }
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

// Health
fastify.get('/api/v1/health', async () => {
  return { status: 'ok', message: 'NEXUS Gateway is running' }
})

// ── AUTH ──────────────────────────────────

// Helpers de refresh token
const REFRESH_TTL_DAYS = 30

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex') // 80 chars, URL-safe
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

async function issueTokenPair(fastify, vendedor, deviceId) {
  const accessToken = fastify.jwt.sign(
    { vendedor_id: vendedor.id, uuid: vendedor.uuid, nombre: vendedor.nombre, email: vendedor.email, role: vendedor.rol || 'vendedor' },
    { expiresIn: '24h' }
  )

  const rawRefresh = generateRefreshToken()
  const refreshHash = hashToken(rawRefresh)
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000)

  await query(
    `INSERT INTO refresh_tokens (vendedor_id, token_hash, device_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [vendedor.id, refreshHash, deviceId || 'unknown', expiresAt]
  )

  return { accessToken, refreshToken: rawRefresh }
}

// Login real — vendedores desde PostgreSQL
fastify.post('/api/v1/auth/login', async (request, reply) => {
  const { email, password, device_id } = request.body || {}
  if (!email || !password) return reply.code(400).send({ error: 'Email y password requeridos' })

  const result = await query(
    'SELECT id, uuid, nombre, email, password_hash, zona, activo, rol FROM vendedores WHERE email = $1',
    [email.toLowerCase()]
  )

  const vendedor = result.rows[0]
  if (!vendedor || !vendedor.activo) return reply.code(401).send({ error: 'Credenciales inválidas' })

  const valid = await bcrypt.compare(password, vendedor.password_hash)
  if (!valid) return reply.code(401).send({ error: 'Credenciales inválidas' })

  await query('UPDATE vendedores SET ultimo_login = NOW() WHERE id = $1', [vendedor.id])

  const { accessToken, refreshToken } = await issueTokenPair(fastify, vendedor, device_id)

  return {
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 86400,           // segundos — 24h
    vendedor: {
      uuid: vendedor.uuid,
      nombre: vendedor.nombre,
      email: vendedor.email,
      zona: vendedor.zona
    }
  }
})

// Renovar JWT con refresh token
fastify.post('/api/v1/auth/refresh', async (request, reply) => {
  const { refresh_token, device_id } = request.body || {}
  if (!refresh_token) return reply.code(400).send({ error: 'refresh_token requerido' })

  const tokenHash = hashToken(refresh_token)

  const tokenResult = await query(
    `SELECT rt.id, rt.vendedor_id, rt.expires_at, rt.revocado, rt.device_id,
            v.uuid, v.nombre, v.email, v.zona, v.activo, v.rol
     FROM refresh_tokens rt
     JOIN vendedores v ON v.id = rt.vendedor_id
     WHERE rt.token_hash = $1`,
    [tokenHash]
  )

  const row = tokenResult.rows[0]

  if (!row)             return reply.code(401).send({ error: 'Token inválido' })
  if (row.revocado)     return reply.code(401).send({ error: 'Token revocado' })
  if (!row.activo)      return reply.code(401).send({ error: 'Vendedor inactivo' })
  if (new Date(row.expires_at) < new Date()) {
    return reply.code(401).send({ error: 'Token expirado' })
  }

  // Revocar el token actual (rotación — cada refresh invalida el anterior)
  await query('UPDATE refresh_tokens SET revocado = true WHERE id = $1', [row.id])

  const vendedor = { id: row.vendedor_id, uuid: row.uuid, nombre: row.nombre, email: row.email, zona: row.zona, rol: row.rol }
  const { accessToken, refreshToken } = await issueTokenPair(fastify, vendedor, device_id || row.device_id)

  return {
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 86400
  }
})

function isAdminTokenValid(request) {
  const expected = String(process.env.NEXUS_ADMIN_TOKEN || '').trim()
  const provided = String(request.headers['x-nexus-admin-token'] || '').trim()
  if (!expected || !provided || Buffer.byteLength(expected) !== Buffer.byteLength(provided)) {
    return false
  }
  return Boolean(expected && provided && crypto.timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(expected)
  ))
}

async function verifyAdminToken(request, reply) {
  try {
    if (!isAdminTokenValid(request)) {
      return reply.code(401).send({ error: 'Token admin inválido' })
    }
  } catch {
    return reply.code(401).send({ error: 'Token admin inválido' })
  }
}

const syncLocks = new Map()

async function runGatewaySync(name, options = {}) {
  if (syncLocks.has(name)) return syncLocks.get(name)

  const promise = (async () => {
    switch (name) {
      case 'vendors':
        return syncVendors(odooPost)
      case 'clients':
        return syncClients(odooPost)
      case 'companies':
        return syncVendorCompanies(odooPost)
      case 'orders':
        return syncVendorOrders(odooPost, options)
      case 'stock-delta':
        return syncStock(odooPost, { mode: 'delta' })
      case 'stock-full':
        return syncStock(odooPost, { mode: 'full' })
      case 'journals':
        return syncPaymentJournals(odooPost)
      case 'prices':
        return runPriceBookSyncCycle({ processAll: true })
      case 'product-images':
        return syncProductImages(odooPost, options)
      case 'catalog': {
        // Invalida el cache Redis del catálogo. La próxima request al gateway
        // re-fetcha desde Odoo (trayendo cualquier campo nuevo agregado al
        // endpoint, ej. barcode). No bloquea — solo borra claves.
        const keys = await redis.keys('catalog:products:*')
        if (keys.length) await redis.del(...keys)
        return { invalidated_keys: keys.length, keys }
      }
      case 'outbox':
        return {
          requeued: await requeueOutboxBacklog(),
          processed: await drainOutboxBacklog(20),
        }
      case 'all': {
        const results = {}
        for (const item of ['catalog', 'vendors', 'clients', 'companies', 'orders', 'journals', 'prices', 'product-images', 'stock-delta', 'outbox']) {
          results[item] = await runGatewaySync(item, options)
        }
        return results
      }
      default:
        throw new Error(`Sync desconocido: ${name}`)
    }
  })()

  syncLocks.set(name, promise)
  try {
    return await promise
  } finally {
    syncLocks.delete(name)
  }
}

fastify.get('/admin/sync', async (_, reply) => {
  reply.type('text/html')
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NEXUS Gateway Sync</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #172033; background: #f7f8fb; }
    main { max-width: 840px; margin: auto; background: white; border-radius: 16px; padding: 24px; box-shadow: 0 12px 40px #1b25401a; }
    h1 { margin-top: 0; }
    label { display: block; margin-bottom: 12px; font-weight: 700; }
    input { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid #c8cfda; border-radius: 10px; }
    .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0; }
    button { padding: 12px 14px; border: 0; border-radius: 10px; background: #1646d8; color: white; font-weight: 700; cursor: pointer; }
    button.secondary { background: #2f3b52; }
    button.danger { background: #9b2c2c; }
    pre { min-height: 180px; overflow: auto; padding: 16px; border-radius: 10px; background: #101828; color: #d1e7ff; }
  </style>
</head>
<body>
  <main>
    <h1>NEXUS Gateway Sync</h1>
    <p>Ejecuta sincronizadores manuales sin reiniciar el gateway ni golpear Odoo durante deploy.</p>
    <div class="fields">
      <div>
        <label>Admin token</label>
        <input id="token" type="password" autocomplete="off" placeholder="NEXUS_ADMIN_TOKEN">
      </div>
      <div>
        <label>Default code opcional</label>
        <input id="defaultCode" type="text" autocomplete="off" placeholder="SKU específico para imágenes">
      </div>
    </div>
    <div class="grid">
      <button data-sync="vendors">Vendedores</button>
      <button data-sync="clients">Clientes</button>
      <button data-sync="companies">Empresas</button>
      <button data-sync="orders">Pedidos</button>
      <button data-sync="journals">Diarios</button>
      <button data-sync="prices">Precios</button>
      <button data-sync="product-images">Imágenes faltantes</button>
      <button data-sync="stock-delta">Stock delta</button>
      <button class="secondary" data-sync="stock-full">Stock full</button>
      <button data-sync="outbox">Outbox</button>
      <button class="danger" data-sync="all">Todo</button>
    </div>
    <pre id="output">Listo.</pre>
  </main>
  <script>
    const output = document.getElementById('output')
    document.querySelectorAll('button[data-sync]').forEach((button) => {
      button.addEventListener('click', async () => {
        const sync = button.dataset.sync
        const token = document.getElementById('token').value
        const defaultCode = document.getElementById('defaultCode').value.trim()
        output.textContent = 'Ejecutando ' + sync + '...'
        try {
          const res = await fetch('/api/v1/admin/sync/' + sync, {
            method: 'POST',
            headers: { 'X-Nexus-Admin-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_code: defaultCode || undefined }),
          })
          const data = await res.json()
          output.textContent = JSON.stringify(data, null, 2)
        } catch (err) {
          output.textContent = err.stack || err.message
        }
      })
    })
  </script>
</body>
</html>`
})

fastify.post('/api/v1/admin/sync/:name', { preHandler: [verifyAdminToken] }, async (request, reply) => {
  const name = String(request.params.name || '')
  const options = request.body || {}
  const startedAt = Date.now()
  try {
    const result = await runGatewaySync(name, options)
    return { status: 'ok', sync: name, duration_ms: Date.now() - startedAt, result }
  } catch (err) {
    fastify.log.error(`[ADMIN_SYNC] ${name}: ${err.stack || err.message}`)
    return reply.code(500).send({ status: 'error', sync: name, error: err.message })
  }
})

// ── CATALOG ───────────────────────────────

fastify.get('/api/v1/catalog', async (request, reply) => {
  const { products, cached } = await getCatalog()
  return sendWithEtag(request, reply, { status: 'ok', count: products.length, products, cached })
})

// ── PRODUCT IMAGE ─────────────────────────

fastify.get('/api/v1/product/:id/image', async (request, reply) => {
  try {
    const result = await query(
      `SELECT mimetype, image_data, write_date
         FROM product_images
        WHERE product_id = $1`,
      [parseInt(request.params.id, 10)]
    )
    const image = result.rows[0]
    if (!image) return reply.code(404).send()

    // 7 días de cache en el dispositivo + nginx (immutable hasta que el
    // write_date cambie, que rota el ETag).
    reply.header('Cache-Control', 'public, max-age=604800')
    if (image.write_date) {
      const etag = `"product-${request.params.id}-${new Date(image.write_date).getTime()}"`
      reply.header('ETag', etag)
      const clientTag = String(request.headers['if-none-match'] || '').replace(/^W\//, '')
      if (clientTag === etag) {
        return reply.code(304).send()
      }
    }
    reply.header('Content-Type', image.mimetype || 'image/png')
    return reply.send(Buffer.from(image.image_data))
  } catch {
    reply.code(404).send()
  }
})

// ── SYNC ──────────────────────────────────

fastify.get('/api/v1/sync/initial', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user
  const productIds = await getVendorCatalogProductIds(vendedor_id)
  if (!productIds.length) {
    return { status: 'ok', count: 0, products: [], cached: false }
  }
  const { products, cached } = await getCatalog(productIds)
  // `cached` fuera del cuerpo hasheado cambiaría el ETag sin cambiar los
  // datos — pero su valor depende del Redis TTL, no de los productos.
  // Lo dejamos: el costo es un ETag distinto 1 vez por hora como máximo.
  return sendWithEtag(request, reply, { status: 'ok', count: products.length, products, cached })
})

// ── CLIENTES DEL VENDEDOR ─────────────────

fastify.get('/api/v1/clients', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user

  const result = await query(
    `SELECT c.odoo_id, c.nombre, c.rif, c.telefono, c.direccion,
            c.lat, c.lng, c.bloqueado, c.credito_restringido,
            c.motivo_bloqueo, c.canal, c.credito_limite, c.credito_usado,
            c.delivery_addresses, c.default_delivery_id
     FROM clientes c
     INNER JOIN vendedor_cliente_rel vcr ON vcr.cliente_odoo_id = c.odoo_id
     WHERE vcr.vendedor_id = $1
     ORDER BY c.nombre ASC`,
    [vendedor_id]
  )

  const clientes = result.rows.map(c => ({
    odoo_id:             c.odoo_id,
    nombre:              c.nombre,
    rif:                 c.rif,
    telefono:            c.telefono,
    direccion:           c.direccion,
    lat:                 c.lat ? parseFloat(c.lat) : null,
    lng:                 c.lng ? parseFloat(c.lng) : null,
    bloqueado:           c.bloqueado,
    credito_restringido: c.credito_restringido,
    motivo_bloqueo:      c.motivo_bloqueo,
    canal:               c.canal,
    credito_limite:      parseFloat(c.credito_limite  || 0),
    credito_usado:       parseFloat(c.credito_usado   || 0),
    credito_disponible:  parseFloat((c.credito_limite || 0) - (c.credito_usado || 0)),
    delivery_addresses:  Array.isArray(c.delivery_addresses) ? c.delivery_addresses : [],
    default_delivery_id: c.default_delivery_id || c.odoo_id,
  }))

  return sendWithEtag(request, reply, { status: 'ok', count: clientes.length, clientes })
})

// ── PRICE BOOK DEL VENDEDOR ──────────────────────────────────────────────────

fastify.get('/api/v1/prices/book', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user
  const book = await getVendorPriceBook(vendedor_id)
  // synced_at del book deriva del max(updated_at) de los datos (no del
  // reloj), así que el ETag es estable mientras los precios no cambien.
  return sendWithEtag(request, reply, {
    status: 'ok',
    ...book,
  })
})

fastify.post('/api/v1/prices/sync', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id, uuid } = request.user
  const book = await getVendorPriceBook(vendedor_id)

  return {
    status: 'ok',
    source: 'gateway_cache',
    vendor_uuid: uuid,
    ...book,
  }
})

// ── PEDIDOS DEL VENDEDOR ──────────────────────────────────────────────────────

async function upsertVendorOrderCache(vendorUuid, order) {
  await query(
    `INSERT INTO vendor_orders_cache (
       vendor_uuid, order_id, order_name, state, partner_id, partner_name,
       partner_vat, date_order, write_date, amount_total, currency_code,
       client_order_ref, payload, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (vendor_uuid, order_id) DO UPDATE SET
       order_name       = EXCLUDED.order_name,
       state            = EXCLUDED.state,
       partner_id       = EXCLUDED.partner_id,
       partner_name     = EXCLUDED.partner_name,
       partner_vat      = EXCLUDED.partner_vat,
       date_order       = EXCLUDED.date_order,
       write_date       = EXCLUDED.write_date,
       amount_total     = EXCLUDED.amount_total,
       currency_code    = EXCLUDED.currency_code,
       client_order_ref = EXCLUDED.client_order_ref,
       payload          = EXCLUDED.payload,
       updated_at       = NOW()`,
    [
      vendorUuid,
      order.id,
      order.name || null,
      order.state || null,
      order.partner_id || null,
      order.partner_name || null,
      order.partner_vat || null,
      order.date_order || null,
      order.write_date || null,
      order.amount_total || 0,
      order.currency || null,
      order.client_order_ref || null,
      JSON.stringify(order),
    ]
  )
}

// Trae órdenes frescas de Odoo y actualiza el cache local. Usado como
// refresh en background por GET /orders — los errores solo se loguean.
const _ordersRefreshInFlight = new Map() // vendor_uuid → timestamp del último refresh

async function refreshVendorOrdersFromOdoo(uuid, { limit, offset, state, search }) {
  const last = _ordersRefreshInFlight.get(uuid)
  if (last && Date.now() - last < 30 * 1000) return // throttle: 1 refresh / 30s / vendedor
  _ordersRefreshInFlight.set(uuid, Date.now())

  const result = await odooPost('/nexus/api/v1/vendor_orders', {
    vendor_nexus_uuid: uuid,
    limit,
    offset,
    state,
    search,
  })
  const liveOrders = result?.orders || []
  for (const order of liveOrders) {
    await upsertVendorOrderCache(uuid, order)
  }
  await reconcileOrdersFromOdooOrders(liveOrders)
  return liveOrders
}

fastify.get('/api/v1/orders', { preHandler: [verifyToken] }, async (request, reply) => {
  const { uuid } = request.user
  const limit = Math.min(Math.max(Number(request.query.limit || 30), 1), 100)
  const offset = Math.max(Number(request.query.offset || 0), 0)
  const state = request.query.state || null
  const search = request.query.search || null

  // Cache-first: si hay cache local, responder de inmediato (sin esperar a
  // Odoo, que puede tardar hasta 30s) y refrescar en background — la
  // siguiente consulta de la app ya verá lo nuevo. Solo si el cache está
  // vacío (vendedor nuevo / primer uso) se consulta Odoo en línea.
  const hasCache = await query(
    'SELECT 1 FROM vendor_orders_cache WHERE vendor_uuid = $1 LIMIT 1',
    [uuid]
  )

  if (!hasCache.rows.length) {
    try {
      const liveOrders = await refreshVendorOrdersFromOdoo(uuid, { limit, offset, state, search })
      return {
        status: 'ok',
        source: 'odoo_live',
        orders: liveOrders || [],
        count: liveOrders?.length || 0,
        total: liveOrders?.length || 0,
        limit,
        offset,
      }
    } catch (err) {
      fastify.log.warn(`[GET /orders] Odoo no disponible, usando cache local: ${err.message}`)
    }
  } else {
    refreshVendorOrdersFromOdoo(uuid, { limit, offset, state, search })
      .catch((err) => fastify.log.warn(`[GET /orders] refresh background falló: ${err.message}`))
  }

  const conditions = ['vendor_uuid = $1']
  const params = [uuid]
  if (state) {
    params.push(state)
    conditions.push(`state = $${params.length}`)
  }
  if (search) {
    params.push(`%${search}%`)
    conditions.push(`(
      order_name ILIKE $${params.length}
      OR partner_name ILIKE $${params.length}
      OR partner_vat ILIKE $${params.length}
      OR client_order_ref ILIKE $${params.length}
    )`)
  }

  const where = conditions.join(' AND ')
  const totalResult = await query(
    `SELECT COUNT(*)::int AS total FROM vendor_orders_cache WHERE ${where}`,
    params
  )
  const rowsResult = await query(
    `SELECT payload
       FROM vendor_orders_cache
      WHERE ${where}
      ORDER BY date_order DESC NULLS LAST, order_id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  )
  const orders = rowsResult.rows.map((row) => row.payload)

  return {
    status: 'ok',
    source: 'gateway_cache',
    orders,
    count: orders.length,
    total: totalResult.rows[0]?.total || 0,
    limit,
    offset,
  }
})

// ── EMPRESAS DEL VENDEDOR ─────────────────────────────────────────────────────

fastify.get('/api/v1/vendor/companies', { preHandler: [verifyToken] }, async (request, reply) => {
  const { uuid } = request.user  // nexus_uuid del vendedor

  const result = await query(
    `SELECT company_id, company_name, currency_code, warehouse_id, warehouse_name, is_default
       FROM vendor_companies
      WHERE vendor_uuid = $1
      ORDER BY company_name`,
    [uuid]
  )
  const companies = result.rows.map((row) => ({
    id: row.company_id,
    name: row.company_name,
    currency: row.currency_code,
    warehouse_id: row.warehouse_id,
    warehouse_name: row.warehouse_name,
  }))
  const defaultCompany = result.rows.find((row) => row.is_default) || result.rows[0]

  return {
    status:             'ok',
    count:              companies.length,
    default_company_id: defaultCompany?.company_id ?? null,
    companies,
  }
})

// ── STOCK POR ALMACÉN (consumido por la app) ────────────────────────────────
//
// La app llama este endpoint en tres momentos:
//   1. Al login (sin since)             → snapshot completo del almacén
//   2. WorkManager cada 5-6h (con since) → solo cambios desde el último sync
//   3. Pull-to-refresh (con since)       → idem
//
// El stock viene del cache local del gateway (tabla stock_levels), que se
// mantiene fresco con los crons sync_stock (delta cada 20min, full cada 6h).
// Las reservas pending NO se descuentan aquí — la validación final ocurre
// en POST /api/v1/orders al confirmar el pedido.

fastify.get('/api/v1/vendor/stock', { preHandler: [verifyToken] }, async (request, reply) => {
  const { uuid: vendorNexusUuid, vendedor_id: vendorId } = request.user
  const warehouseIdRaw = request.query.warehouse_id
  const since          = request.query.since  // ISO 8601 opcional

  const warehouseId = parseInt(warehouseIdRaw, 10)
  if (!warehouseId || Number.isNaN(warehouseId)) {
    return reply.code(400).send({
      error: 'warehouse_id requerido y debe ser un entero positivo'
    })
  }

  // No consultar Odoo durante refresh de app; la reconciliación ocurre en cron/manual sync_stock.

  let sql = `
    SELECT
      sl.product_id,
      GREATEST(sl.quantity - COALESCE(r.reserved, 0), 0) AS quantity,
      sl.updated_at
    FROM stock_levels sl
    LEFT JOIN (
      SELECT product_id, warehouse_id, SUM(quantity) AS reserved
        FROM reservations
       WHERE warehouse_id = $1 AND status IN ('pending', 'confirmed', 'deducted_pending_sync')
       GROUP BY product_id, warehouse_id
    ) r ON r.product_id = sl.product_id AND r.warehouse_id = sl.warehouse_id
    WHERE sl.warehouse_id = $1
  `
  const params = [warehouseId]

  if (since) {
    sql += ' AND sl.updated_at > $2'
    params.push(since)
  }

  sql += ' ORDER BY sl.product_id'

  let rows
  try {
    const result = await query(sql, params)
    rows = result.rows
  } catch (err) {
    fastify.log.error(`[GET /vendor/stock] Error: ${err.message}`)
    return reply.code(500).send({ error: 'Error al consultar stock' })
  }

  const items = rows.map((r) => ({
    product_id: r.product_id,
    quantity:   parseFloat(r.quantity),
    updated_at: r.updated_at,
  }))

  return {
    status:       'ok',
    warehouse_id: warehouseId,
    count:        items.length,
    synced_at:    new Date().toISOString(),
    items,
  }
})

// ── DIARIOS DE PAGO (lista en cache, alimentada por sync_payment_journals) ──

fastify.get('/api/v1/vendor/journals', { preHandler: [verifyToken] }, async (request, reply) => {
  const companyIdRaw = request.query.company_id
  const companyId = parseInt(companyIdRaw, 10)

  let sql = `
    SELECT id, company_id, company_name, name, code, type, currency_code
      FROM payment_journals
  `
  const params = []
  if (companyId && !Number.isNaN(companyId)) {
    sql += ' WHERE company_id = $1'
    params.push(companyId)
  }
  sql += ' ORDER BY company_name, name'

  let rows
  try {
    const result = await query(sql, params)
    rows = result.rows
  } catch (err) {
    fastify.log.error(`[GET /vendor/journals] Error: ${err.message}`)
    return reply.code(500).send({ error: 'Error al consultar diarios' })
  }

  return {
    status:   'ok',
    count:    rows.length,
    journals: rows,
  }
})

// ── SUGERENCIAS DE PEDIDO (offline-first, lee del cache local) ──────────────
//
// La app consulta este endpoint en sus triggers de sync (login, pull-to-
// refresh, WorkManager) y guarda el resultado en su SQLite. Al entrar al
// paso "Pedido" del wizard, lee de su cache local sin red.
//
// El cache del gateway se mantiene fresco por el worker tras cada
// VISIT_COMPLETED (event-driven). Si un vendedor consulta y no tiene cache
// (vendedor nuevo, restore de DB, etc.), disparamos backfill async.

fastify.get('/api/v1/vendor/order_suggestions', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id: vendorId, uuid: vendorUuid } = request.user

  let rows
  try {
    const result = await query(
      `SELECT client_id, product_id, target, last_post, updated_at
         FROM order_suggestions_cache
        WHERE vendor_id = $1
        ORDER BY client_id, product_id`,
      [vendorId]
    )
    rows = result.rows
  } catch (err) {
    fastify.log.error(`[GET /vendor/order_suggestions] Error: ${err.message}`)
    return reply.code(500).send({ error: 'Error al consultar sugerencias' })
  }

  // Si está vacío, disparar backfill async (no bloquea esta respuesta).
  // La app recibirá lista vacía esta vez, en la próxima sync ya tendrá data.
  if (rows.length === 0) {
    backfillVendorSuggestions(odooPost, vendorUuid, vendorId)
      .catch((err) => fastify.log.warn(
        `[SUGGESTIONS] backfill async falló: ${err.message}`
      ))
  }

  return {
    status:      'ok',
    count:       rows.length,
    synced_at:   new Date().toISOString(),
    suggestions: rows.map((r) => ({
      client_id:  r.client_id,
      product_id: r.product_id,
      target:     parseFloat(r.target),
      last_post:  parseFloat(r.last_post),
      updated_at: r.updated_at,
    })),
  }
})

// ── TASA DE CAMBIO POR FECHA (proxy a Odoo, sin cache) ──────────────────────

fastify.get('/api/v1/exchange_rate', { preHandler: [verifyToken] }, async (request, reply) => {
  const date = request.query.date  // ISO 8601 opcional
  const companyId = parseInt(request.query.company_id, 10)

  if (!companyId || Number.isNaN(companyId)) {
    return reply.code(400).send({ error: 'company_id es requerido' })
  }

  try {
    const result = await odooPost('/nexus/api/v1/exchange_rate', {
      date: date || null,
      company_id: companyId,
    })
    if (result?.error) {
      return reply.code(400).send(result)
    }
    return {
      status:        'ok',
      date:          result.date,
      rate:          result.rate,
      currency_code: result.currency_code,
    }
  } catch (err) {
    fastify.log.error(`[GET /exchange_rate] Error: ${err.message}`)
    return reply.code(502).send({ error: 'No se pudo consultar tasa en Odoo' })
  }
})

// ── FACTURAS PENDIENTES DE UN CLIENTE (proxy a Odoo, sin cache) ─────────────

fastify.get('/api/v1/clients/:id/invoices', { preHandler: [verifyToken] }, async (request, reply) => {
  const partnerId = parseInt(request.params.id, 10)
  const companyId = parseInt(request.query.company_id, 10)

  if (!partnerId || Number.isNaN(partnerId)) {
    return reply.code(400).send({ error: 'partner_id (en la URL) inválido' })
  }
  if (!companyId || Number.isNaN(companyId)) {
    return reply.code(400).send({ error: 'company_id es requerido' })
  }

  try {
    const result = await odooPost('/nexus/api/v1/partner_invoices', {
      partner_id: partnerId,
      company_id: companyId,
    })
    if (result?.error) {
      return reply.code(400).send(result)
    }
    return {
      status:   'ok',
      count:    result?.count || 0,
      invoices: result?.invoices || [],
    }
  } catch (err) {
    fastify.log.error(`[GET /clients/${partnerId}/invoices] Error: ${err.message}`)
    return reply.code(502).send({ error: 'No se pudo consultar facturas en Odoo' })
  }
})

// ── SOLICITUDES DE PAGO (online, sin outbox por ahora) ──────────────────────

fastify.post('/api/v1/payment_requests', { preHandler: [verifyToken] }, async (request, reply) => {
  const { uuid: vendorNexusUuid, vendedor_id: vendorId } = request.user
  const body = request.body || {}

  const required = ['client_uuid', 'cliente_odoo_id', 'company_id',
                    'journal_id', 'amount', 'lines']
  const missing = required.filter((k) =>
    body[k] === undefined || body[k] === null || body[k] === ''
  )
  if (missing.length) {
    return reply.code(400).send({
      error: `Faltan campos requeridos: ${missing.join(', ')}`,
    })
  }
  if (!Array.isArray(body.lines) || !body.lines.length) {
    return reply.code(400).send({ error: 'lines debe ser un array no vacío' })
  }

  try {
    const result = await odooPost('/nexus/api/v1/create_payment_request', {
      client_uuid:       body.client_uuid,
      vendor_nexus_uuid: vendorNexusUuid,
      cliente_odoo_id:   body.cliente_odoo_id,
      company_id:        body.company_id,
      journal_id:        body.journal_id,
      amount:            body.amount,
      date:              body.date || null,
      payment_reference: body.payment_reference || null,
      attachment_b64:    body.attachment_b64 || null,
      attachment_name:   body.attachment_name || null,
      device_id:         body.device_id || null,
      lines:             body.lines,
    })

    if (result?.error) {
      return reply.code(400).send(result)
    }

    fastify.log.info(
      `[PAYMENT_REQUEST] ${result.created ? 'created' : 'idempotent'} ` +
      `${result.name} vendor=${vendorNexusUuid?.slice(0, 8)} ` +
      `partner=${body.cliente_odoo_id}`
    )
    return {
      status:               'ok',
      created:              result.created || false,
      payment_request_id:   result.payment_request_id,
      nexus_id:             result.nexus_id,
      name:                 result.name,
    }
  } catch (err) {
    // Propagar el detalle real al cliente — antes se tragaba con un genérico
    // "No se pudo crear la solicitud en Odoo" (HTTP 502) que ocultaba causas
    // típicas (factura inexistente, monto excedido, journal inválido, etc.).
    // err.message viene de odooPost() que ya extrae el message del JSON-RPC.
    const detail = (err && err.message) ? String(err.message) : 'Error desconocido'
    fastify.log.error(`[POST /payment_requests] Odoo error: ${detail}`)
    return reply.code(502).send({
      error: `Odoo rechazó la solicitud: ${detail}`,
    })
  }
})

fastify.get('/api/v1/payment_requests', { preHandler: [verifyToken] }, async (request, reply) => {
  const { uuid: vendorNexusUuid } = request.user
  const limit = Math.min(parseInt(request.query.limit, 10) || 30, 100)
  const offset = Math.max(parseInt(request.query.offset, 10) || 0, 0)
  const state = request.query.state || null

  try {
    const result = await odooPost('/nexus/api/v1/vendor_payment_requests', {
      vendor_nexus_uuid: vendorNexusUuid,
      limit,
      offset,
      state,
    })
    return {
      status:   'ok',
      count:    result?.count || 0,
      total:    result?.total || 0,
      limit,
      offset,
      requests: result?.requests || [],
    }
  } catch (err) {
    fastify.log.error(`[GET /payment_requests] Error: ${err.message}`)
    return reply.code(502).send({ error: 'No se pudo consultar solicitudes en Odoo' })
  }
})

// ── SYNC MANUAL DE CLIENTES (trigger desde la app) ───────────────────────────

fastify.post('/api/v1/clients/sync', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id, uuid } = request.user

  // Devolver la lista actualizada desde PostgreSQL
  const updated = await query(
    `SELECT c.odoo_id, c.nombre, c.rif, c.telefono, c.direccion,
            c.lat, c.lng, c.bloqueado, c.credito_restringido,
            c.motivo_bloqueo, c.canal, c.credito_limite, c.credito_usado,
            c.delivery_addresses, c.default_delivery_id
     FROM clientes c
     INNER JOIN vendedor_cliente_rel vcr ON vcr.cliente_odoo_id = c.odoo_id
     WHERE vcr.vendedor_id = $1
     ORDER BY c.nombre ASC`,
    [vendedor_id]
  )

  const clientes = updated.rows.map(c => ({
    odoo_id:             c.odoo_id,
    nombre:              c.nombre,
    rif:                 c.rif,
    telefono:            c.telefono,
    direccion:           c.direccion,
    lat:                 c.lat ? parseFloat(c.lat) : null,
    lng:                 c.lng ? parseFloat(c.lng) : null,
    bloqueado:           c.bloqueado,
    credito_restringido: c.credito_restringido,
    motivo_bloqueo:      c.motivo_bloqueo,
    canal:               c.canal,
    credito_limite:      parseFloat(c.credito_limite  || 0),
    credito_usado:       parseFloat(c.credito_usado   || 0),
    credito_disponible:  parseFloat((c.credito_limite || 0) - (c.credito_usado || 0)),
    delivery_addresses:  Array.isArray(c.delivery_addresses) ? c.delivery_addresses : [],
    default_delivery_id: c.default_delivery_id || c.odoo_id,
  }))

  fastify.log.info(`[SYNC_CLIENTS_MANUAL] vendedor_id=${vendedor_id} clientes=${clientes.length}`)
  return {
    status: 'ok',
    source: 'gateway_cache',
    count: clientes.length,
    clientes,
    vendor_uuid: uuid,
  }
})

// ── ROUTES / RUTAS ────────────────────────

fastify.get('/api/v1/routes/today', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user
  const fecha = new Date().toISOString().split('T')[0]
  return getRuta(vendedor_id, fecha, reply)
})

fastify.get('/api/v1/routes/:fecha', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user
  const { fecha } = request.params
  return getRuta(vendedor_id, fecha, reply)
})

async function getRuta(vendedor_id, fecha, reply) {
  const rutaResult = await query(
    `SELECT r.id, r.uuid, r.fecha, r.estado,
            r.algoritmo, r.distancia_estimada_km, r.origen_lat, r.origen_lng
     FROM rutas r
     WHERE r.vendedor_id = $1 AND r.fecha = $2`,
    [vendedor_id, fecha]
  )

  if (!rutaResult.rows.length) {
    return reply.code(404).send({ error: 'No hay ruta para esta fecha' })
  }

  const ruta = rutaResult.rows[0]

  const paradasResult = await query(
    `SELECT p.id, p.orden, p.orden_actual, p.estado, p.lat, p.lng, p.notas, p.saltada_at,
            c.odoo_id, c.nombre, c.rif, c.telefono, c.direccion, c.bloqueado,
            (c.credito_limite - c.credito_usado) AS credito_disponible,
            v.uuid AS visita_uuid
     FROM paradas p
     JOIN clientes c ON c.odoo_id = p.cliente_id
     LEFT JOIN visitas v ON v.parada_id = p.id
     WHERE p.ruta_id = $1
     ORDER BY COALESCE(p.orden_actual, p.orden) ASC`,
    [ruta.id]
  )

  const paradas = paradasResult.rows.map(p => ({
    id: p.id,
    orden: p.orden,
    orden_actual: p.orden_actual ?? p.orden,
    estado: p.estado,
    lat: p.lat,
    lng: p.lng,
    notas: p.notas,
    saltada_at: p.saltada_at,
    visita_uuid: p.visita_uuid ?? null,
    cliente: {
      odoo_id: p.odoo_id,
      nombre: p.nombre,
      rif: p.rif,
      telefono: p.telefono,
      direccion: p.direccion,
      bloqueado: p.bloqueado,
      credito_disponible: parseFloat(p.credito_disponible ?? 0)
    }
  }))

  const kpis = {
    total_paradas: paradas.length,
    completadas: paradas.filter(p => p.estado === 'completed').length,
    pendientes: paradas.filter(p => p.estado === 'pending').length,
    saltadas: paradas.filter(p => p.estado === 'skipped').length
  }

  return {
    status: 'ok',
    ruta: {
      uuid:                  ruta.uuid,
      fecha:                 ruta.fecha,
      estado:                ruta.estado,
      algoritmo:             ruta.algoritmo ?? 'nombre',
      distancia_estimada_km: ruta.distancia_estimada_km ? parseFloat(ruta.distancia_estimada_km) : null,
      origen_lat:            ruta.origen_lat ? parseFloat(ruta.origen_lat) : null,
      origen_lng:            ruta.origen_lng ? parseFloat(ruta.origen_lng) : null,
      paradas,
      kpis,
    },
  }
}

// ── ADMIN: triggerear generación de rutas manualmente ─────────────────────────
// Útil para pruebas, re-generar rutas tras sync de clientes, o forzar optimización OSRM.
// Solo supervisores y admins.

fastify.post('/api/v1/admin/routes/generate', { preHandler: [verifyToken] }, async (request, reply) => {
  if (request.user.role !== 'supervisor' && request.user.role !== 'admin') {
    return reply.code(403).send({ error: 'Solo supervisores pueden triggerear la generación de rutas' })
  }
  try {
    const result = await generateRoutes()
    return { status: 'ok', ...result }
  } catch (err) {
    fastify.log.error(`[ADMIN_ROUTES] Error generando rutas: ${err.stack || err.message}`)
    return reply.code(500).send({ error: err.message })
  }
})

// PATCH parada — cambiar estado o reordenar
fastify.patch('/api/v1/routes/:ruta_uuid/stops/:parada_id', { preHandler: [verifyToken] }, async (request, reply) => {
  const { estado, orden_actual } = request.body || {}
  const { parada_id } = request.params

  const updates = []
  const values = []
  let i = 1

  if (estado) {
    updates.push(`estado = $${i++}`)
    values.push(estado)
    if (estado === 'skipped') {
      updates.push(`saltada_at = NOW()`)
    }
  }
  if (orden_actual !== undefined) {
    updates.push(`orden_actual = $${i++}`)
    values.push(orden_actual)
  }

  if (!updates.length) return reply.code(400).send({ error: 'Nada que actualizar' })

  values.push(parada_id)
  await query(`UPDATE paradas SET ${updates.join(', ')} WHERE id = $${i}`, values)

  return { status: 'ok' }
})

// ── VISITAS ───────────────────────────────

fastify.post('/api/v1/visits', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user
  const {
    tipo, client_uuid, visita_uuid,
    cliente_odoo_id, parada_id,
    checkin_lat, checkin_lng, checkin_at,
    checkout_at, notas
  } = request.body || {}

  if (!tipo || !client_uuid) {
    return reply.code(400).send({ error: 'tipo y client_uuid son requeridos' })
  }

  // ── CHECKIN ───────────────────────────────────────────
  if (tipo === 'checkin') {
    if (!cliente_odoo_id) {
      return reply.code(400).send({ error: 'cliente_odoo_id requerido para checkin' })
    }

    // Idempotencia — si la visita ya existe, devolver sin error
    const existing = await query('SELECT uuid FROM visitas WHERE uuid = $1', [client_uuid])
    if (existing.rows.length) {
      return { status: 'ok', visita_uuid: client_uuid, skipped: true }
    }

    const ts = checkin_at || new Date().toISOString()

    await query(
      `INSERT INTO visitas (uuid, vendedor_id, cliente_odoo_id, parada_id, checkin_lat, checkin_lng, checkin_at, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'abierta')`,
      [client_uuid, vendedor_id, cliente_odoo_id, parada_id || null,
       checkin_lat || null, checkin_lng || null, ts]
    )

    if (parada_id) {
      await query(`UPDATE paradas SET estado = 'on_site' WHERE id = $1`, [parada_id])
    }

    await query(
      `INSERT INTO outbox (client_uuid, vendedor_id, tipo, estado, payload)
       VALUES ($1, $2, 'VISIT_CHECKIN', 'DONE', $3)
       ON CONFLICT (client_uuid) DO NOTHING`,
      [client_uuid, vendedor_id, JSON.stringify({ cliente_odoo_id, parada_id, checkin_lat, checkin_lng, checkin_at: ts })]
    )

    console.log(`[VISITS] ✅ CHECKIN ${client_uuid} — vendedor ${vendedor_id}, cliente ${cliente_odoo_id}`)
    return { status: 'ok', visita_uuid: client_uuid }
  }

  // ── CHECKOUT ──────────────────────────────────────────
  if (tipo === 'checkout') {
    if (!visita_uuid) {
      return reply.code(400).send({ error: 'visita_uuid requerido para checkout (UUID del checkin original)' })
    }

    const visitResult = await query(
      `SELECT id, parada_id FROM visitas WHERE uuid = $1 AND vendedor_id = $2`,
      [visita_uuid, vendedor_id]
    )
    if (!visitResult.rows.length) {
      return reply.code(404).send({ error: 'Visita no encontrada o no pertenece a este vendedor' })
    }

    const visita = visitResult.rows[0]
    const ts = checkout_at || new Date().toISOString()

    await query(
      `UPDATE visitas SET estado = 'cerrada', checkout_at = $1, notas = $2 WHERE uuid = $3`,
      [ts, notas || null, visita_uuid]
    )

    if (visita.parada_id) {
      await query(`UPDATE paradas SET estado = 'completed' WHERE id = $1`, [visita.parada_id])
    }

    // client_uuid = UUID nuevo del evento checkout (idempotencia independiente del checkin)
    // payload incluye visita_uuid para que el worker sepa qué visita cerrar en Odoo
    await query(
      `INSERT INTO outbox (client_uuid, vendedor_id, tipo, estado, payload)
       VALUES ($1, $2, 'VISIT_CLOSED', 'DONE', $3)
       ON CONFLICT (client_uuid) DO NOTHING`,
      [client_uuid, vendedor_id, JSON.stringify({ visita_uuid, checkout_at: ts, notas })]
    )

    console.log(`[VISITS] ✅ CHECKOUT visita ${visita_uuid} — evento ${client_uuid}`)
    return { status: 'ok', visita_uuid }
  }

  return reply.code(400).send({ error: "tipo debe ser 'checkin' o 'checkout'" })
})

// ── SYNC PUSH (outbox desde Flutter) ─────

fastify.post('/api/v1/sync/push', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user
  const { events } = request.body || {}

  if (!Array.isArray(events) || !events.length) {
    return reply.code(400).send({ error: 'events[] requerido' })
  }

  const results = []
  const seenEvents = new Set()

  for (const event of events) {
    const eventKey = `${event?.tipo || ''}:${event?.client_uuid || ''}`
    if (seenEvents.has(eventKey)) {
      results.push({
        client_uuid: event?.client_uuid,
        status: 'SKIPPED_DUPLICATE',
        skipped: true,
      })
      continue
    }
    seenEvents.add(eventKey)

    const { client_uuid, tipo, payload } = event

    if (!client_uuid || !tipo || !payload) {
      results.push({ client_uuid, status: 'ERROR', error: 'Faltan campos requeridos' })
      continue
    }

    // Idempotencia — leer estado actual; las transiciones se hacen vía CLAIM
    // atómico (UPDATE ... WHERE estado IN (...) RETURNING) más abajo, que es
    // seguro frente a concurrencia sin necesidad de mantener transacción
    // abierta durante el HTTP a Odoo.
    const existing = await query(
      'SELECT estado, tipo, odoo_ref, updated_at FROM outbox WHERE client_uuid = $1',
      [client_uuid]
    )
    if (existing.rows.length) {
      const existingRow = existing.rows[0]

      // Si ya está procesado (DONE) — devolver el resultado, no re-ejecutar.
      // PERO solo si el DONE corresponde al MISMO tipo que el evento entrante.
      // El _checkinUuid se reutiliza para VISIT_CHECKIN (local, odoo_ref='local')
      // y luego para VISIT_COMPLETED (real, debe ir a Odoo). Si el row dice
      // DONE pero por un VISIT_CHECKIN previo, el COMPLETED entrante TIENE que
      // procesarse normalmente — caer a la lógica de claim de abajo.
      if (existingRow.estado === 'DONE' && existingRow.tipo === tipo) {
        if (tipo === 'ORDER_CREATED') {
          const ped = await query(
            'SELECT odoo_order_id, odoo_order_name FROM pedidos WHERE client_uuid = $1',
            [client_uuid]
          )
          const pedRow = ped.rows[0] || {}
          results.push({
            client_uuid,
            status: 'DONE',
            odoo_order_id: pedRow.odoo_order_id || null,
            odoo_order_name: pedRow.odoo_order_name || null,
            skipped: true,
          })
          continue
        }
        if (tipo === 'VISIT_COMPLETED') {
          // Solo skip si ya hay un odoo_ref real (no el placeholder 'local'
          // que dejó un VISIT_CHECKIN previo con el mismo UUID).
          if (existingRow.odoo_ref && existingRow.odoo_ref !== 'local') {
            results.push({ client_uuid, status: 'DONE', odoo_ref: existingRow.odoo_ref, skipped: true })
            continue
          }
          // odoo_ref es 'local' o vacío → cae al handler de VISIT_COMPLETED abajo.
        }
      }

      // Si otro request del mismo client_uuid ya está procesando (SENDING),
      // NO re-ejecutar — devolver PROCESSING para que el cliente reintente.
      if (existingRow.estado === 'SENDING') {
        results.push({ client_uuid, status: 'PROCESSING', skipped: true })
        continue
      }

      if (tipo === 'ORDER_CREATED' && existingRow.estado !== 'DONE') {
        // Validar stock y reservar antes de tocar el pedido — anti-overselling
        const reservation = await _validateAndReserveOrder({
          orderUuid: client_uuid,
          vendorId: vendedor_id,
          payload,
        })
        if (!reservation.ok) {
          await query(
            `UPDATE outbox
               SET estado = 'STOCK_INSUFFICIENT', error_msg = $1, updated_at = NOW()
             WHERE client_uuid = $2`,
            [JSON.stringify({ items: reservation.items }), client_uuid]
          )
          fastify.log.warn(`[SYNC_PUSH] ORDER_CREATED ${client_uuid}: stock insuficiente`)
          results.push({
            client_uuid,
            status: 'STOCK_INSUFFICIENT',
            items: reservation.items,
          })
          continue
        }

        try {
          // CLAIM atómico: solo procesamos si el estado actual NO es SENDING/DONE.
          // Si otro request ganó la carrera, el UPDATE devuelve 0 filas y salimos.
          const claimed = await query(
            `UPDATE outbox
               SET tipo = 'ORDER_CREATED', estado = 'SENDING', payload = $1,
                   error_msg = NULL, updated_at = NOW()
             WHERE client_uuid = $2
               AND estado NOT IN ('SENDING', 'DONE')
             RETURNING client_uuid`,
            [JSON.stringify(payload), client_uuid]
          )
          if (!claimed.rows.length) {
            results.push({ client_uuid, status: 'PROCESSING', skipped: true })
            continue
          }
          await query(
            `INSERT INTO pedidos (client_uuid, vendedor_id, cliente_odoo_id, total, notas)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (client_uuid) DO NOTHING`,
            [client_uuid, vendedor_id, payload.cliente_odoo_id, payload.total || 0, payload.notas || null]
          )
        } catch (err) {
          // Liberar reserva — falló antes de llegar a Odoo
          await failReservations(client_uuid, err.message)
          await query(
            `UPDATE outbox
               SET estado = 'FAILED', retry_count = retry_count + 1,
                   error_msg = $1, updated_at = NOW()
             WHERE client_uuid = $2`,
            [err.message, client_uuid]
          )
          fastify.log.error(`[SYNC_PUSH] ORDER_CREATED ${client_uuid}: ${err.stack || err.message}`)
          results.push({ client_uuid, status: 'FAILED', error: err.message })
          continue
        }
        const result = await runOrderWithSoftTimeout(
          client_uuid,
          processOrder(
            { data: { tipo, payload: { ...payload, vendedor_id }, clientUuid: client_uuid, vendedor_id } },
            odooPost
          )
        )
        results.push({ client_uuid, ...result })
        continue
      }

      if (tipo === 'VISIT_COMPLETED') {
        if (existingRow.tipo === 'VISIT_COMPLETED' && existingRow.estado === 'DONE' && existingRow.odoo_ref && existingRow.odoo_ref !== 'local') {
          results.push({ client_uuid, status: 'DONE', odoo_ref: existingRow.odoo_ref, skipped: true })
          continue
        }

        try {
          const claimed = await query(
            `UPDATE outbox
               SET tipo = 'VISIT_COMPLETED', estado = 'SENDING', payload = $1,
                   error_msg = NULL, updated_at = NOW()
             WHERE client_uuid = $2
               AND NOT (tipo = 'VISIT_COMPLETED' AND estado = 'DONE' AND odoo_ref IS NOT NULL AND odoo_ref <> 'local')
             RETURNING client_uuid`,
            [JSON.stringify(payload), client_uuid]
          )
          if (!claimed.rows.length) {
            results.push({ client_uuid, status: 'DONE', skipped: true })
            continue
          }

          const result = await processVisit(
            { data: { tipo, payload: { ...payload, vendedor_id }, clientUuid: client_uuid, vendedor_id } },
            odooPost
          )
          results.push({ client_uuid, status: result.status || 'DONE', odoo_visit_id: result.odoo_visit_id })
        } catch (err) {
          await query(
            `UPDATE outbox
               SET estado = 'FAILED', retry_count = retry_count + 1,
                   error_msg = $1, updated_at = NOW()
             WHERE client_uuid = $2`,
            [err.message, client_uuid]
          )
          fastify.log.error(`[SYNC_PUSH] VISIT_COMPLETED ${client_uuid}: ${err.stack || err.message}`)
          results.push({ client_uuid, status: 'FAILED', error: err.message })
        }
        continue
      }

      if (tipo === 'VISIT_CHECKIN' || tipo === 'VISIT_CLOSED') {
        await query(
          `UPDATE outbox SET estado = 'DONE', odoo_ref = 'local', updated_at = NOW()
            WHERE client_uuid = $1`,
          [client_uuid]
        )
        results.push({ client_uuid, status: 'DONE', odoo_ref: 'local', skipped: true })
        continue
      }

      results.push({ client_uuid, status: existingRow.estado, skipped: true })
      continue
    }

    // Para ORDER_CREATED: validar stock y reservar ANTES de meterlo a la outbox.
    // Si el stock no alcanza, el pedido nunca se persiste — el vendedor recibe
    // STOCK_INSUFFICIENT con los disponibles reales y ajusta su pedido.
    if (tipo === 'ORDER_CREATED') {
      const reservation = await _validateAndReserveOrder({
        orderUuid: client_uuid,
        vendorId: vendedor_id,
        payload,
      })
      if (!reservation.ok) {
        fastify.log.warn(`[SYNC_PUSH] ORDER_CREATED ${client_uuid}: stock insuficiente`)
        results.push({
          client_uuid,
          status: 'STOCK_INSUFFICIENT',
          items: reservation.items,
        })
        continue
      }
    }

    // Insertar en outbox. Si otro request del mismo client_uuid ganó la carrera,
    // ON CONFLICT no inserta — devolvemos PROCESSING para que el cliente espere.
    const inserted = await query(
      `INSERT INTO outbox (client_uuid, vendedor_id, tipo, estado, payload, device_id)
       VALUES ($1, $2, $3, 'PENDING', $4, $5)
       ON CONFLICT (client_uuid) DO NOTHING
       RETURNING client_uuid`,
      [client_uuid, vendedor_id, tipo, JSON.stringify(payload), event.device_id || null]
    )
    if (!inserted.rows.length) {
      // Otro request ya lo insertó entre nuestro SELECT y este INSERT.
      results.push({ client_uuid, status: 'PROCESSING', skipped: true })
      // Liberar la reserva que creamos arriba (si era ORDER_CREATED), ya que
      // el ganador de la carrera creará la suya propia o ya la creó.
      if (tipo === 'ORDER_CREATED') {
        await failReservations(client_uuid, 'duplicate_request_lost_race').catch(() => {})
      }
      continue
    }

    // Insertar en tabla específica según tipo
    if (tipo === 'ORDER_CREATED') {
      await query(
        `INSERT INTO pedidos (client_uuid, vendedor_id, cliente_odoo_id, total, notas)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (client_uuid) DO NOTHING`,
        [client_uuid, vendedor_id, payload.cliente_odoo_id, payload.total || 0, payload.notas || null]
      )
    } else if (tipo === 'VISIT_CHECKIN' || tipo === 'VISIT_COMPLETED') {
      // Usar client_uuid como uuid de la visita — el worker lo busca por este campo
      await query(
        `INSERT INTO visitas (uuid, vendedor_id, cliente_odoo_id, parada_id, checkin_lat, checkin_lng, checkin_at, checkout_at, notas, estado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (uuid) DO NOTHING`,
        [
          client_uuid, vendedor_id, payload.cliente_odoo_id,
          payload.parada_id || null,
          payload.checkin_lat || null,
          payload.checkin_lng || null,
          payload.checkin_at || null,
          payload.checkout_at || null,
          payload.notas || null,
          tipo === 'VISIT_COMPLETED' ? 'cerrada' : 'abierta'
        ]
      )
    }

    if (tipo === 'ORDER_CREATED') {
      try {
        const claimed = await query(
          `UPDATE outbox SET estado = 'SENDING', updated_at = NOW()
            WHERE client_uuid = $1 AND estado NOT IN ('SENDING', 'DONE')
            RETURNING client_uuid`,
          [client_uuid]
        )
        if (!claimed.rows.length) {
          results.push({ client_uuid, status: 'PROCESSING', skipped: true })
          continue
        }
      } catch (err) {
        // Liberar reserva — falló antes de llegar a Odoo
        await failReservations(client_uuid, err.message)
        await query(
          `UPDATE outbox
             SET estado = 'FAILED', retry_count = retry_count + 1,
                 error_msg = $1, updated_at = NOW()
           WHERE client_uuid = $2`,
          [err.message, client_uuid]
        )
        fastify.log.error(`[SYNC_PUSH] ORDER_CREATED ${client_uuid}: ${err.stack || err.message}`)
        results.push({ client_uuid, status: 'FAILED', error: err.message })
        continue
      }
      const result = await runOrderWithSoftTimeout(
        client_uuid,
        processOrder(
          { data: { tipo, payload: { ...payload, vendedor_id }, clientUuid: client_uuid, vendedor_id } },
          odooPost
        )
      )
      results.push({ client_uuid, ...result })
      continue
    }

    if (tipo === 'VISIT_COMPLETED') {
      try {
        const claimed = await query(
          `UPDATE outbox SET estado = 'SENDING', updated_at = NOW()
            WHERE client_uuid = $1 AND estado NOT IN ('SENDING', 'DONE')
            RETURNING client_uuid`,
          [client_uuid]
        )
        if (!claimed.rows.length) {
          results.push({ client_uuid, status: 'PROCESSING', skipped: true })
          continue
        }
        const result = await processVisit(
          { data: { tipo, payload: { ...payload, vendedor_id }, clientUuid: client_uuid, vendedor_id } },
          odooPost
        )
        results.push({ client_uuid, status: result.status || 'DONE', odoo_visit_id: result.odoo_visit_id })
      } catch (err) {
        await query(
          `UPDATE outbox
             SET estado = 'FAILED', retry_count = retry_count + 1,
                 error_msg = $1, updated_at = NOW()
           WHERE client_uuid = $2`,
          [err.message, client_uuid]
        )
        fastify.log.error(`[SYNC_PUSH] VISIT_COMPLETED ${client_uuid}: ${err.stack || err.message}`)
        results.push({ client_uuid, status: 'FAILED', error: err.message })
      }
      continue
    }

    // Visitas y otros eventos quedan en outbox para procesamiento best-effort.
    if (tipo === 'VISIT_CHECKIN' || tipo === 'VISIT_CLOSED') {
      await query(
        `UPDATE outbox SET estado = 'DONE', odoo_ref = 'local', updated_at = NOW()
          WHERE client_uuid = $1`,
        [client_uuid]
      )
      results.push({ client_uuid, status: 'DONE', odoo_ref: 'local' })
      continue
    }

    try {
      await addToQueue(tipo, { ...payload, vendedor_id }, client_uuid)
    } catch (err) {
      await query(
        `UPDATE outbox SET error_msg = $1, updated_at = NOW() WHERE client_uuid = $2`,
        [`BullMQ enqueue failed: ${err.message}`, client_uuid]
      )
    }

    results.push({ client_uuid, status: 'QUEUED' })
  }

  return { status: 'ok', results }
})

// GET estado de eventos del outbox
fastify.get('/api/v1/sync/status', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id, uuid: vendorNexusUuid } = request.user
  const { uuids } = request.query

  if (!uuids) return reply.code(400).send({ error: 'uuids requerido (comma-separated)' })

  const uuidList = uuids.split(',').map(u => u.trim()).filter(Boolean)
  // Un solo query con LEFT JOIN al cache de pedidos — antes era 1 query por
  // cada ORDER_CREATED DONE (N+1, lento con outbox grandes).
  const result = await query(
    `SELECT o.client_uuid, o.tipo, o.estado, o.odoo_ref, o.retry_count,
            o.error_msg, o.updated_at, voc.payload AS order_payload
       FROM outbox o
       LEFT JOIN LATERAL (
         SELECT payload FROM vendor_orders_cache
          WHERE o.tipo = 'ORDER_CREATED' AND o.estado = 'DONE'
            AND vendor_uuid = $3 AND client_order_ref = o.client_uuid::text
          LIMIT 1
       ) voc ON true
      WHERE o.client_uuid = ANY($1) AND o.vendedor_id = $2`,
    [uuidList, vendedor_id, vendorNexusUuid]
  )

  const events = result.rows.map((row) => {
    const { order_payload: order, ...event } = row
    if (order && event.tipo === 'ORDER_CREATED' && event.estado === 'DONE') {
      event.estado = order.state || event.estado
      event.odoo_ref = order.name || event.odoo_ref
      event.odoo_order_id = order.id || null
    }
    return event
  })

  return { status: 'ok', events }
})

// ── UBICACIONES ──────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function updateRedisLocation(vendedor_id, uuid, nombre, lat, lng, estado, cliente_actual) {
  const payload = {
    vendedor_id, uuid, nombre,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    cliente_actual: cliente_actual || null,
    estado: estado || 'en_ruta',
    timestamp: new Date().toISOString()
  }
  await redis.setex(`location:${vendedor_id}`, 60 * 60 * 2, JSON.stringify(payload))
}

// Batch de puntos GPS desde Flutter (offline-first — acumula y manda al recuperar señal)
fastify.post('/api/v1/vendors/gps_track', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id, uuid, nombre } = request.user
  const { points } = request.body || {}

  if (!Array.isArray(points) || !points.length) {
    return reply.code(400).send({ error: 'points[] requerido' })
  }

  const values = []
  const placeholders = []
  let i = 1
  for (const p of points) {
    if (p.lat == null || p.lng == null || !p.captured_at) continue
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`)
    values.push(vendedor_id, parseFloat(p.lat), parseFloat(p.lng),
      parseFloat(p.accuracy || 0), p.estado || 'en_ruta', p.captured_at)
  }

  if (!placeholders.length) return reply.code(400).send({ error: 'No hay puntos válidos' })

  await query(
    `INSERT INTO gps_tracks (vendedor_id, lat, lng, accuracy, estado, captured_at)
     VALUES ${placeholders.join(', ')}`,
    values
  )

  // Actualizar Redis con el punto más reciente del batch
  const last = points[points.length - 1]
  await updateRedisLocation(vendedor_id, uuid, nombre, last.lat, last.lng, last.estado, null)

  return { status: 'ok', saved: placeholders.length }
})

// Compatibilidad: PATCH /vendors/location (punto único) — persiste en gps_tracks + Redis
fastify.patch('/api/v1/vendors/location', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id, uuid, nombre } = request.user
  const { lat, lng, cliente_actual, estado } = request.body || {}

  if (!lat || !lng) return reply.code(400).send({ error: 'lat y lng requeridos' })

  await updateRedisLocation(vendedor_id, uuid, nombre, lat, lng, estado, cliente_actual)

  return { status: 'ok' }
})

// Supervisor — todos los vendedores en el mapa
fastify.get('/api/v1/supervisor/team/locations', { preHandler: [verifyToken] }, async (request, reply) => {
  if (request.user.role !== 'supervisor' && request.user.role !== 'admin') {
    return reply.code(403).send({ error: 'Solo supervisores' })
  }

  // Obtener todos los vendedores activos
  const vendedores = await query(
    'SELECT id, uuid, nombre, zona FROM vendedores WHERE activo = true'
  )

  // Una sola llamada MGET en vez de un GET por vendedor
  const raws = vendedores.rows.length
    ? await redis.mget(vendedores.rows.map((v) => `location:${v.id}`))
    : []
  const locations = vendedores.rows.map((v, i) => {
      const raw = raws[i]
      const loc = raw ? JSON.parse(raw) : null
      return {
        vendedor_id: v.id,
        uuid: v.uuid,
        nombre: v.nombre,
        zona: v.zona,
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null,
        cliente_actual: loc?.cliente_actual ?? null,
        estado: loc ? loc.estado : 'sin_senal',
        timestamp: loc?.timestamp ?? null,
        minutos_sin_reporte: loc
          ? Math.floor((Date.now() - new Date(loc.timestamp).getTime()) / 60000)
          : null
      }
    })

  const con_senal = locations.filter(l => l.lat !== null).length

  return {
    status: 'ok',
    total: locations.length,
    con_senal,
    sin_senal: locations.length - con_senal,
    vendedores: locations
  }
})

// Supervisor — track GeoJSON de un vendedor en una fecha
fastify.get('/api/v1/supervisor/vendor/:uuid/track', { preHandler: [verifyToken] }, async (request, reply) => {
  if (request.user.role !== 'supervisor' && request.user.role !== 'admin') {
    return reply.code(403).send({ error: 'Solo supervisores' })
  }

  const { uuid } = request.params
  const fecha = request.query.fecha || new Date().toISOString().split('T')[0]

  const vendedorRow = await query(
    'SELECT id FROM vendedores WHERE uuid = $1 AND activo = true',
    [uuid]
  )
  if (!vendedorRow.rows.length) return reply.code(404).send({ error: 'Vendedor no encontrado' })

  const vendedor_id = vendedorRow.rows[0].id

  const tracks = await query(
    `SELECT lat, lng, estado, captured_at
     FROM gps_tracks
     WHERE vendedor_id = $1
       AND captured_at::date = $2::date
     ORDER BY captured_at ASC`,
    [vendedor_id, fecha]
  )

  if (!tracks.rows.length) {
    return {
      type: 'Feature',
      geometry: null,
      properties: { vendedor_uuid: uuid, fecha, puntos: 0, distancia_km: 0 }
    }
  }

  const coords = tracks.rows.map(r => [parseFloat(r.lng), parseFloat(r.lat)])

  let distancia_km = 0
  for (let i = 1; i < tracks.rows.length; i++) {
    const prev = tracks.rows[i - 1]
    const curr = tracks.rows[i]
    distancia_km += haversineKm(
      parseFloat(prev.lat), parseFloat(prev.lng),
      parseFloat(curr.lat), parseFloat(curr.lng)
    )
  }

  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: {
      vendedor_uuid: uuid,
      fecha,
      puntos: tracks.rows.length,
      distancia_km: Math.round(distancia_km * 10) / 10
    }
  }
})

// ─────────────────────────────────────────
// POST /api/v1/photos/upload — upload chunked (JSON + base64)
// ─────────────────────────────────────────
// Protocolo de chunks:
//   { visita_uuid, foto_uuid, filename, chunk_index (0-based), total_chunks, data (base64) }
//   → partial: { status: "partial", foto_uuid, chunks_recibidos }
//   → complete: { status: "complete", foto_uuid, odoo_attachment_id }
//
// Cada chunk se guarda en /tmp/nexus_photos/<visita_uuid>/<foto_uuid>_<N>.chunk
// Al recibir el último chunk se ensambla, se sube a Odoo como ir.attachment y se limpia /tmp.
// TODO: migrar la subida a un endpoint del módulo nexus_mobile cuando Lenn lo exponga.
// ─────────────────────────────────────────
fastify.post('/api/v1/photos/upload', { preHandler: [verifyToken] }, async (request, reply) => {
  const { visita_uuid, foto_uuid, filename, chunk_index, total_chunks, data } = request.body
  const { vendedor_id } = request.user

  // ── Validación básica ──────────────────────────────────
  if (!visita_uuid || !foto_uuid || !filename || chunk_index == null || !total_chunks || !data) {
    return reply.code(400).send({ error: 'Faltan campos: visita_uuid, foto_uuid, filename, chunk_index, total_chunks, data' })
  }
  if (typeof chunk_index !== 'number' || typeof total_chunks !== 'number') {
    return reply.code(400).send({ error: 'chunk_index y total_chunks deben ser números' })
  }

  // ── Preparar directorio temporal ──────────────────────
  const tmpDir = path.join('/tmp/nexus_photos', visita_uuid)
  fs.mkdirSync(tmpDir, { recursive: true })

  const chunkPath = path.join(tmpDir, `${foto_uuid}_${chunk_index}.chunk`)

  // Decodificar y guardar el chunk
  const chunkBuffer = Buffer.from(data, 'base64')
  fs.writeFileSync(chunkPath, chunkBuffer)

  // ── Primer chunk: registrar en tabla fotos ─────────────
  if (chunk_index === 0) {
    // Buscar visita_id a partir del uuid
    const visitaRow = await query(
      'SELECT id FROM visitas WHERE uuid = $1',
      [visita_uuid]
    )
    const visitaId = visitaRow.rows[0]?.id || null

    await query(
      `INSERT INTO fotos (uuid, visita_id, vendedor_id, filename, chunks_total, chunks_recibidos)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (uuid) DO UPDATE SET chunks_recibidos = fotos.chunks_recibidos + 1`,
      [foto_uuid, visitaId, vendedor_id, filename, total_chunks]
    )
  } else {
    await query(
      `UPDATE fotos SET chunks_recibidos = chunks_recibidos + 1 WHERE uuid = $1`,
      [foto_uuid]
    )
  }

  // ── ¿Es el último chunk? → ensamblar y subir a Odoo ──
  const esUltimo = chunk_index === total_chunks - 1

  if (!esUltimo) {
    return { status: 'partial', foto_uuid, chunks_recibidos: chunk_index + 1 }
  }

  // Verificar que todos los chunks están presentes
  for (let i = 0; i < total_chunks; i++) {
    if (!fs.existsSync(path.join(tmpDir, `${foto_uuid}_${i}.chunk`))) {
      return reply.code(422).send({ error: `Falta el chunk ${i} — reiniciar la subida` })
    }
  }

  // Ensamblar todos los chunks en orden
  const assembledPath = path.join(tmpDir, `${foto_uuid}_assembled`)
  const writeStream = fs.createWriteStream(assembledPath)
  for (let i = 0; i < total_chunks; i++) {
    const chunk = fs.readFileSync(path.join(tmpDir, `${foto_uuid}_${i}.chunk`))
    writeStream.write(chunk)
  }
  writeStream.end()
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve)
    writeStream.on('error', reject)
  })

  const assembledBuffer = fs.readFileSync(assembledPath)
  const sizeBytes       = assembledBuffer.length
  const base64Full      = assembledBuffer.toString('base64')

  // ── Subir foto vía módulo nexus_mobile ───────────────
  let odooAttachmentId = null
  try {
    const result = await odooPost('/nexus/api/v1/upload_attachment', {
      visita_uuid,
      nombre:    filename,
      datos_b64: base64Full,
      mimetype:  filename.match(/\.(jpg|jpeg)$/i) ? 'image/jpeg' : 'image/png'
    })
    odooAttachmentId = result.attachment_id
    fastify.log.info(`[PHOTOS] ✅ ${foto_uuid} → Odoo attachment ID: ${odooAttachmentId}`)
  } catch (err) {
    fastify.log.warn(`[PHOTOS] No se pudo subir a Odoo: ${err.message} — foto guardada localmente`)
  }

  // ── Actualizar fotos en PostgreSQL ───────────────────
  await query(
    `UPDATE fotos
     SET upload_completo = true, storage_path = $1, size_bytes = $2,
         chunks_recibidos = $3
     WHERE uuid = $4`,
    [assembledPath, sizeBytes, total_chunks, foto_uuid]
  )

  // Limpiar chunks temporales (mantener el ensamblado como backup)
  for (let i = 0; i < total_chunks; i++) {
    try { fs.unlinkSync(path.join(tmpDir, `${foto_uuid}_${i}.chunk`)) } catch (_) {}
  }

  fastify.log.info(`[PHOTOS] ${foto_uuid} ensamblado (${(sizeBytes / 1024).toFixed(1)} KB)`)
  return {
    status: 'complete',
    foto_uuid,
    size_bytes: sizeBytes,
    odoo_attachment_id: odooAttachmentId
  }
})

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000
// REGLA OPERATIVA (requisito #7): el gateway NUNCA debe sincronizar al
// arrancar. Toda sincronización es manual (endpoints /admin/sync) o por
// cron. Hard-deshabilitado para evitar que una variable de entorno olvidada
// en `.env` dispare sincronizaciones masivas cada reinicio.
const AUTO_SYNC_ON_START = false
const ENABLE_SYNC_CRONS = process.env.NEXUS_ENABLE_SYNC_CRONS !== 'false'

fastify.listen({ port: PORT, host: '0.0.0.0' }, async (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }

  // Verificar conexiones DB
  try {
    await testConnections()
  } catch (e) {
    fastify.log.error('DB connection failed on startup:', e.message)
  }

  // Inyectar funciones Odoo al worker de BullMQ
  setOdooCall(odooCall)   // legacy — mantener por si acaso
  setOdooPost(odooPost)   // módulo nexus_mobile — todos los processors lo usan
  if (worker) {
    fastify.log.info('[BullMQ] Worker iniciado — procesando cola nexus:outbox')
  } else {
    fastify.log.info('[OUTBOX_DRAIN] BullMQ worker deshabilitado — procesando desde PostgreSQL')
  }

  fastify.log.info(`[NEXUS SYNC] auto_start=${AUTO_SYNC_ON_START} crons=${ENABLE_SYNC_CRONS}`)
  if (AUTO_SYNC_ON_START) {
    try {
      const h = await odooPost('/nexus/api/v1/health')
      fastify.log.info(`[NEXUS MODULE] ✅ ${h.module} v${h.version} — ${h.vendor_count} vendedor(es) activo(s)`)
    } catch (e) {
      fastify.log.warn(`[NEXUS MODULE] ⚠️  Módulo no responde: ${e.message} — sync de vendedores pausado hasta instalación`)
    }
  }

  // ── Cron: sync vendedores desde Odoo (cada 1 hora) ──
  const VENDOR_SYNC_INTERVAL = 60 * 60 * 1000 // 1 hora

  async function runVendorSync() {
    try {
      const result = await syncVendors(odooPost)
      fastify.log.info(`[SYNC_VENDORS] creados: ${result.creados}, actualizados: ${result.actualizados}, desactivados: ${result.desactivados}`)
    } catch (e) {
      fastify.log.error(`[SYNC_VENDORS] Error: ${e.message}`)
    }
  }

  if (AUTO_SYNC_ON_START) runVendorSync()
  if (ENABLE_SYNC_CRONS) setInterval(runVendorSync, VENDOR_SYNC_INTERVAL)

  // ── Cron: sync de price books desde Odoo (cada 2 minutos) ──
  const PRICE_SYNC_INTERVAL = 2 * 60 * 1000

  async function runPriceSync() {
    try {
      const result = await runPriceBookSyncCycle({ processAll: true })
      fastify.log.info(
        `[SYNC_PRICEBOOKS] seeded=${result.seeded} events=${result.queued} processed=${result.processed} synced=${result.synced} skipped=${result.skipped} failed=${result.failed}`
      )
    } catch (e) {
      fastify.log.error(`[SYNC_PRICEBOOKS] Error: ${e.message}`)
    }
  }

  if (AUTO_SYNC_ON_START) runPriceSync()
  if (ENABLE_SYNC_CRONS) setInterval(runPriceSync, PRICE_SYNC_INTERVAL)

  // ── Cron: reconciliar outbox PENDING / SENDING zombies (cada 1 minuto) ──
  const OUTBOX_REQUEUE_INTERVAL = 60 * 1000

  async function runOutboxRequeue() {
    try {
      const queued = await requeueOutboxBacklog()
      if (queued) fastify.log.info(`[OUTBOX_REQUEUE] ${queued} evento(s) reencolado(s)`)
      const processed = await drainOutboxBacklog(20)
      if (processed) fastify.log.info(`[OUTBOX_DRAIN] ${processed} evento(s) procesado(s)`)
    } catch (e) {
      fastify.log.error(`[OUTBOX_REQUEUE] Error: ${e.message}`)
    }
  }

  if (AUTO_SYNC_ON_START) runOutboxRequeue()
  if (ENABLE_SYNC_CRONS) setInterval(runOutboxRequeue, OUTBOX_REQUEUE_INTERVAL)

  // ── Cron: sync clientes desde Odoo (cada 6 horas) ────
  const CLIENT_SYNC_INTERVAL = 6 * 60 * 60 * 1000

  async function runClientSync() {
    try {
      const result = await syncClients(odooPost)
      fastify.log.info(`[SYNC_CLIENTS] clientes: ${result.clientes}, relaciones: ${result.relaciones}`)
      const companies = await syncVendorCompanies(odooPost)
      fastify.log.info(`[SYNC_VENDOR_COMPANIES] vendors=${companies.vendors || 0} companies=${companies.companies || 0}`)
    } catch (e) {
      fastify.log.error(`[SYNC_CLIENTS] Error: ${e.message}`)
    }
  }

  if (AUTO_SYNC_ON_START) runClientSync()
  if (ENABLE_SYNC_CRONS) setInterval(runClientSync, CLIENT_SYNC_INTERVAL)

  // ── Cron: sync stock desde Odoo ────────────────────────────
  // Dos cadencias:
  //   - Delta cada 20 min: solo cambios desde el último sync
  //   - Full cada 6 h:    snapshot completo (reconciliación)
  const STOCK_DELTA_INTERVAL = 20 * 60 * 1000        // 20 minutos
  const STOCK_FULL_INTERVAL  = 6 * 60 * 60 * 1000    // 6 horas

  async function runStockDelta() {
    try {
      const result = await syncStock(odooPost, { mode: 'delta' })
      if (result.synced > 0 || result.errores) {
        fastify.log.info(`[SYNC_STOCK:delta] synced=${result.synced || 0} errores=${result.errores || 0}`)
      }
    } catch (e) {
      fastify.log.error(`[SYNC_STOCK:delta] Error: ${e.message}`)
    }
  }

  async function runStockFull() {
    try {
      const result = await syncStock(odooPost, { mode: 'full' })
      fastify.log.info(`[SYNC_STOCK:full] synced=${result.synced || 0} errores=${result.errores || 0}`)
    } catch (e) {
      fastify.log.error(`[SYNC_STOCK:full] Error: ${e.message}`)
    }
  }

  // Si AUTO_SYNC_ON_START=false, el full inicial se ejecuta manualmente desde /admin/sync.
  if (AUTO_SYNC_ON_START) runStockFull()
  if (ENABLE_SYNC_CRONS) {
    setInterval(runStockDelta, STOCK_DELTA_INTERVAL)
    setInterval(runStockFull, STOCK_FULL_INTERVAL)
  }

  // ── Cron: sync diarios de pago desde Odoo (cada 6 horas) ─────
  const JOURNALS_SYNC_INTERVAL = 6 * 60 * 60 * 1000

  async function runJournalsSync() {
    try {
      const result = await syncPaymentJournals(odooPost)
      fastify.log.info(`[SYNC_JOURNALS] synced=${result.synced || 0}`)
    } catch (e) {
      fastify.log.error(`[SYNC_JOURNALS] Error: ${e.message}`)
    }
  }

  if (AUTO_SYNC_ON_START) runJournalsSync()
  if (ENABLE_SYNC_CRONS) setInterval(runJournalsSync, JOURNALS_SYNC_INTERVAL)

  // ── Cron: cache de pedidos por vendedor (cada 30 minutos) ─────
  const ORDERS_SYNC_INTERVAL = 30 * 60 * 1000

  async function runOrdersSync() {
    try {
      const result = await syncVendorOrders(odooPost)
      fastify.log.info(`[SYNC_VENDOR_ORDERS] synced=${result.synced || 0} vendors=${result.vendors || 0}`)
    } catch (e) {
      fastify.log.error(`[SYNC_VENDOR_ORDERS] Error: ${e.message}`)
    }
  }

  if (AUTO_SYNC_ON_START) runOrdersSync()
  if (ENABLE_SYNC_CRONS) setInterval(runOrdersSync, ORDERS_SYNC_INTERVAL)

  // ── Cron: cache local de imágenes de productos (cada 12 horas) ─────
  const PRODUCT_IMAGES_SYNC_INTERVAL = 12 * 60 * 60 * 1000

  async function runProductImagesSync() {
    try {
      const result = await syncProductImages(odooPost)
      if (result.synced > 0 || result.errores) {
        fastify.log.info(`[SYNC_PRODUCT_IMAGES] synced=${result.synced || 0} errores=${result.errores || 0}`)
      }
    } catch (e) {
      fastify.log.error(`[SYNC_PRODUCT_IMAGES] Error: ${e.message}`)
    }
  }

  if (AUTO_SYNC_ON_START) runProductImagesSync()
  if (ENABLE_SYNC_CRONS) setInterval(runProductImagesSync, PRODUCT_IMAGES_SYNC_INTERVAL)

  // ── Cron: expirar reservas pending viejas ─────────────────────
  // Si el worker crashea entre crear la reserva y procesarla en Odoo, la
  // reserva quedaría 'pending' bloqueando stock indefinidamente. Este cron
  // las marca 'expired' después de 30 min — el stock vuelve a estar
  // disponible para otros vendedores.
  const RESERVATION_EXPIRE_INTERVAL = 60 * 1000  // 1 minuto

  async function runReservationExpiration() {
    try {
      await expireOldReservations()
    } catch (e) {
      fastify.log.error(`[RESERVATIONS] Error al expirar: ${e.message}`)
    }
  }

  if (ENABLE_SYNC_CRONS) setInterval(runReservationExpiration, RESERVATION_EXPIRE_INTERVAL)
})
