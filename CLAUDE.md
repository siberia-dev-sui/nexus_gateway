# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run in development (auto-restarts on file changes)
npm run dev

# Run in production
npm start

# Run with Docker Compose (binds port 80 → 3000)
docker-compose up --build -d
```

There are no tests configured in this project.

## Architecture

Single-file Node.js API gateway (`server.js`) built on **Fastify**, acting as a middleware layer between a mobile field-sales app (Leiros/NEXUS) and a hosted **Odoo** instance.

### Odoo integration

All Odoo communication goes through two functions:
- `odooAuth()` — authenticates via `/web/session/authenticate`, stores the session cookie in the module-level `odooSession` variable.
- `odooCall(model, method, args, kwargs)` — calls `/web/dataset/call_kw` with the session cookie. On session expiry (detected via `res.data.error`), it transparently re-auths and retries once.

### Catalog caching

`fetchCatalogFromOdoo()` uses a 2-step query to avoid scanning Odoo's binary image columns:
1. Query `ir.attachment` to find product IDs that have an image (fast index scan).
2. Query `product.product` filtered to those IDs.

Results are stored in module-level `_catalogCache` / `_catalogCacheTime` with a 1-hour TTL. The cache is warmed on server startup (non-blocking). Both `/api/v1/catalog` and `/api/v1/sync/initial` share this cache.

### Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/health` | None | Health check |
| POST | `/api/v1/auth/login` | None | Returns JWT; credentials come from `.env` (`DEMO_EMAIL`/`DEMO_PASSWORD`) |
| GET | `/api/v1/catalog` | None | Public product catalog (text only, cached 1h) |
| GET | `/api/v1/product/:id/image` | None | Proxies `image_256` from Odoo with 24h browser cache |
| GET | `/api/v1/sync/initial` | JWT | Same data as `/catalog` but JWT-protected |

### Environment variables (`.env`)

`ODOO_URL`, `ODOO_DB`, `ODOO_BOT_EMAIL`, `ODOO_BOT_PASSWORD` — Odoo connection.  
`JWT_SECRET`, `DEMO_EMAIL`, `DEMO_PASSWORD` — auth.  
`PORT` — defaults to 3000.
