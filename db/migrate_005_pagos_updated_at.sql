-- Tarea 4: columna updated_at faltaba en pagos (payment.js la referenciaba y crasheaba)
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
