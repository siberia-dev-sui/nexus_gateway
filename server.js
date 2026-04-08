require('dotenv').config()

const fastify = require('fastify')({ logger: true })
const axios = require('axios').create({ proxy: false })

// --- Odoo client ---
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
      {
        jsonrpc: '2.0',
        method: 'call',
        params: { model, method, args, kwargs }
      },
      { headers: { Cookie: odooSession.join('; ') } }
    )

    if (res.data.error) {
      // Session expired — re-auth once
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

// --- Plugins ---
fastify.register(require('@fastify/cors'), { origin: true })
fastify.register(require('@fastify/jwt'), { secret: process.env.JWT_SECRET })

// --- Auth helper ---
async function verifyToken(request, reply) {
  try {
    await request.jwtVerify()
  } catch (err) {
    reply.send(err)
  }
}

// --- Routes ---

// Health check
fastify.get('/api/v1/health', async (request, reply) => {
  return { status: 'ok', message: 'NEXUS Gateway is running' }
})

// Login
fastify.post('/api/v1/auth/login', async (request, reply) => {
  const { email, password } = request.body || {}

  if (email === process.env.DEMO_EMAIL && password === process.env.DEMO_PASSWORD) {
    const token = fastify.jwt.sign(
      { email, role: 'vendedor' },
      { expiresIn: '24h' }
    )
    return { token }
  }

  reply.code(401).send({ error: 'Invalid credentials' })
})

// Catálogo público — caché en memoria 1h para no saturar Odoo
// Las imágenes se sirven por URL lazy (no base64 en bulk)
let _catalogCache = null
let _catalogCacheTime = null
const CATALOG_TTL_MS = 60 * 60 * 1000 // 1 hora

fastify.get('/api/v1/catalog', async (request, reply) => {
  const now = Date.now()
  if (_catalogCache && _catalogCacheTime && (now - _catalogCacheTime) < CATALOG_TTL_MS) {
    return { status: 'ok', count: _catalogCache.length, products: _catalogCache, cached: true }
  }

  const products = await odooCall(
    'product.product',
    'search_read',
    [[['sale_ok', '=', true], ['active', '=', true]]],
    {
      fields: ['name', 'list_price', 'qty_available', 'categ_id', 'default_code'],
      limit: 200
    }
  )

  // Agrega URL de imagen por producto — Flutter la carga lazy sin saturar Odoo
  const withImages = products.map(p => ({
    ...p,
    image_url: `${process.env.ODOO_URL}/web/image/product.product/${p.id}/image_128`
  }))

  _catalogCache = withImages
  _catalogCacheTime = now
  return { status: 'ok', count: withImages.length, products: withImages, cached: false }
})

// Sync inicial — productos reales de Odoo (protegido)
fastify.get('/api/v1/sync/initial', { preHandler: [verifyToken] }, async (request, reply) => {
  const products = await odooCall(
    'product.product',
    'search_read',
    [[['sale_ok', '=', true], ['active', '=', true]]],
    {
      fields: ['name', 'list_price', 'qty_available', 'categ_id', 'default_code'],
      limit: 200
    }
  )

  return {
    status: 'ok',
    count: products.length,
    products
  }
})

// --- Start ---
const PORT = process.env.PORT || 3000

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
