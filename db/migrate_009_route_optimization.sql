-- Migración 009: metadata de optimización de rutas
-- Agrega columnas para registrar el algoritmo usado, distancia estimada y punto de origen

ALTER TABLE rutas ADD COLUMN IF NOT EXISTS algoritmo           TEXT    DEFAULT 'nombre';
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS distancia_estimada_km NUMERIC(8,2);
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS origen_lat          NUMERIC(10,7);
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS origen_lng          NUMERIC(10,7);

COMMENT ON COLUMN rutas.algoritmo              IS 'nombre | nn | osrm';
COMMENT ON COLUMN rutas.distancia_estimada_km  IS 'km estimados de recorrido en el orden generado';
COMMENT ON COLUMN rutas.origen_lat             IS 'posición del vendedor al momento de generar la ruta';
COMMENT ON COLUMN rutas.origen_lng             IS 'posición del vendedor al momento de generar la ruta';
