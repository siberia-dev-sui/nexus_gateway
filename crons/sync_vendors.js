const bcrypt = require('bcrypt')
const { query } = require('../db')

// ─────────────────────────────────────────
// Cron: sync vendedores desde Odoo → PostgreSQL
// Frecuencia: cada 1 hora
//
// Odoo (nexus.vendor) es la fuente de verdad de los vendedores.
// El link entre ambas tablas es:
//   vendedores.uuid  ←→  nexus.vendor.nexus_uuid
//
// Flujo:
//   1. Admin crea el vendedor en Odoo → nexus_uuid y nexus_password se autogeneran
//   2. Este cron lo replica a PostgreSQL usando la contraseña de Odoo (hasheada aquí)
//   3. El vendedor inicia sesión en la app con email + esa contraseña
// ─────────────────────────────────────────

async function syncVendors(odooCall) {
  console.log('[SYNC_VENDORS] Iniciando sync desde nexus.vendor en Odoo...')

  let vendors = []

  try {
    vendors = await odooCall(
      'nexus.vendor',
      'search_read',
      [[['active', '=', true]]],
      { fields: ['id', 'nexus_uuid', 'name', 'email', 'phone', 'zone', 'nexus_password', 'image_url'], limit: 500 }
    )
  } catch (err) {
    console.error('[SYNC_VENDORS] Error al leer nexus.vendor desde Odoo:', err.message)
    console.error('[SYNC_VENDORS] ¿Está instalado el módulo nexus_mobile en Odoo y tiene el modelo nexus.vendor?')
    return { creados: 0, actualizados: 0, desactivados: 0, errores: 1 }
  }

  if (!vendors.length) {
    console.log('[SYNC_VENDORS] No se encontraron vendedores activos en Odoo')
    return { creados: 0, actualizados: 0, desactivados: 0 }
  }

  console.log(`[SYNC_VENDORS] ${vendors.length} vendedor(es) encontrados en Odoo`)

  let creados = 0
  let actualizados = 0

  for (const v of vendors) {
    // nexus_uuid es obligatorio — si falta, el vendedor no puede sincronizarse
    if (!v.nexus_uuid) {
      console.warn(`[SYNC_VENDORS] Vendedor ID=${v.id} (${v.name}) sin nexus_uuid — omitido`)
      continue
    }

    if (!v.email) {
      console.warn(`[SYNC_VENDORS] Vendedor ${v.name} sin email — omitido`)
      continue
    }

    if (!v.nexus_password) {
      console.warn(`[SYNC_VENDORS] Vendedor ${v.name} sin nexus_password — omitido`)
      continue
    }

    const email = v.email.toLowerCase().trim()
    const zona  = v.zone || null

    // Buscar por uuid (vínculo principal) o por email como fallback
    const imageUrl = v.image_url || null

    const existing = await query(
      `SELECT id, nombre, email, zona, imagen_url, activo
       FROM vendedores
       WHERE uuid = $1 OR email = $2
       LIMIT 1`,
      [v.nexus_uuid, email]
    )

    if (existing.rows.length) {
      const row = existing.rows[0]
      const cambios = (
        row.nombre     !== v.name   ||
        row.email      !== email    ||
        row.zona       !== zona     ||
        row.imagen_url !== imageUrl ||
        !row.activo
      )

      if (cambios) {
        await query(
          `UPDATE vendedores
           SET nombre = $1, email = $2, zona = $3, activo = true,
               uuid = $4, odoo_vendor_id = $5, imagen_url = $6
           WHERE id = $7`,
          [v.name, email, zona, v.nexus_uuid, v.id, imageUrl, row.id]
        )
        console.log(`[SYNC_VENDORS] Actualizado: ${v.name} (${email})`)
        actualizados++
      }
    } else {
      // Vendedor nuevo — hashear la contraseña que viene de Odoo
      const hash = await bcrypt.hash(v.nexus_password, 10)

      await query(
        `INSERT INTO vendedores (uuid, odoo_vendor_id, nombre, email, password_hash, zona, imagen_url, activo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [v.nexus_uuid, v.id, v.name, email, hash, zona, imageUrl]
      )

      console.log(`[SYNC_VENDORS] Creado: ${v.name} (${email}) — contraseña generada en Odoo`)
      creados++
    }
  }

  // Desactivar vendedores que ya no están activos en Odoo
  const activeUuids = vendors
    .filter(v => v.nexus_uuid)
    .map(v => v.nexus_uuid)

  if (activeUuids.length) {
    const result = await query(
      `UPDATE vendedores
       SET activo = false
       WHERE uuid IS NOT NULL
         AND uuid != ALL($1::uuid[])
         AND activo = true
       RETURNING nombre, email`,
      [activeUuids]
    )
    if (result.rows.length) {
      result.rows.forEach(row => {
        console.log(`[SYNC_VENDORS] Desactivado: ${row.nombre} (${row.email}) — ya no está en Odoo`)
      })
      return { creados, actualizados, desactivados: result.rows.length }
    }
  }

  console.log(`[SYNC_VENDORS] Completado — creados: ${creados}, actualizados: ${actualizados}`)
  return { creados, actualizados, desactivados: 0 }
}

module.exports = { syncVendors }
