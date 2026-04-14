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
  // field.visit acepta vendor_uuid y lo resuelve a vendor_id internamente
  let odooVisitId = null
  try {
    const visitData = {
      partner_id:        cliente_odoo_id,
      checkin_lat:       checkin_lat,
      checkin_lng:       checkin_lng,
      checkin_datetime:  checkin_at,
      checkout_datetime: checkout_at,
      notes:             notas || '',
      nexus_uuid:        clientUuid
    }

    // Pasar vendor_uuid si está disponible — Odoo lo resuelve al nexus.vendor correcto
    if (vendorUuid) {
      visitData.vendor_uuid = vendorUuid
    }

    odooVisitId = await odooCall('field.visit', 'create', [visitData])
  } catch (err) {
    // field.visit puede no existir aún o tener un error transitorio
    // En ese caso guardamos solo en PostgreSQL y seguimos
    console.warn(`[VISIT] No se pudo crear en Odoo: ${err.message}`)
  }

  // ── Actualizar PostgreSQL ─────────────────────────────
  // visitas.uuid fue seteado con client_uuid en sync/push (VISIT_CHECKIN)
  await query(
    `UPDATE visitas SET estado = 'cerrada', checkout_at = $1, notas = $2 WHERE uuid = $3`,
    [checkout_at || null, notas || null, clientUuid]
  )
  await query(
    `UPDATE outbox
     SET estado = 'DONE', odoo_ref = $1, updated_at = NOW()
     WHERE client_uuid = $2`,
    [odooVisitId ? String(odooVisitId) : 'local', clientUuid]
  )

  console.log(
    `[VISIT] ✅ ${clientUuid} cerrada` +
    (odooVisitId ? ` → Odoo field.visit ID: ${odooVisitId}` : ' (local only)') +
    (vendorUuid  ? ` — vendedor: ${vendorUuid.slice(0, 8)}…` : '')
  )

  return { status: 'DONE', odoo_visit_id: odooVisitId }
}

module.exports = { processVisit }
