const { redis } = require('../db')

// ─────────────────────────────────────────
// Cron: sync precios desde módulo nexus_mobile → Redis
// Frecuencia: al arrancar + cada 30 minutos
//
// El módulo devuelve: { prices: [{ product_id, lst_price }] }
// Se guarda en Redis como hash: HSET prices <product_id> <precio>
//
// El worker BullMQ (order.js) lee con HGET prices <product_id>
// para validar que el precio del vendedor no difiera más del 5%.
// ─────────────────────────────────────────

async function syncPrices(odooPost) {
  console.log('[SYNC_PRICES] Iniciando sync de precios desde módulo nexus_mobile...')

  let prices = []
  try {
    const data = await odooPost('/nexus/api/v1/get_prices', {})
    prices = data?.prices || []
  } catch (err) {
    console.error('[SYNC_PRICES] Error al llamar /get_prices:', err.message)
    return { synced: 0, errores: 1 }
  }

  if (!prices.length) {
    console.log('[SYNC_PRICES] No se encontraron precios')
    return { synced: 0 }
  }

  // Construir el hash completo y hacer un solo HSET (atómico)
  const pairs = []
  for (const p of prices) {
    if (p.lst_price > 0) {
      pairs.push(String(p.product_id), String(p.lst_price))
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
