const { query } = require('../../db')

async function processPayment(job, odooPost) {
  const { payload, clientUuid } = job.data
  const { cliente_odoo_id, monto, metodo, visita_uuid } = payload

  // ── Resolver vendor_nexus_uuid (PostgreSQL — no toca Odoo) ──
  const vendorRow = await query(
    `SELECT v.uuid AS vendor_uuid
     FROM outbox o
     JOIN vendedores v ON v.id = o.vendedor_id
     WHERE o.client_uuid = $1`,
    [clientUuid]
  )
  const vendorNexusUuid = vendorRow.rows[0]?.vendor_uuid || null

  // ── Crear pago vía módulo nexus_mobile ────────────────
  // El módulo valida el journal y llama action_post internamente.
  const result = await odooPost('/nexus/api/v1/create_payment', {
    client_uuid:       clientUuid,
    cliente_odoo_id,
    visita_uuid:       visita_uuid || null,
    vendor_nexus_uuid: vendorNexusUuid,
    monto,
    metodo
  })

  const paymentId = result.payment_id

  // ── Actualizar PostgreSQL ─────────────────────────────
  await query(
    `UPDATE pagos SET odoo_payment_id = $1, updated_at = NOW() WHERE client_uuid = $2`,
    [paymentId, clientUuid]
  )
  await query(
    `UPDATE outbox SET estado = 'DONE', odoo_ref = $1, updated_at = NOW()
     WHERE client_uuid = $2`,
    [String(paymentId), clientUuid]
  )

  console.log(`[PAYMENT] ✅ ${clientUuid} → Odoo payment ID: ${paymentId} ($${monto})`)
  return { status: 'DONE', odoo_payment_id: paymentId }
}

module.exports = { processPayment }
