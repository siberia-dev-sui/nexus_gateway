-- Migración 004: agrega campos nexus a tabla clientes
-- Campos provenientes de res.partner extendido por el módulo nexus_mobile

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS credito_restringido BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS motivo_bloqueo      TEXT,
  ADD COLUMN IF NOT EXISTS canal               TEXT;
