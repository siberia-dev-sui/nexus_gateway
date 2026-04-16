const { query } = require('../../db')

async function processVisit(job, odooCall) {
  const { tipo, payload, clientUuid } = job.data
  const {
    cliente_odoo_id,
    checkin_lat,
    checkin_lng,
    checkin_at,
    checkout_at,
    notas
  } = payload

  // VISIT_CHECKIN: la visita ya fue insertada en sync/push con estado 'abierta'
  // Solo marcar como DONE en outbox — Odoo se actualiza al VISIT_CLOSED
  if (tipo === 'VISIT_CHECKIN') {
    await query(
      `UPDATE outbox SET estado = 'DONE', odoo_ref = 'local', updated_at = NOW() WHERE client_uuid = $1`,
      [clientUuid]
    )
    console.log(`[VISIT] ✅ CHECKIN ${clientUuid} registrado localmente`)
    return { status: 'DONE', local_only: true }
  }

  // ── Resolver UUID del vendedor ────────────────────────
  // outbox.vendedor_id → vendedores.uuid (= nexus.vendor.nexus_uuid en Odoo)
  const vendorRow = await query(
    `SELECT v.uuid AS vendor_uuid
     FROM outbox o
     JOIN vendedores v ON v.id = o.vendedor_id
     WHERE o.client_uuid = $1`,
    [clientUuid]
  )
  const vendorUuid = vendorRow.rows[0]?.vendor_uuid || null

  // ── Crear visita en Odoo ──────────────────────────────
  // Para VISIT_CLOSED desde /api/v1/visits: payload.visita_uuid identifica la visita
  // Para VISIT_CLOSED desde sync/push offline: clientUuid es el UUID de la visita (fallback)
  const targetVisitaUuid = payload.visita_uuid || clientUuid
  const checkoutAt = payload.checkout_at || checkout_at

  // Leer datos del checkin desde PostgreSQL para completar el field.visit en Odoo
  const visitaRow = await query(
    `SELECT cliente_odoo_id, checkin_lat, checkin_lng, checkin_at FROM visitas WHERE uuid = $1`,
    [targetVisitaUuid]
  )
  const visitaData = visitaRow.rows[0] || {}

  let odooVisitId = null
  try {
    const visitOdoo = {
      partner_id:        visitaData.cliente_odoo_id || cliente_odoo_id,
      checkin_lat:       visitaData.checkin_lat     || checkin_lat,
      checkin_lng:       visitaData.checkin_lng     || checkin_lng,
      checkin_datetime:  visitaData.checkin_at      || checkin_at,
      checkout_datetime: checkoutAt,
      notes:             notas || '',
      nexus_uuid:        targetVisitaUuid           // idempotencia en Odoo
    }

    if (vendorUuid) {
      visitOdoo.vendor_uuid = vendorUuid
    }

    odooVisitId = await odooCall('field.visit', 'create', [visitOdoo])
  } catch (err) {
    // field.visit puede no existir aún — seguimos, solo guardamos en PostgreSQL
    console.warn(`[VISIT] No se pudo crear en Odoo: ${err.message}`)
  }

  // ── Actualizar PostgreSQL ─────────────────────────────
  await query(
    `UPDATE visitas SET estado = 'cerrada', checkout_at = $1, notas = $2 WHERE uuid = $3`,
    [checkoutAt || null, notas || null, targetVisitaUuid]
  )
  await query(
    `UPDATE outbox
     SET estado = 'DONE', odoo_ref = $1, updated_at = NOW()
     WHERE client_uuid = $2`,
    [odooVisitId ? String(odooVisitId) : 'local', clientUuid]
  )

  console.log(
    `[VISIT] ✅ ${targetVisitaUuid} cerrada` +
    (odooVisitId ? ` → Odoo field.visit ID: ${odooVisitId}` : ' (local only)') +
    (vendorUuid  ? ` — vendedor: ${vendorUuid.slice(0, 8)}…` : '')
  )

  return { status: 'DONE', odoo_visit_id: odooVisitId }
}

module.exports = { processVisit }
