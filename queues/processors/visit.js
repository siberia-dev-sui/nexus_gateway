const { query } = require('../../db')

async function processVisit(job, odooCall) {
  const { payload, clientUuid } = job.data
  const { cliente_odoo_id, checkin_lat, checkin_lng, checkin_at, checkout_at, notas } = payload

  // Intentar crear visita en Odoo si existe el modelo field.visit
  // (disponible cuando se instale el módulo nexus_field)
  let odooVisitId = null
  try {
    odooVisitId = await odooCall('field.visit', 'create', [{
      partner_id: cliente_odoo_id,
      checkin_lat,
      checkin_lng,
      checkin_datetime: checkin_at,
      checkout_datetime: checkout_at,
      notes: notas || '',
      nexus_uuid: clientUuid
    }])
  } catch {
    // field.visit no existe aún — OK, seguir sin Odoo
    console.log(`[VISIT] field.visit no disponible en Odoo — guardando solo en PostgreSQL`)
  }

  // Actualizar visita en PostgreSQL
  await query(
    `UPDATE visitas SET estado = 'cerrada' WHERE uuid = $1`,
    [clientUuid]
  )
  await query(
    `UPDATE outbox SET estado = 'DONE', odoo_ref = $1, updated_at = NOW()
     WHERE client_uuid = $2`,
    [odooVisitId ? String(odooVisitId) : 'local', clientUuid]
  )

  console.log(`[VISIT] ✅ ${clientUuid} cerrada${odooVisitId ? ` → Odoo ID: ${odooVisitId}` : ' (local)'}`)
  return { status: 'DONE', odoo_visit_id: odooVisitId }
}

module.exports = { processVisit }
