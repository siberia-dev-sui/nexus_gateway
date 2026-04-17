-- Migración 008: price books por cliente+empresa y cola de sincronización

CREATE TABLE IF NOT EXISTS cliente_empresa_pricelist (
  cliente_odoo_id INTEGER REFERENCES clientes(odoo_id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL,
  pricelist_id    INTEGER NOT NULL,
  pricelist_name  TEXT NOT NULL,
  currency_code   TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (cliente_odoo_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_cliente_empresa_pricelist_lookup
  ON cliente_empresa_pricelist(pricelist_id, company_id);

CREATE TABLE IF NOT EXISTS pricelist_prices (
  company_id      INTEGER NOT NULL,
  pricelist_id    INTEGER NOT NULL,
  pricelist_name  TEXT NOT NULL,
  currency_code   TEXT,
  product_id      INTEGER NOT NULL,
  price           NUMERIC(16,6) NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (company_id, pricelist_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_pricelist_prices_lookup
  ON pricelist_prices(company_id, pricelist_id);

CREATE TABLE IF NOT EXISTS pricelist_sync_queue (
  pricelist_id    INTEGER NOT NULL,
  company_id      INTEGER NOT NULL,
  source          TEXT DEFAULT 'odoo',
  status          TEXT DEFAULT 'PENDING',
  dirty           BOOLEAN DEFAULT FALSE,
  requested_at    TIMESTAMPTZ DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  last_error      TEXT,
  PRIMARY KEY (pricelist_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_pricelist_sync_queue_status
  ON pricelist_sync_queue(status, requested_at);
