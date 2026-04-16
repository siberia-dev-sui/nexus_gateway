const { query } = require('../../db')

async function processVisit(job, odooPost) {
  const { tipo, payload, clientUuid } = job.data
  const {
    cliente_odoo_id,
    checkin_lat,
    checkin_lng,
    checkin_at,
    notas
  } = payload

  // ── Resolver vendor_nexus_uuid (PostgreSQL — no toca Odoo) ──
  const vendorRow = await query(
    `SELECT v.uuid AS vendor_uuid
     FROM outbox o
     JOIN vendedores v ON v.id = o.vendedor_id
     WHERE o.client_uuid = $1`,
    [clientUuid]
  )
  const vendorNexusUuid = vendorRow.rows[0]?.vendor_uuid || null

  // ── VISIT_CHECKIN ─────────────────────────────────────
  if (tipo === 'VISIT_CHECKIN') {
    const ts = checkin_at || new Date().toISOString()

    let odooVisitId = null
    try {
      const result = await odooPost('/nexus/api/v1/create_visit', {
        nexus_uuid:        clientUuid,
        tipo:              'checkin',
        cliente_odoo_id,
        vendor_nexus_uuid: vendorNexusUuid,
        checkin_at:        ts,
        checkin_lat:       checkin_lat || null,
        checkin_lng:       checkin_lng || null
      })
      odooVisitId = result.visit_id
    } catch (err) {
      // El módulo puede no tener la visita aún — no bloqueamos
      console.warn(`[VISIT] No se pudo registrar checkin en Odoo: ${err.message}`)
    }

    await query(
      `UPDATE outbox SET estado = 'DONE', odoo_ref = $1, updated_at = NOW()
       WHERE client_uuid = $2`,
      [odooVisitId ? String(odooVisitId) : 'local', clientUuid]
    )

    console.log(`[VISIT] ✅ CHECKIN ${clientUuid}` +
      (odooVisitId ? ` → Odoo visit ID: ${odooVisitId}` : ' (local only)'))
    return { status: 'DONE', odoo_visit_id: odooVisitId }
  }

  // ── VISIT_CLOSED ──────────────────────────────────────
  // payload.visita_uuid = nexus_uuid del checkin (el mismo que se envió al módulo en CHECKIN)
  // clientUuid = UUID del evento checkout (idempotencia del outbox)
  const targetVisitaUuid = payload.visita_uuid || clientUuid
  const checkoutAt = payload.checkout_at || null

  // Leer datos del checkin desde PostgreSQL para completar la visita en Odoo
  const visitaRow = await query(
    `SELECT cliente_odoo_id, checkin_lat, checkin_lng, checkin_at FROM visitas WHERE uuid = $1`,
    [targetVisitaUuid]
  )
  const visitaData = visitaRow.rows[0] || {}

  let odooVisitId = null
  try {
    const result = await odooPost('/nexus/api/v1/create_visit', {
      nexus_uuid:        targetVisitaUuid,
      tipo:              'VISIT_CLOSED',
      cliente_odoo_id:   visitaData.cliente_odoo_id || cliente_odoo_id,
      vendor_nexus_uuid: vendorNexusUuid,
      checkin_at:        visitaData.checkin_at || checkin_at || null,
      checkin_lat:       visitaData.checkin_lat || checkin_lat || null,
      checkin_lng:       visitaData.checkin_lng || checkin_lng || null,
      checkout_at:       checkoutAt,
      notas:             notas || null
    })
    odooVisitId = result.visit_id
  } catch (err) {
    console.warn(`[VISIT] No se pudo cerrar visita en Odoo: ${err.message}`)
  }

  // ── Actualizar PostgreSQL ─────────────────────────────
  await query(
    `UPDATE visitas SET estado = 'cerrada', checkout_at = $1, notas = $2 WHERE uuid = $3`,
    [checkoutAt || null, notas || null, targetVisitaUuid]
  )
  await query(
    `UPDATE outbox SET estado = 'DONE', odoo_ref = $1, updated_at = NOW()
     WHERE client_uuid = $2`,
    [odooVisitId ? String(odooVisitId) : 'local', clientUuid]
  )

  console.log(
    `[VISIT] ✅ ${targetVisitaUuid} cerrada` +
    (odooVisitId ? ` → Odoo visit ID: ${odooVisitId}` : ' (local only)') +
    (vendorNexusUuid ? ` — vendedor: ${vendorNexusUuid.slice(0, 8)}…` : '')
  )
  return { status: 'DONE', odoo_visit_id: odooVisitId }
}

module.exports = { processVisit }
