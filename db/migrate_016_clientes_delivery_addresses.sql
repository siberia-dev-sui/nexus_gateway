-- migrate_016: Añadir columnas para direcciones de entrega por cliente.
-- Origen: res.partner.child_ids con type='delivery' en Odoo.
-- El cron sync_clients las traerá serializadas en cada ciclo.

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS delivery_addresses JSONB DEFAULT '[]'::jsonb;

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS default_delivery_id INTEGER;
