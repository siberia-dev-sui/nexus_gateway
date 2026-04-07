require('dotenv').config()

const fastify = require('fastify')({ logger: true })

// --- Plugins ---
fastify.register(require('@fastify/cors'), {
  origin: true
})

fastify.register(require('@fastify/jwt'), {
  secret: process.env.JWT_SECRET
})

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

// Login — hardcoded for demo, replace with Odoo auth later
fastify.post('/api/v1/auth/login', async (request, reply) => {
  const { email, password } = request.body || {}

  // TODO: replace with Odoo JSON-RPC authentication
  if (email === process.env.DEMO_EMAIL && password === process.env.DEMO_PASSWORD) {
    const token = fastify.jwt.sign(
      { email, role: 'vendedor' },
      { expiresIn: '24h' }
    )
    return { token }
  }

  reply.code(401).send({ error: 'Invalid credentials' })
})

// Protected example — GET /api/v1/sync/initial (stub)
fastify.get('/api/v1/sync/initial', { preHandler: [verifyToken] }, async (request, reply) => {
  // TODO: connect to Odoo JSON-RPC and return real products
  return {
    status: 'ok',
    message: 'Odoo sync not yet configured',
    products: []
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
