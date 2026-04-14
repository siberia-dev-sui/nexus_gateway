-- NEXUS Gateway — PostgreSQL Schema
-- Ejecutar una sola vez al inicializar la base de datos

-- ─────────────────────────────────────────
-- EXTENSIONES
-- ─────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- para gen_random_uuid()

-- ─────────────────────────────────────────
-- VENDEDORES
-- 120 vendedores de campo. Odoo no los conoce.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendedores (
  id              SERIAL PRIMARY KEY,
  uuid            UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  odoo_vendor_id  INTEGER,                              -- nexus.vendor.id en Odoo (se llena en sync)
  nombre          TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,                        -- bcrypt
  zona            TEXT,                                 -- zona geográfica asignada
  imagen_url      TEXT,                                 -- URL de foto del vendedor (desde Odoo /web/image)
  activo          BOOLEAN DEFAULT TRUE,
  device_id       TEXT,                                 -- binding del dispositivo
  ultimo_login    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- REFRESH TOKENS
-- Sesiones activas por vendedor + device
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              SERIAL PRIMARY KEY,
  vendedor_id     INTEGER REFERENCES vendedores(id) ON DELETE CASCADE,
  token_hash      TEXT UNIQUE NOT NULL,                 -- SHA-256 del token
  device_id       TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revocado        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- CLIENTES
-- Espejo de res.partner de Odoo (solo campos necesarios)
-- Se sincroniza desde Odoo via cron
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes (
  id              SERIAL PRIMARY KEY,
  odoo_id         INTEGER UNIQUE NOT NULL,              -- res.partner.id en Odoo
  nombre          TEXT NOT NULL,
  rif             TEXT,
  telefono        TEXT,
  direccion       TEXT,
  zona            TEXT,
  lat             NUMERIC(10,7),                        -- partner_latitude en Odoo
  lng             NUMERIC(10,7),                        -- partner_longitude en Odoo
  credito_limite  NUMERIC(12,2) DEFAULT 0,
  credito_usado   NUMERIC(12,2) DEFAULT 0,
  bloqueado       BOOLEAN DEFAULT FALSE,
  last_sync       TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ASIGNACIÓN VENDEDOR → CLIENTES
-- Fuente de verdad: nexus.vendor.client_ids en Odoo
-- Poblado por: crons/sync_clients.js
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendedor_cliente_rel (
  vendedor_id     INTEGER REFERENCES vendedores(id)    ON DELETE CASCADE,
  cliente_odoo_id INTEGER REFERENCES clientes(odoo_id) ON DELETE CASCADE,
  PRIMARY KEY (vendedor_id, cliente_odoo_id)
);

CREATE INDEX IF NOT EXISTS idx_vcrel_vendedor ON vendedor_cliente_rel(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_vcrel_cliente  ON vendedor_cliente_rel(cliente_odoo_id);

-- ─────────────────────────────────────────
-- RUTAS
-- Plan diario generado a las 4AM por cron
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rutas (
  id              SERIAL PRIMARY KEY,
  uuid            UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  vendedor_id     INTEGER REFERENCES vendedores(id),
  fecha           DATE NOT NULL,
  estado          TEXT DEFAULT 'pendiente',             -- pendiente | en_curso | completada
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vendedor_id, fecha)
);

CREATE TABLE IF NOT EXISTS paradas (
  id              SERIAL PRIMARY KEY,
  ruta_id         INTEGER REFERENCES rutas(id) ON DELETE CASCADE,
  cliente_id      INTEGER REFERENCES clientes(odoo_id),
  orden           INTEGER NOT NULL,                     -- secuencia del día
  orden_actual    INTEGER,                              -- posición reordenada en tiempo real
  estado          TEXT DEFAULT 'pending',               -- pending | on_site | completed | skipped
  lat             NUMERIC(10,7),
  lng             NUMERIC(10,7),
  notas           TEXT,
  saltada_at      TIMESTAMPTZ                           -- se llena cuando estado = 'skipped'
);

-- ─────────────────────────────────────────
-- VISITAS
-- Registro completo de cada visita de campo
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visitas (
  id              SERIAL PRIMARY KEY,
  uuid            UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  vendedor_id     INTEGER REFERENCES vendedores(id),
  cliente_odoo_id INTEGER,
  parada_id       INTEGER REFERENCES paradas(id),
  estado          TEXT DEFAULT 'abierta',               -- abierta | cerrada | rechazada
  checkin_lat     NUMERIC(10,7),
  checkin_lng     NUMERIC(10,7),
  checkin_at      TIMESTAMPTZ,
  checkout_at     TIMESTAMPTZ,
  notas           TEXT,
  aprobado_por    INTEGER REFERENCES vendedores(id),    -- supervisor
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- OUTBOX
-- Cola transaccional offline-first
-- Garantía de idempotencia por client_uuid
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox (
  id              SERIAL PRIMARY KEY,
  client_uuid     UUID UNIQUE NOT NULL,                 -- generado en el teléfono
  vendedor_id     INTEGER REFERENCES vendedores(id),
  tipo            TEXT NOT NULL,                        -- VISIT_CHECKIN | ORDER_CREATED | PAYMENT_RECORDED | PHOTO_UPLOADED | VISIT_CLOSED
  estado          TEXT DEFAULT 'PENDING',               -- PENDING | SENDING | SENT | ACK | DONE | FAILED | DEAD
  payload         JSONB NOT NULL,
  device_id       TEXT,
  retry_count     INTEGER DEFAULT 0,
  error_msg       TEXT,
  odoo_ref        TEXT,                                 -- ID creado en Odoo (sale.order.id, etc.)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- PEDIDOS
-- Referencia cruzada: outbox → Odoo
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pedidos (
  id              SERIAL PRIMARY KEY,
  uuid            UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  client_uuid     UUID REFERENCES outbox(client_uuid),  -- link al outbox
  vendedor_id     INTEGER REFERENCES vendedores(id),
  cliente_odoo_id INTEGER NOT NULL,
  odoo_order_id   INTEGER,                              -- sale.order.id en Odoo (se llena al confirmar)
  odoo_order_name TEXT,                                 -- ej: S00123
  estado          TEXT DEFAULT 'pendiente',             -- pendiente | confirmado | despachado | cancelado
  total           NUMERIC(12,2),
  notas           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- PAGOS
-- Referencia cruzada: outbox → Odoo
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pagos (
  id              SERIAL PRIMARY KEY,
  uuid            UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  client_uuid     UUID REFERENCES outbox(client_uuid),
  vendedor_id     INTEGER REFERENCES vendedores(id),
  cliente_odoo_id INTEGER NOT NULL,
  odoo_payment_id INTEGER,                              -- account.payment.id en Odoo
  monto           NUMERIC(12,2) NOT NULL,
  metodo          TEXT,                                 -- efectivo | transferencia | cheque
  referencia      TEXT,
  foto_evidencia  TEXT,                                 -- path en block storage
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- FOTOS
-- Metadata de uploads chunked
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fotos (
  id              SERIAL PRIMARY KEY,
  uuid            UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  visita_id       INTEGER REFERENCES visitas(id),
  vendedor_id     INTEGER REFERENCES vendedores(id),
  filename        TEXT NOT NULL,
  storage_path    TEXT,                                 -- ruta en Hetzner Block Storage
  size_bytes      INTEGER,
  upload_completo BOOLEAN DEFAULT FALSE,
  chunks_total    INTEGER,
  chunks_recibidos INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ÍNDICES
-- ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_outbox_estado       ON outbox(estado);
CREATE INDEX IF NOT EXISTS idx_outbox_vendedor     ON outbox(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_visitas_vendedor    ON visitas(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_visitas_cliente     ON visitas(cliente_odoo_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_vendedor    ON pedidos(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_odoo        ON pedidos(odoo_order_id);
CREATE INDEX IF NOT EXISTS idx_rutas_fecha         ON rutas(fecha);
CREATE INDEX IF NOT EXISTS idx_paradas_ruta        ON paradas(ruta_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token       ON refresh_tokens(token_hash);
