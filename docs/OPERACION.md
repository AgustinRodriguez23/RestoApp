# Operación del servidor

Cómo se mantiene la app en producción: actualizar, volver atrás, mirar logs, hacer backups y cuidar el servidor.
El servidor es un VPS de Hetzner con Ubuntu. La app vive en `~/restoapp` (un clon del repo) y corre con `docker-compose.prod.yml`.
El `.env` de esa carpeta tiene `COMPOSE_FILE=docker-compose.prod.yml`, así que todos los comandos son `docker compose ...` sin `-f`, siempre parado en `~/restoapp`.

## Qué cambia respecto de Vercel o Render

| | Vercel / Render | VPS propio |
|---|---|---|
| Deploy | Automático con cada push | Lo hace uno: el CI publica las imágenes y en el servidor se bajan con `pull` |
| Volver atrás | Un botón | Se elige la imagen de un commit anterior con `IMAGE_TAG` |
| Logs | Panel web | `docker compose logs`, o Grafana por un túnel SSH |
| Bases de datos | Servicio aparte, con backups incluidos | Contenedores en el mismo servidor: **los backups son responsabilidad nuestra** |
| Sistema operativo | No existe para uno | Hay que actualizarlo y reiniciar cada tanto |
| HTTPS | Incluido | Caddy pide y renueva el certificado solo |

La contracara es el control: se paga un precio fijo, no hay "sleep" de la app gratuita, y se ve todo lo que pasa.

## Entrar

```bash
ssh deploy@<IP>
cd ~/restoapp
```

Solo entra el usuario `deploy` y solo con clave SSH: root y contraseñas están deshabilitados.

## Ver cómo está

```bash
docker compose ps                         # cada contenedor con su estado; los servicios deberían decir (healthy)
curl -s https://<dominio>/api/health      # lo mismo visto desde afuera, pasando por Caddy y nginx
free -h                                   # memoria: mirar "available", no "free"
docker stats --no-stream                  # memoria y CPU de cada contenedor
df -h /                                   # disco
docker system df                          # cuánto ocupan imágenes, volúmenes y logs de Docker
```

## Logs

```bash
docker compose logs -f --tail=100 web-bff           # seguir uno en vivo (Ctrl+C para salir)
docker compose logs --since 1h reservations-service  # la última hora
docker compose logs --since 1h | grep <correlationId>  # un pedido a través de todos los servicios
```

Los logs de Docker tienen tope (3 archivos de 10 MB por contenedor), así que no llenan el disco, pero tampoco duran para siempre.
Para buscar con más historia y ver gráficos está Grafana. En 4 GB de memoria está apagado: se levanta con `docker compose up -d loki alloy grafana` mirando `free -h`.
Grafana no está publicado en internet; se entra con un túnel desde la compu:

```bash
ssh -L 3030:localhost:3030 deploy@<IP>   # dejar esa terminal abierta y entrar a http://localhost:3030
```

## Publicar una versión nueva

1. Mergear el PR a `main`. El CI corre de nuevo y, si pasa, `release.yml` publica las imágenes con dos etiquetas: `latest` y `sha-<commit>`.
2. Esperar a que el workflow **Release** esté en verde en GitHub (pestaña Actions).
3. En el servidor:

```bash
git pull                     # por si cambiaron docker-compose.prod.yml, el Caddyfile o los scripts
docker compose pull          # baja las imágenes nuevas (no corta nada todavía)
docker compose up -d caddy   # recrea solo los contenedores que cambiaron
docker compose ps            # esperar a que vuelvan a (healthy)
docker image prune -f        # borra las imágenes viejas que quedaron sin etiqueta
```

`up -d caddy` levanta Caddy y todo de lo que depende, o sea la app entera menos Loki, Alloy y Grafana. Un contenedor cuya imagen y configuración no cambiaron no se toca.
Las migraciones de la base corren solas cuando arranca cada servicio.
Hay unos segundos de corte mientras se recrea cada servicio: para este proyecto es aceptable, y evitarlo requiere más de un servidor.

## Volver a una versión anterior

Si algo sale mal después de un deploy:

1. Buscar el commit bueno: en GitHub, el historial de `main` o los paquetes del repo. La etiqueta es `sha-` más los primeros 7 caracteres del commit.
2. En el `.env` del servidor (`nano .env`), cambiar `IMAGE_TAG=latest` por `IMAGE_TAG=sha-abc1234`.
3. `docker compose pull && docker compose up -d caddy`

Cuando el arreglo esté en `main`, volver a `IMAGE_TAG=latest` y repetir el paso 3.
Ojo: volver atrás el código **no deshace las migraciones**. Funciona porque las migraciones de este proyecto solo agregan (columnas, tablas), y el código viejo ignora lo que no conoce.

## Cambiar una variable del `.env`

```bash
nano .env
docker compose up -d auth-service   # el servicio que usa esa variable; compose ve el cambio y lo recrea
```

`docker compose restart` **no** lee el `.env` de nuevo: reinicia el contenedor con la configuración vieja. Para que tome un cambio hay que usar `up -d`.
Para confirmar que lo tomó: `docker compose exec auth-service printenv ALLOW_OWNER_SELF_REGISTER`.

Las contraseñas de las bases no se pueden cambiar así: se fijan la primera vez que se crea cada volumen, y cambiarlas en el `.env` después rompe la conexión (`password authentication failed`).
Lo engañoso es que no falla en el momento: el servicio sigue andando con la configuración vieja hasta que algo lo recrea (un deploy, un `up -d`), a veces semanas después.
Si pasa, se le pone a la base la contraseña del `.env`. Desde adentro del contenedor Postgres no pide contraseña, y la nueva ya está cargada en su variable:

```bash
echo 'ALTER USER :"u" PASSWORD :'"'"'p'"'"';' | docker compose exec -T postgres-auth sh -c 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v u="$POSTGRES_USER" -v p="$POSTGRES_PASSWORD"'
docker compose up -d auth-service
```

## Crear un admin

El admin es quien aprueba o rechaza las solicitudes para ser dueño (pantalla «Solicitudes»). La app no tiene forma de crearlo, a propósito: si el registro aceptara `ADMIN`, cualquiera podría pedirlo. Se hace desde la base.

1. Registrarse en la app con una **cuenta aparte**. Cada usuario tiene un solo rol: si se convierte la cuenta de un dueño, pierde el panel de sus restaurantes.
2. En el servidor, abrir la consola de la base de auth. Usa el usuario y la base que ya tiene el contenedor, así no hace falta abrir el `.env`:

```bash
docker compose exec postgres-auth sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

3. Adentro de `psql` (sale con `\q`):

```sql
UPDATE users SET role = 'ADMIN' WHERE email = 'el-mail-del-admin@ejemplo.com';
```

Tiene que responder `UPDATE 1`. Con `UPDATE 0`, el email no coincide con ninguna cuenta.

4. En la app, **cerrar sesión y volver a entrar**: el rol viaja dentro del token, y el que se tenía es de antes del cambio.

Para sacarle el rol, lo mismo con `role = 'CUSTOMER'`. El e2e crea su admin de esta misma forma, así que el procedimiento queda probado en cada PR.

## Backups

Las bases son contenedores con sus datos en volúmenes de Docker en el disco del servidor. Si el disco se rompe o se borra un volumen, se pierden: no hay nadie más guardando una copia.

### Automáticos

`scripts/backup.sh` hace un dump de las 5 bases (3 Postgres con `pg_dump`, 2 Mongo con `mongodump`) en `~/backups/<fecha>_<hora>/` y borra los de más de 14 días.
Un dump es una copia lógica (el SQL o los documentos), consistente aunque la app esté recibiendo pedidos. No sirve copiar la carpeta de datos con la base andando.

Para programarlo, una vez:

```bash
mkdir -p ~/backups                # cron abre el log antes de correr el script: la carpeta tiene que existir
~/restoapp/scripts/backup.sh     # probarlo a mano primero
crontab -e                        # y agregar esta línea al final:
```

```
0 6 * * * /home/deploy/restoapp/scripts/backup.sh >> /home/deploy/backups/backup.log 2>&1
```

Corre todos los días a las 6:00 del reloj del servidor (UTC), que son las 3:00 en Argentina. Lo que imprime, incluidos los errores, queda en `~/backups/backup.log`.

**Un backup que falla en silencio es el problema más común.** Dos formas de enterarse:

- Mirar `tail ~/backups/backup.log` cada tanto: tiene que haber una línea `backup ok` por día.
- Crear un chequeo gratis en [healthchecks.io](https://healthchecks.io) y poner su URL al principio de la línea del cron: `BACKUP_PING_URL=https://hc-ping.com/<uuid> /home/deploy/restoapp/...`. El script le avisa cuando termina bien, y si un día no le avisa, healthchecks.io manda un mail.

### Sacarlos del servidor

Un backup en el mismo disco no protege si se pierde el servidor. Dos capas, de menos a más esfuerzo:

1. **Backups de Hetzner** (en el panel del servidor, pestaña Backups): una imagen de todo el disco por día, se guardan las últimas 7, y cuesta un 20 % del precio del servidor. Incluye `~/backups`. Se borran si se borra el servidor.
2. **Una copia en la compu**, cada tanto. Desde Git Bash en la compu, en una sola línea:

```bash
scp -r deploy@<IP>:backups/<fecha>_<hora> ./backups-restoapp/
```

La carpeta `backups-restoapp/` está en el `.gitignore`: los dumps tienen datos de usuarios y nunca van al repo.

### Restaurar

Probar la restauración cada tanto es la única forma de saber que el backup sirve. Antes de restaurar una base, frenar el servicio que la usa para que no escriba en el medio. Con `b=~/backups/<fecha>_<hora>`:

```bash
# Postgres (lo mismo para reservations y payments): el dump borra y vuelve a crear cada tabla
docker compose stop auth-service
gunzip -c $b/auth.sql.gz | docker compose exec -T postgres-auth sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > /dev/null
docker compose up -d caddy

# Mongo (lo mismo para notifications): --drop reemplaza cada colección por la del backup
docker compose stop restaurants-service
docker compose exec -T mongo-restaurants sh -c 'mongorestore --quiet --archive --gzip --drop --nsInclude "restaurants_db.*" --authenticationDatabase admin --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD"' < $b/restaurants.archive.gz
docker compose up -d caddy
```

`--nsInclude` restaura solo la base de la app y deja afuera la base `admin`, donde Mongo guarda sus usuarios.
Si en el `.env` se cambió el nombre de la base (`RESTAURANTS_MONGO_DB`, `NOTIFICATIONS_MONGO_DB`), usar ese.

## Mantener el servidor

```bash
sudo apt update && sudo apt upgrade -y   # una vez por semana, o cuando haya avisos de seguridad
ls /var/run/reboot-required              # si existe, hay que reiniciar (por ejemplo, después de actualizar el kernel)
sudo reboot
```

Después de reiniciar los contenedores vuelven solos (`restart: unless-stopped`). Igual conviene entrar y mirar `docker compose ps`.
Ubuntu trae `unattended-upgrades`, que instala solo los parches de seguridad. Lo que no hace es reiniciar.

## Cuando algo anda mal

| Síntoma | Dónde mirar |
|---|---|
| La página no carga | `docker compose ps`: ¿están `caddy` y `web` arriba? `docker compose logs --tail=50 caddy` |
| La página carga pero la API responde 502 o 503 | `/api/health` dice qué servicio está caído; después, sus logs |
| Un contenedor se reinicia una y otra vez | `docker compose logs --tail=100 <servicio>`: casi siempre falta una variable o no conecta a su base |
| Se cayó algo sin error en los logs | `docker inspect <contenedor> --format '{{.State.OOMKilled}}'`: si dice `true`, se quedó sin memoria (`free -h`) |
| Error del certificado | `docker compose logs caddy`: el dominio tiene que seguir apuntando a la IP del servidor |
| Disco lleno | `docker system df` y `docker image prune -f` |

## Lo que nunca hay que hacer

- **`docker compose down -v`**: la `-v` borra los volúmenes, es decir, todas las bases. `docker compose down` sin `-v` sí se puede.
- **`docker volume prune`** o **`docker system prune --volumes`**: mismo efecto.
- **Cambiar las contraseñas de las bases en el `.env`**: ver más arriba.
- **Pegar el `.env` en un chat, un issue o un commit**: tiene todos los secretos. La copia va en el gestor de contraseñas.
- **Construir las imágenes en el servidor** (`docker compose build`): el servidor usa las del CI, que ya pasaron los tests. Además, con 4 GB de memoria, el build compite con la app.
