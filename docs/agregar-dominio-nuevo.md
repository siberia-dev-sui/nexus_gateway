# Cómo agregar un dominio nuevo al gateway

**Caso documentado:** Conectar `devsiberian.grupoleiros.com` al gateway  
**Servidor:** `77.42.71.221`  
**Stack:** Docker + nginx + NestJS gateway en puerto 3000

---

## El problema

El nginx del servidor solo conoce el dominio `77-42-71-221.sslip.io`. Cuando se agrega un dominio nuevo en Cloudflare apuntando al servidor, Cloudflare recibe error **521** porque nginx no tiene configurado ese dominio y no sabe a dónde mandar el tráfico.

El gateway sí está corriendo. El firewall sí está abierto. El DNS sí está bien. Solo falta configurar nginx.

---

## Pasos para agregar un dominio nuevo

### 1. Editar el nginx config

El archivo está en el host en:
```
/opt/nexus_gateway/nginx/nginx.conf
```

Agregar un nuevo bloque **antes** del bloque de puerto 443:

```nginx
server {
    listen 80;
    server_name NUEVO-DOMINIO.com;

    location / {
        proxy_pass         http://gateway:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

> Usar puerto 80 porque Cloudflare en modo Flexible se conecta al origen por HTTP.

### 2. Escribir el cambio en el archivo preservando el inode

**No usar un editor que reemplace el archivo** (como nano, vim con `:w`, etc. sí funcionan). El problema ocurre si el archivo se reemplaza completamente creando un nuevo inode — Docker queda atado al inode viejo y no ve el cambio.

Usar `tee` para escribir en el mismo inode:
```bash
tee /opt/nexus_gateway/nginx/nginx.conf << 'EOF'
# ... contenido completo del archivo ...
EOF
```

### 3. Reiniciar el contenedor nginx

```bash
docker restart nexus_nginx
```

Verificar que levantó bien:
```bash
docker logs nexus_nginx --tail 20
```

### 4. Configurar Cloudflare SSL en modo Flexible

En el dashboard de Cloudflare:
- **SSL/TLS → Overview → Flexible**

Esto hace que Cloudflare se conecte al origen por HTTP (puerto 80). Si se deja en "Full" o "Full Strict", Cloudflare intentará HTTPS al origen, pero el certificado del servidor es para `77-42-71-221.sslip.io`, no para el nuevo dominio, y fallará.

### 5. Verificar

```bash
curl -s -o /dev/null -w "%{http_code}" http://77.42.71.221/ -H "Host: NUEVO-DOMINIO.com"
# Debe devolver 200 o 404 (no 301 ni 521)

curl -s -o /dev/null -w "%{http_code}" https://NUEVO-DOMINIO.com/
# Debe devolver 200 o 404 desde Cloudflare
```

---

## Config completo de referencia (con devsiberian)

```nginx
server {
    listen 80;
    server_name 77-42-71-221.sslip.io;
    return 301 https://$host$request_uri;
}

server {
    listen 80;
    server_name devsiberian.grupoleiros.com;

    location / {
        proxy_pass         http://gateway:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl;
    server_name 77-42-71-221.sslip.io;

    ssl_certificate     /etc/letsencrypt/live/77-42-71-221.sslip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/77-42-71-221.sslip.io/privkey.pem;

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

## Diagnóstico rápido si vuelve a pasar error 521

```bash
# 1. ¿Está corriendo nginx?
docker ps | grep nginx

# 2. ¿El servidor responde directo?
curl -k https://77.42.71.221/ -H "Host: DOMINIO.com"

# 3. ¿Puertos abiertos externamente?
curl -s https://internetdb.shodan.io/77.42.71.221 | python3 -m json.tool

# 4. ¿El dominio tiene el bloque en nginx?
docker exec nexus_nginx cat /etc/nginx/conf.d/default.conf | grep server_name
```
