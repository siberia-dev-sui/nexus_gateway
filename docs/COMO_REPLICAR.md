# Cómo replicar el servidor NEXUS Gateway (staging / nuevo servidor)

Guía para levantar una copia exacta de este servidor en una máquina nueva.
Basada en la configuración actual de producción: `nexus.eqnio.com` / IP `77.42.71.221`.

---

## Requisitos del servidor nuevo

- Ubuntu 24.04 LTS
- 2 vCPU, 4 GB RAM (Hetzner CX22 o equivalente)
- Docker + Docker Compose plugin
- Git
- Puertos 80 y 443 abiertos al público
- Un dominio apuntando a la IP del servidor nuevo (registro A en DNS)

---

## 1. Instalar Docker

```bash
curl -fsSL https://get.docker.com | sh
```

---

## 2. Clonar el repositorio

```bash
git clone git@github.com:siberia-dev-sui/nexus_gateway.git /opt/nexus_gateway
cd /opt/nexus_gateway
```

Para staging, cambiar a la rama correspondiente:

```bash
git checkout staging
```

---

## 3. Configurar variables de entorno

```bash
cp .env.example .env
nano .env
```

Completar con los valores del servidor de referencia (pedir al equipo):

```env
POSTGRES_PASSWORD=
REDIS_PASSWORD=
JWT_SECRET=
NEXUS_ADMIN_TOKEN=
ODOO_URL=
ODOO_DB=
ODOO_BOT_EMAIL=
ODOO_BOT_PASSWORD=
DEMO_EMAIL=
PORT=3000
NEXUS_AUTO_SYNC_ON_START=false
NEXUS_ENABLE_SYNC_CRONS=true
```

---

## 4. Configurar nginx con el dominio nuevo

Editar `/opt/nexus_gateway/nginx/nginx.conf` y reemplazar `nexus.eqnio.com` con el dominio del servidor nuevo:

```nginx
server {
    listen 80;
    server_name TU-DOMINIO.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name TU-DOMINIO.com;

    ssl_certificate     /etc/letsencrypt/live/TU-DOMINIO.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/TU-DOMINIO.com/privkey.pem;

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

---

## 5. Obtener certificado SSL (Let's Encrypt)

Antes de levantar Docker, obtener el certificado con el puerto 80 libre:

```bash
sudo apt install certbot -y
sudo certbot certonly --standalone -d TU-DOMINIO.com --agree-tos --no-eff-email
```

Verificar que los certificados quedaron en:

```bash
ls /etc/letsencrypt/live/TU-DOMINIO.com/
# fullchain.pem  privkey.pem
```

---

## 6. Levantar los contenedores

```bash
cd /opt/nexus_gateway
docker compose up -d
```

Verificar que los 4 contenedores están corriendo:

```bash
docker ps
# nexus_gateway, nexus_nginx, nexus_postgres, nexus_redis
```

---

## 7. Correr las migraciones de base de datos

```bash
for f in db/migrate_*.sql; do
  echo ">> $f"
  docker exec -i nexus_postgres psql -U nexus -d nexus -v ON_ERROR_STOP=1 < "$f"
done
```

---

## 8. Verificar que el gateway responde

```bash
curl https://TU-DOMINIO.com/api/v1/health
# {"status":"ok"}
```

---

## 9. Sincronización inicial desde Odoo

Disparar el sync manual desde el panel admin para poblar la base de datos:

```bash
curl -X POST https://TU-DOMINIO.com/api/v1/admin/sync/all \
  -H "X-Nexus-Admin-Token: TU_ADMIN_TOKEN"
```

O desde el navegador en: `https://TU-DOMINIO.com/admin/sync`

---

## Actualizaciones y deploy

Para deployar una nueva versión en cualquier momento:

```bash
cd /opt/nexus_gateway
./deploy.sh
```

El script hace `git pull`, rebuild del contenedor gateway, restart y aplica migraciones nuevas.

---

## Estructura de contenedores

| Contenedor      | Imagen                  | Puerto        |
|-----------------|-------------------------|---------------|
| nexus_gateway   | nexus_gateway-gateway   | 3000 interno  |
| nexus_nginx     | nginx:alpine            | 80 y 443      |
| nexus_postgres  | postgres:16-alpine      | 5432 interno  |
| nexus_redis     | redis:7-alpine          | 6379 interno  |

---

## Troubleshooting

```bash
# Logs del gateway
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
