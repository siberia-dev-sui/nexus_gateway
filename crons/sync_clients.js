const { query } = require('../db')

async function upsertClient(client) {
  await query(
    `INSERT INTO clientes (odoo_id, nombre, rif, telefono, direccion, lat, lng,
                           bloqueado, credito_restringido, motivo_bloqueo, canal, last_sync)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (odoo_id) DO UPDATE SET
       nombre              = EXCLUDED.nombre,
       rif                 = EXCLUDED.rif,
       telefono            = EXCLUDED.telefono,
       direccion           = EXCLUDED.direccion,
       lat                 = EXCLUDED.lat,
       lng                 = EXCLUDED.lng,
       bloqueado           = EXCLUDED.bloqueado,
       credito_restringido = EXCLUDED.credito_restringido,
       motivo_bloqueo      = EXCLUDED.motivo_bloqueo,
       canal               = EXCLUDED.canal,
       last_sync           = NOW()`,
    [
      client.odoo_id,
      client.nombre,
      client.rif || null,
      client.telefono || null,
      client.direccion || null,
      client.lat || null,
      client.lng || null,
      client.bloqueado || false,
      client.credito_restringido || false,
      client.motivo_bloqueo || null,
      client.canal || null,
    ]
  )
}

async function replaceClientCompanyPricelists(client) {
  await query(
    'DELETE FROM cliente_empresa_pricelist WHERE cliente_odoo_id = $1',
    [client.odoo_id]
  )

  let assignments = 0
  for (const entry of (client.company_pricelists || [])) {
    await query(
      `INSERT INTO cliente_empresa_pricelist (
         cliente_odoo_id, company_id, pricelist_id, pricelist_name, currency_code, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (cliente_odoo_id, company_id) DO UPDATE SET
         pricelist_id   = EXCLUDED.pricelist_id,
         pricelist_name = EXCLUDED.pricelist_name,
         currency_code  = EXCLUDED.currency_code,
         updated_at     = NOW()`,
      [
        client.odoo_id,
        entry.company_id,
        entry.pricelist_id,
        entry.pricelist_name || `Pricelist ${entry.pricelist_id}`,
        entry.currency_code || null,
      ]
    )
    assignments++
  }

  return assignments
}

async function resolveVendorId(vendor, overrides = new Map()) {
  if (overrides.has(vendor.nexus_uuid)) {
    return overrides.get(vendor.nexus_uuid)
  }

  const vendRow = await query(
    'SELECT id FROM vendedores WHERE uuid = $1',
    [vendor.nexus_uuid]
  )
  return vendRow.rows[0]?.id || null
}

async function syncVendorPayload(vendors, options = {}) {
  const vendorOverrides = options.vendorOverrides || new Map()
  const syncedClientIds = new Set()
  let clientesSynced = 0
  let relaciones = 0
  let pricelistAssignments = 0

  for (const vendor of vendors) {
    const clients = vendor.clients || []
    for (const client of clients) {
      if (syncedClientIds.has(client.odoo_id)) continue

      await upsertClient(client)
      pricelistAssignments += await replaceClientCompanyPricelists(client)
      syncedClientIds.add(client.odoo_id)
      clientesSynced++
    }
  }

  for (const vendor of vendors) {
    const vendedorId = await resolveVendorId(vendor, vendorOverrides)
    if (!vendedorId) {
      console.warn(`[SYNC_CLIENTS] Vendedor uuid=${vendor.nexus_uuid} no está en PostgreSQL — ¿corrió sync_vendors?`)
      continue
    }

    const clientIdsOdoo = (vendor.clients || []).map((client) => client.odoo_id)

    for (const odooId of clientIdsOdoo) {
      await query(
        `INSERT INTO vendedor_cliente_rel (vendedor_id, cliente_odoo_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [vendedorId, odooId]
      )
      relaciones++
    }

    if (clientIdsOdoo.length) {
      await query(
        `DELETE FROM vendedor_cliente_rel
         WHERE vendedor_id = $1
           AND cliente_odoo_id != ALL($2::int[])`,
        [vendedorId, clientIdsOdoo]
      )
    } else {
      await query(
        'DELETE FROM vendedor_cliente_rel WHERE vendedor_id = $1',
        [vendedorId]
      )
    }
  }

  await query(
    `DELETE FROM cliente_empresa_pricelist cep
      WHERE NOT EXISTS (
        SELECT 1
          FROM vendedor_cliente_rel vcr
         WHERE vcr.cliente_odoo_id = cep.cliente_odoo_id
      )`
  )

  return {
    clientes: clientesSynced,
    relaciones,
    pricelist_assignments: pricelistAssignments,
  }
}

async function syncClients(odooPost) {
  console.log('[SYNC_CLIENTS] Iniciando sync desde módulo nexus_mobile...')

  let data
  try {
    data = await odooPost('/nexus/api/v1/all_vendor_clients', {})
  } catch (err) {
    console.error('[SYNC_CLIENTS] Error al llamar /all_vendor_clients:', err.message)
    return { clientes: 0, relaciones: 0, pricelist_assignments: 0, errores: 1 }
  }

  const vendors = data?.vendors || []
  if (!vendors.length) {
    console.log('[SYNC_CLIENTS] No hay vendedores activos con clientes en Odoo')
    return { clientes: 0, relaciones: 0, pricelist_assignments: 0 }
  }

  const totalClientes = vendors.reduce((acc, vendor) => acc + (vendor.clients?.length || 0), 0)
  console.log(`[SYNC_CLIENTS] ${vendors.length} vendedor(es), ${totalClientes} cliente(s)`) 

  const result = await syncVendorPayload(vendors)
  console.log(`[SYNC_CLIENTS] ${result.clientes} cliente(s) sincronizados en tabla clientes`)
  console.log(`[SYNC_CLIENTS] ${result.relaciones} relación(es) vendedor-cliente activas`)
  console.log(`[SYNC_CLIENTS] ${result.pricelist_assignments} asignación(es) cliente-empresa-lista activas`)
  console.log('[SYNC_CLIENTS] Completado')
  return result
}

async function syncVendorClients(odooPost, { vendedorId, nexusUuid }) {
  console.log(`[SYNC_CLIENTS] Iniciando sync manual para vendedor ${nexusUuid}...`)

  let data
  try {
    data = await odooPost('/nexus/api/v1/vendor_clients', { nexus_uuid: nexusUuid })
  } catch (err) {
    console.error('[SYNC_CLIENTS] Error al llamar /vendor_clients:', err.message)
    return { clientes: 0, relaciones: 0, pricelist_assignments: 0, errores: 1 }
  }

  const vendor = {
    nexus_uuid: nexusUuid,
    clients: data?.clients || [],
  }
  const result = await syncVendorPayload([vendor], {
    vendorOverrides: new Map([[nexusUuid, vendedorId]]),
  })
  console.log(`[SYNC_CLIENTS] Sync manual completado para ${nexusUuid}`)
  return result
}

module.exports = { syncClients, syncVendorClients }
