const bcrypt = require('bcrypt')
const { query } = require('../db')

// ─────────────────────────────────────────
// Cron: sync vendedores desde módulo nexus_mobile → PostgreSQL
// Frecuencia: al arrancar + cada 1 hora
//
// El módulo es la fuente de verdad de los vendedores (nexus.vendor en Odoo).
// Endpoint: POST /nexus/api/v1/get_vendors → { vendors: [...] }
// Campos disponibles: nexus_uuid, nombre, email, telefono, activo, odoo_id
//
// Nota sobre contraseñas: el módulo no expone nexus_password por seguridad.
// - Vendedores existentes: se actualiza el perfil, la contraseña no cambia.
// - Vendedores nuevos: se omiten (no se puede crear sin contraseña).
//   → Lenn debe exponer un endpoint de onboarding o añadir nexus_password al módulo.
// ─────────────────────────────────────────

async function syncVendors(odooPost) {
  console.log('[SYNC_VENDORS] Iniciando sync desde módulo nexus_mobile...')

  let vendors = []

  try {
    const data = await odooPost('/nexus/api/v1/get_vendors', {})
    vendors = data?.vendors || []
  } catch (err) {
    console.error('[SYNC_VENDORS] Error al llamar /get_vendors:', err.message)
    return { creados: 0, actualizados: 0, desactivados: 0, errores: 1 }
  }

  // Filtrar solo los activos para el upsert
  const activos = vendors.filter(v => v.activo !== false)

  if (!activos.length) {
    console.log('[SYNC_VENDORS] No hay vendedores activos en Odoo')
    return { creados: 0, actualizados: 0, desactivados: 0 }
  }

  console.log(`[SYNC_VENDORS] ${activos.length} vendedor(es) encontrados en Odoo`)

  let creados = 0
  let actualizados = 0

  for (const v of activos) {
    if (!v.nexus_uuid) {
      console.warn(`[SYNC_VENDORS] Vendedor odoo_id=${v.odoo_id} (${v.nombre}) sin nexus_uuid — omitido`)
      continue
    }
    if (!v.email) {
      console.warn(`[SYNC_VENDORS] Vendedor ${v.nombre} sin email — omitido`)
      continue
    }

    const email = v.email.toLowerCase().trim()

    const existing = await query(
      `SELECT id, nombre, email, activo
       FROM vendedores
       WHERE uuid = $1 OR email = $2
       LIMIT 1`,
      [v.nexus_uuid, email]
    )

    if (existing.rows.length) {
      // Actualizar perfil — sin tocar password_hash (módulo no lo expone)
      await query(
        `UPDATE vendedores
         SET nombre = $1, email = $2, activo = true,
             uuid = $3, odoo_vendor_id = $4
         WHERE id = $5`,
        [v.nombre, email, v.nexus_uuid, v.odoo_id, existing.rows[0].id]
      )

      if (
        existing.rows[0].nombre !== v.nombre ||
        existing.rows[0].email  !== email    ||
        !existing.rows[0].activo
      ) {
        console.log(`[SYNC_VENDORS] Actualizado: ${v.nombre} (${email})`)
        actualizados++
      }
    } else {
      // Vendedor nuevo sin contraseña — no se puede crear hasta que el módulo exponga nexus_password
      console.warn(
        `[SYNC_VENDORS] Vendedor nuevo detectado: ${v.nombre} (${email}) — ` +
        'omitido: el módulo no expone nexus_password. ' +
        'Lenn debe añadir nexus_password al endpoint /get_vendors o crear un endpoint de onboarding.'
      )
    }
  }

  // Desactivar en PostgreSQL los que ya no están activos en Odoo
  const activeUuids = activos
    .filter(v => v.nexus_uuid)
    .map(v => v.nexus_uuid)

  let desactivados = 0
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
      result.rows.forEach(row =>
        console.log(`[SYNC_VENDORS] Desactivado: ${row.nombre} (${row.email}) — ya no está en Odoo`)
      )
      desactivados = result.rows.length
    }
  }

  console.log(`[SYNC_VENDORS] Completado — creados: ${creados}, actualizados: ${actualizados}, desactivados: ${desactivados}`)
  return { creados, actualizados, desactivados }
}

module.exports = { syncVendors }
