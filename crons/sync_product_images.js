const { query } = require('../db')

const DEFAULT_LIMIT = 200

async function upsertProductImages(images) {
  let synced = 0

  for (const image of images) {
    if (!image.product_id || !image.image_b64) continue

    const buffer = Buffer.from(image.image_b64, 'base64')
    await query(
      `INSERT INTO product_images (
         product_id, default_code, write_date, mimetype, image_data, size_bytes, synced_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (product_id) DO UPDATE SET
         default_code = EXCLUDED.default_code,
         write_date   = EXCLUDED.write_date,
         mimetype     = EXCLUDED.mimetype,
         image_data   = EXCLUDED.image_data,
         size_bytes   = EXCLUDED.size_bytes,
         synced_at    = NOW()`,
      [
        image.product_id,
        image.default_code || null,
        image.write_date || null,
        image.mimetype || 'image/png',
        buffer,
        buffer.length,
      ]
    )
    synced++
  }

  return synced
}

async function syncProductImages(odooPost, options = {}) {
  const tag = '[SYNC_PRODUCT_IMAGES]'
  const defaultCode = options.default_code ? String(options.default_code).trim() : null
  const cached = await query('SELECT product_id FROM product_images')
  const cachedProductIds = new Set(cached.rows.map((row) => Number(row.product_id)))

  let totalSynced = 0
  let latestWriteDate = null
  let hasMore = true

  while (hasMore) {
    let data
    try {
      data = await odooPost('/nexus/api/v1/product_images', {
        default_code: defaultCode,
        exclude_product_ids: defaultCode ? [] : [...cachedProductIds],
        limit: DEFAULT_LIMIT,
      })
    } catch (err) {
      console.error(`${tag} Error al llamar /product_images:`, err.message)
      return { synced: totalSynced, errores: 1 }
    }

    const images = data?.images || []
    totalSynced += await upsertProductImages(images)
    for (const image of images) {
      cachedProductIds.add(Number(image.product_id))
    }
    latestWriteDate = data?.latest_write_date || latestWriteDate
    hasMore = Boolean(data?.has_more && !defaultCode)

    if (!images.length) break
  }

  console.log(`${tag} ${totalSynced} imagen(es) faltantes sincronizadas${defaultCode ? ` default_code=${defaultCode}` : ''}`)
  return { synced: totalSynced, default_code: defaultCode, latest_write_date: latestWriteDate }
}

module.exports = { syncProductImages }
