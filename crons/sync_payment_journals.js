const { query } = require('../db')

// ─────────────────────────────────────────
// Cron: sync diarios de pago desde módulo nexus_mobile → PostgreSQL.
//
// Frecuencia: al arrancar + cada 6 horas (los diarios no cambian seguido).
//
// El módulo devuelve: { journals: [{ id, name, code, type, company_id,
// company_name, currency_code }] }. La app los pide vía
// GET /api/v1/vendor/journals?company_id=X para el picker al crear una
// solicitud de pago.
//
// No se borran diarios "vivos" que vinieron en una pasada anterior pero
// hoy no — un diario archivado en Odoo simplemente deja de aparecer en
// el endpoint, pero la fila local se mantiene hasta el siguiente full sync.
// Para evitar mostrarle al vendedor un diario que ya no existe en Odoo,
// hacemos DELETE de los que no vinieron en este batch.
// ─────────────────────────────────────────

async function syncPaymentJournals(odooPost) {
  console.log('[SYNC_JOURNALS] Iniciando sync de diarios de pago...')

  let data
  try {
    data = await odooPost('/nexus/api/v1/payment_journals', {})
  } catch (err) {
    console.error('[SYNC_JOURNALS] Error al llamar /payment_journals:', err.message)
    return { synced: 0, errores: 1 }
  }

  const journals = data?.journals || []
  if (!journals.length) {
    // No hay diarios disponibles — limpiamos la tabla para reflejar Odoo
    await query('DELETE FROM payment_journals')
    console.log('[SYNC_JOURNALS] No hay diarios disponibles en Odoo (tabla vaciada)')
    return { synced: 0 }
  }

  // UPSERT cada uno
  for (const j of journals) {
    await query(
      `INSERT INTO payment_journals
         (id, company_id, company_name, name, code, type, currency_code, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE SET
         company_id    = EXCLUDED.company_id,
         company_name  = EXCLUDED.company_name,
         name          = EXCLUDED.name,
         code          = EXCLUDED.code,
         type          = EXCLUDED.type,
         currency_code = EXCLUDED.currency_code,
         updated_at    = NOW()`,
      [
        j.id,
        j.company_id,
        j.company_name || null,
        j.name,
        j.code || null,
        j.type || null,
        j.currency_code || null,
      ]
    )
  }

  // Limpiar diarios que ya no están en Odoo (archivados o eliminados)
  const liveIds = journals.map((j) => j.id)
  await query(
    `DELETE FROM payment_journals WHERE id != ALL($1::int[])`,
    [liveIds]
  )

  console.log(`[SYNC_JOURNALS] ${journals.length} diario(s) actualizados`)
  return { synced: journals.length }
}

module.exports = { syncPaymentJournals }
