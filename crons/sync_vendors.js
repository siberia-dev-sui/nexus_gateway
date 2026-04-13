const bcrypt = require('bcrypt')
const { query } = require('../db')

// ─────────────────────────────────────────
// Cron: sync vendedores desde Odoo → PostgreSQL
// Frecuencia: cada 1 hora
//
// Odoo es la fuente de verdad de los empleados.
// Este cron jala hr.employee donde es_vendedor_nexus = true
// y mantiene la tabla vendedores sincronizada.
//
// Lenn debe agregar en hr.employee:
//   - es_vendedor_nexus (Boolean)
//   - nexus_zona        (Char)
// ─────────────────────────────────────────

async function syncVendors(odooCall) {
  console.log('[SYNC_VENDORS] Iniciando sync desde Odoo...')

  let empleados = []

  try {
    // Intentar con campo es_vendedor_nexus (requiere modulo nexus_field de Lenn)
    empleados = await odooCall(
      'hr.employee',
      'search_read',
      [[['es_vendedor_nexus', '=', true], ['active', '=', true]]],
      { fields: ['id', 'name', 'work_email', 'nexus_zona'], limit: 200 }
    )
  } catch (err) {
    // Si el campo no existe aun, jalar todos los empleados activos como fallback
    console.warn('[SYNC_VENDORS] Campo es_vendedor_nexus no disponible en Odoo, usando fallback (todos los empleados activos)')
    empleados = await odooCall(
      'hr.employee',
      'search_read',
      [[['active', '=', true]]],
      { fields: ['id', 'name', 'work_email'], limit: 200 }
    )
  }

  if (!empleados.length) {
    console.log('[SYNC_VENDORS] No se encontraron empleados en Odoo')
    return { creados: 0, actualizados: 0, desactivados: 0 }
  }

  console.log(`[SYNC_VENDORS] ${empleados.length} empleados encontrados en Odoo`)

  let creados = 0
  let actualizados = 0

  for (const emp of empleados) {
    // Ignorar empleados sin email — no pueden iniciar sesion en la app
    if (!emp.work_email) {
      console.warn(`[SYNC_VENDORS] Empleado ${emp.id} (${emp.name}) sin work_email — omitido`)
      continue
    }

    const email = emp.work_email.toLowerCase().trim()
    const zona  = emp.nexus_zona || null

    // Buscar si ya existe por odoo_employee_id o por email
    const existing = await query(
      'SELECT id, nombre, email, zona, activo FROM vendedores WHERE odoo_employee_id = $1 OR email = $2',
      [emp.id, email]
    )

    if (existing.rows.length) {
      // Actualizar datos si cambiaron
      const v = existing.rows[0]
      const cambios = v.nombre !== emp.name || v.email !== email || v.zona !== zona || !v.activo

      if (cambios) {
        await query(
          `UPDATE vendedores
           SET nombre = $1, email = $2, zona = $3, activo = true,
               odoo_employee_id = $4
           WHERE id = $5`,
          [emp.name, email, zona, emp.id, v.id]
        )
        console.log(`[SYNC_VENDORS] Actualizado: ${emp.name} (${email})`)
        actualizados++
      }
    } else {
      // Vendedor nuevo — crear con password temporal
      const passwordTemporal = generarPassword()
      const hash = await bcrypt.hash(passwordTemporal, 10)

      await query(
        `INSERT INTO vendedores (nombre, email, password_hash, zona, odoo_employee_id, activo)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [emp.name, email, hash, zona, emp.id]
      )

      // Loguear la password temporal para que el admin la distribuya
      // TODO: reemplazar con envio por email/SMS cuando este disponible
      console.log(`[SYNC_VENDORS] Creado: ${emp.name} (${email}) — password temporal: ${passwordTemporal}`)
      creados++
    }
  }

  // Desactivar vendedores que ya no estan en Odoo como nexus_vendors
  // Solo si el campo es_vendedor_nexus existe (no en fallback)
  const odooIds = empleados.map(e => e.id)
  if (odooIds.length) {
    const desactivados = await query(
      `UPDATE vendedores
       SET activo = false
       WHERE odoo_employee_id IS NOT NULL
         AND odoo_employee_id != ALL($1::int[])
         AND activo = true
       RETURNING nombre, email`,
      [odooIds]
    )
    if (desactivados.rows.length) {
      desactivados.rows.forEach(v => {
        console.log(`[SYNC_VENDORS] Desactivado: ${v.nombre} (${v.email}) — ya no esta en Odoo`)
      })
      return { creados, actualizados, desactivados: desactivados.rows.length }
    }
  }

  console.log(`[SYNC_VENDORS] Completado — creados: ${creados}, actualizados: ${actualizados}`)
  return { creados, actualizados, desactivados: 0 }
}

// Password temporal: 8 caracteres, letras + numeros
function generarPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let pass = ''
  for (let i = 0; i < 8; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)]
  }
  return pass
}

module.exports = { syncVendors }
