require('dotenv').config()

const fastify = require('fastify')({ logger: true })
const axios = require('axios').create({ proxy: false })
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const { query, redis, testConnections } = require('./db')
const { addToQueue } = require('./queues/index')
const { worker, setOdooCall } = require('./queues/worker')
const { syncVendors } = require('./crons/sync_vendors')
const { syncPrices } = require('./crons/sync_prices')
const { syncClients } = require('./crons/sync_clients')

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

// Helper para endpoints custom del módulo nexus_mobile (no /web/dataset/call_kw)
async function odooPost(path, params = {}) {
  if (!odooSession) await odooAuth()
  try {
    const res = await axios.post(
      `${process.env.ODOO_URL}${path}`,
      { jsonrpc: '2.0', method: 'call', params },
      { headers: { Cookie: odooSession.join('; ') } }
    )
    if (res.data.error) {
      odooSession = null
      await odooAuth()
      return odooPost(path, params)  // reintento una vez
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
  const result = await odooPost('/nexus/api/v1/catalog')
  return result.products
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
    { vendedor_id: vendedor.id, uuid: vendedor.uuid, email: vendedor.email, role: vendedor.rol || 'vendedor' },
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
    'SELECT id, uuid, nombre, email, password_hash, zona, activo FROM vendedores WHERE email = $1',
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
            v.uuid, v.nombre, v.email, v.zona, v.activo
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

  const vendedor = { id: row.vendedor_id, uuid: row.uuid, nombre: row.nombre, email: row.email, zona: row.zona }
  const { accessToken, refreshToken } = await issueTokenPair(fastify, vendedor, device_id || row.device_id)

  return {
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: 86400
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

// ── CLIENTES DEL VENDEDOR ─────────────────

fastify.get('/api/v1/clients', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id } = request.user

  const result = await query(
    `SELECT c.odoo_id, c.nombre, c.rif, c.telefono, c.direccion,
            c.lat, c.lng, c.bloqueado, c.credito_restringido,
            c.motivo_bloqueo, c.canal, c.credito_limite, c.credito_usado
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
  }))

  return { status: 'ok', count: clientes.length, clientes }
})

// ── SYNC MANUAL DE CLIENTES (trigger desde la app) ───────────────────────────

fastify.post('/api/v1/clients/sync', { preHandler: [verifyToken] }, async (request, reply) => {
  const { vendedor_id, uuid } = request.user

  // Consultar Odoo solo para este vendedor
  const result = await odooPost('/nexus/api/v1/vendor_clients', { nexus_uuid: uuid })
  if (!result) {
    return reply.code(502).send({ error: 'No se pudo conectar con Odoo' })
  }

  const partners = result.clients || []

  // Upsert clientes en PostgreSQL
  for (const p of partners) {
    const dir = [p.direccion].filter(Boolean).join(', ') || null
    await query(
      `INSERT INTO clientes (odoo_id, nombre, rif, telefono, direccion, lat, lng,
                             bloqueado, credito_restringido, motivo_bloqueo, canal, last_sync)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (odoo_id) DO UPDATE SET
         nombre              = EXCLUDED.nombre,
         rif                 = EXCLUDED.rif,
         telefono            = EXCLUDED.telefono,
         direccion           = EXCLUDED.direccion,
         lat                 = EXCLUDED.lat,
         lng                 = EXCLUDED.lng,
         bloqueado           = EXCLUDED.bloqueado,
         credito_restringido = EXCLUDED.credito_restringido,
         motivo_bloqueo      = EXCLUDED.motivo_bloqueo,
         canal               = EXCLUDED.canal,
         last_sync           = NOW()`,
      [p.odoo_id, p.nombre, p.rif || null, p.telefono || null, dir,
       p.lat || null, p.lng || null, p.bloqueado || false,
       p.credito_restringido || false, p.motivo_bloqueo || null, p.canal || null]
    )
  }

  // Actualizar relaciones: insertar nuevas y eliminar las que ya no están en Odoo
  const clientIds = partners.map(p => p.odoo_id)

  for (const odooId of clientIds) {
    await query(
      `INSERT INTO vendedor_cliente_rel (vendedor_id, cliente_odoo_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [vendedor_id, odooId]
    )
  }

  if (clientIds.length) {
    await query(
      `DELETE FROM vendedor_cliente_rel
       WHERE vendedor_id = $1 AND cliente_odoo_id != ALL($2::int[])`,
      [vendedor_id, clientIds]
    )
  } else {
    await query(
      'DELETE FROM vendedor_cliente_rel WHERE vendedor_id = $1',
      [vendedor_id]
    )
  }

  // Devolver la lista actualizada desde PostgreSQL
  const updated = await query(
    `SELECT c.odoo_id, c.nombre, c.rif, c.telefono, c.direccion,
            c.lat, c.lng, c.bloqueado, c.credito_restringido,
            c.motivo_bloqueo, c.canal, c.credito_limite, c.credito_usado
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
  }))

  fastify.log.info(`[SYNC_CLIENTS_MANUAL] vendedor_id=${vendedor_id} clientes=${clientes.length}`)
  return { status: 'ok', count: clientes.length, clientes }
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
       VALUES ($1, $2, 'VISIT_CHECKIN', 'PENDING', $3)
       ON CONFLICT (client_uuid) DO NOTHING`,
      [client_uuid, vendedor_id, JSON.stringify({ cliente_odoo_id, parada_id, checkin_lat, checkin_lng, checkin_at: ts })]
    )
    await addToQueue('VISIT_CHECKIN', { cliente_odoo_id, parada_id, checkin_lat, checkin_lng, checkin_at: ts }, client_uuid)

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
       VALUES ($1, $2, 'VISIT_CLOSED', 'PENDING', $3)
       ON CONFLICT (client_uuid) DO NOTHING`,
      [client_uuid, vendedor_id, JSON.stringify({ visita_uuid, checkout_at: ts, notas })]
    )
    await addToQueue('VISIT_CLOSED', { visita_uuid, checkout_at: ts, notas }, client_uuid)

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

  // Health check del módulo nexus_mobile — warning si no está instalado
  try {
    const h = await odooPost('/nexus/api/v1/health')
    fastify.log.info(`[NEXUS MODULE] ✅ ${h.module} v${h.version} — ${h.vendor_count} vendedor(es) activo(s)`)
  } catch (e) {
    fastify.log.warn(`[NEXUS MODULE] ⚠️  Módulo no responde: ${e.message} — sync de vendedores pausado hasta instalación`)
  }

  // Warm up catalog cache en Redis
  getCatalog().then(({ products, cached }) => {
    if (!cached) fastify.log.info(`Catalog cache warmed: ${products.length} products`)
    else fastify.log.info(`Catalog loaded from Redis cache`)
  }).catch(e => fastify.log.warn('Catalog warm-up failed:', e.message))

  // ── Cron: sync vendedores desde Odoo (cada 1 hora) ──
  const VENDOR_SYNC_INTERVAL = 60 * 60 * 1000 // 1 hora

  async function runVendorSync() {
    try {
      const result = await syncVendors(odooCall)
      fastify.log.info(`[SYNC_VENDORS] creados: ${result.creados}, actualizados: ${result.actualizados}, desactivados: ${result.desactivados}`)
    } catch (e) {
      fastify.log.error(`[SYNC_VENDORS] Error: ${e.message}`)
    }
  }

  // Correr al arrancar y luego cada hora
  runVendorSync()
  setInterval(runVendorSync, VENDOR_SYNC_INTERVAL)

  // ── Cron: sync precios desde Odoo (cada 30 minutos) ──
  const PRICE_SYNC_INTERVAL = 30 * 60 * 1000

  async function runPriceSync() {
    try {
      const result = await syncPrices(odooCall)
      fastify.log.info(`[SYNC_PRICES] ${result.synced} precio(s) sincronizados`)
    } catch (e) {
      fastify.log.error(`[SYNC_PRICES] Error: ${e.message}`)
    }
  }

  runPriceSync()
  setInterval(runPriceSync, PRICE_SYNC_INTERVAL)

  // ── Cron: sync clientes desde Odoo (cada 6 horas) ────
  const CLIENT_SYNC_INTERVAL = 6 * 60 * 60 * 1000

  async function runClientSync() {
    try {
      const result = await syncClients(odooCall)
      fastify.log.info(`[SYNC_CLIENTS] clientes: ${result.clientes}, relaciones: ${result.relaciones}`)
    } catch (e) {
      fastify.log.error(`[SYNC_CLIENTS] Error: ${e.message}`)
    }
  }

  // Correr al arrancar y luego cada 6 horas
  runClientSync()
  setInterval(runClientSync, CLIENT_SYNC_INTERVAL)
})
