-- Cache local de imágenes de productos sincronizadas desde Odoo.
-- Evita pedir /web/image a Odoo en cada dispositivo y permite sync incremental.

CREATE TABLE IF NOT EXISTS product_images (
  product_id      INTEGER PRIMARY KEY,
  default_code    TEXT,
  write_date      TIMESTAMPTZ,
  mimetype        TEXT DEFAULT 'image/png',
  image_data      BYTEA NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_images_default_code
  ON product_images(default_code);

CREATE INDEX IF NOT EXISTS idx_product_images_write_date
  ON product_images(write_date);
