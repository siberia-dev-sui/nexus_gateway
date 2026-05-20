const { query } = require('../db')

const DEFAULT_LIMIT = 100

async function upsertOrder(vendorUuid, order) {
  await query(
    `INSERT INTO vendor_orders_cache (
       vendor_uuid, order_id, order_name, state, partner_id, partner_name,
       partner_vat, date_order, write_date, amount_total, currency_code,
       client_order_ref, payload, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (vendor_uuid, order_id) DO UPDATE SET
       order_name       = EXCLUDED.order_name,
       state            = EXCLUDED.state,
       partner_id       = EXCLUDED.partner_id,
       partner_name     = EXCLUDED.partner_name,
       partner_vat      = EXCLUDED.partner_vat,
       date_order       = EXCLUDED.date_order,
       write_date       = EXCLUDED.write_date,
       amount_total     = EXCLUDED.amount_total,
       currency_code    = EXCLUDED.currency_code,
       client_order_ref = EXCLUDED.client_order_ref,
       payload          = EXCLUDED.payload,
       updated_at       = NOW()`,
    [
      vendorUuid,
      order.id,
      order.name || null,
      order.state || null,
      order.partner_id || null,
      order.partner_name || null,
      order.partner_vat || null,
      order.date_order || null,
      order.write_date || null,
      order.amount_total || 0,
      order.currency || null,
      order.client_order_ref || null,
      JSON.stringify(order),
    ]
  )
}

async function syncVendorOrders(odooPost, options = {}) {
  const tag = '[SYNC_VENDOR_ORDERS]'
  let vendors = []

  if (options.vendor_uuid) {
    vendors = [{ uuid: String(options.vendor_uuid) }]
  } else {
    const result = await query('SELECT uuid FROM vendedores WHERE activo = true AND uuid IS NOT NULL ORDER BY id')
    vendors = result.rows
  }

  let synced = 0
  let vendorsSynced = 0

  for (const vendor of vendors) {
    const vendorUuid = String(vendor.uuid)
    let data
    try {
      data = await odooPost('/nexus/api/v1/vendor_orders', {
        vendor_nexus_uuid: vendorUuid,
        limit: DEFAULT_LIMIT,
        offset: 0,
      })
    } catch (err) {
      console.error(`${tag} Error vendor=${vendorUuid}:`, err.message)
      continue
    }

    const orders = data?.orders || []
    for (const order of orders) {
      await upsertOrder(vendorUuid, order)
      synced++
    }

    const orderIds = orders.map((order) => Number(order.id)).filter(Boolean)
    if (orderIds.length) {
      await query(
        'DELETE FROM vendor_orders_cache WHERE vendor_uuid = $1 AND order_id != ALL($2::int[])',
        [vendorUuid, orderIds]
      )
    } else {
      await query('DELETE FROM vendor_orders_cache WHERE vendor_uuid = $1', [vendorUuid])
    }
    vendorsSynced++
  }

  console.log(`${tag} ${synced} pedido(s), ${vendorsSynced} vendedor(es) sincronizados`)
  return { synced, vendors: vendorsSynced }
}

module.exports = { syncVendorOrders }
