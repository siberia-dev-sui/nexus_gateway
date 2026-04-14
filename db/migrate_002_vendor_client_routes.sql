-- Migración 002: tabla de asignación vendedor-cliente + coordenadas en clientes
-- Ejecutar en bases de datos existentes.
-- Para instalaciones nuevas, schema.sql ya incluye estos cambios.

-- Coordenadas del cliente (vienen de res.partner.partner_latitude/lng en Odoo)
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS lng NUMERIC(10,7);

-- Asignación vendedor → cartera de clientes
-- Fuente de verdad: nexus.vendor.client_ids en Odoo (Many2many con res.partner)
-- Este cron lo puebla: crons/sync_clients.js
CREATE TABLE IF NOT EXISTS vendedor_cliente_rel (
  vendedor_id     INTEGER REFERENCES vendedores(id)    ON DELETE CASCADE,
  cliente_odoo_id INTEGER REFERENCES clientes(odoo_id) ON DELETE CASCADE,
  PRIMARY KEY (vendedor_id, cliente_odoo_id)
);

CREATE INDEX IF NOT EXISTS idx_vcrel_vendedor ON vendedor_cliente_rel(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_vcrel_cliente  ON vendedor_cliente_rel(cliente_odoo_id);
