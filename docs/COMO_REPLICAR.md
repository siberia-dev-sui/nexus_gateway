# Cómo replicar el servidor NEXUS Gateway (staging)

Este documento explica cómo levantar una copia exacta del servidor de producción
en una máquina nueva, y qué cambiar para que el staging no tenga conflictos con producción.

**Servidor de producción de referencia:**
- IP: `77.42.71.221`
- Dominio: `nexus.eqnio.com`
- Rama: `main`

---

## Qué cambia en staging vs producción

Estos son los únicos puntos donde staging debe diferenciarse de producción.
Todo lo demás es idéntico.

| Qué                  | Producción                                | Staging                          |
|----------------------|-------------------------------------------|----------------------------------|
| Dominio              | `nexus.eqnio.com`                         | dominio nuevo (ej: `staging-nexus.eqnio.com`) |
| IP del servidor      | `77.42.71.221`                            | IP del servidor nuevo            |
| `ODOO_URL`           | `https://equinocciodev-gleiros.odoo.com`  | URL del Odoo de staging          |
| `ODOO_DB`            | `equinocciodev-gleiros-main-13911622`     | DB del Odoo de staging           |
| `JWT_SECRET`         | (valor de producción)                     | **valor distinto** — si es igual, tokens de staging serían válidos en producción |
| `NEXUS_ADMIN_TOKEN`  | (valor de producción)                     | **valor distinto** — mismo motivo |
| `POSTGRES_PASSWORD`  | (valor de producción)                     | puede ser el mismo, es interno   |
| `REDIS_PASSWORD`     | (valor de producción)                     | puede ser el mismo, es interno   |
| Rama git             | `main`                                    | `staging`                        |
| `NEXUS_ENABLE_SYNC_CRONS` | `true`                               | `false` recomendado al inicio para no saturar Odoo de staging |

---

## Paso a paso

### 1. Servidor nuevo — requisitos

- Ubuntu 24.04 LTS
- 2 vCPU, 4 GB RAM (Hetzner CX22 o equivalente)
- Docker + Docker Compose plugin instalados
- Puertos 80 y 443 abiertos
- Un dominio o subdominio apuntando a la IP del servidor nuevo (registro A en DNS)

Instalar Docker si no está:
```bash
curl -fsSL https://get.docker.com | sh
```

---

### 2. Clonar el repositorio en rama staging

```bash
git clone git@github.com:siberia-dev-sui/nexus_gateway.git /opt/nexus_gateway
cd /opt/nexus_gateway
git checkout staging
```

---

### 3. Crear el .env con los valores de staging

```bash
cp .env.example .env
nano .env
```

Completar así — los valores marcados con ⚠️ deben ser distintos a producción:

```env
PORT=3000

# Odoo de STAGING (no el de producción)
ODOO_URL=https://TU-ODOO-STAGING.odoo.com
ODOO_DB=nombre-de-la-db-staging
ODOO_BOT_EMAIL=admin
ODOO_BOT_PASSWORD=contraseña-del-bot-en-odoo-staging

DEMO_EMAIL=bot_ventas@leiros.com

# ⚠️ DISTINTO A PRODUCCIÓN — si es igual, tokens de staging valen en prod
JWT_SECRET=staging-secret-largo-y-aleatorio

# ⚠️ DISTINTO A PRODUCCIÓN — token compartido con el módulo Odoo de staging
NEXUS_ADMIN_TOKEN=staging-admin-token

# PostgreSQL (interno al servidor, puede ser cualquier contraseña)
POSTGRES_PASSWORD=staging-postgres-password
POSTGRES_URL=postgresql://nexus:staging-postgres-password@nexus_postgres:5432/nexus

# Redis (interno al servidor)
REDIS_PASSWORD=staging-redis-password
REDIS_URL=redis://:staging-redis-password@nexus_redis:6379
REDIS_HOST=nexus_redis

# Sync — recomendado false al inicio para no saturar Odoo de staging
NEXUS_AUTO_SYNC_ON_START=false
NEXUS_ENABLE_SYNC_CRONS=false

ENABLE_BULLMQ_WORKER=false
ENFORCE_PRICE_VALIDATION=false
```

---

### 4. Configurar nginx con el dominio de staging

Editar `nginx/nginx.conf` y reemplazar `nexus.eqnio.com` con el dominio de staging:

```bash
nano /opt/nexus_gateway/nginx/nginx.conf
```

El archivo debe quedar así (reemplazar `TU-DOMINIO-STAGING.com`):

```nginx
server {
    listen 80;
    server_name TU-DOMINIO-STAGING.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name TU-DOMINIO-STAGING.com;

    ssl_certificate     /etc/letsencrypt/live/TU-DOMINIO-STAGING.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/TU-DOMINIO-STAGING.com/privkey.pem;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass         http://gateway:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

> ⚠️ No tocar `nginx/nginx.conf` en el repo — editar solo el archivo local en el servidor nuevo.
> Si se hace commit de ese cambio, pisaría la config de producción en la rama.

---

### 5. Obtener certificado SSL

Con el puerto 80 libre (antes de levantar Docker):

```bash
sudo apt install certbot -y
sudo certbot certonly --standalone -d TU-DOMINIO-STAGING.com --agree-tos --no-eff-email
```

Verificar:

```bash
ls /etc/letsencrypt/live/TU-DOMINIO-STAGING.com/
# fullchain.pem  privkey.pem
```

---

### 6. Levantar los contenedores

```bash
cd /opt/nexus_gateway
docker compose up -d
```

Verificar que los 4 contenedores están corriendo:

```bash
docker ps
# nexus_gateway   Up
# nexus_nginx     Up
# nexus_postgres  Up
# nexus_redis     Up
```

---

### 7. Correr las migraciones de base de datos

```bash
for f in db/migrate_*.sql; do
  echo ">> $f"
  docker exec -i nexus_postgres psql -U nexus -d nexus -v ON_ERROR_STOP=1 < "$f"
done
```

Las migraciones son idempotentes — se pueden correr más de una vez sin problema.

---

### 8. Verificar que responde

```bash
curl https://TU-DOMINIO-STAGING.com/api/v1/health
# {"status":"ok"}
```

---

### 9. Sync inicial desde Odoo de staging

Una vez verificado, poblar la base de datos desde el panel admin:

```
https://TU-DOMINIO-STAGING.com/admin/sync
```

O por curl:

```bash
curl -X POST https://TU-DOMINIO-STAGING.com/api/v1/admin/sync/all \
  -H "X-Nexus-Admin-Token: TU_STAGING_ADMIN_TOKEN"
```

Después de esto activar los crons en el `.env`:

```env
NEXUS_ENABLE_SYNC_CRONS=true
```

Y reiniciar el gateway:

```bash
docker compose restart gateway
```

---

## Actualizaciones en staging

Para traer cambios nuevos de la rama staging:

```bash
cd /opt/nexus_gateway
./deploy.sh
```

---

## Troubleshooting

```bash
# Logs del gateway en tiempo real
docker logs -f nexus_gateway

# Logs de nginx
docker logs -f nexus_nginx

# Entrar a la base de datos
docker exec -it nexus_postgres psql -U nexus -d nexus

# Reiniciar solo el gateway (sin bajar DB ni Redis)
docker compose restart gateway

# Ver errores recientes
docker logs nexus_gateway --tail 100 | grep -i error
```
