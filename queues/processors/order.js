const { query, redis } = require('../../db')

// Umbral de diferencia de precio aceptable (5%)
const PRICE_TOLERANCE = 0.05

async function processOrder(job, odooPost) {
  const { payload, clientUuid } = job.data
  const { vendedor_id, cliente_odoo_id, lines, visita_uuid } = payload

  // ── Validación de precios (Redis — no toca Odoo) ──────
  const conflictos = []

  for (const line of lines) {
    const cachedRaw = await redis.hget('prices', String(line.product_id))
    if (cachedRaw) {
      const precioActual    = parseFloat(cachedRaw)
      const precioVendedor  = parseFloat(line.price_unit)
      const diferencia      = Math.abs(precioActual - precioVendedor) / precioActual

      if (diferencia > PRICE_TOLERANCE) {
        conflictos.push({
          product_id:    line.product_id,
          precio_vendedor: precioVendedor,
          precio_actual:   precioActual,
          diferencia_pct:  (diferencia * 100).toFixed(1)
        })
      }
    }
  }

  if (conflictos.length > 0) {
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

  // ── Resolver vendor_nexus_uuid (PostgreSQL — no toca Odoo) ──
  const vendorRow = await query(
    'SELECT uuid FROM vendedores WHERE id = $1',
    [vendedor_id]
  )
  const vendorNexusUuid = vendorRow.rows[0]?.uuid || null

  // ── Crear pedido vía módulo nexus_mobile ──────────────
  // El módulo confirma el pedido internamente — no llamar action_confirm.
  // La respuesta ya trae order_id y name — no llamar odoo read.
  const result = await odooPost('/nexus/api/v1/create_order', {
    client_uuid:       clientUuid,
    cliente_odoo_id,
    visita_uuid:       visita_uuid || null,
    vendor_nexus_uuid: vendorNexusUuid,
    lines: lines.map(l => ({
      product_id: l.product_id,
      qty:        l.qty,
      price_unit: l.price_unit,
      name:       l.name || ''
    }))
  })

  const orderId   = result.order_id
  const orderName = result.name

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
    (vendorNexusUuid ? ` — vendor: ${vendorNexusUuid.slice(0, 8)}…` : '')
  )
  return { status: 'DONE', odoo_order_id: orderId, odoo_order_name: orderName }
}

module.exports = { processOrder }
