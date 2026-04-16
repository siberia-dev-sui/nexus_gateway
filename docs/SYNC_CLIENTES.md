# Sincronización de Clientes: Odoo → Gateway → App

## ¿Qué se hizo y por qué?

### El problema original

El endpoint `/api/v1/clients` consultaba Odoo **en tiempo real** cada vez que un vendedor
abría la pantalla de clientes en la app. Es decir:

```
App abre pantalla de clientes
        ↓
Gateway recibe la petición
        ↓
Gateway le pregunta a Odoo: "dame los clientes de este vendedor"
        ↓
Odoo consulta su base de datos y responde
        ↓
Gateway devuelve los datos a la app
```

Esto funcionaba, pero tenía varios problemas:

- **Carga innecesaria en Odoo**: cada vez que cualquier vendedor abría la app,
  se generaba una consulta a la base de datos de Odoo. Con muchos vendedores
  activos al mismo tiempo, Odoo recibía muchas consultas simultáneas para datos
  que casi nunca cambian.

- **Odoo es el cuello de botella**: si Odoo estaba lento, caído o en
  mantenimiento, la app no podía mostrar los clientes aunque el gateway estuviera
  funcionando perfectamente.

- **El gateway no aportaba valor real** para este endpoint: solo hacía de
  intermediario sin agregar nada, pasando la consulta directo a Odoo.

---

## La solución: caché en PostgreSQL del gateway

El gateway ya tenía el código escrito para esto (`crons/sync_clients.js` y las
tablas `clientes` y `vendedor_cliente_rel`), pero nunca se había activado.

Se implementó el flujo correcto:

```
Una vez al arrancar el servidor y luego cada 6 horas:
  sync_clients.js → le pregunta a Odoo → guarda en PostgreSQL del gateway

App abre pantalla de clientes:
  GET /api/v1/clients → gateway lee su propio PostgreSQL → responde a la app
  (Odoo no se entera de nada)
```

Odoo solo recibe consultas del cron, no de cada vendedor individualmente.

---

## Cambios realizados

### 1. `server.js` — Activar el cron de sync de clientes

Se importó `syncClients` y se registró para correr al arrancar el servidor
y repetirse cada 6 horas:

```js
const { syncClients } = require('./crons/sync_clients')

// Al arrancar y cada 6 horas
runClientSync()
setInterval(runClientSync, 6 * 60 * 60 * 1000)
```

**¿Por qué cada 6 horas?** Los clientes asignados a un vendedor no cambian
con frecuencia. Es un dato administrativo que el equipo de backoffice ajusta
ocasionalmente. Sincronizar cada 6 horas es más que suficiente y mantiene
la carga sobre Odoo mínima.

---

### 2. `server.js` — Cambiar el endpoint `/api/v1/clients`

**Antes** (consulta en tiempo real a Odoo):
```js
const result = await odooPost('/nexus/api/v1/vendor_clients', { nexus_uuid: uuid })
```

**Después** (lee del PostgreSQL del gateway):
```js
const result = await query(
  `SELECT c.odoo_id, c.nombre, c.rif, c.telefono, c.direccion,
          c.lat, c.lng, c.bloqueado, c.credito_restringido,
          c.motivo_bloqueo, c.canal, c.credito_limite, c.credito_usado
   FROM clientes c
   INNER JOIN vendedor_cliente_rel vcr ON vcr.cliente_odoo_id = c.odoo_id
   WHERE vcr.vendedor_id = $1
   ORDER BY c.nombre ASC`,
  [vendedor_id]
)
```

---

### 3. `db/migrate_004_clientes_nexus_fields.sql` — Nueva migración

La tabla `clientes` no tenía los campos de negocio de Nexus. Se agregaron:

```sql
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS credito_restringido BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS motivo_bloqueo      TEXT,
  ADD COLUMN IF NOT EXISTS canal               TEXT;
```

| Campo | Origen en Odoo | Descripción |
|---|---|---|
| `credito_restringido` | `nexus_credit_restricted` | El cliente tiene crédito restringido |
| `motivo_bloqueo` | `nexus_block_reason` | Razón por la que el cliente está bloqueado |
| `canal` | `nexus_channel` | Canal de venta (moderno, tradicional, horeca, digital) |

---

### 4. `crons/sync_clients.js` — Traer los campos nuevos de Odoo

Se agregaron los 3 campos nuevos a la consulta de Odoo y al upsert en PostgreSQL:

```js
// Campos leídos de Odoo
fields: [
  ...
  'nexus_credit_restricted',
  'nexus_block_reason',
  'nexus_channel'
]

// Guardados en PostgreSQL
INSERT INTO clientes (..., credito_restringido, motivo_bloqueo, canal, ...)
```

---

## Cómo aplicar en producción

```bash
# 1. Correr la migración de base de datos
psql $DATABASE_URL -f db/migrate_004_clientes_nexus_fields.sql

# 2. Reiniciar el servidor (el cron corre automáticamente al arrancar)
npm start
```

Al arrancar, el servidor ejecuta `sync_clients` inmediatamente, pobla las
tablas y desde ese momento todos los GET de clientes responden desde
PostgreSQL sin tocar Odoo.

---

## Flujo completo actual

```
ODOO
  Admin asigna clientes a vendedor en nexus.vendor.client_ids
        ↓  (máximo 6 horas de delay)
GATEWAY — cron sync_clients.js
  Lee nexus.vendor + res.partner desde Odoo
  Guarda en tabla clientes (upsert)
  Guarda asignaciones en vendedor_cliente_rel (upsert + limpia eliminados)
        ↓
GATEWAY — GET /api/v1/clients
  Lee clientes desde PostgreSQL propio
  Devuelve lista al vendedor autenticado por JWT
        ↓
APP — RutaScreen
  Muestra lista de clientes asignados
```
