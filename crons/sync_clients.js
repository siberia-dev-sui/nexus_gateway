const { query } = require('../db')

// ─────────────────────────────────────────
// Cron: sync clientes desde módulo nexus_mobile → PostgreSQL
// Frecuencia: al arrancar + cada 6 horas
//
// Usa el endpoint batch /nexus/api/v1/all_vendor_clients del módulo,
// que devuelve todos los vendedores con sus clientes en una sola llamada.
// Esto reemplaza las llamadas directas al ORM de Odoo (odooCall) que
// acoplaban el gateway a los modelos internos de Odoo.
//
// Flujo:
//   1. Una llamada al módulo → todos los vendedores con sus clientes
//   2. Upsert de cada cliente en tabla clientes
//   3. Upsert de relaciones en vendedor_cliente_rel
//   4. Elimina relaciones que ya no existen en Odoo
// ─────────────────────────────────────────

async function syncClients(odooPost) {
  console.log('[SYNC_CLIENTS] Iniciando sync desde módulo nexus_mobile...')

  // ── Una sola llamada al módulo ────────────────────────────
  let data
  try {
    data = await odooPost('/nexus/api/v1/all_vendor_clients', {})
  } catch (err) {
    console.error('[SYNC_CLIENTS] Error al llamar /all_vendor_clients:', err.message)
    return { clientes: 0, relaciones: 0, errores: 1 }
  }

  const vendors = data?.vendors || []

  if (!vendors.length) {
    console.log('[SYNC_CLIENTS] No hay vendedores activos con clientes en Odoo')
    return { clientes: 0, relaciones: 0 }
  }

  const totalClientes = vendors.reduce((acc, v) => acc + (v.clients?.length || 0), 0)
  console.log(`[SYNC_CLIENTS] ${vendors.length} vendedor(es), ${totalClientes} cliente(s) únicos`)

  // ── Upsert de todos los clientes únicos ───────────────────
  // Usamos un Map para evitar upserts duplicados si un cliente
  // está asignado a más de un vendedor.
  const clientesSyncedIds = new Set()
  let clientesSynced = 0

  for (const vendor of vendors) {
    for (const c of (vendor.clients || [])) {
      if (clientesSyncedIds.has(c.odoo_id)) continue

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
          c.odoo_id, c.nombre, c.rif || null, c.telefono || null,
          c.direccion || null, c.lat || null, c.lng || null,
          c.bloqueado || false, c.credito_restringido || false,
          c.motivo_bloqueo || null, c.canal || null,
        ]
      )

      clientesSyncedIds.add(c.odoo_id)
      clientesSynced++
    }
  }

  console.log(`[SYNC_CLIENTS] ${clientesSynced} cliente(s) sincronizados en tabla clientes`)

  // ── Upsert de relaciones vendedor → cliente ───────────────
  let relaciones = 0

  for (const vendor of vendors) {
    const vendRow = await query(
      'SELECT id FROM vendedores WHERE uuid = $1',
      [vendor.nexus_uuid]
    )

    if (!vendRow.rows.length) {
      console.warn(`[SYNC_CLIENTS] Vendedor uuid=${vendor.nexus_uuid} no está en PostgreSQL — ¿corrió sync_vendors?`)
      continue
    }

    const vendedorId      = vendRow.rows[0].id
    const clientIdsOdoo   = (vendor.clients || []).map(c => c.odoo_id)

    // Insertar relaciones nuevas
    for (const odooId of clientIdsOdoo) {
      await query(
        `INSERT INTO vendedor_cliente_rel (vendedor_id, cliente_odoo_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [vendedorId, odooId]
      )
      relaciones++
    }

    // Eliminar relaciones que ya no están en Odoo
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

  console.log(`[SYNC_CLIENTS] ${relaciones} relación(es) vendedor-cliente activas`)
  console.log('[SYNC_CLIENTS] Completado')
  return { clientes: clientesSynced, relaciones }
}

module.exports = { syncClients }
