-- Migración 003: columna imagen_url en vendedores
-- Ejecutar en bases de datos existentes que ya tienen el schema anterior.

ALTER TABLE vendedores
  ADD COLUMN IF NOT EXISTS imagen_url TEXT;

COMMENT ON COLUMN vendedores.imagen_url IS 'URL de la foto del vendedor (Odoo /web/image/nexus.vendor/{id}/image)';
