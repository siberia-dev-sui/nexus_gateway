const { query } = require('../db')

// ─────────────────────────────────────────
// Sistema de sugerencias de pedido (event-driven, sin cron)
//
// Flujo:
//   - El worker, tras procesar exitosamente un VISIT_COMPLETED, llama
//     refreshSuggestionsFor(vendorUuid, clientId) para reflejar la nueva
//     visita en el cache.
//   - El endpoint GET /vendor/order_suggestions, si el vendedor no tiene
//     filas en cache, dispara backfillVendorSuggestions(vendorUuid) en
//     background para poblar de todos sus clientes asignados.
//
// Lectura desde la app:
//   - Pide GET /vendor/order_suggestions → lee de la tabla y devuelve.
//   - La app guarda el resultado en su SQLite local para uso offline.
// ─────────────────────────────────────────

/**
 * Refresca el cache para un solo par (vendor, client). Se llama desde el
 * worker tras procesar un VISIT_COMPLETED exitoso.
 *
 * Si Odoo no devuelve sugerencias (ej: cliente sin historial), borra las
 * filas existentes — la ausencia es una señal válida.
 */
async function refreshSuggestionsFor(odooPost, vendorUuid, clientId, vendorId) {
  if (!vendorUuid || !clientId || !vendorId) {
    return { synced: 0, skipped: true }
  }

  let data
  try {
    data = await odooPost('/nexus/api/v1/order_suggestions', {
      vendor_nexus_uuid: vendorUuid,
      client_id:         clientId,
    })
  } catch (err) {
    console.error(
      `[SUGGESTIONS] Error pidiendo /order_suggestions vendor=${vendorUuid.slice(0, 8)} client=${clientId}:`,
      err.message
    )
    return { synced: 0, errores: 1 }
  }

  const suggestions = data?.suggestions || []

  // Borrar lo viejo de ese par para que la lista quede consistente con
  // lo que Odoo cree ahora (un producto que ya no aparece se borra)
  await query(
    `DELETE FROM order_suggestions_cache
      WHERE vendor_id = $1 AND client_id = $2`,
    [vendorId, clientId]
  )

  if (!suggestions.length) {
    console.log(
      `[SUGGESTIONS] vendor=${vendorUuid.slice(0, 8)} client=${clientId} → sin sugerencias (cache limpiada)`
    )
    return { synced: 0 }
  }

  // UPSERT en lote
  const placeholders = []
  const values = []
  let p = 1
  for (const s of suggestions) {
    placeholders.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, NOW())`)
    values.push(vendorId, clientId, s.product_id, s.target, s.last_post)
    p += 5
  }

  await query(
    `INSERT INTO order_suggestions_cache
       (vendor_id, client_id, product_id, target, last_post, updated_at)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (vendor_id, client_id, product_id) DO UPDATE SET
       target     = EXCLUDED.target,
       last_post  = EXCLUDED.last_post,
       updated_at = NOW()`,
    values
  )

  console.log(
    `[SUGGESTIONS] vendor=${vendorUuid.slice(0, 8)} client=${clientId} → ${suggestions.length} producto(s)`
  )
  return { synced: suggestions.length }
}

/**
 * Backfill async: recorre TODOS los clientes asignados al vendedor y
 * recomputa sus sugerencias. Se dispara cuando el endpoint detecta cache
 * vacío para un vendedor (típicamente: vendedor nuevo o cache nuevo).
 *
 * No bloquea — el endpoint devuelve lo que haya (vacío al principio) y el
 * resto se popula en background. La próxima sync del app traerá la data.
 */
async function backfillVendorSuggestions(odooPost, vendorUuid, vendorId) {
  if (!vendorUuid || !vendorId) return { synced: 0 }

  // Sacar los clientes asignados al vendedor (ya están en la tabla de
  // relación vendedor_cliente_rel, alimentada por sync_clients)
  const clientRows = await query(
    `SELECT cliente_odoo_id FROM vendedor_cliente_rel WHERE vendedor_id = $1`,
    [vendorId]
  )

  if (!clientRows.rows.length) {
    console.log(`[SUGGESTIONS] backfill: vendor=${vendorUuid.slice(0, 8)} sin clientes asignados`)
    return { synced: 0 }
  }

  let total = 0
  for (const row of clientRows.rows) {
    const result = await refreshSuggestionsFor(
      odooPost, vendorUuid, row.cliente_odoo_id, vendorId
    )
    total += result.synced || 0
  }

  console.log(
    `[SUGGESTIONS] backfill: vendor=${vendorUuid.slice(0, 8)} → ${clientRows.rows.length} cliente(s), ${total} fila(s) cacheadas`
  )
  return { synced: total }
}

module.exports = {
  refreshSuggestionsFor,
  backfillVendorSuggestions,
}
