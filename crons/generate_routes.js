const { query } = require('../db')

// ─────────────────────────────────────────
// Cron: generación de rutas diarias
// Frecuencia: 4:00AM (día nuevo) y 10:00AM (actualización)
//
// Lógica:
//   4:00AM — genera rutas completas del día con todos los clientes asignados
//   10:00AM — agrega paradas nuevas SOLO si la ruta aún no fue iniciada
//             (estado = 'pendiente'). Si ya está 'en_curso' o 'completada',
//             no se toca — no se interrumpe al vendedor en campo.
//
// Requisito previo: sync_vendors + sync_clients ya corrieron
//   (tablas vendedores, clientes y vendedor_cliente_rel pobladas)
// ─────────────────────────────────────────

async function generateRoutes() {
  const hoy = new Date().toISOString().split('T')[0]
  console.log(`[GEN_ROUTES] Generando rutas para ${hoy}...`)

  const vendedores = await query(
    'SELECT id, uuid, nombre FROM vendedores WHERE activo = true'
  )

  if (!vendedores.rows.length) {
    console.log('[GEN_ROUTES] No hay vendedores activos')
    return { generadas: 0, actualizadas: 0 }
  }

  let generadas  = 0
  let actualizadas = 0
  let sinClientes  = 0

  for (const vendedor of vendedores.rows) {
    // Clientes asignados a este vendedor, ordenados por nombre
    // TODO: reemplazar orden por optimización geográfica cuando haya lat/lng suficiente
    const clientesResult = await query(
      `SELECT vcr.cliente_odoo_id, c.nombre, c.lat, c.lng
       FROM vendedor_cliente_rel vcr
       JOIN clientes c ON c.odoo_id = vcr.cliente_odoo_id
       WHERE vcr.vendedor_id = $1
       ORDER BY c.nombre ASC`,
      [vendedor.id]
    )

    if (!clientesResult.rows.length) {
      sinClientes++
      continue
    }

    const clientes = clientesResult.rows

    // ¿Ya existe una ruta para hoy?
    const rutaExistente = await query(
      'SELECT id, estado FROM rutas WHERE vendedor_id = $1 AND fecha = $2',
      [vendedor.id, hoy]
    )

    if (rutaExistente.rows.length) {
      const ruta = rutaExistente.rows[0]

      // No tocar rutas ya iniciadas o completadas
      if (ruta.estado !== 'pendiente') {
        console.log(`[GEN_ROUTES] Ruta de ${vendedor.nombre} en estado '${ruta.estado}' — no se modifica`)
        continue
      }

      // Agregar solo clientes que no están ya en la ruta
      const paradasActuales = await query(
        'SELECT cliente_id FROM paradas WHERE ruta_id = $1',
        [ruta.id]
      )
      const clientesEnRuta = new Set(paradasActuales.rows.map(p => p.cliente_id))

      const clientesNuevos = clientes.filter(c => !clientesEnRuta.has(c.cliente_odoo_id))

      if (clientesNuevos.length) {
        const maxOrdenResult = await query(
          'SELECT COALESCE(MAX(orden), 0) AS max FROM paradas WHERE ruta_id = $1',
          [ruta.id]
        )
        let orden = maxOrdenResult.rows[0].max + 1

        for (const cliente of clientesNuevos) {
          await query(
            `INSERT INTO paradas (ruta_id, cliente_id, orden, lat, lng)
             VALUES ($1, $2, $3, $4, $5)`,
            [ruta.id, cliente.cliente_odoo_id, orden++,
             cliente.lat || null, cliente.lng || null]
          )
        }

        console.log(`[GEN_ROUTES] ${clientesNuevos.length} parada(s) nueva(s) → ${vendedor.nombre}`)
        actualizadas++
      }

    } else {
      // Crear ruta nueva para hoy
      const rutaResult = await query(
        `INSERT INTO rutas (vendedor_id, fecha, estado)
         VALUES ($1, $2, 'pendiente')
         RETURNING id`,
        [vendedor.id, hoy]
      )
      const rutaId = rutaResult.rows[0].id

      let orden = 1
      for (const cliente of clientes) {
        await query(
          `INSERT INTO paradas (ruta_id, cliente_id, orden, lat, lng)
           VALUES ($1, $2, $3, $4, $5)`,
          [rutaId, cliente.cliente_odoo_id, orden++,
           cliente.lat || null, cliente.lng || null]
        )
      }

      console.log(`[GEN_ROUTES] ✅ ${vendedor.nombre} — ${clientes.length} parada(s)`)
      generadas++
    }
  }

  console.log(
    `[GEN_ROUTES] Completado — generadas: ${generadas}, ` +
    `actualizadas: ${actualizadas}, sin clientes: ${sinClientes}`
  )
  return { generadas, actualizadas, sinClientes }
}

module.exports = { generateRoutes }
