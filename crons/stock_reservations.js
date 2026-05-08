const { pool, query } = require('../db')

// ─────────────────────────────────────────
// Sistema de reservas anti-overselling.
//
// Cada ORDER_CREATED, antes de enviarse a Odoo, valida stock y crea reservas
// 'pending'. Cuando el worker termina con Odoo, las reservas se mueven a
// 'confirmed' (Odoo aceptó) o 'failed' (rechazó / liberar stock).
//
// Si el worker se cae a mitad de camino, un cron de barrido (expireOldReservations)
// libera las reservas pending de más de 30min para que no bloqueen stock.
// ─────────────────────────────────────────

// Tiempo máximo que una reserva puede quedar 'pending' antes de expirar
const RESERVATION_EXPIRATION_MINUTES = 30

/**
 * Valida disponibilidad y crea reservas en una transacción atómica.
 *
 * Estrategia anti-race: SELECT FOR UPDATE sobre stock_levels bloquea las
 * filas hasta el COMMIT, así dos pedidos concurrentes para el mismo producto
 * se serializan — el segundo solo arranca cuando el primero terminó.
 *
 * @param {Object} params
 * @param {string} params.orderUuid     client_uuid del ORDER_CREATED
 * @param {number} params.vendorId      vendedores.id
 * @param {number} params.warehouseId   stock.warehouse.id
 * @param {Array}  params.lines         [{ product_id, qty }]
 *
 * @returns {Promise<{ok: true}|{ok: false, items: Array}>}
 */
async function validateAndReserve({ orderUuid, vendorId, warehouseId, lines }) {
  if (!Array.isArray(lines) || !lines.length) {
    return { ok: false, items: [], error: 'no_lines' }
  }

  const productIds = lines.map((l) => parseInt(l.product_id, 10))
  const requested = new Map() // product_id → qty solicitada
  for (const line of lines) {
    const pid = parseInt(line.product_id, 10)
    const qty = parseFloat(line.qty)
    requested.set(pid, (requested.get(pid) || 0) + qty)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lock + lectura de stock + reservas pending de los productos afectados
    const stockResult = await client.query(
      `SELECT product_id, quantity
         FROM stock_levels
        WHERE warehouse_id = $1 AND product_id = ANY($2::int[])
        FOR UPDATE`,
      [warehouseId, productIds]
    )
    const stockByProduct = new Map()
    for (const row of stockResult.rows) {
      stockByProduct.set(row.product_id, parseFloat(row.quantity))
    }

    const pendingResult = await client.query(
      `SELECT product_id, COALESCE(SUM(quantity), 0) AS reserved
         FROM reservations
        WHERE warehouse_id = $1
          AND status = 'pending'
          AND product_id = ANY($2::int[])
        GROUP BY product_id`,
      [warehouseId, productIds]
    )
    const reservedByProduct = new Map()
    for (const row of pendingResult.rows) {
      reservedByProduct.set(row.product_id, parseFloat(row.reserved))
    }

    // Calcular disponible y comparar
    const insufficient = []
    for (const [productId, requestedQty] of requested.entries()) {
      const stock = stockByProduct.get(productId) || 0
      const reserved = reservedByProduct.get(productId) || 0
      const available = stock - reserved
      if (available < requestedQty) {
        insufficient.push({
          product_id: productId,
          available,
          requested: requestedQty,
        })
      }
    }

    if (insufficient.length > 0) {
      await client.query('ROLLBACK')
      return { ok: false, items: insufficient }
    }

    // Crear las reservas en lote
    const placeholders = []
    const values = []
    let p = 1
    for (const [productId, qty] of requested.entries()) {
      placeholders.push(
        `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, 'pending', NOW())`
      )
      values.push(productId, warehouseId, vendorId, orderUuid, qty)
      p += 5
    }

    await client.query(
      `INSERT INTO reservations
         (product_id, warehouse_id, vendor_id, order_uuid, quantity, status, created_at)
       VALUES ${placeholders.join(',')}`,
      values
    )

    await client.query('COMMIT')
    return { ok: true }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Marca como 'confirmed' las reservas pending de un pedido.
 * Llamar después de que Odoo aceptó el sale.order.
 */
async function confirmReservations(orderUuid) {
  const result = await query(
    `UPDATE reservations
        SET status = 'confirmed', resolved_at = NOW()
      WHERE order_uuid = $1 AND status = 'pending'`,
    [orderUuid]
  )
  return result.rowCount
}

/**
 * Marca como 'failed' las reservas pending — libera el stock comprometido.
 * Llamar cuando Odoo rechaza el pedido o el worker no puede procesarlo.
 */
async function failReservations(orderUuid, errorMsg = null) {
  const result = await query(
    `UPDATE reservations
        SET status = 'failed', resolved_at = NOW()
      WHERE order_uuid = $1 AND status = 'pending'`,
    [orderUuid]
  )
  if (errorMsg) {
    console.warn(`[RESERVATIONS] ${orderUuid} → failed (${errorMsg})`)
  }
  return result.rowCount
}

/**
 * Cron: marca como 'expired' las reservas pending viejas.
 * Sin esto, una reserva fantasma (worker crasheado, p.ej.) bloquearía
 * stock para siempre.
 */
async function expireOldReservations() {
  const result = await query(
    `UPDATE reservations
        SET status = 'expired', resolved_at = NOW()
      WHERE status = 'pending'
        AND created_at < NOW() - ($1 || ' minutes')::INTERVAL`,
    [RESERVATION_EXPIRATION_MINUTES.toString()]
  )
  if (result.rowCount > 0) {
    console.log(`[RESERVATIONS] ${result.rowCount} reserva(s) expirada(s)`)
  }
  return result.rowCount
}

module.exports = {
  validateAndReserve,
  confirmReservations,
  failReservations,
  expireOldReservations,
}
