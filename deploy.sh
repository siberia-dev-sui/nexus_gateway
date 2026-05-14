#!/usr/bin/env bash
set -euo pipefail

git pull
docker compose build --no-cache gateway
docker compose up -d

for f in db/migrate_*.sql; do
  echo ">> $f"
  docker exec -i nexus_postgres psql -U nexus -d nexus -v ON_ERROR_STOP=1 < "$f"
done
