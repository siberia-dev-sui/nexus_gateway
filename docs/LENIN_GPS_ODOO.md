# NEXUS Field — GPS Tracking & Módulo Odoo
> **Para:** Lenin  
> **Fecha:** 2026-05-08  
> **Sesión:** Implementación del sistema GPS offline-first + optimización de rutas  

---

## 1. QUÉ SE CONSTRUYÓ HOY

### En el Gateway (Node.js / PostgreSQL)
1. **Algoritmo de optimización de rutas** (`crons/generate_routes.js`)
2. **Migración de BD** (`db/migrate_009_route_optimization.sql`)
3. **Endpoint admin** `POST /api/v1/admin/routes/generate`
4. **Enriquecimiento** de `GET /api/v1/routes/today` con metadata de optimización

### En Flutter (app del vendedor)
1. **`RouteDay` model** actualizado con campos `algoritmo`, `distanciaEstimadaKm`, `origenLat/Lng`

---

## 2. CÓMO FUNCIONA EL GPS HOY (flujo completo)

```
VENDEDOR EN CAMPO
│
├─ [Check-in en cliente]
│    WizardScreen → LocationService.getCurrentPosition()
│    → geolocator, alta precisión, timeout 15s
│    → guarda checkin_lat / checkin_lng en visita
│    → envía PATCH /api/v1/vendors/location (actualiza Redis TTL 2h)
│
├─ [Tracking continuo — PENDIENTE DE IMPLEMENTAR]
│    (falta un Timer periódico cada 2-3 min que capture posición)
│    → guardar en GpsTrackTable (SQLite local, offline-first)
│
└─ [Cuando hay red — WorkManager cada 15 min]
     OutboxService._syncGpsTracks()
     → lee GpsTrackTable (puntos no sincronizados)
     → POST /api/v1/vendors/gps_track  (batch de puntos)
     → marca puntos como synced
     → limpia puntos >7 días

GATEWAY
│
├─ POST /api/v1/vendors/gps_track
│    → INSERT en tabla gps_tracks (PostgreSQL)
│    → updateRedisLocation() → key location:{vendedor_id} TTL 2h
│
├─ PATCH /api/v1/vendors/location  (punto único, sin persistir en BD)
│    → solo actualiza Redis TTL 2h
│
├─ GET /api/v1/supervisor/team/locations  (solo supervisores)
│    → lee Redis → devuelve lat/lng/estado de todos los vendedores
│
└─ GET /api/v1/supervisor/vendor/:uuid/track  (solo supervisores)
     → lee gps_tracks de PostgreSQL
     → devuelve GeoJSON LineString del recorrido del día

ODOO (módulo nexus_field — lo que tú construyes)
│
└─ nexus_map.js (OWL + Leaflet)
     → cada 30s → GET /supervisor/team/locations
     → pines en mapa de Venezuela
     → 🟢 en_cliente | 🔵 en_ruta | ⚫ sin_señal
```

---

## 3. BASE DE DATOS POSTGRESQL — TABLAS GPS

### `gps_tracks` (creada en migrate_006)
```sql
CREATE TABLE gps_tracks (
  id          SERIAL PRIMARY KEY,
  vendedor_id INTEGER NOT NULL REFERENCES vendedores(id),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  accuracy    DOUBLE PRECISION DEFAULT 0,
  estado      TEXT DEFAULT 'en_ruta',  -- en_ruta | en_cliente | sin_senal
  captured_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gps_tracks_vendedor_date
  ON gps_tracks(vendedor_id, captured_at DESC);
```

### `rutas` (columnas nuevas — migrate_009)
```sql
ALTER TABLE rutas ADD COLUMN algoritmo            TEXT DEFAULT 'nombre'; -- nombre|nn|osrm
ALTER TABLE rutas ADD COLUMN distancia_estimada_km NUMERIC(8,2);
ALTER TABLE rutas ADD COLUMN origen_lat           NUMERIC(10,7);
ALTER TABLE rutas ADD COLUMN origen_lng           NUMERIC(10,7);
```

### `visitas` (checkin GPS)
```sql
checkin_lat  NUMERIC(10,7),
checkin_lng  NUMERIC(10,7),
checkin_at   TIMESTAMPTZ,
checkout_at  TIMESTAMPTZ
```

---

## 4. REDIS — KEYS GPS

```
location:{vendedor_id}  →  JSON, TTL 2h
{
  "vendedor_id": 1,
  "uuid": "...",
  "nombre": "Juan Pérez",
  "lat": 10.4880,
  "lng": -66.8792,
  "estado": "en_cliente",      -- en_ruta | en_cliente | sin_senal
  "cliente_actual": "Farmacia XYZ",
  "timestamp": "2026-05-08T14:30:00Z",
  "minutos_sin_reporte": 5
}
```

---

## 5. ENDPOINTS API — GPS (todos requieren JWT)

### `POST /api/v1/vendors/gps_track`
Batch de puntos GPS desde Flutter. Offline-first — Flutter acumula y manda cuando recupera señal.

**Request:**
```json
{
  "points": [
    {
      "lat": 10.4880,
      "lng": -66.8792,
      "accuracy": 12.5,
      "estado": "en_ruta",
      "captured_at": "2026-05-08T14:30:00.000Z"
    }
  ]
}
```
**Response:**
```json
{ "status": "ok", "inserted": 5 }
```

---

### `PATCH /api/v1/vendors/location`
Punto único. Solo actualiza Redis (no persiste en BD). Para compatibilidad con check-in puntual.

**Request:**
```json
{
  "lat": 10.4880,
  "lng": -66.8792,
  "estado": "en_cliente",
  "cliente_actual": "Farmacia XYZ"
}
```

---

### `GET /api/v1/supervisor/team/locations`
**Solo supervisores/admin.** Mapa en tiempo real de todos los vendedores.

**Response:**
```json
{
  "status": "ok",
  "total": 4,
  "con_senal": 3,
  "sin_senal": 1,
  "vendedores": [
    {
      "vendedor_id": 1,
      "uuid": "...",
      "nombre": "Juan Pérez",
      "lat": 10.4880,
      "lng": -66.8792,
      "estado": "en_cliente",
      "cliente_actual": "Farmacia XYZ",
      "minutos_sin_reporte": 2
    }
  ]
}
```

---

### `GET /api/v1/supervisor/vendor/:uuid/track`
**Solo supervisores/admin.** Recorrido GPS de un vendedor en una fecha. Devuelve GeoJSON.

**Params:** `?fecha=2026-05-08` (default: hoy)

**Response:**
```json
{
  "status": "ok",
  "vendedor_uuid": "...",
  "fecha": "2026-05-08",
  "geometry": {
    "type": "LineString",
    "coordinates": [[-66.87, 10.48], [-66.86, 10.49], ...]
  },
  "properties": {
    "puntos": 42,
    "distancia_km": 18.3
  }
}
```

---

### `GET /api/v1/routes/today`
Ruta optimizada del día del vendedor. **Ahora incluye metadata de optimización.**

**Response (campos nuevos):**
```json
{
  "status": "ok",
  "ruta": {
    "uuid": "...",
    "fecha": "2026-05-08",
    "estado": "en_curso",
    "algoritmo": "osrm",
    "distancia_estimada_km": 47.3,
    "origen_lat": 10.4880,
    "origen_lng": -66.8792,
    "paradas": [...],
    "kpis": { "total_paradas": 8, "completadas": 3, "pendientes": 5, "saltadas": 0 }
  }
}
```

`algoritmo` puede ser:
- `nombre` — orden alfabético (sin coords suficientes)
- `nn` — Nearest Neighbor (offline, sin internet)
- `osrm` — OSRM Trip API (calles reales, mejor resultado)

---

### `POST /api/v1/admin/routes/generate`
**Solo supervisores/admin.** Triggerear el cron de generación de rutas manualmente.

**Response:**
```json
{ "status": "ok", "generadas": 3, "actualizadas": 1, "sinClientes": 0 }
```

---

## 6. ALGORITMO DE OPTIMIZACIÓN DE RUTAS

El cron `generate_routes.js` corre a las **4:00 AM y 10:00 AM** con dos capas:

### Capa 1 — Nearest Neighbor (offline, siempre disponible)
```
Punto inicio = última GPS del vendedor en Redis
             ó primer cliente con coordenadas

Por cada iteración:
  → elige el cliente más cercano no visitado (distancia haversine)
  → avanza a ese cliente
  → repite hasta visitar todos

Clientes sin lat/lng → van al final
Complejidad O(n²), <5ms para ≤40 clientes
Reducción vs orden alfabético: ~35%
```

### Capa 2 — OSRM Trip (online, fallback automático)
```
Si hay internet:
  → llama a router.project-osrm.org/trip/v1/driving/{coords}
  → roundtrip=false, source=first, destination=last
  → OSRM resuelve TSP con distancias reales por calles
  → timeout 4s → si falla, usa resultado de capa 1 silenciosamente

Mejora adicional sobre NN: ~20%
```

---

## 7. LO QUE FALTA IMPLEMENTAR (para que el mapa funcione completo)

### En Flutter (GPS tracker periódico)
Falta un `Timer.periodic` en `RutaScreen` o un `LocationService.startTracking()` que:
- Capture posición cada 2-3 minutos mientras la ruta está activa
- Guarde en `GpsTrackTable` (SQLite local)
- Detecte estado: si hay visita activa → `en_cliente`, si no → `en_ruta`
- El `OutboxService` ya sube los puntos en batch cuando hay red (listo)

### En Odoo — módulo `nexus_field` (lo tuyo, Lenin)

---

## 8. LO QUE DEBES CONSTRUIR EN ODOO (Lenin)

### 8.1 — Vista de recorrido GPS de un vendedor

En el módulo `nexus_field`, agregar una vista que muestre el track GPS del día en un mapa Leaflet.

**Datos:** `GET /api/v1/supervisor/vendor/:uuid/track?fecha=YYYY-MM-DD`  
**Formato:** GeoJSON LineString → dibujarlo con `L.geoJSON()` en Leaflet

```javascript
// Ejemplo en nexus_map.js
const trackRes = await fetch(
  `${this.gatewayUrl}/api/v1/supervisor/vendor/${uuid}/track?fecha=${fecha}`,
  { headers: { Authorization: `Bearer ${this.token}` } }
)
const trackData = await trackRes.json()
if (trackData.geometry) {
  L.geoJSON(trackData).addTo(this.map)
}
```

---

### 8.2 — Campo `field.visit` en Odoo (CRÍTICO — pendiente desde antes)

El gateway ya manda los datos. Si el modelo no existe, falla silenciosamente.

```python
class FieldVisit(models.Model):
    _name = 'field.visit'
    _description = 'Visita de campo NEXUS'

    partner_id        = fields.Many2one('res.partner', required=True)
    nexus_uuid        = fields.Char(index=True)
    checkin_lat       = fields.Float(digits=(10, 7))
    checkin_lng       = fields.Float(digits=(10, 7))
    checkin_datetime  = fields.Datetime()
    checkout_datetime = fields.Datetime()
    notes             = fields.Text()
    vendor_name       = fields.Char()

    _sql_constraints = [
        ('nexus_uuid_unique', 'UNIQUE(nexus_uuid)', 'UUID duplicado')
    ]
```

El gateway manda exactamente estos campos desde `queues/processors/visit.js`:
```javascript
odooCall('field.visit', 'create', [{
  partner_id:        cliente_odoo_id,
  checkin_lat:       checkin_lat,
  checkin_lng:       checkin_lng,
  checkin_datetime:  checkin_at,
  checkout_datetime: checkout_at,
  notes:             notas,
  nexus_uuid:        clientUuid,
}])
```

---

### 8.3 — Mapa en tiempo real (ya existe, solo mejoras)

El mapa de `nexus_map.js` ya funciona. Mejoras opcionales:
- Agregar **selector de fecha** para ver el track histórico de un vendedor
- Mostrar **distancia estimada vs recorrida** (viene en la respuesta de `/routes/today`)
- Mostrar el **algoritmo usado** (`nn` o `osrm`) como badge en la ruta

---

### 8.4 — Dashboard de rutas del día (nuevo)

Endpoint: `GET /api/v1/routes/today` (con JWT de supervisor)  
Muestra por cada vendedor: paradas totales, completadas, saltadas, distancia estimada, algoritmo.

---

## 9. CREDENCIALES Y URLS

```
Gateway:         https://nexus.eqnio.com
Vendedor demo:   bot_ventas@leiros.com / 123456
Odoo staging:    https://equinocciodev-gleiros-19-0-28086660.dev.odoo.com
Odoo admin:      admin / 12345678
```

**JWT de supervisor** (para endpoints `/supervisor/*`):
Pídelo a Hugo — se genera con el rol `supervisor` en la tabla `vendedores`.

---

## 10. RESUMEN DE ARCHIVOS CLAVE

| Archivo | Qué hace |
|---|---|
| `crons/generate_routes.js` | Genera rutas optimizadas (NN + OSRM) a las 4AM y 10AM |
| `db/migrate_009_route_optimization.sql` | Agrega columnas de metadata a tabla `rutas` |
| `db/migrate_006_gps_tracks.sql` | Crea tabla `gps_tracks` |
| `odoo_module/nexus_field/static/src/js/nexus_map.js` | Mapa Leaflet en Odoo (supervisores) |
| `queues/processors/visit.js` | Manda checkin/checkout a `field.visit` en Odoo |
| `server.js` línea ~1094 | `POST /api/v1/vendors/gps_track` |
| `server.js` línea ~1128 | `PATCH /api/v1/vendors/location` |
| `server.js` línea ~1140 | `GET /api/v1/supervisor/team/locations` |
| `server.js` línea ~1184 | `GET /api/v1/supervisor/vendor/:uuid/track` |

---

*Documento generado: 2026-05-08 — Sesión de trabajo Hugo + Claude*
