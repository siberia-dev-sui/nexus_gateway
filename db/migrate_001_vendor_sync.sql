-- Migración 001: adaptar vendedores para sincronización desde nexus.vendor (Odoo)
-- Ejecutar en bases de datos existentes (schema.sql ya incluye estos cambios para instalaciones nuevas)
--
-- Cambios:
--   - Agrega odoo_vendor_id a vendedores (reemplaza el intento de odoo_employee_id)
--   - Agrega orden_actual y saltada_at a paradas (usados por el API de rutas)

ALTER TABLE vendedores
  ADD COLUMN IF NOT EXISTS odoo_vendor_id INTEGER;

COMMENT ON COLUMN vendedores.odoo_vendor_id IS 'nexus.vendor.id en Odoo — se llena en cada sync';

ALTER TABLE paradas
  ADD COLUMN IF NOT EXISTS orden_actual INTEGER,
  ADD COLUMN IF NOT EXISTS saltada_at   TIMESTAMPTZ;

COMMENT ON COLUMN paradas.orden_actual IS 'Posición reordenada en tiempo real por el vendedor';
COMMENT ON COLUMN paradas.saltada_at   IS 'Timestamp cuando el vendedor marcó la parada como skipped';
