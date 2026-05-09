-- Migración 011: estado transitorio para reservas de pedidos confirmados en Odoo
--
-- deducted_pending_sync significa:
--   Odoo ya confirmó el pedido y descontará/descontó inventario real, pero el
--   último sync_stock del gateway todavía no necesariamente trajo ese on-hand.
--   Mientras tanto sigue restando disponibilidad móvil. Cuando sync_stock
--   actualiza el producto después de la confirmación, la reserva se libera.

ALTER TABLE reservations
  DROP CONSTRAINT IF EXISTS reservations_status_chk;

ALTER TABLE reservations
  ADD CONSTRAINT reservations_status_chk
  CHECK (status IN ('pending', 'confirmed', 'deducted_pending_sync', 'failed', 'expired'));

CREATE INDEX IF NOT EXISTS idx_reservations_deducted_pending_sync
  ON reservations(product_id, warehouse_id, resolved_at)
  WHERE status = 'deducted_pending_sync';
