-- Índices de rendimiento (junio 2026)
--
-- vendedores(email): el login hace WHERE email = $1 en cada inicio de sesión.
-- vendor_orders_cache(vendor_uuid, client_order_ref): GET /sync/status hace
--   LATERAL JOIN por client_order_ref para enriquecer ORDER_CREATED DONE.
-- outbox(estado, created_at): requeue/drain escanean por estado ordenando
--   por created_at cada 60s.

CREATE INDEX IF NOT EXISTS idx_vendedores_email
  ON vendedores (email);

CREATE INDEX IF NOT EXISTS idx_vendor_orders_cache_client_ref
  ON vendor_orders_cache (vendor_uuid, client_order_ref);

CREATE INDEX IF NOT EXISTS idx_outbox_estado_created
  ON outbox (estado, created_at);
