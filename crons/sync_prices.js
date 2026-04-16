const { redis } = require('../db')

// ─────────────────────────────────────────
// Cron: sync precios desde Odoo → Redis
// Frecuencia: cada 30 minutos
//
// Lee lst_price de product.product y lo guarda en Redis como hash:
//   HSET prices <product_id> <precio>
//
// El worker BullMQ (order.js) lee con HGET prices <product_id>
// para validar que el precio del vendedor no difiera más del 5%.
// Sin este cron, Redis "prices" está vacío y la validación no actúa.
// ─────────────────────────────────────────

async function syncPrices(odooCall) {
  console.log('[SYNC_PRICES] Iniciando sync de precios desde Odoo...')

  let products = []
  try {
    products = await odooCall(
      'product.product',
      'search_read',
      [[['active', '=', true], ['sale_ok', '=', true]]],
      { fields: ['id', 'lst_price'], limit: 5000 }
    )
  } catch (err) {
    console.error('[SYNC_PRICES] Error al leer precios desde Odoo:', err.message)
    return { synced: 0, errores: 1 }
  }

  if (!products.length) {
    console.log('[SYNC_PRICES] No se encontraron productos activos')
    return { synced: 0 }
  }

  // Construir el hash completo y hacer un solo HSET (atómico)
  const pairs = []
  for (const p of products) {
    if (p.lst_price > 0) {
      pairs.push(String(p.id), String(p.lst_price))
    }
  }

  if (pairs.length) {
    await redis.hset('prices', ...pairs)
  }

  const synced = pairs.length / 2
  console.log(`[SYNC_PRICES] ${synced} precio(s) actualizados en Redis hash "prices"`)
  return { synced }
}

module.exports = { syncPrices }
