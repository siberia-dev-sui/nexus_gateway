-- Tarea 1: historial GPS por vendedor para track del supervisor
CREATE TABLE IF NOT EXISTS gps_tracks (
  id          SERIAL PRIMARY KEY,
  vendedor_id INTEGER NOT NULL REFERENCES vendedores(id),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  accuracy    DOUBLE PRECISION DEFAULT 0,
  estado      TEXT DEFAULT 'en_ruta',   -- en_ruta | en_cliente | sin_senal
  captured_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gps_tracks_vendedor_date
  ON gps_tracks(vendedor_id, captured_at DESC);
