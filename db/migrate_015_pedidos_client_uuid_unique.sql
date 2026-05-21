-- migrate_015: Garantizar UNIQUE en pedidos.client_uuid
-- Razón: bloquear duplicación de pedidos cuando /api/v1/sync/push recibe
-- la misma client_uuid dos veces (reintento del teléfono, race condition).
-- Antes existía un ON CONFLICT (client_uuid) DO NOTHING que era inocuo:
-- sin restricción UNIQUE, NUNCA disparaba conflicto y permitía duplicados.

-- Limpieza previa: si existen duplicados, conservar el de id menor.
DELETE FROM pedidos p
USING pedidos p2
WHERE p.client_uuid = p2.client_uuid
  AND p.id > p2.id;

ALTER TABLE pedidos
  ADD CONSTRAINT pedidos_client_uuid_uniq UNIQUE (client_uuid);
