const { query } = require('../../db')

async function processPayment(job, odooCall) {
  const { payload, clientUuid } = job.data
  const { cliente_odoo_id, monto, metodo, referencia } = payload

  // Método de pago → journal de Odoo
  const JOURNAL_MAP = {
    efectivo:      'cash',
    transferencia: 'bank',
    cheque:        'bank'
  }
  const paymentMethod = JOURNAL_MAP[metodo] || 'cash'

  // Buscar journal en Odoo
  const journals = await odooCall('account.journal', 'search_read',
    [[['type', '=', paymentMethod]]],
    { fields: ['id', 'name'], limit: 1 }
  )
  if (!journals.length) throw new Error(`No journal encontrado para método: ${metodo}`)
  const journalId = journals[0].id

  // Crear pago en Odoo
  const paymentId = await odooCall('account.payment', 'create', [{
    partner_id: cliente_odoo_id,
    amount: monto,
    journal_id: journalId,
    payment_type: 'inbound',
    partner_type: 'customer',
    ref: referencia || clientUuid,
    memo: `NEXUS - ${clientUuid}`
  }])

  // Confirmar el pago (action_post)
  await odooCall('account.payment', 'action_post', [[paymentId]])

  // Actualizar PostgreSQL
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
