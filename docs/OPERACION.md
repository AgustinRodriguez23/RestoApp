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

## Cuentas de demo

Con esto el login muestra «Probar como dueño» y «Probar como cliente», para que alguien (por ejemplo, un recruiter) vea la app sin registrarse. El navegador manda solo el rol, y el BFF entra con las credenciales que tiene en el `.env`: la contraseña no aparece en ningún lado público. Las cuentas son compartidas, así que un script las vuelve a su estado modelo todas las noches.

### Crearlas, una sola vez

1. Generar dos contraseñas (hexadecimal, así no hay caracteres que la terminal interprete):

```bash
openssl rand -hex 16
```

2. Registrar las dos cuentas. Con emails `@example.com`, un dominio reservado para ejemplos que no es de nadie. En una sola línea cada una, cambiando `<clave>`:

```bash
curl -s "https://$(grep ^DOMAIN= ~/restoapp/.env | cut -d= -f2)/api/auth/register" -H 'content-type: application/json' -d '{"email":"demo-dueno@example.com","name":"Dueño de demo","password":"<clave>"}'
```

```bash
curl -s "https://$(grep ^DOMAIN= ~/restoapp/.env | cut -d= -f2)/api/auth/register" -H 'content-type: application/json' -d '{"email":"demo-cliente@example.com","name":"Cliente de demo","password":"<clave>"}'
```

Las dos quedan como clientes. Al dueño se le cambia el rol como al admin (ver «Crear un admin»), con `role = 'RESTAURANT_OWNER'` y su email.

3. Agregarlas al `.env` y aplicar el cambio:

```
DEMO_OWNER_EMAIL=demo-dueno@example.com
DEMO_OWNER_PASSWORD=<clave del dueño>
DEMO_CUSTOMER_EMAIL=demo-cliente@example.com
DEMO_CUSTOMER_PASSWORD=<clave del cliente>
```

```bash
docker compose up -d web-bff
```

4. Comprobar: `curl -s https://<dominio>/api/auth/demo` tiene que responder `{"accounts":["owner","customer"]}`.

5. Correr el reseteo a mano una vez: crea el restaurante modelo del dueño, «Bodegón La Demo», con su carta y la agenda de ejemplo. La primera vez tarda cerca de un minuto, porque hace unas 50 reservas con su pago.

```bash
docker compose run --rm --no-deps -v /home/deploy/restoapp/scripts:/scripts:ro -e BFF_URL=http://web-bff:3000 --entrypoint node web-bff /scripts/demo-reset.mjs
```

Tiene que terminar con `reseteo ok`.

### El reseteo de todas las noches

`scripts/demo-reset.mjs` usa la API del BFF, igual que el front, y no toca las bases:

- **Cliente:** cancela sus reservas por venir. Así libera las mesas y no llega al tope de reservas sin pagar.
- **Dueño:** deja solo el restaurante modelo, con sus datos, mesas, horarios y carta originales. Los demás los borra. El modelo se corrige en el lugar y no se borra y se vuelve a crear, así conserva su historial de reservas.
- **Agenda de ejemplo:** para que el panel del dueño no esté vacío, cuatro clientes ficticios (`demo-ejemplo-1@example.com` a `demo-ejemplo-4@example.com`) tienen reservado el restaurante modelo para hoy y los 6 días siguientes: unas 7 reservas por día, casi todas pagadas y una con el pago rechazado. Cada noche se agrega el día que entra en la ventana, y las de los 3 días anteriores que siguen confirmadas se marcan como «asistió», salvo una por día que queda como «no vino». Así, entrando como dueño a la tarde, las reservas del mediodía ya se pueden marcar. El plan de cada día sale de la fecha: repetir el script no duplica nada. Si un visitante ocupó la mesa de un horario, ese horario se saltea.

Los clientes ficticios se registran solos la primera vez. Sus contraseñas no se guardan en ningún lado: se calculan a partir de `DEMO_OWNER_PASSWORD` (un HMAC con su email). Por eso, **si se cambia la contraseña del dueño de demo, estos clientes ya no pueden entrar** y el log lo avisa. Para arreglarlo, borrar las cuatro cuentas con `psql` en `postgres-auth` (`DELETE FROM users WHERE email LIKE 'demo-ejemplo-%@example.com';`) y correr el reseteo: los vuelve a registrar con la contraseña nueva. Las reservas de ejemplo se reconocen por el nombre del cliente y no por el id de la cuenta, así que las que ya existían siguen contando y la agenda no se duplica.

Corre adentro de un contenedor de la imagen del web-bff (`docker compose run`), porque el servidor no tiene Node instalado y ese contenedor ya trae las variables `DEMO_*`. Para programarlo, `crontab -e` y agregar esta línea al final:

```
0 7 * * * cd /home/deploy/restoapp && docker compose run --rm --no-deps -v /home/deploy/restoapp/scripts:/scripts:ro -e BFF_URL=http://web-bff:3000 --entrypoint node web-bff /scripts/demo-reset.mjs >> /home/deploy/backups/demo-reset.log 2>&1
```

Corre a las 7:00 UTC (4:00 en Argentina), después del backup. El `cd` hace falta porque compose busca el `docker-compose` y el `.env` en la carpeta actual. Para ver cómo le fue: `tail ~/backups/demo-reset.log`, con una línea `reseteo ok` por noche.

Si el log dice que una cuenta no pudo entrar (401), la contraseña del `.env` ya no coincide con la de la cuenta. Mientras tanto, el botón de esa cuenta responde «no disponible» en vez de entrar.

Para sacar la demo: borrar las cuatro variables, `docker compose up -d web-bff`, y la línea del cron. Las cuentas y sus reservas quedan en las bases, pero ya nadie las usa.

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
