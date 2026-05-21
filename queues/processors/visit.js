const { query } = require('../../db')
const { refreshSuggestionsFor } = require('../../crons/order_suggestions')

async function processVisit(job, odooPost) {
  const { tipo, payload, clientUuid } = job.data
  const {
    cliente_odoo_id,
    checkin_lat,
    checkin_lng,
    checkin_at,
    notas
  } = payload

  // ── Resolver vendor (uuid + id) desde PostgreSQL — no toca Odoo ──
  const vendorRow = await query(
    `SELECT v.id AS vendor_id, v.uuid AS vendor_uuid
     FROM outbox o
     JOIN vendedores v ON v.id = o.vendedor_id
     WHERE o.client_uuid = $1`,
    [clientUuid]
  )
  const vendorNexusUuid = vendorRow.rows[0]?.vendor_uuid || null
  const vendorId = vendorRow.rows[0]?.vendor_id || null

  if (tipo === 'VISIT_COMPLETED') {
    const result = await odooPost('/nexus/api/v1/create_visit', {
      nexus_uuid:        clientUuid,
      tipo:              'VISIT_COMPLETED',
      cliente_odoo_id,
      vendor_nexus_uuid: vendorNexusUuid,
      company_id:        payload.company_id || null,
      checkin_at:        checkin_at || null,
      checkin_lat:       checkin_lat || null,
      checkin_lng:       checkin_lng || null,
      checkout_at:       payload.checkout_at || null,
      checkout_lat:      payload.checkout_lat || null,
      checkout_lng:      payload.checkout_lng || null,
      notas:             notas || null,
      inventory_lines:   payload.inventory_lines || [],
      return_lines:      payload.return_lines || [],
      merch_tasks:       payload.merch_tasks || [],
      promotions:        payload.promotions || [],
      photos:            payload.photos || [],
      order_uuid:        payload.order_uuid || null,
    })

    await query(
      `UPDATE visitas
          SET estado = 'cerrada', checkout_at = $1, notas = $2
        WHERE uuid = $3`,
      [payload.checkout_at || null, notas || null, clientUuid]
    )
    await query(
      `UPDATE outbox SET tipo = 'VISIT_COMPLETED', estado = 'DONE', odoo_ref = $1, updated_at = NOW()
       WHERE client_uuid = $2`,
      [String(result.visit_id), clientUuid]
    )

    console.log(`[VISIT] ✅ COMPLETED ${clientUuid} → Odoo visit ID: ${result.visit_id}`)

    // Event-driven: refrescar las sugerencias de pedido para este par
    // (vendor, client) en el cache del gateway. No bloqueamos el worker
    // si esto falla — el cache eventualmente se actualizaría en la
    // próxima visita o via backfill.
    if (vendorNexusUuid && vendorId && cliente_odoo_id) {
      refreshSuggestionsFor(odooPost, vendorNexusUuid, cliente_odoo_id, vendorId)
        .catch((err) => console.warn(
          `[VISIT] No se pudo refrescar sugerencias post-VISIT_COMPLETED: ${err.message}`
        ))
    }

    return { status: 'DONE', odoo_visit_id: result.visit_id }
  }

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
