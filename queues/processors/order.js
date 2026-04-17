const { query } = require('../../db')

// Umbral de diferencia de precio aceptable (5%)
const PRICE_TOLERANCE = 0.05

async function processOrder(job, odooPost) {
  const { payload, clientUuid } = job.data
  const { vendedor_id, cliente_odoo_id, lines, visita_uuid, company_id } = payload

  // ── Validación de precios (price book local — no toca Odoo) ──────
  const conflictos = []
  let pricelistAssignment = null

  if (company_id) {
    const assignmentResult = await query(
      `SELECT pricelist_id, pricelist_name, currency_code
         FROM cliente_empresa_pricelist
        WHERE cliente_odoo_id = $1 AND company_id = $2`,
      [cliente_odoo_id, company_id]
    )
    pricelistAssignment = assignmentResult.rows[0] || null
  }

  if (!pricelistAssignment) {
    conflictos.push({
      tipo: 'missing_pricelist',
      cliente_odoo_id,
      company_id: company_id || null,
      detalle: 'No existe lista de precio sincronizada para este cliente y empresa',
    })
  }

  for (const line of lines) {
    if (!pricelistAssignment) continue

    const priceRow = await query(
      `SELECT price
         FROM pricelist_prices
        WHERE company_id = $1
          AND pricelist_id = $2
          AND product_id = $3`,
      [company_id, pricelistAssignment.pricelist_id, line.product_id]
    )

    if (!priceRow.rows.length) {
      conflictos.push({
        tipo: 'missing_price',
        product_id: line.product_id,
        pricelist_id: pricelistAssignment.pricelist_id,
        detalle: 'Producto sin precio sincronizado en la lista activa',
      })
      continue
    }

    const precioActual = parseFloat(priceRow.rows[0].price || 0)
    const precioVendedor = parseFloat(line.price_unit)

    if (precioActual <= 0) {
      if (precioVendedor !== 0) {
        conflictos.push({
          tipo: 'price_mismatch',
          product_id: line.product_id,
          precio_vendedor: precioVendedor,
          precio_actual: precioActual,
          diferencia_pct: '100.0',
          currency_code: pricelistAssignment.currency_code || null,
        })
      }
      continue
    }

    const diferencia = Math.abs(precioActual - precioVendedor) / precioActual

    if (diferencia > PRICE_TOLERANCE) {
      conflictos.push({
        tipo: 'price_mismatch',
        product_id: line.product_id,
        precio_vendedor: precioVendedor,
        precio_actual: precioActual,
        diferencia_pct: (diferencia * 100).toFixed(1),
        pricelist_id: pricelistAssignment.pricelist_id,
        currency_code: pricelistAssignment.currency_code || null,
      })
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
    company_id:        company_id || null,
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
