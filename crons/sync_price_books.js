const { query } = require('../db')

function chunk(items, size) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function enqueuePriceSync(pricelistId, companyId, source = 'odoo', force = true) {
  if (!pricelistId || !companyId) return

  if (!force) {
    await query(
      `INSERT INTO pricelist_sync_queue (pricelist_id, company_id, source, status, dirty, requested_at)
       VALUES ($1, $2, $3, 'PENDING', false, NOW())
       ON CONFLICT (pricelist_id, company_id) DO NOTHING`,
      [pricelistId, companyId, source]
    )
    return
  }

  await query(
    `INSERT INTO pricelist_sync_queue (pricelist_id, company_id, source, status, dirty, requested_at, last_error)
     VALUES ($1, $2, $3, 'PENDING', false, NOW(), NULL)
     ON CONFLICT (pricelist_id, company_id) DO UPDATE SET
       source       = EXCLUDED.source,
       requested_at = NOW(),
       last_error   = NULL,
       status       = CASE
                        WHEN pricelist_sync_queue.status = 'PROCESSING' THEN 'PROCESSING'
                        ELSE 'PENDING'
                      END,
       dirty        = CASE
                        WHEN pricelist_sync_queue.status = 'PROCESSING' THEN true
                        ELSE false
                      END`,
    [pricelistId, companyId, source]
  )
}

async function seedPriceSyncQueueFromAssignments() {
  const result = await query(
    `INSERT INTO pricelist_sync_queue (pricelist_id, company_id, source, status, dirty, requested_at)
     SELECT DISTINCT cep.pricelist_id, cep.company_id, 'assignment', 'PENDING', false, NOW()
       FROM cliente_empresa_pricelist cep
     ON CONFLICT (pricelist_id, company_id) DO UPDATE SET
       status = CASE
                  WHEN pricelist_sync_queue.status = 'FAILED' THEN 'PENDING'
                  ELSE pricelist_sync_queue.status
                END,
       requested_at = CASE
                        WHEN pricelist_sync_queue.status = 'FAILED' THEN NOW()
                        ELSE pricelist_sync_queue.requested_at
                      END,
       last_error = CASE
                      WHEN pricelist_sync_queue.status = 'FAILED' THEN NULL
                      ELSE pricelist_sync_queue.last_error
                    END`
  )
  return result.rowCount || 0
}

async function syncPriceEvents(odooPost) {
  let data
  try {
    data = await odooPost('/nexus/api/v1/pricelist_sync_events', { limit: 200 })
  } catch (err) {
    console.error('[SYNC_PRICE_EVENTS] Error al llamar /pricelist_sync_events:', err.message)
    return { queued: 0, acknowledged: 0, errores: 1 }
  }

  const events = data?.events || []
  if (!events.length) {
    return { queued: 0, acknowledged: 0 }
  }

  for (const event of events) {
    await enqueuePriceSync(event.pricelist_id, event.company_id, event.reason || 'odoo_event', true)
  }

  try {
    await odooPost('/nexus/api/v1/pricelist_sync_ack', {
      event_ids: events.map((event) => event.event_id),
    })
  } catch (err) {
    console.error('[SYNC_PRICE_EVENTS] Error al hacer ack de eventos:', err.message)
    return { queued: events.length, acknowledged: 0, errores: 1 }
  }

  return { queued: events.length, acknowledged: events.length }
}

async function replacePricelistPrices(snapshot) {
  const pricelist = snapshot.pricelist || {}
  const companyId = pricelist.company_id
  const pricelistId = pricelist.id
  const pricelistName = pricelist.name || `Pricelist ${pricelistId}`
  const currencyCode = pricelist.currency_code || null
  const prices = snapshot.prices || []

  await query(
    'DELETE FROM pricelist_prices WHERE company_id = $1 AND pricelist_id = $2',
    [companyId, pricelistId]
  )

  for (const rows of chunk(prices, 500)) {
    const values = []
    const params = []
    let index = 1

    for (const row of rows) {
      values.push(`($${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5}, NOW())`)
      params.push(
        companyId,
        pricelistId,
        pricelistName,
        currencyCode,
        row.product_id,
        row.price ?? 0
      )
      index += 6
    }

    await query(
      `INSERT INTO pricelist_prices (
         company_id, pricelist_id, pricelist_name, currency_code, product_id, price, updated_at
       ) VALUES ${values.join(', ')}`,
      params
    )
  }

  return prices.length
}

async function markQueueStatus(pricelistId, companyId, status, lastError = null) {
  await query(
    `UPDATE pricelist_sync_queue
        SET status = $3,
            processed_at = NOW(),
            last_error = $4,
            dirty = CASE WHEN $3 = 'PENDING' THEN false ELSE dirty END
      WHERE pricelist_id = $1 AND company_id = $2`,
    [pricelistId, companyId, status, lastError]
  )
}

async function processPriceSyncQueue(odooPost, options = {}) {
  const limit = Math.max(1, Number(options.limit || 10))
  let processed = 0
  let synced = 0
  let skipped = 0
  let failed = 0

  while (processed < limit) {
    const next = await query(
      `SELECT pricelist_id, company_id
         FROM pricelist_sync_queue
        WHERE status = 'PENDING'
        ORDER BY requested_at ASC
        LIMIT 1`
    )

    if (!next.rows.length) break

    const job = next.rows[0]
    processed++

    await query(
      `UPDATE pricelist_sync_queue
          SET status = 'PROCESSING',
              dirty = false,
              last_error = NULL
        WHERE pricelist_id = $1 AND company_id = $2`,
      [job.pricelist_id, job.company_id]
    )

    try {
      const assignmentResult = await query(
        `SELECT COUNT(*)::int AS total
           FROM cliente_empresa_pricelist
          WHERE pricelist_id = $1 AND company_id = $2`,
        [job.pricelist_id, job.company_id]
      )
      const assignmentCount = assignmentResult.rows[0]?.total || 0

      if (!assignmentCount) {
        await query(
          'DELETE FROM pricelist_prices WHERE pricelist_id = $1 AND company_id = $2',
          [job.pricelist_id, job.company_id]
        )
        await markQueueStatus(job.pricelist_id, job.company_id, 'DONE')
        skipped++
        continue
      }

      const snapshot = await odooPost('/nexus/api/v1/pricelist_snapshot', {
        pricelist_id: job.pricelist_id,
        company_id: job.company_id,
      })

      if (snapshot?.error) {
        const msg = String(snapshot.error)
        if (msg.includes('no encontrados') || msg.includes('no encontrada')) {
          await query(
            'DELETE FROM pricelist_prices WHERE pricelist_id = $1 AND company_id = $2',
            [job.pricelist_id, job.company_id]
          )
          await markQueueStatus(job.pricelist_id, job.company_id, 'DONE')
          skipped++
          continue
        }
        throw new Error(msg)
      }

      await replacePricelistPrices(snapshot)

      const state = await query(
        'SELECT dirty FROM pricelist_sync_queue WHERE pricelist_id = $1 AND company_id = $2',
        [job.pricelist_id, job.company_id]
      )

      if (state.rows[0]?.dirty) {
        await query(
          `UPDATE pricelist_sync_queue
              SET status = 'PENDING',
                  dirty = false,
                  processed_at = NOW(),
                  last_error = NULL,
                  requested_at = NOW()
            WHERE pricelist_id = $1 AND company_id = $2`,
          [job.pricelist_id, job.company_id]
        )
      } else {
        await markQueueStatus(job.pricelist_id, job.company_id, 'DONE')
      }

      synced++
    } catch (err) {
      await markQueueStatus(job.pricelist_id, job.company_id, 'FAILED', err.message)
      failed++
    }
  }

  return { processed, synced, skipped, failed }
}

async function getVendorPriceBook(vendedorId) {
  const assignmentsResult = await query(
    `SELECT cep.cliente_odoo_id, cep.company_id, cep.pricelist_id,
            cep.pricelist_name, cep.currency_code, cep.updated_at
       FROM cliente_empresa_pricelist cep
       INNER JOIN vendedor_cliente_rel vcr ON vcr.cliente_odoo_id = cep.cliente_odoo_id
      WHERE vcr.vendedor_id = $1
      ORDER BY cep.cliente_odoo_id ASC, cep.company_id ASC`,
    [vendedorId]
  )

  const pricesResult = await query(
    `SELECT pp.company_id, pp.pricelist_id, pp.product_id, pp.price,
            pp.pricelist_name, pp.currency_code, pp.updated_at
       FROM pricelist_prices pp
       INNER JOIN (
         SELECT DISTINCT cep.company_id, cep.pricelist_id
           FROM cliente_empresa_pricelist cep
           INNER JOIN vendedor_cliente_rel vcr ON vcr.cliente_odoo_id = cep.cliente_odoo_id
          WHERE vcr.vendedor_id = $1
       ) used
         ON used.company_id = pp.company_id
        AND used.pricelist_id = pp.pricelist_id
      ORDER BY pp.company_id ASC, pp.pricelist_id ASC, pp.product_id ASC`,
    [vendedorId]
  )

  const assignments = assignmentsResult.rows.map((row) => ({
    cliente_odoo_id: row.cliente_odoo_id,
    company_id: row.company_id,
    pricelist_id: row.pricelist_id,
    pricelist_name: row.pricelist_name,
    currency_code: row.currency_code,
    updated_at: row.updated_at,
  }))

  const prices = pricesResult.rows.map((row) => ({
    company_id: row.company_id,
    pricelist_id: row.pricelist_id,
    pricelist_name: row.pricelist_name,
    currency_code: row.currency_code,
    product_id: row.product_id,
    price: parseFloat(row.price || 0),
    updated_at: row.updated_at,
  }))

  let latestUpdatedAt = null
  for (const row of [...assignments, ...prices]) {
    if (!row.updated_at) continue
    if (!latestUpdatedAt || new Date(row.updated_at) > new Date(latestUpdatedAt)) {
      latestUpdatedAt = row.updated_at
    }
  }

  return {
    synced_at: latestUpdatedAt,
    assignments,
    prices,
    assignment_count: assignments.length,
    price_count: prices.length,
  }
}

module.exports = {
  enqueuePriceSync,
  seedPriceSyncQueueFromAssignments,
  syncPriceEvents,
  processPriceSyncQueue,
  getVendorPriceBook,
}
