const { query, redis } = require('../../db')

// Umbral de diferencia de precio aceptable (5%)
const PRICE_TOLERANCE = 0.05

async function processOrder(job, odooCall) {
  const { payload, clientUuid } = job.data
  const { vendedor_id, cliente_odoo_id, lines, notas } = payload

  // ── Validación de precios ─────────────────────────────
  const conflictos = []

  for (const line of lines) {
    const cachedRaw = await redis.hget('prices', String(line.product_id))
    if (cachedRaw) {
      const precioActual = parseFloat(cachedRaw)
      const precioVendedor = parseFloat(line.price_unit)
      const diferencia = Math.abs(precioActual - precioVendedor) / precioActual

      if (diferencia > PRICE_TOLERANCE) {
        conflictos.push({
          product_id: line.product_id,
          precio_vendedor: precioVendedor,
          precio_actual: precioActual,
          diferencia_pct: (diferencia * 100).toFixed(1)
        })
      }
    }
  }

  if (conflictos.length > 0) {
    // Marcar para revisión — NO enviar a Odoo
    await query(
      `UPDATE pedidos SET estado = 'PENDING_REVIEW', precio_conflicto = $1, updated_at = NOW()
       WHERE client_uuid = $2`,
      [JSON.stringify(conflictos), clientUuid]
    )
    await query(
      `UPDATE outbox SET estado = 'PENDING_REVIEW', updated_at = NOW() WHERE client_uuid = $1`,
      [clientUuid]
    )
    console.log(`[ORDER] Conflicto de precios en ${clientUuid}:`, conflictos)
    return { status: 'PENDING_REVIEW', conflictos }
  }

  // ── Resolver nexus_vendor_id y nexus_visit_id ────────
  // Necesarios para trazabilidad en Odoo: qué vendedor y qué visita generaron el pedido.

  let nexusVendorId = null
  if (vendedor_id) {
    const vendRow = await query(
      'SELECT odoo_vendor_id FROM vendedores WHERE id = $1',
      [vendedor_id]
    )
    nexusVendorId = vendRow.rows[0]?.odoo_vendor_id || null
  }

  let nexusVisitId = null
  if (payload.visita_uuid) {
    try {
      const visitIds = await odooCall('field.visit', 'search',
        [[['nexus_uuid', '=', payload.visita_uuid]]])
      nexusVisitId = visitIds[0] || null
    } catch (err) {
      // field.visit puede no existir aún en staging — no bloqueamos el pedido
      console.warn(`[ORDER] No se pudo resolver field.visit para ${payload.visita_uuid}: ${err.message}`)
    }
  }

  // ── Crear pedido en Odoo ──────────────────────────────
  const orderLines = lines.map(l => [0, 0, {
    product_id: l.product_id,
    product_uom_qty: l.qty,
    price_unit: l.price_unit,
    name: l.name || ''
  }])

  const saleOrderPayload = {
    partner_id: cliente_odoo_id,
    order_line: orderLines,
    note: notas || '',
    client_order_ref: clientUuid,
    nexus_sync_state: 'synced'
  }

  if (nexusVendorId) saleOrderPayload.nexus_vendor_id = nexusVendorId
  if (nexusVisitId)  saleOrderPayload.nexus_visit_id  = nexusVisitId

  const orderId = await odooCall('sale.order', 'create', [saleOrderPayload])

  // Confirmar el pedido
  await odooCall('sale.order', 'action_confirm', [[orderId]])

  // Obtener nombre del pedido (S00123)
  const orderData = await odooCall('sale.order', 'read', [[orderId]], {
    fields: ['name', 'amount_total']
  })
  const orderName = orderData[0]?.name

  // ── Actualizar PostgreSQL ─────────────────────────────
  await query(
    `UPDATE pedidos
     SET odoo_order_id = $1, odoo_order_name = $2, estado = 'confirmado', updated_at = NOW()
     WHERE client_uuid = $3`,
    [orderId, orderName, clientUuid]
  )
  await query(
    `UPDATE outbox SET estado = 'DONE', odoo_ref = $1, updated_at = NOW()
     WHERE client_uuid = $2`,
    [String(orderId), clientUuid]
  )

  console.log(
    `[ORDER] ✅ ${clientUuid} → Odoo ${orderName} (ID: ${orderId})` +
    (nexusVendorId ? ` — vendor: ${nexusVendorId}` : '') +
    (nexusVisitId  ? ` — visit: ${nexusVisitId}`  : '')
  )
  return { status: 'DONE', odoo_order_id: orderId, odoo_order_name: orderName }
}

module.exports = { processOrder }
