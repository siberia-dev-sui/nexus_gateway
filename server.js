require('dotenv').config()

const fastify = require('fastify')({ logger: true })
const axios = require('axios').create({ proxy: false })
const bcrypt = require('bcrypt')
const { query, redis, testConnections } = require('./db')
const { addToQueue } = require('./queues/index')
const { worker, setOdooCall } = require('./queues/worker')
const { syncVendors }   = require('./crons/sync_vendors')
const { syncClients }   = require('./crons/sync_clients')
const { generateRoutes } = require('./crons/generate_routes')
const cron              = require('node-cron')

// ─────────────────────────────────────────
// Odoo client
// ─────────────────────────────────────────
let odooSession = null

async function odooAuth() {
  const res = await axios.post(`${process.env.ODOO_URL}/web/session/authenticate`, {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      db: process.env.ODOO_DB,
      login: process.env.ODOO_BOT_EMAIL,
      password: process.env.ODOO_BOT_PASSWORD
    }
  })
  if (res.data.result && res.data.result.uid) {
    odooSession = res.headers['set-cookie']
    return true
  }
  throw new Error('Odoo auth failed')
}

async function odooCall(model, method, args = [], kwargs = {}) {
  if (!odooSession) await odooAuth()
  try {
    const res = await axios.post(
      `${process.env.ODOO_URL}/web/dataset/call_kw`,
      { jsonrpc: '2.0', method: 'call', params: { model, method, args, kwargs } },
      { headers: { Cookie: odooSession.join('; ') } }
    )
    if (res.data.error) {
      odooSession = null
      await odooAuth()
      return odooCall(model, method, args, kwargs)
    }
    return res.data.result
  } catch (err) {
    odooSession = null
    throw err
  }
}

// ─────────────────────────────────────────
// Plugins
// ─────────────────────────────────────────
fastify.register(require('@fastify/cors'), { origin: true })
fastify.register(require('@fastify/jwt'), { secret: process.env.JWT_SECRET })

async function verifyToken(request, reply) {
  try {
    await request.jwtVerify()
  } catch (err) {
    reply.send(err)
  }
}

// ─────────────────────────────────────────
// Catalog cache (Redis-backed)
// ─────────────────────────────────────────
const CATALOG_TTL_SEC = 60 * 60 // 1 hora

async function fetchCatalogFromOdoo() {
  const attachments = await odooCall(
    'ir.attachment',
    'search_read',
    [[['res_model', 'in', ['product.product', 'product.template']], ['res_field', 'in', ['image_1920', 'image_128']]]],
    { fields: ['res_id'], limit: 2000 }
  )
  const idsWithImage = [...new Set(attachments.map(a => a.res_id).filter(Boolean))]
  const products = await odooCall(
    'product.product',
    'search_read',
    [[['sale_ok', '=', true], ['active', '=', true], ['id', 'in', idsWithImage]]],
    { fields: ['name', 'list_price', 'qty_available', 'categ_id', 'default_code'], limit: 500 }
  )
  return products
}

async function getCatalog() {
  const cached = await redis.get('catalog:products')
  if (cached) return { products: JSON.parse(cached), cached: true }
  const products = await fetchCatalogFromOdoo()
  await redis.setex('catalog:products', CATALOG_TTL_SEC, JSON.stringify(products))
  return { products, cached: false }
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

// Health
fastify.get('/api/v1/health', async () => {
  return { status: 'ok', message: 'NEXUS Gateway is running' }
})

// ── AUTH ──────────────────────────────────

// Login real — vendedores desde PostgreSQL
fastify.post('/api/v1/auth/login', async (request, reply) => {
  const { email, password } = request.body || {}
  if (!email || !password) return reply.code(400).send({ error: 'Email y password requeridos' })

  const result = await query(
    'SELECT id, uuid, nombre, email, password_hash, zona, device_id, activo FROM vendedores WHERE email = $1',
    [email.toLowerCase()]
  )

  const vendedor = result.rows[0]
  if (!vendedor || !vendedor.activo) return reply.code(401).send({ error: 'Credenciales inválidas' })

  const valid = await bcrypt.compare(password, vendedor.password_hash)
  if (!valid) return reply.code(401).send({ error: 'Credenciales inválidas' })

  await query('UPDATE vendedores SET ultimo_login = NOW() WHERE id = $1', [vendedor.id])

  const token = fastify.jwt.sign(
    { vendedor_id: vendedor.id, uuid: vendedor.uuid, email: vendedor.email, role: 'vendedor' },
    { expiresIn: '24h' }
  )

  return {
    token,
    vendedor: {
      uuid: vendedor.uuid,
      nombre: vendedor.nombre,
      email: vendedor.email,
      zona: vendedor.zona
    }
  }
})

// ── CATALOG ───────────────────────────────

fastify.get('/api/v1/catalog', async () => {
  const { products, cached } = await getCatalog()
  return { status: 'ok', count: products.length, products, cached }
})

// ── PRODUCT IMAGE ─────────────────────────

fastify.get('/api/v1/product/:id/image', async (request, reply) => {
  if (!odooSession) await odooAuth()
  const url = `${process.env.ODOO_URL}/web/image/product.product/${request.params.id}/image_256`
  try {
    let res = await axios.get(url, { headers: { Cookie: odooSession.join('; ') }, responseType: 'arraybuffer' })
    if (res.status === 403 || res.status === 302) {
      odooSession = null
      await odooAuth()
      res = await axios.get(url, { headers: { Cookie: odooSession.join('; ') }, responseType: 'arraybuffer' })
    }
    reply.header('Content-Type', res.headers['content-type'] || 'image/png')
    reply.header('Cache-Control', 'public, max-age=86400')
    return reply.send(Buffer.from(res.data))
  } catch {
    reply.code(404).send()
  }
})

// ── SYNC ──────────────────────────────────

fastify.get('/api/v1/sync/initial', { preHandler: [verifyToken] }, async () => {
  const { products, cached } = await getCatalog()
  return { status: 'ok', count: products.length, products, cached }
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
    `SELECT r.id, r.uuid, r.fecha, r.estado
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

  return { status: 'ok', ruta: { uuid: ruta.uuid, fecha: ruta.fecha, estado: ruta.estado, paradas, kpis } }
}

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

// ── SYNC PUSH (outbox desde Flutter) ─────

fastify.post('/api/v1/sync/push', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user
  const { events } = request.body || {}

  if (!Array.isArray(events) || !events.length) {
    return reply.code(400).send({ error: 'events[] requerido' })
  }

  const results = []

  for (const event of events) {
    const { client_uuid, tipo, payload } = event

    if (!client_uuid || !tipo || !payload) {
      results.push({ client_uuid, status: 'ERROR', error: 'Faltan campos requeridos' })
      continue
    }

    // Idempotencia — si ya existe este UUID, no procesar de nuevo
    const existing = await query(
      'SELECT estado FROM outbox WHERE client_uuid = $1',
      [client_uuid]
    )
    if (existing.rows.length) {
      results.push({ client_uuid, status: existing.rows[0].estado, skipped: true })
      continue
    }

    // Insertar en outbox
    await query(
      `INSERT INTO outbox (client_uuid, vendedor_id, tipo, estado, payload, device_id)
       VALUES ($1, $2, $3, 'PENDING', $4, $5)`,
      [client_uuid, vendedor_id, tipo, JSON.stringify(payload), event.device_id || null]
    )

    // Insertar en tabla específica según tipo
    if (tipo === 'ORDER_CREATED') {
      await query(
        `INSERT INTO pedidos (client_uuid, vendedor_id, cliente_odoo_id, total, notas)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (client_uuid) DO NOTHING`,
        [client_uuid, vendedor_id, payload.cliente_odoo_id, payload.total || 0, payload.notas || null]
      )
    } else if (tipo === 'PAYMENT_RECORDED') {
      await query(
        `INSERT INTO pagos (client_uuid, vendedor_id, cliente_odoo_id, monto, metodo, referencia)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (client_uuid) DO NOTHING`,
        [client_uuid, vendedor_id, payload.cliente_odoo_id, payload.monto, payload.metodo || 'efectivo', payload.referencia || null]
      )
    } else if (tipo === 'VISIT_CHECKIN') {
      // Usar client_uuid como uuid de la visita — el worker lo busca por este campo
      await query(
        `INSERT INTO visitas (uuid, vendedor_id, cliente_odoo_id, parada_id, checkin_lat, checkin_lng, checkin_at, estado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'abierta') ON CONFLICT (uuid) DO NOTHING`,
        [
          client_uuid, vendedor_id, payload.cliente_odoo_id,
          payload.parada_id || null,
          payload.checkin_lat || null,
          payload.checkin_lng || null,
          payload.checkin_at || null
        ]
      )
    }

    // Encolar en BullMQ
    await addToQueue(tipo, payload, client_uuid)

    results.push({ client_uuid, status: 'QUEUED' })
  }

  return { status: 'ok', results }
})

// GET estado de eventos del outbox
fastify.get('/api/v1/sync/status', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user
  const { uuids } = request.query

  if (!uuids) return reply.code(400).send({ error: 'uuids requerido (comma-separated)' })

  const uuidList = uuids.split(',').map(u => u.trim()).filter(Boolean)
  const result = await query(
    `SELECT client_uuid, tipo, estado, odoo_ref, retry_count, error_msg, updated_at
     FROM outbox WHERE client_uuid = ANY($1) AND vendedor_id = $2`,
    [uuidList, vendedor_id]
  )

  return { status: 'ok', events: result.rows }
})

// ── UBICACIONES ──────────────────────────

// Teléfono reporta su ubicación al gateway
fastify.patch('/api/v1/vendors/location', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id, uuid, nombre } = request.user
  const { lat, lng, cliente_actual, estado } = request.body || {}

  if (!lat || !lng) return reply.code(400).send({ error: 'lat y lng requeridos' })

  const payload = {
    vendedor_id,
    uuid,
    nombre,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    cliente_actual: cliente_actual || null,
    estado: estado || 'en_ruta',            // en_ruta | en_cliente | sin_senal
    timestamp: new Date().toISOString()
  }

  // Guardar en Redis con TTL 2h (si no reporta en 2h, se considera sin señal)
  await redis.setex(`location:${vendedor_id}`, 60 * 60 * 2, JSON.stringify(payload))

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

  // Leer ubicaciones desde Redis en paralelo
  const locations = await Promise.all(
    vendedores.rows.map(async (v) => {
      const raw = await redis.get(`location:${v.id}`)
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
  )

  const con_senal = locations.filter(l => l.lat !== null).length

  return {
    status: 'ok',
    total: locations.length,
    con_senal,
    sin_senal: locations.length - con_senal,
    vendedores: locations
  }
})

// ─────────────────────────────────────────
// Start
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000

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

  // Inyectar odooCall al worker de BullMQ
  setOdooCall(odooCall)
  fastify.log.info('[BullMQ] Worker iniciado — procesando cola nexus:outbox')

  // Warm up catalog cache en Redis
  getCatalog().then(({ products, cached }) => {
    if (!cached) fastify.log.info(`Catalog cache warmed: ${products.length} products`)
    else fastify.log.info(`Catalog loaded from Redis cache`)
  }).catch(e => fastify.log.warn('Catalog warm-up failed:', e.message))

  // ── Helpers de crons ─────────────────────────────────
  async function runVendorSync() {
    try {
      const r = await syncVendors(odooCall)
      fastify.log.info(`[SYNC_VENDORS] creados: ${r.creados}, actualizados: ${r.actualizados}, desactivados: ${r.desactivados}`)
    } catch (e) {
      fastify.log.error(`[SYNC_VENDORS] Error: ${e.message}`)
    }
  }

  async function runClientSync() {
    try {
      const r = await syncClients(odooCall)
      fastify.log.info(`[SYNC_CLIENTS] clientes: ${r.clientes}, relaciones: ${r.relaciones}`)
    } catch (e) {
      fastify.log.error(`[SYNC_CLIENTS] Error: ${e.message}`)
    }
  }

  async function runGenerateRoutes() {
    try {
      const r = await generateRoutes()
      fastify.log.info(`[GEN_ROUTES] generadas: ${r.generadas}, actualizadas: ${r.actualizadas}`)
    } catch (e) {
      fastify.log.error(`[GEN_ROUTES] Error: ${e.message}`)
    }
  }

  // ── Cron: sync vendedores (cada 1 hora, arranca inmediato) ──
  runVendorSync()
  setInterval(runVendorSync, 60 * 60 * 1000)

  // ── Cron: sync clientes — 3:50AM y 9:50AM ────────────
  // Corre 10 min antes de generate_routes para tener datos frescos
  cron.schedule('50 3 * * *', runClientSync, { timezone: 'America/Caracas' })
  cron.schedule('50 9 * * *', runClientSync, { timezone: 'America/Caracas' })

  // ── Cron: generación de rutas — 4:00AM y 10:00AM ─────
  // 4AM: rutas del día nuevo (captura cambios post-6PM del día anterior)
  // 10AM: añade paradas nuevas a rutas aún no iniciadas
  cron.schedule('0 4 * * *',  runGenerateRoutes, { timezone: 'America/Caracas' })
  cron.schedule('0 10 * * *', runGenerateRoutes, { timezone: 'America/Caracas' })
})
