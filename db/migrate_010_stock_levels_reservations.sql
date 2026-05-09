-- Migración 010: Sistema de stock y reservas para vendedores móviles
--
-- Contexto:
--   stock_levels  → espejo del stock interno de Odoo por producto y almacén.
--                   Lo llena el cron sync_stock cada 20min (delta) y 6h (full),
--                   leyendo de /nexus/api/v1/get_all_stock_quants en el módulo.
--
--   reservations  → registros de stock comprometido por pedidos en vuelo.
--                   Cada ORDER_CREATED crea una reserva 'pending'. El worker
--                   la mueve a 'confirmed' (Odoo aceptó) o 'failed' (rechazó).
--                   Un cron de barrido marca 'expired' las pending viejas.
--
-- Stock disponible para validar pedidos:
--   available = stock_levels.quantity
--             - SUM(reservations.quantity WHERE status = 'pending')

-- ─────────────────────────────────────────
-- STOCK_LEVELS — caché de stock por producto y almacén
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_levels (
  product_id      INTEGER NOT NULL,
  warehouse_id    INTEGER NOT NULL,
  quantity        NUMERIC(16,4) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (product_id, warehouse_id)
);

-- Lookup rápido por almacén (la app pide siempre filtrando por warehouse)
CREATE INDEX IF NOT EXISTS idx_stock_levels_warehouse
  ON stock_levels(warehouse_id);

-- Lookup por updated_at para el endpoint delta GET /vendor/stock?since=...
CREATE INDEX IF NOT EXISTS idx_stock_levels_warehouse_updated
  ON stock_levels(warehouse_id, updated_at DESC);

-- ─────────────────────────────────────────
-- RESERVATIONS — stock comprometido por pedidos en vuelo
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservations (
  id              SERIAL PRIMARY KEY,
  product_id      INTEGER NOT NULL,
  warehouse_id    INTEGER NOT NULL,
  vendor_id       INTEGER REFERENCES vendedores(id),
  order_uuid      UUID NOT NULL,                  -- client_uuid del outbox / sale.order
  quantity        NUMERIC(16,4) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | deducted_pending_sync | failed | expired
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,                    -- cuándo dejó de ser 'pending'
  CONSTRAINT reservations_status_chk
    CHECK (status IN ('pending', 'confirmed', 'deducted_pending_sync', 'failed', 'expired'))
);

-- Cálculo de disponible: SUM(quantity) WHERE status='pending' por (product, warehouse)
CREATE INDEX IF NOT EXISTS idx_reservations_pending_lookup
  ON reservations(product_id, warehouse_id, status)
  WHERE status = 'pending';

-- Barrido de expiración: pending con created_at viejo
CREATE INDEX IF NOT EXISTS idx_reservations_pending_age
  ON reservations(created_at)
  WHERE status = 'pending';

-- Lookup por order_uuid al confirmar/fallar desde el worker
CREATE INDEX IF NOT EXISTS idx_reservations_order_uuid
  ON reservations(order_uuid);
