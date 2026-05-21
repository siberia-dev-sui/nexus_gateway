-- Migración 016: Cache de sugerencias de pedido por (vendor, client, product)
--
-- Contexto:
--   La app pre-llena el paso "Pedido" del wizard con cantidades sugeridas
--   según el histórico de visitas de cada cliente. Para no consultar Odoo
--   en cada wizard (offline-first), el gateway mantiene esta tabla con el
--   target y last_post calculados.
--
-- Actualización (event-driven, sin cron):
--   - El worker, tras procesar un VISIT_COMPLETED exitoso en Odoo, llama a
--     /nexus/api/v1/order_suggestions(vendor, client) y hace UPSERT acá.
--   - Si la app pide y el cache está vacío para un vendedor, el endpoint
--     dispara un backfill async (consulta todos sus clientes).
--
-- Lectura:
--   - GET /api/v1/vendor/order_suggestions devuelve las filas para el
--     vendedor del JWT, la app las cachea en su propio SQLite.

CREATE TABLE IF NOT EXISTS order_suggestions_cache (
  vendor_id    INTEGER NOT NULL,
  client_id    INTEGER NOT NULL,
  product_id   INTEGER NOT NULL,
  target       NUMERIC(12,2) NOT NULL,
  last_post    NUMERIC(12,2) NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (vendor_id, client_id, product_id)
);

-- Consulta caliente: "dame todas las sugerencias para este vendedor"
CREATE INDEX IF NOT EXISTS idx_order_suggestions_vendor
  ON order_suggestions_cache(vendor_id);

-- Consulta de invalidación: "limpia este par vendor+client antes de UPSERT"
CREATE INDEX IF NOT EXISTS idx_order_suggestions_vendor_client
  ON order_suggestions_cache(vendor_id, client_id);
