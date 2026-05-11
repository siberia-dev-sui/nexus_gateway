-- Migración 011: Diarios de pago disponibles para vendedores móviles
--
-- Contexto:
--   payment_journals → espejo de account.journal en Odoo, filtrado a los
--   diarios bank/cash con inbound payment method (los únicos válidos para
--   crear account.payment.request desde la app NEXUS).
--
--   El cron sync_payment_journals los baja desde el módulo nexus_mobile
--   periódicamente. La app los consulta vía GET /api/v1/vendor/journals
--   filtrando por empresa activa para mostrar el picker al vendedor.

CREATE TABLE IF NOT EXISTS payment_journals (
  id            INTEGER NOT NULL,
  company_id    INTEGER NOT NULL,
  company_name  TEXT,
  name          TEXT NOT NULL,
  code          TEXT,
  type          TEXT,                          -- 'bank' | 'cash'
  currency_code TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_payment_journals_company
  ON payment_journals(company_id);
