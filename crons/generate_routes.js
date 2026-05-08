const { query, redis } = require('../db')
const axios = require('axios').create({ proxy: false })

// ─────────────────────────────────────────
// Cron: generación de rutas diarias optimizadas
// Frecuencia: 4:00AM (día nuevo) y 10:00AM (actualización)
//
// Algoritmo (dos capas, offline-first):
//   Capa 1 — Nearest Neighbor greedy (siempre disponible, sin red)
//            O(n²), <5ms para ≤40 clientes, reduce ~35% distancia vs orden alfabético
//   Capa 2 — OSRM Trip (si hay red, timeout 4s → fallback silencioso a capa 1)
//            Usa distancias reales por calles, mejora otro ~20% sobre NN
//
// Punto de inicio: última posición GPS del vendedor (Redis) o primer cliente con coords
// ─────────────────────────────────────────

const OSRM_URL    = 'http://router.project-osrm.org'
const OSRM_TIMEOUT = 4000  // ms — si tarda más, usa NN y sigue

// ── Utilidades geométricas ─────────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  return 2 * R * Math.asin(Math.sqrt(
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  ))
}

function totalDistanceKm(startLat, startLng, clients) {
  let dist = 0
  let lat  = startLat
  let lng  = startLng
  for (const c of clients) {
    if (c.lat != null && c.lng != null) {
      dist += haversineKm(lat, lng, parseFloat(c.lat), parseFloat(c.lng))
      lat = parseFloat(c.lat)
      lng = parseFloat(c.lng)
    }
  }
  return Math.round(dist * 10) / 10
}

// ── Capa 1: Nearest Neighbor ───────────────────────────────────────────────
// Siempre disponible, sin red. O(n²), suficiente para ≤40 paradas.
// Clientes sin coords van al final (no se pueden optimizar).

function nearestNeighbor(startLat, startLng, clients) {
  const withCoords    = clients.filter(c => c.lat != null && c.lng != null)
  const withoutCoords = clients.filter(c => c.lat == null || c.lng == null)

  if (!withCoords.length) return clients

  const unvisited = [...withCoords]
  const ordered   = []
  let curLat = startLat
  let curLng = startLng

  while (unvisited.length) {
    let bestIdx  = 0
    let bestDist = Infinity
    for (let i = 0; i < unvisited.length; i++) {
      const d = haversineKm(curLat, curLng, parseFloat(unvisited[i].lat), parseFloat(unvisited[i].lng))
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    const next = unvisited.splice(bestIdx, 1)[0]
    ordered.push(next)
    curLat = parseFloat(next.lat)
    curLng = parseFloat(next.lng)
  }

  return [...ordered, ...withoutCoords]
}

// ── Capa 2: OSRM Trip ──────────────────────────────────────────────────────
// Optimización usando calles reales. Timeout 4s → null si falla.
// OSRM Trip API: /trip/v1/driving/{coords}?roundtrip=false&source=first
//   - coords[0]  = origen del vendedor
//   - coords[1…] = clientes con lat/lng
//   - waypoints[i].waypoint_index = posición en el trip optimizado

async function osrmOptimize(startLat, startLng, clients) {
  const withCoords    = clients.filter(c => c.lat != null && c.lng != null)
  const withoutCoords = clients.filter(c => c.lat == null || c.lng == null)

  if (withCoords.length < 2) return null   // nada que optimizar

  const coords = [
    `${startLng},${startLat}`,
    ...withCoords.map(c => `${parseFloat(c.lng)},${parseFloat(c.lat)}`),
  ].join(';')

  const url = `${OSRM_URL}/trip/v1/driving/${coords}` +
              `?roundtrip=false&source=first&destination=last`

  const res = await axios.get(url, { timeout: OSRM_TIMEOUT })
  if (res.data.code !== 'Ok' || !Array.isArray(res.data.waypoints)) return null

  // waypoints tiene una entrada por coordenada de entrada.
  // waypoints[0] = origen vendedor → lo descartamos.
  // waypoints[i+1].waypoint_index = posición en el trip para withCoords[i].
  const clientWaypoints = res.data.waypoints.slice(1)  // quitar origen
  if (clientWaypoints.length !== withCoords.length) return null

  const sorted = clientWaypoints
    .map((wp, i) => ({ ...withCoords[i], _tripOrder: wp.waypoint_index }))
    .sort((a, b) => a._tripOrder - b._tripOrder)
    .map(({ _tripOrder, ...c }) => c)

  return [...sorted, ...withoutCoords]
}

// ── Posición de inicio del vendedor ────────────────────────────────────────

async function getVendorStartPosition(vendedorId) {
  try {
    const raw = await redis.get(`location:${vendedorId}`)
    if (!raw) return null
    const loc = JSON.parse(raw)
    if (loc.lat && loc.lng) return { lat: parseFloat(loc.lat), lng: parseFloat(loc.lng) }
  } catch (_) {}
  return null
}

// ── Generador principal ────────────────────────────────────────────────────

async function generateRoutes() {
  const hoy = new Date().toISOString().split('T')[0]
  console.log(`[GEN_ROUTES] Generando rutas para ${hoy}...`)

  const vendedores = await query(
    'SELECT id, uuid, nombre FROM vendedores WHERE activo = true'
  )

  if (!vendedores.rows.length) {
    console.log('[GEN_ROUTES] No hay vendedores activos')
    return { generadas: 0, actualizadas: 0, sinClientes: 0 }
  }

  let generadas  = 0
  let actualizadas = 0
  let sinClientes  = 0

  for (const vendedor of vendedores.rows) {
    // Todos los clientes asignados (sin orden — el algoritmo decide)
    const clientesResult = await query(
      `SELECT vcr.cliente_odoo_id, c.nombre, c.lat, c.lng
         FROM vendedor_cliente_rel vcr
         JOIN clientes c ON c.odoo_id = vcr.cliente_odoo_id
        WHERE vcr.vendedor_id = $1`,
      [vendedor.id]
    )

    if (!clientesResult.rows.length) {
      sinClientes++
      continue
    }

    const clientes = clientesResult.rows

    // Punto de inicio: última GPS del vendedor o primer cliente con coords
    const gpsStart       = await getVendorStartPosition(vendedor.id)
    const firstWithCoords = clientes.find(c => c.lat && c.lng)
    const origen = gpsStart
      || (firstWithCoords
          ? { lat: parseFloat(firstWithCoords.lat), lng: parseFloat(firstWithCoords.lng) }
          : null)

    // ── Optimizar orden ──────────────────────────────────────────────────
    let ordenados = clientes
    let algoritmo = 'nombre'

    if (origen) {
      // Capa 1: Nearest Neighbor (offline, siempre)
      ordenados = nearestNeighbor(origen.lat, origen.lng, clientes)
      algoritmo = 'nn'

      // Capa 2: OSRM (online, fallback silencioso)
      try {
        const osrmResult = await osrmOptimize(origen.lat, origen.lng, clientes)
        if (osrmResult) {
          ordenados = osrmResult
          algoritmo = 'osrm'
        }
      } catch (err) {
        console.log(`[GEN_ROUTES] OSRM no disponible (${vendedor.nombre}): ${err.message} — usando NN`)
      }
    }

    const distKm = origen ? totalDistanceKm(origen.lat, origen.lng, ordenados) : null

    console.log(
      `[GEN_ROUTES] ${vendedor.nombre} — algoritmo: ${algoritmo}` +
      (distKm != null ? `, distancia estimada: ${distKm} km` : '')
    )

    // ── Persistir ────────────────────────────────────────────────────────
    const rutaExistente = await query(
      'SELECT id, estado FROM rutas WHERE vendedor_id = $1 AND fecha = $2',
      [vendedor.id, hoy]
    )

    if (rutaExistente.rows.length) {
      const ruta = rutaExistente.rows[0]

      if (ruta.estado !== 'pendiente') {
        console.log(`[GEN_ROUTES] Ruta de ${vendedor.nombre} en estado '${ruta.estado}' — no se modifica`)
        continue
      }

      // Agregar solo clientes nuevos (parada ya existente = skip)
      const paradasActuales = await query(
        'SELECT cliente_id FROM paradas WHERE ruta_id = $1',
        [ruta.id]
      )
      const clientesEnRuta = new Set(paradasActuales.rows.map(p => p.cliente_id))
      const clientesNuevos = ordenados.filter(c => !clientesEnRuta.has(c.cliente_odoo_id))

      if (clientesNuevos.length) {
        const maxOrdenResult = await query(
          'SELECT COALESCE(MAX(orden), 0) AS max FROM paradas WHERE ruta_id = $1',
          [ruta.id]
        )
        let orden = maxOrdenResult.rows[0].max + 1
        for (const c of clientesNuevos) {
          await query(
            `INSERT INTO paradas (ruta_id, cliente_id, orden, lat, lng)
             VALUES ($1, $2, $3, $4, $5)`,
            [ruta.id, c.cliente_odoo_id, orden++, c.lat || null, c.lng || null]
          )
        }
        await query(
          `UPDATE rutas
              SET algoritmo = $1, distancia_estimada_km = $2,
                  origen_lat = $3, origen_lng = $4
            WHERE id = $5`,
          [algoritmo, distKm, origen?.lat ?? null, origen?.lng ?? null, ruta.id]
        )
        console.log(`[GEN_ROUTES] ${clientesNuevos.length} parada(s) nueva(s) → ${vendedor.nombre}`)
        actualizadas++
      }

    } else {
      // Ruta nueva del día
      const rutaResult = await query(
        `INSERT INTO rutas
           (vendedor_id, fecha, estado, algoritmo, distancia_estimada_km, origen_lat, origen_lng)
         VALUES ($1, $2, 'pendiente', $3, $4, $5, $6)
         RETURNING id`,
        [vendedor.id, hoy, algoritmo, distKm, origen?.lat ?? null, origen?.lng ?? null]
      )
      const rutaId = rutaResult.rows[0].id

      let orden = 1
      for (const c of ordenados) {
        await query(
          `INSERT INTO paradas (ruta_id, cliente_id, orden, lat, lng)
           VALUES ($1, $2, $3, $4, $5)`,
          [rutaId, c.cliente_odoo_id, orden++, c.lat || null, c.lng || null]
        )
      }
      console.log(`[GEN_ROUTES] ✅ ${vendedor.nombre} — ${clientes.length} parada(s), ${algoritmo}, ~${distKm ?? '?'} km`)
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
