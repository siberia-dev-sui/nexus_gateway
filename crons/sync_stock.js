const { query, redis } = require('../db')
const { releaseDeductedReservationsCoveredByStockSync } = require('./stock_reservations')

// ─────────────────────────────────────────
// Cron: sync stock por almacén desde módulo nexus_mobile → PostgreSQL
//
// Modos:
//   - delta (cada 20min): pasa since=<último_generated_at> al módulo,
//     que devuelve solo stock.quant con write_date posterior
//   - full  (cada 6 h):   sin since, devuelve snapshot completo de
//     todas las ubicaciones configuradas en nexus.warehouse.config
//
// El módulo agrega stock por (warehouse_id, product_id) sumando los
// available_quantity de los quants en las sub-ubicaciones de la ubicación
// configurada. La gateway solo guarda el resultado en stock_levels.
//
// Estado del sync:
//   Redis key: nexus:last_stock_sync_<mode> (ISO timestamp)
//   Se persiste el generated_at devuelto por Odoo, no el reloj local —
//   así no hay gaps ni overlaps por desincronización de relojes.
// ─────────────────────────────────────────

const REDIS_KEY_LAST_DELTA = 'nexus:last_stock_sync_delta'
const REDIS_KEY_LAST_FULL = 'nexus:last_stock_sync_full'

const BULK_UPSERT_BATCH_SIZE = 500

/**
 * UPSERT en lote a stock_levels usando un solo INSERT por chunk.
 * Mucho más rápido que un INSERT por fila para 10k+ items.
 */
async function bulkUpsertStock(items) {
  let synced = 0

  for (let i = 0; i < items.length; i += BULK_UPSERT_BATCH_SIZE) {
    const batch = items.slice(i, i + BULK_UPSERT_BATCH_SIZE)

    const placeholders = []
    const values = []
    let p = 1
    for (const item of batch) {
      placeholders.push(`($${p}, $${p + 1}, $${p + 2}, NOW())`)
      values.push(item.product_id, item.warehouse_id, item.available_quantity)
      p += 3
    }

    await query(
      `INSERT INTO stock_levels (product_id, warehouse_id, quantity, updated_at)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET
         quantity   = EXCLUDED.quantity,
         updated_at = NOW()`,
      values
    )
    synced += batch.length
  }

  return synced
}

/**
 * Sincroniza stock con Odoo en modo delta o full.
 *
 * @param {Function} odooPost
 * @param {Object} options
 * @param {('delta'|'full')} options.mode
 */
async function syncStock(odooPost, options = {}) {
  const mode = options.mode === 'full' ? 'full' : 'delta'
  const tag = `[SYNC_STOCK:${mode}]`

  let since = null
  if (mode === 'delta') {
    since = await redis.get(REDIS_KEY_LAST_DELTA)
    if (!since) {
      console.log(`${tag} No hay last_sync previo — primer delta cubrirá ventana indefinida`)
    }
  }

  console.log(`${tag} Iniciando${since ? ` since=${since}` : ' (full)'}...`)

  let data
  try {
    data = await odooPost('/nexus/api/v1/get_all_stock_quants', { since })
  } catch (err) {
    console.error(`${tag} Error al llamar /get_all_stock_quants:`, err.message)
    return { synced: 0, errores: 1 }
  }

  const items = data?.items || []
  const generatedAt = data?.generated_at || null

  if (!items.length) {
    console.log(`${tag} Sin cambios (0 items)`)
    if (generatedAt) {
      await redis.set(
        mode === 'delta' ? REDIS_KEY_LAST_DELTA : REDIS_KEY_LAST_FULL,
        generatedAt
      )
    }
    return { synced: 0, mode }
  }

  let synced
  try {
    synced = await bulkUpsertStock(items)
    const released = await releaseDeductedReservationsCoveredByStockSync(items)
    if (released > 0) {
      console.log(`${tag} ${released} reserva(s) liberadas tras sync de on-hand Odoo`)
    }
  } catch (err) {
    console.error(`${tag} Error al UPSERT:`, err.message)
    return { synced: 0, errores: 1 }
  }

  if (generatedAt) {
    await redis.set(
      mode === 'delta' ? REDIS_KEY_LAST_DELTA : REDIS_KEY_LAST_FULL,
      generatedAt
    )
    // El full sync también actualiza el ancla del delta — después de un
    // snapshot completo, el siguiente delta arranca desde el mismo punto.
    if (mode === 'full') {
      await redis.set(REDIS_KEY_LAST_DELTA, generatedAt)
    }
  }

  console.log(`${tag} ${synced} item(s) actualizados (generated_at=${generatedAt})`)
  return { synced, mode, generated_at: generatedAt }
}

module.exports = { syncStock }
