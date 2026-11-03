#!/usr/bin/env bash
# Backup de las 5 bases. En el servidor lo corre cron todas las noches (ver docs/OPERACION.md); a mano: scripts/backup.sh
# Deja una carpeta por corrida en ~/backups (fecha y hora en UTC) y borra las de más de 14 días.
#
# Lo que no se respalda, a propósito:
#  - RabbitMQ: un evento que no llegó a publicarse sigue en el outbox de Postgres, y se publica de nuevo.
#  - Redis: es caché, se rearma solo.
#  - Los certificados de Caddy: Let's Encrypt los vuelve a dar.
#  - El .env: tiene los secretos, y su copia va en el gestor de contraseñas, no al lado de los datos.
#
# Variables opcionales: BACKUP_DIR (carpeta destino), BACKUP_RETENTION_DAYS, y BACKUP_PING_URL para avisarle a un
# servicio como healthchecks.io que el backup terminó bien: si un día no avisa, ese servicio manda un mail.
set -euo pipefail # pipefail: si pg_dump falla, falla el script aunque gzip haya terminado bien

# La raíz del repo, donde está el .env con COMPOSE_FILE: así docker compose usa el archivo de producción
cd "$(dirname "$0")/.."

destino="${BACKUP_DIR:-$HOME/backups}"
dias="${BACKUP_RETENTION_DAYS:-14}"
fecha="$(date -u +%Y-%m-%d_%H%M)"
# Se escribe en una carpeta temporal y se renombra al final: una carpeta con fecha es siempre un backup completo
tmp="$destino/.en-curso-$fecha"
trap 'rm -rf "$tmp"' EXIT

umask 077 # tienen datos de usuarios (emails, hashes de contraseñas): solo los puede leer el dueño
mkdir -p "$tmp"

# Las comillas simples hacen que $POSTGRES_USER y compañía se lean adentro del contenedor, que ya los tiene:
# así el script no necesita leer las contraseñas del .env. -T porque cron no tiene terminal.
for base in auth reservations payments; do
  docker compose exec -T "postgres-$base" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
    | gzip > "$tmp/$base.sql.gz"
done

for base in restaurants notifications; do
  docker compose exec -T "mongo-$base" sh -c 'mongodump --quiet --archive --gzip --authenticationDatabase admin \
    --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD"' \
    > "$tmp/$base.archive.gz"
done

mv "$tmp" "$destino/$fecha"
# Solo las carpetas con fecha: el log y cualquier otra cosa que haya en la carpeta no se tocan
find "$destino" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$dias" -exec rm -rf {} +

echo "$(date -u +%FT%TZ) backup ok: $destino/$fecha ($(du -sh "$destino/$fecha" | cut -f1))"
if [ -n "${BACKUP_PING_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_PING_URL" || echo "no se pudo avisar a BACKUP_PING_URL" >&2
fi
