# NEXUS — Contexto Completo para LLM
> **Última actualización:** 13 abril 2026  
> **Última sesión de trabajo:** 10 abril 2026  
> **Para:** Lenn — desarrollo del módulo Odoo  

---

## 1. QUÉ ES ESTE PROYECTO

**NEXUS** es una plataforma móvil **offline-first** para los **120 vendedores de campo de Grupo Leiros** (Venezuela). Los vendedores trabajan en zonas sin señal y sincronizan datos con Odoo cuando hay red.

### El problema que resuelve
Grupo Leiros pagaba **$4,560/mes en licencias Odoo** para sus vendedores de campo. NEXUS reemplaza esas licencias con:
- Una **app Flutter** propia instalada en los teléfonos de los vendedores
- Un **API Gateway** propio (Fastify + PostgreSQL + Redis)
- **1 solo usuario bot** en Odoo que hace todas las operaciones

Costo nuevo: ~$50/mes. Ahorro: $54,120/año.

### Patrón clave: "1 bot, 120 vendedores"
```
Odoo Enterprise
  └── 1 usuario bot: bot_nexus@leiros.com (ID 311)
  └── Los 120 vendedores NO existen en Odoo
  └── Pedidos/pagos se crean a nombre del bot

NEXUS Gateway (PostgreSQL propio)
  └── tabla vendedores → 120 vendedores con JWT propio
  └── tabla pedidos, pagos, visitas, rutas...
  └── BullMQ → procesa eventos offline → los manda a Odoo via el bot
```

---

## 2. INFRAESTRUCTURA DEL SERVIDOR

### Servidor Hetzner CX22
```
IP:       77.42.71.221
Dominio:  77-42-71-221.sslip.io
OS:       Ubuntu 24.04.4 LTS
Docker:   29.4.0
Node.js:  v20.20.2
RAM:      3.7 GB (2.9 GB libre)
Disco:    38 GB (33 GB libre)
CPU:      2 vCPU Intel Xeon Skylake @ 2GHz (~5% uso)
Región:   Helsinki (hel1)
```

### Contenedores Docker (todos activos al 13/04/2026)
```
nexus_postgres   Up 2 días   PostgreSQL 16 Alpine — puerto 5432 (interno)
nexus_redis      Up 2 días   Redis 7 Alpine — puerto 6379 (interno)
nexus_gateway    Up 2 días   Fastify Node.js — puerto 3000 (interno)
nexus_nginx      Up 3 días   Nginx Alpine — puertos 80:80, 443:443 (público)
```

### Seguridad
- `fail2ban` activo — ya baneó 3 IPs en el primer día
- SSH sin password: `PasswordAuthentication no`, solo clave pública
- Bots atacando constantemente (PHP injection, Docker API, WebDAV) — todos devuelven 404, sin riesgo

---

## 3. STACK COMPLETO

| Capa | Tecnología |
|------|-----------|
| App móvil | Flutter 3.41.6, Drift/SQLite AES-256, Riverpod, WorkManager, Dio |
| Gateway | Fastify 4 (Node.js v20), `@fastify/jwt`, `@fastify/cors` |
| Base de datos | PostgreSQL 16 + Redis 7 |
| Cola offline | BullMQ 5 (sobre Redis) |
| ERP | Odoo 17 on-prem / staging: 19brandia.odoo.com |
| Infra | Hetzner CX22, Docker Compose, Nginx, Let's Encrypt |
| Dispositivos | Honor X8C / Honor Magic 8 Lite (Android 15, API 35) |

---

## 4. CREDENCIALES Y CONFIGURACIÓN

### Archivo `.env` del gateway (`/opt/nexus_gateway/.env`)
```env
JWT_SECRET=nexus_demo_secret_2026_super_secure
POSTGRES_URL=postgresql://nexus:NexusDB2026!@nexus_postgres:5432/nexus
POSTGRES_PASSWORD=NexusDB2026!
REDIS_URL=redis://:NexusRedis2026!@nexus_redis:6379
REDIS_PASSWORD=NexusRedis2026!
ODOO_URL=https://19brandia.odoo.com
ODOO_DB=equinocciodev-gleiros-19-0-staging3-29334581
ODOO_BOT_EMAIL=bot_nexus@leiros.com
ODOO_BOT_PASSWORD=NexusBot2026!
PORT=3000
```

### Conexión a Odoo (staging)
```
URL:      https://19brandia.odoo.com
DB:       equinocciodev-gleiros-19-0-staging3-29334581
Bot user: bot_nexus@leiros.com
Password: NexusBot2026!
Bot ID:   311 (en Odoo)
```

### Vendedor demo (para pruebas)
```
email:    bot_ventas@leiros.com
password: 123456
zona:     Caracas
```

---

## 5. BASE DE DATOS POSTGRESQL — 10 TABLAS

### Schema completo (`/opt/nexus_gateway/db/schema.sql`)

```sql
-- VENDEDORES: los 120 vendedores. Odoo no los conoce.
CREATE TABLE vendedores (
  id            SERIAL PRIMARY KEY,
  uuid          UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  nombre        TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,        -- bcrypt
  zona          TEXT,                 -- zona geográfica asignada
  activo        BOOLEAN DEFAULT TRUE,
  device_id     TEXT,                 -- binding del dispositivo
  ultimo_login  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- REFRESH_TOKENS: sesiones activas por vendedor + device
CREATE TABLE refresh_tokens (
  id          SERIAL PRIMARY KEY,
  vendedor_id INTEGER REFERENCES vendedores(id) ON DELETE CASCADE,
  token_hash  TEXT UNIQUE NOT NULL,   -- SHA-256 del token
  device_id   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revocado    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- CLIENTES: espejo de res.partner de Odoo (solo campos necesarios)
-- Se sincroniza desde Odoo via cron (AÚN NO IMPLEMENTADO)
CREATE TABLE clientes (
  id             SERIAL PRIMARY KEY,
  odoo_id        INTEGER UNIQUE NOT NULL,  -- res.partner.id en Odoo
  nombre         TEXT NOT NULL,
  rif            TEXT,
  telefono       TEXT,
  direccion      TEXT,
  zona           TEXT,
  credito_limite NUMERIC(12,2) DEFAULT 0,
  credito_usado  NUMERIC(12,2) DEFAULT 0,
  bloqueado      BOOLEAN DEFAULT FALSE,
  last_sync      TIMESTAMPTZ DEFAULT NOW()
);

-- RUTAS: plan diario generado a las 4AM por cron (AÚN NO IMPLEMENTADO)
CREATE TABLE rutas (
  id          SERIAL PRIMARY KEY,
  uuid        UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  vendedor_id INTEGER REFERENCES vendedores(id),
  fecha       DATE NOT NULL,
  estado      TEXT DEFAULT 'pendiente', -- pendiente | en_curso | completada
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vendedor_id, fecha)
);

-- PARADAS: clientes a visitar en cada ruta
CREATE TABLE paradas (
  id          SERIAL PRIMARY KEY,
  ruta_id     INTEGER REFERENCES rutas(id) ON DELETE CASCADE,
  cliente_id  INTEGER REFERENCES clientes(odoo_id),
  orden       INTEGER NOT NULL,        -- plan original del cron (inmutable)
  orden_actual INTEGER,               -- orden real según el vendedor en campo
  estado      TEXT DEFAULT 'pending', -- pending | on_site | completed | skipped
  lat         NUMERIC(10,7),
  lng         NUMERIC(10,7),
  notas       TEXT,
  saltada_at  TIMESTAMPTZ             -- cuándo saltó esta parada
);

-- VISITAS: registro completo de cada visita de campo
CREATE TABLE visitas (
  id              SERIAL PRIMARY KEY,
  uuid            UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  vendedor_id     INTEGER REFERENCES vendedores(id),
  cliente_odoo_id INTEGER,
  parada_id       INTEGER REFERENCES paradas(id),
  estado          TEXT DEFAULT 'abierta', -- abierta | cerrada | rechazada
  checkin_lat     NUMERIC(10,7),
  checkin_lng     NUMERIC(10,7),
  checkin_at      TIMESTAMPTZ,
  checkout_at     TIMESTAMPTZ,
  notas           TEXT,
  aprobado_por    INTEGER REFERENCES vendedores(id), -- supervisor
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- OUTBOX: cola transaccional offline-first (corazón del sistema)
-- Garantía de idempotencia por client_uuid (generado en el teléfono)
CREATE TABLE outbox (
  id          SERIAL PRIMARY KEY,
  client_uuid UUID UNIQUE NOT NULL,   -- UUID generado en Flutter
  vendedor_id INTEGER REFERENCES vendedores(id),
  tipo        TEXT NOT NULL,          -- ORDER_CREATED | PAYMENT_RECORDED | VISIT_CHECKIN | VISIT_CLOSED | PHOTO_UPLOADED
  estado      TEXT DEFAULT 'PENDING', -- PENDING | SENDING | SENT | ACK | DONE | FAILED | DEAD | PENDING_REVIEW
  payload     JSONB NOT NULL,
  device_id   TEXT,
  retry_count INTEGER DEFAULT 0,
  error_msg   TEXT,
  odoo_ref    TEXT,                   -- ID creado en Odoo (sale.order.id, etc.)
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- PEDIDOS: referencia cruzada outbox ↔ Odoo sale.order
CREATE TABLE pedidos (
  id               SERIAL PRIMARY KEY,
  uuid             UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  client_uuid      UUID UNIQUE REFERENCES outbox(client_uuid),
  vendedor_id      INTEGER REFERENCES vendedores(id),
  cliente_odoo_id  INTEGER NOT NULL,
  odoo_order_id    INTEGER,           -- sale.order.id en Odoo
  odoo_order_name  TEXT,              -- ej: S00123
  estado           TEXT DEFAULT 'pendiente', -- pendiente | confirmado | PENDING_REVIEW | despachado | cancelado
  total            NUMERIC(12,2),
  notas            TEXT,
  precio_conflicto JSONB,             -- detalles del conflicto de precio si aplica
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- PAGOS: cobros con evidencia
CREATE TABLE pagos (
  id              SERIAL PRIMARY KEY,
  uuid            UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  client_uuid     UUID UNIQUE REFERENCES outbox(client_uuid),
  vendedor_id     INTEGER REFERENCES vendedores(id),
  cliente_odoo_id INTEGER NOT NULL,
  odoo_payment_id INTEGER,            -- account.payment.id en Odoo
  monto           NUMERIC(12,2) NOT NULL,
  metodo          TEXT,               -- efectivo | transferencia | cheque
  referencia      TEXT,
  foto_evidencia  TEXT,               -- path en Hetzner Block Storage
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- FOTOS: metadata de uploads chunked
CREATE TABLE fotos (
  id               SERIAL PRIMARY KEY,
  uuid             UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  visita_id        INTEGER REFERENCES visitas(id),
  vendedor_id      INTEGER REFERENCES vendedores(id),
  filename         TEXT NOT NULL,
  storage_path     TEXT,              -- ruta en Hetzner Block Storage
  size_bytes       INTEGER,
  upload_completo  BOOLEAN DEFAULT FALSE,
  chunks_total     INTEGER,
  chunks_recibidos INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
```

### Estado actual de la BD (13/04/2026)
```
vendedores:  1 registro (bot_ventas@leiros.com, zona Caracas)
clientes:    0 registros — cron de sync pendiente
rutas:       0 registros — cron 4AM pendiente
outbox:      2 registros de prueba
```

---

## 6. REDIS — ESTRUCTURA DE KEYS

```
catalog:products         → JSON array de 397 productos de Odoo (TTL 1h)
                           [actualmente expirado — se regenera al primer /catalog]
prices                   → HASH: product_id → precio actual
                           [pendiente de implementar con cron 30min]
location:{vendedor_id}   → JSON con lat/lng/estado/timestamp (TTL 2h)
                           [se actualiza con PATCH /vendors/location]
bull:nexus-outbox:*      → Keys internas de BullMQ (no tocar)
```

---

## 7. API ENDPOINTS ACTIVOS

**Base URL:** `https://77-42-71-221.sslip.io`

### Sin autenticación
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/v1/health` | Healthcheck — `{"status":"ok"}` |
| POST | `/api/v1/auth/login` | Login vendedor → JWT 24h |
| GET | `/api/v1/catalog` | Catálogo 397 productos (Redis cache 1h) |
| GET | `/api/v1/product/:id/image` | Proxy imagen desde Odoo (cache 24h) |

### Con JWT (`Authorization: Bearer <token>`)
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/v1/sync/initial` | Catálogo completo para sync inicial |
| GET | `/api/v1/routes/today` | Ruta del día del vendedor |
| GET | `/api/v1/routes/:fecha` | Ruta de una fecha específica (YYYY-MM-DD) |
| PATCH | `/api/v1/routes/:ruta_uuid/stops/:parada_id` | Actualizar estado/orden de parada |
| POST | `/api/v1/sync/push` | Recibir batch de eventos offline desde Flutter |
| GET | `/api/v1/sync/status?uuids=...` | Consultar estado de eventos por UUID |
| PATCH | `/api/v1/vendors/location` | Reportar ubicación GPS (guarda en Redis TTL 2h) |

### Solo supervisor/admin
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/v1/supervisor/team/locations` | Mapa en tiempo real de todos los vendedores |

### Pendiente de implementar (CRÍTICO)
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/v1/visits` | Checkin/checkout de visita |
| POST | `/api/v1/orders` | Crear pedido (líneas de productos) |
| POST | `/api/v1/payments` | Registrar cobro |
| POST | `/api/v1/photos/upload` | Upload chunked de foto |
| POST | `/api/v1/auth/refresh` | Renovar JWT con refresh token |

---

## 8. AUTH — CÓMO FUNCIONA EL JWT

### Login
```
POST /api/v1/auth/login
Body: { "email": "bot_ventas@leiros.com", "password": "123456" }

Response: {
  "token": "<JWT>",
  "vendedor": { "uuid": "...", "nombre": "...", "email": "...", "zona": "Caracas" }
}
```

### Payload del JWT
```json
{
  "vendedor_id": 1,
  "uuid": "<uuid>",
  "email": "bot_ventas@leiros.com",
  "role": "vendedor",
  "iat": ...,
  "exp": ...  // 24 horas
}
```

### Roles posibles
- `vendedor` — acceso a sus propios datos
- `supervisor` — acceso a ubicaciones del equipo (falta columna `rol` en tabla `vendedores`)
- `admin` — igual que supervisor

---

## 9. BULL MQ — COLA OFFLINE

### Arquitectura
```
Flutter (offline)
  └── genera client_uuid (UUID v4) por evento
  └── guarda en SQLite local

Flutter (con red)
  └── POST /sync/push [{ client_uuid, tipo, payload }]
      └── Gateway → INSERT outbox (PENDING)
      └── Gateway → addJob BullMQ (jobId = client_uuid → idempotente)
          └── Worker → UPDATE outbox (SENDING) → llama Odoo
              ✅ → UPDATE outbox (DONE), UPDATE pedidos.odoo_order_id
              ❌ → backoff exponencial: 30s→60s→120s→300s→600s
              ❌×5 → UPDATE outbox (DEAD), supervisor interviene
```

### Cola y prioridades
```
Cola: nexus-outbox (en Redis)
  P0 — ORDER_CREATED      priority: 10  (CRÍTICO)
  P0 — PAYMENT_RECORDED   priority: 10  (CRÍTICO)
  P1 — VISIT_CHECKIN      priority: 7
  P1 — VISIT_CLOSED       priority: 7
  P3 — PHOTO_UPLOADED     priority: 3   (background)
```

### Circuit breaker
- 3 fallos consecutivos hacia Odoo → abre el circuit, pausa 60s
- Al reabrir → resetea contador
- Evita que un Odoo caído vacíe todos los reintentos

### Validación de precios en ORDER_CREATED
```
Por cada línea del pedido:
  precio del vendedor vs. Redis hash "prices:{product_id}"
  diferencia < 5%  → enviar a Odoo sin problema
  diferencia > 5%  → outbox.estado = PENDING_REVIEW
                     pedidos.precio_conflicto = [{product_id, precio_vendedor, precio_actual, diferencia_pct}]
                     NO se envía a Odoo → supervisor debe resolver
```

---

## 10. CÓMO EL GATEWAY HABLA CON ODOO

```javascript
// Autenticación de sesión Odoo
POST https://19brandia.odoo.com/web/session/authenticate
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "db": "equinocciodev-gleiros-19-0-staging3-29334581",
    "login": "bot_nexus@leiros.com",
    "password": "NexusBot2026!"
  }
}
// Guarda la cookie de sesión en odooSession

// Llamadas al ORM de Odoo
POST https://19brandia.odoo.com/web/dataset/call_kw
Headers: { Cookie: <odooSession> }
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "sale.order",
    "method": "create",
    "args": [{ "partner_id": 123, "order_line": [...] }],
    "kwargs": {}
  }
}
```

### Modelos Odoo usados por el gateway
| Modelo Odoo | Para qué |
|-------------|----------|
| `product.product` | Catálogo de productos |
| `ir.attachment` | Buscar imágenes de productos |
| `sale.order` | Crear y confirmar pedidos |
| `account.payment` | Registrar cobros |
| `account.journal` | Buscar journal de caja/banco |
| `field.visit` | Registrar visitas (requiere módulo nexus_field instalado) |

---

## 11. MÓDULO ODOO — nexus_field (PENDIENTE DE SUBIR)

### Ubicación en el servidor
```
/opt/nexus_gateway/odoo_module/nexus_field/
```

### Estructura de archivos
```
nexus_field/
├── __init__.py
├── __manifest__.py          ← metadata del módulo
├── models/
│   ├── __init__.py
│   └── nexus_config.py      ← modelo nexus.config (URL + token + intervalo)
├── views/
│   ├── nexus_menu.xml       ← menú "NEXUS Field" en Odoo
│   └── nexus_map_view.xml   ← template del mapa
└── static/src/js/
    └── nexus_map.js         ← componente OWL + Leaflet.js
```

### Qué hace el módulo
1. Agrega un menú "NEXUS Field" en Odoo con dos submenús:
   - **Mapa en Tiempo Real** — mapa Leaflet que muestra todos los vendedores activos
   - **Configuración** — formulario para configurar URL del gateway + token supervisor

2. El mapa llama al gateway cada 30s:
   ```
   GET /api/v1/supervisor/team/locations
   Authorization: Bearer <token_supervisor_de_config>
   ```

3. Colores en el mapa:
   - 🟢 Verde: `en_cliente` (está en una visita)
   - 🔵 Azul: `en_ruta` (en tránsito)
   - ⚫ Gris: `sin_senal` (no reporta hace >0 min)

### Odoo staging para instalar
```
URL:    https://19brandia.odoo.com
DB:     equinocciodev-gleiros-19-0-staging3-29334581
```

### Cómo instalar (cuando esté en GitHub)
1. Subir `nexus_field/` al repo GitHub conectado a Odoo.sh
2. Push → rebuild automático en Odoo.sh
3. Odoo Apps → buscar "NEXUS Field" → Instalar
4. Ir a NEXUS Field → Configuración → ingresar URL del gateway + JWT supervisor

### Modelo `nexus.config`
```python
class NexusConfig(models.Model):
    _name = 'nexus.config'
    _description = 'Configuración NEXUS Gateway'

    name            = fields.Char(default='NEXUS Gateway', readonly=True)
    gateway_url     = fields.Char(default='https://77-42-71-221.sslip.io')
    refresh_interval = fields.Integer(default=30)   # segundos
    supervisor_token = fields.Char(required=True)   # JWT de supervisor
```

---

## 12. MODELO field.visit EN ODOO (PENDIENTE — LO HACE LENN)

El procesador `queues/processors/visit.js` intenta crear registros en Odoo con este modelo:

```javascript
odooCall('field.visit', 'create', [{
  partner_id:         cliente_odoo_id,    // res.partner.id
  checkin_lat:        checkin_lat,        // NUMERIC
  checkin_lng:        checkin_lng,        // NUMERIC
  checkin_datetime:   checkin_at,         // TIMESTAMPTZ (ISO 8601)
  checkout_datetime:  checkout_at,        // TIMESTAMPTZ (ISO 8601)
  notes:              notas,              // TEXT
  nexus_uuid:         clientUuid          // UUID del outbox (para idempotencia)
}])
```

**Si el modelo no existe en Odoo, el gateway NO falla** — el error se silencia y la visita se guarda solo en PostgreSQL. Cuando el módulo esté instalado, empezará a replicar automáticamente.

### Lo que Lenn necesita construir en el módulo
1. **Modelo `field.visit`** con los campos que el gateway espera:
   - `partner_id` — Many2one a `res.partner`
   - `checkin_lat`, `checkin_lng` — Float
   - `checkin_datetime`, `checkout_datetime` — Datetime
   - `notes` — Text
   - `nexus_uuid` — Char (UNIQUE, para idempotencia)
   - `vendor_name` — Char (para mostrar en Odoo, llenar desde gateway)

2. **Vista lista** de visitas de campo en Odoo (filtrable por fecha, vendedor, cliente)

3. **Vista formulario** de cada visita con mapa embebido si hay coordenadas

4. Agregarlo al menú NEXUS Field → "Visitas de Campo"

---

## 13. CRONS PENDIENTES DE IMPLEMENTAR

| Cron | Hora | Qué hace | Prioridad |
|------|------|---------|-----------|
| Generador de rutas | 4:00 AM diario | Por cada vendedor activo: busca clientes de su zona, crea rutas + paradas ordenadas por distancia | CRÍTICO |
| Sync catálogo Odoo | Cada 1h | Actualiza `catalog:products` en Redis | ALTO |
| Sync precios | Cada 30min | Actualiza hash `prices` en Redis con precios actuales de Odoo | ALTO |
| Sync clientes | Cada 6h | Sincroniza `res.partner` de Odoo → tabla `clientes` | ALTO |
| Reconciliación outbox | Cada 6h | Reintentar eventos DEAD, alertar supervisor | ALTO |

---

## 14. FLUJO COMPLETO DE UNA VENTA (referencia)

```
1. SYNC INICIAL (primera vez o diario)
   Flutter → GET /sync/initial → Redis → 397 productos en Drift SQLite

2. RUTA DEL DÍA
   Flutter → GET /routes/today → PostgreSQL → lista de clientes a visitar

3. CHECKIN EN CLIENTE
   Flutter detecta geofence 100m → genera UUID → guarda en outbox local
   Con red → POST /sync/push { tipo: VISIT_CHECKIN, ... }
   Gateway → INSERT outbox + INSERT visitas + BullMQ

4. TOMAR PEDIDO (offline)
   Vendedor registra pedido en la app → guarda en SQLite con UUID
   Con red → POST /sync/push { tipo: ORDER_CREATED, lines: [...] }
   BullMQ Worker → valida precios → crea sale.order en Odoo

5. COBRAR (offline)
   Vendedor registra pago → UUID → SQLite
   Con red → POST /sync/push { tipo: PAYMENT_RECORDED, monto: X }
   BullMQ Worker → crea account.payment en Odoo → action_post

6. CHECKOUT
   Flutter → POST /sync/push { tipo: VISIT_CLOSED }
   Worker → UPDATE visitas.estado = cerrada → field.visit en Odoo (si módulo instalado)

7. SUPERVISOR VE EN TIEMPO REAL
   Odoo → módulo nexus_field → mapa Leaflet
   Cada 30s → GET /supervisor/team/locations → Redis → pines en el mapa
```

---

## 15. REPOSITORIOS

```
Gateway:      github.com/siberia-dev-sui/nexus_gateway
Flutter app:  /Users/siberia/Desktop/lerios_crm  (local del dev)
```

---

## 16. DEUDA TÉCNICA PRIORIZADA (estado al 13/04/2026)

| # | Tarea | Prioridad | Bloqueante para |
|---|-------|-----------|----------------|
| 1 | Cron sync clientes Odoo → tabla `clientes` | CRÍTICO | Todo el flujo de rutas (FK constraint) |
| 2 | Cron 4AM generador de rutas diarias | CRÍTICO | Navegación de campo |
| 3 | POST /api/v1/visits (checkin/checkout) | CRÍTICO | Registrar presencia en cliente |
| 4 | POST /api/v1/orders (crear pedido) | CRÍTICO | Ventas |
| 5 | POST /api/v1/payments (registrar cobro) | CRÍTICO | Cobros |
| 6 | POST /api/v1/auth/refresh (renovar JWT) | ALTO | Sesión dura solo 24h |
| 7 | Cron catálogo delta 1h + precios 30min | ALTO | Precios actualizados |
| 8 | Cron reconciliación outbox DEAD (6h) | ALTO | Supervisión de errores |
| 9 | Modelo field.visit en módulo Odoo | ALTO | **Lenn** — sync visitas a Odoo |
| 10 | Subir nexus_field a GitHub → Odoo.sh | MEDIO | Mapa supervisor en Odoo |
| 11 | Columna `rol` en tabla `vendedores` | MEDIO | Diferenciación supervisor/vendedor |
| 12 | POST /photos/upload chunked | MEDIO | Evidencia fotográfica de cobros |
| 13 | Dashboard admin web /admin | MEDIO | Gestión interna |

---

## 17. NOTAS PARA LENN — MÓDULO ODOO

### Qué existe hoy en `/opt/nexus_gateway/odoo_module/nexus_field/`
El módulo ya tiene lo básico: menú, mapa Leaflet, modelo `nexus.config`. Funciona para ver vendedores en el mapa.

**Lo que falta y necesitas agregar:**

### 1. Modelo `field.visit` (prioridad máxima)
El gateway ya tiene el código que lo llama (en `queues/processors/visit.js`). Solo hace falta que el modelo exista en Odoo. El gateway fallará silenciosamente si no existe, pero las visitas no se verán en Odoo.

Campos mínimos requeridos:
```python
class FieldVisit(models.Model):
    _name = 'field.visit'
    _description = 'Visita de campo NEXUS'

    partner_id        = fields.Many2one('res.partner', required=True)
    nexus_uuid        = fields.Char(index=True)    # UUID único del gateway
    checkin_lat       = fields.Float(digits=(10,7))
    checkin_lng       = fields.Float(digits=(10,7))
    checkin_datetime  = fields.Datetime()
    checkout_datetime = fields.Datetime()
    notes             = fields.Text()
    vendor_name       = fields.Char()              # nombre del vendedor para referencia
```

### 2. El módulo es Odoo 17 (staging en odoo.com)
El staging es `https://19brandia.odoo.com` con Odoo 17/19. Usar OWL para componentes JS.

### 3. El gateway crea `field.visit` con estos datos exactos
```python
{
    'partner_id':         <int>,       # res.partner.id del cliente
    'checkin_lat':        <float>,
    'checkin_lng':        <float>,
    'checkin_datetime':   <str ISO>,   # "2026-04-10T09:30:00Z"
    'checkout_datetime':  <str ISO>,
    'notes':              <str>,
    'nexus_uuid':         <str UUID>   # para idempotencia
}
```

### 4. El campo `nexus_uuid` debe ser UNIQUE
Para evitar duplicados si el gateway reintenta (idempotencia):
```python
_sql_constraints = [
    ('nexus_uuid_unique', 'UNIQUE(nexus_uuid)', 'UUID duplicado')
]
```

---

## 18. ESTADO DE BOTS/ATAQUES (info de seguridad)

Los logs muestran ataques constantes al servidor que todos devuelven 404:
- PHP injection via ThinkPHP (`/index.php?s=/index/\\think...`)
- File inclusion via pearcmd
- Docker API scan (`/containers/json`)
- WebDAV (`PROPFIND /`)

Todo normal para un servidor público. fail2ban los banea automáticamente.

---

*Documento generado: 13 abril 2026 | Gateway: /opt/nexus_gateway/docs/NEXUS_CONTEXT_LLM.md*
