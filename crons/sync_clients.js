const { query } = require('../db')

// ─────────────────────────────────────────
// Cron: sync clientes desde Odoo → PostgreSQL
// Frecuencia: 3:50AM y 9:50AM (10 min antes de generate_routes)
//
// Requiere: módulo nexus_mobile instalado en Odoo
//
// Flujo:
//   1. Lee nexus.vendor con client_ids → sabe exactamente qué partners
//      son clientes de campo (no trae todo res.partner)
//   2. Lee esos res.partner específicos → upsert en clientes
//   3. Upsert vendedor_cliente_rel (la asignación)
//   4. Elimina asignaciones que ya no existen en Odoo
// ─────────────────────────────────────────

async function syncClients(odooCall) {
  console.log('[SYNC_CLIENTS] Iniciando sync desde nexus.vendor → res.partner...')

  // ── Paso 1: Leer vendedores con su cartera ────────────
  let vendors = []
  try {
    vendors = await odooCall(
      'nexus.vendor',
      'search_read',
      [[['active', '=', true]]],
      { fields: ['id', 'nexus_uuid', 'name', 'client_ids'], limit: 500 }
    )
  } catch (err) {
    console.error('[SYNC_CLIENTS] Error al leer nexus.vendor desde Odoo:', err.message)
    console.error('[SYNC_CLIENTS] ¿Está instalado el módulo nexus_mobile en Odoo?')
    return { clientes: 0, relaciones: 0, errores: 1 }
  }

  // Todos los partner IDs únicos asignados a algún vendedor
  const allClientIds = [...new Set(vendors.flatMap(v => v.client_ids || []))]

  if (!allClientIds.length) {
    console.log('[SYNC_CLIENTS] Ningún vendedor tiene clientes asignados en Odoo')
    return { clientes: 0, relaciones: 0 }
  }

  console.log(`[SYNC_CLIENTS] ${allClientIds.length} cliente(s) únicos en ${vendors.length} vendedor(es)`)

  // ── Paso 2: Leer datos de esos partners específicos ───
  let partners = []
  try {
    partners = await odooCall(
      'res.partner',
      'search_read',
      [[['id', 'in', allClientIds]]],
      {
        fields: [
          'id', 'name', 'vat', 'phone',
          'street', 'city',
          'partner_latitude', 'partner_longitude',
          'nexus_blocked', 'nexus_credit_restricted'
        ],
        limit: 5000
      }
    )
  } catch (err) {
    console.error('[SYNC_CLIENTS] Error al leer res.partner desde Odoo:', err.message)
    return { clientes: 0, relaciones: 0, errores: 1 }
  }

  // ── Paso 3: Upsert en tabla clientes ──────────────────
  let clientesSynced = 0
  const syncedPartnerIds = new Set()

  for (const p of partners) {
    const lat      = p.partner_latitude  || null
    const lng      = p.partner_longitude || null
    const dir      = [p.street, p.city].filter(Boolean).join(', ') || null
    const bloqueado = p.nexus_blocked || false

    await query(
      `INSERT INTO clientes (odoo_id, nombre, rif, telefono, direccion, lat, lng, bloqueado, last_sync)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (odoo_id) DO UPDATE SET
         nombre    = EXCLUDED.nombre,
         rif       = EXCLUDED.rif,
         telefono  = EXCLUDED.telefono,
         direccion = EXCLUDED.direccion,
         lat       = EXCLUDED.lat,
         lng       = EXCLUDED.lng,
         bloqueado = EXCLUDED.bloqueado,
         last_sync = NOW()`,
      [p.id, p.name, p.vat || null, p.phone || null, dir, lat, lng, bloqueado]
    )

    syncedPartnerIds.add(p.id)
    clientesSynced++
  }

  console.log(`[SYNC_CLIENTS] ${clientesSynced} cliente(s) en tabla clientes`)

  // ── Paso 4: Upsert vendedor_cliente_rel ───────────────
  let relaciones = 0

  for (const vendor of vendors) {
    if (!vendor.nexus_uuid || !vendor.client_ids?.length) continue

    // Buscar vendedor en PostgreSQL por uuid (= nexus.vendor.nexus_uuid)
    const vendRow = await query(
      'SELECT id FROM vendedores WHERE uuid = $1',
      [vendor.nexus_uuid]
    )

    if (!vendRow.rows.length) {
      console.warn(`[SYNC_CLIENTS] Vendedor ${vendor.name} no está en PostgreSQL — ¿corrió sync_vendors?`)
      continue
    }

    const vendedorId = vendRow.rows[0].id
    const clientIdsValidos = vendor.client_ids.filter(id => syncedPartnerIds.has(id))

    // Insertar relaciones nuevas
    for (const clientOdooId of clientIdsValidos) {
      await query(
        `INSERT INTO vendedor_cliente_rel (vendedor_id, cliente_odoo_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [vendedorId, clientOdooId]
      )
      relaciones++
    }

    // Eliminar asignaciones que ya no existen en Odoo
    if (clientIdsValidos.length) {
      await query(
        `DELETE FROM vendedor_cliente_rel
         WHERE vendedor_id = $1
           AND cliente_odoo_id != ALL($2::int[])`,
        [vendedorId, clientIdsValidos]
      )
    } else {
      // El vendedor perdió todos sus clientes
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
