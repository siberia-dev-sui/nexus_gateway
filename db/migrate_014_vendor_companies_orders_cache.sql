-- Cache local de empresas por vendedor y pedidos por vendedor.
-- La app debe leer del gateway; Odoo se consulta por cron/manual.

CREATE TABLE IF NOT EXISTS vendor_companies (
  vendor_uuid        UUID NOT NULL,
  company_id         INTEGER NOT NULL,
  company_name       TEXT NOT NULL,
  currency_code      TEXT,
  warehouse_id       INTEGER,
  warehouse_name     TEXT,
  is_default         BOOLEAN DEFAULT FALSE,
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (vendor_uuid, company_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_companies_vendor
  ON vendor_companies(vendor_uuid);

CREATE TABLE IF NOT EXISTS vendor_orders_cache (
  vendor_uuid        UUID NOT NULL,
  order_id           INTEGER NOT NULL,
  order_name         TEXT,
  state              TEXT,
  partner_id         INTEGER,
  partner_name       TEXT,
  partner_vat        TEXT,
  date_order         TIMESTAMPTZ,
  write_date         TIMESTAMPTZ,
  amount_total       NUMERIC(16,2),
  currency_code      TEXT,
  client_order_ref   TEXT,
  payload            JSONB NOT NULL,
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (vendor_uuid, order_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_orders_cache_vendor
  ON vendor_orders_cache(vendor_uuid, date_order DESC, order_id DESC);

CREATE INDEX IF NOT EXISTS idx_vendor_orders_cache_state
  ON vendor_orders_cache(vendor_uuid, state);

CREATE INDEX IF NOT EXISTS idx_vendor_orders_cache_search
  ON vendor_orders_cache(vendor_uuid, order_name, partner_name, partner_vat, client_order_ref);
