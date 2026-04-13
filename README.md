# NEXUS Gateway

API Gateway para la plataforma móvil offline-first de Grupo Leiros. Actúa como capa de intermediación entre la app Flutter de los 120 vendedores de campo y Odoo Enterprise.

---

## El problema que resuelve

Grupo Leiros operaba con 120 licencias de Odoo para sus vendedores de campo: **$4,560/mes**. NEXUS reemplaza ese modelo con una app propia + 1 solo usuario bot en Odoo.

**Costo nuevo: ~$50/mes. Ahorro: $54,120/año.**

---

## Arquitectura

```
┌─────────────────┐        ┌──────────────────────┐        ┌─────────────────┐
│   Flutter App   │◄──────►│   NEXUS Gateway      │◄──────►│  Odoo Enterprise│
│  (120 vendors)  │  HTTPS │  Fastify + PG + Redis│JSON-RPC│  (1 bot account)│
└─────────────────┘        └──────────────────────┘        └─────────────────┘
        │                           │
   SQLite local               BullMQ Queue
   (offline-first)            (async → Odoo)
```

### Principio clave: 1 bot, 120 vendedores

Odoo solo conoce al bot `bot_nexus@leiros.com`. Los 120 vendedores existen únicamente en el PostgreSQL del gateway. Pedidos, pagos y visitas se crean en Odoo a nombre del bot con referencia al vendedor real.

### Comunicación — solo en un sentido

**El gateway llama a Odoo. Odoo nunca llama al gateway.**

```
Gateway → Odoo (JSON-RPC):
  JALA: catálogo, precios, clientes, empleados (crons periódicos)
  EMPUJA: pedidos, pagos, visitas (BullMQ workers)

Odoo → Gateway: nunca
```

Esto es intencional. Odoo permanece sin configuración especial — solo necesita el usuario bot.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js v20, Fastify 4 |
| Base de datos | PostgreSQL 16 |
| Cache | Redis 7 |
| Cola async | BullMQ 5 |
| Protocolo Odoo | JSON-RPC (`/web/dataset/call_kw`) |
| Infra | Hetzner CX22, Docker Compose, Nginx, Let's Encrypt |

---

## Estructura del proyecto

```
nexus_gateway/
├── server.js               ← punto de entrada, todos los endpoints HTTP
├── db.js                   ← pool PostgreSQL + cliente Redis
├── db/
│   └── schema.sql          ← 10 tablas, ejecutar una vez al inicializar
├── queues/
│   ├── index.js            ← definición de la cola BullMQ + prioridades
│   ├── worker.js           ← worker principal + circuit breaker
│   └── processors/
│       ├── order.js        ← ORDER_CREATED → sale.order en Odoo
│       ├── payment.js      ← PAYMENT_RECORDED → account.payment en Odoo
│       └── visit.js        ← VISIT_CLOSED → field.visit en Odoo
├── crons/
│   └── sync_vendors.js     ← sync hr.employee de Odoo → tabla vendedores (cada 1h)
├── odoo_module/
│   └── nexus_field/        ← módulo Odoo: mapa Leaflet en tiempo real
├── nginx/
│   └── nginx.conf          ← proxy HTTPS → gateway:3000
├── docker-compose.yml
├── Dockerfile
└── docs/
    └── sessions/           ← bitácora de sesiones de trabajo
```

---

## Base de datos — 10 tablas

```
vendedores       ← 120 vendedores de campo (Odoo no los conoce)
refresh_tokens   ← sesiones activas por dispositivo
clientes         ← espejo de res.partner de Odoo (sync cada 6h)
rutas            ← plan diario generado a las 4AM por cron
paradas          ← clientes a visitar en cada ruta
visitas          ← registro completo de cada visita de campo
outbox           ← cola transaccional offline-first (corazón del sistema)
pedidos          ← referencia cruzada outbox ↔ Odoo sale.order
pagos            ← cobros registrados en campo
fotos            ← metadata de uploads chunked
```

---

## Comunicación con Odoo

Todo pasa por dos funciones en `server.js`:

```javascript
// Autenticación — guarda la cookie de sesión del bot
odooAuth()

// Operación ORM — cualquier modelo, cualquier método
odooCall(model, method, args, kwargs)
```

**Ejemplo — crear un pedido:**
```javascript
const orderId = await odooCall('sale.order', 'create', [{
  partner_id:      123,
  order_line:      [[0, 0, { product_id: 45, product_uom_qty: 2, price_unit: 100 }]],
  client_order_ref: clientUuid   // UUID del teléfono para idempotencia
}])
await odooCall('sale.order', 'action_confirm', [[orderId]])
```

Si la sesión expira, el gateway se re-autentica automáticamente y reintenta.

---

## Flujo offline-first

```
1. Vendedor trabaja sin internet
   └── App guarda eventos en SQLite local con UUID único por evento

2. Vuelve la señal
   └── Flutter → POST /api/v1/sync/push [{ client_uuid, tipo, payload }]

3. Gateway recibe el batch
   └── INSERT outbox (PENDING) — idempotente por client_uuid
   └── addJob BullMQ — mismo UUID como jobId (nunca se duplica)

4. BullMQ Worker procesa
   └── UPDATE outbox (SENDING)
   └── Llama a Odoo JSON-RPC
   └── ✅ UPDATE outbox (DONE) + referencia Odoo guardada
   └── ❌ Backoff exponencial: 30s → 60s → 120s → 300s → 600s
   └── ❌×5 UPDATE outbox (DEAD) → supervisor interviene

5. Flutter consulta el resultado
   └── GET /api/v1/sync/status?uuids=uuid1,uuid2,...
```

### Prioridades de la cola

| Tipo de evento | Prioridad | Motivo |
|----------------|-----------|--------|
| ORDER_CREATED | P0 (10) | Venta — impacto directo en facturación |
| PAYMENT_RECORDED | P0 (10) | Cobro — liquidez |
| VISIT_CHECKIN / VISIT_CLOSED | P1 (7) | Operación de campo |
| PHOTO_UPLOADED | P3 (3) | Evidencia — puede esperar |

### Circuit breaker

Si Odoo falla 3 veces seguidas → pausa automática de 60 segundos. Evita vaciar los reintentos contra un Odoo caído.

---

## Endpoints activos

| Método | Endpoint | Auth | Descripción |
|--------|----------|------|-------------|
| GET | `/api/v1/health` | No | Healthcheck |
| POST | `/api/v1/auth/login` | No | Login vendedor → JWT 24h |
| GET | `/api/v1/catalog` | No | Catálogo productos (Redis 1h) |
| GET | `/api/v1/product/:id/image` | No | Imagen desde Odoo (cache 24h) |
| GET | `/api/v1/sync/initial` | JWT | Catálogo completo para sync |
| POST | `/api/v1/sync/push` | JWT | Recibir eventos offline desde Flutter |
| GET | `/api/v1/sync/status` | JWT | Estado de eventos por UUID |
| GET | `/api/v1/routes/today` | JWT | Ruta del día |
| GET | `/api/v1/routes/:fecha` | JWT | Ruta por fecha |
| PATCH | `/api/v1/routes/:ruta_uuid/stops/:parada_id` | JWT | Actualizar parada |
| PATCH | `/api/v1/vendors/location` | JWT | Reportar GPS (Redis TTL 2h) |
| GET | `/api/v1/supervisor/team/locations` | JWT supervisor | Mapa en tiempo real |

---

## Crons

| Cron | Frecuencia | Estado |
|------|-----------|--------|
| Sync vendedores desde `hr.employee` | Cada 1h | Activo |
| Sync catálogo productos | Cada 1h | Pendiente |
| Sync precios | Cada 30min | Pendiente |
| Sync clientes (`res.partner`) | Cada 6h | Pendiente |
| Generador de rutas diarias | 4AM diario | Pendiente |
| Reconciliación outbox DEAD | Cada 6h | Pendiente |

---

## Sync de vendedores desde Odoo

Los vendedores se crean en Odoo como `hr.employee` y el gateway los importa automáticamente cada hora.

**Campos necesarios en `hr.employee` (módulo nexus_field):**

```python
es_vendedor_nexus = fields.Boolean(string='Vendedor NEXUS', default=False)
nexus_zona        = fields.Char(string='Zona NEXUS')
```

**Lógica del cron:**
- Empleado nuevo marcado → INSERT en `vendedores` + password temporal en logs
- Empleado modificado → UPDATE nombre, email, zona
- Empleado desmarcado → `vendedores.activo = false` → JWT inválido en próximo request

Si los campos no existen aún en Odoo, el cron hace fallback a todos los empleados activos.

---

## Módulo Odoo — nexus_field

Ubicación: `odoo_module/nexus_field/`

Agrega en Odoo:
- Menú **NEXUS Field** con mapa Leaflet en tiempo real
- Marcadores por vendedor: verde (en cliente), azul (en tránsito), gris (sin señal)
- Actualización cada 30 segundos via fetch al gateway
- Modelo `nexus.config` para configurar URL del gateway y token supervisor

**El mapa llama al gateway desde el browser del supervisor — no desde el servidor de Odoo.**

---

## Variables de entorno

```env
# Gateway
JWT_SECRET=
PORT=3000

# PostgreSQL
POSTGRES_URL=postgresql://nexus:<password>@nexus_postgres:5432/nexus
POSTGRES_PASSWORD=

# Redis
REDIS_URL=redis://:<password>@nexus_redis:6379
REDIS_PASSWORD=

# Odoo
ODOO_URL=https://19brandia.odoo.com
ODOO_DB=
ODOO_BOT_EMAIL=bot_nexus@leiros.com
ODOO_BOT_PASSWORD=
```

---

## Levantar en local / servidor

```bash
# Instalar dependencias
npm install

# Levantar todo con Docker Compose
docker compose up --build -d

# Ver logs del gateway
docker logs nexus_gateway -f

# Ejecutar schema SQL (primera vez)
docker exec -i nexus_postgres psql -U nexus -d nexus < db/schema.sql
```

---

## Para el equipo de Odoo (Lenn)

El gateway consume Odoo via JSON-RPC con 1 cuenta bot. No requiere configuración especial en Odoo ni webhooks.

Lo que el módulo `nexus_field` necesita exponer:

1. **`hr.employee`** — campos `es_vendedor_nexus` y `nexus_zona` para que el cron importe vendedores
2. **`field.visit`** — modelo con campos `partner_id`, `checkin_lat`, `checkin_lng`, `checkin_datetime`, `checkout_datetime`, `notes`, `nexus_uuid` (UNIQUE) para recibir visitas del gateway
3. **El JS del mapa** ya está construido en `nexus_map.js` — solo necesita instalarse

El gateway maneja el resto. Odoo no necesita llamar a nadie.
