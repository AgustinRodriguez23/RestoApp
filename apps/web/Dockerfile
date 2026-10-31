# Se construye desde la raíz del monorepo (ver "context" en docker-compose.yml), donde está el package-lock.json:
# npm ci instala exactamente las versiones que probó el CI. Solo hace falta el package.json de la app.

# ---- Etapa 1: build de la app (Vite genera archivos estáticos) ----
FROM node:24-alpine AS build
WORKDIR /app
# Más paciencia con el registro de npm (en redes lentas el build cortaba con ETIMEDOUT)
ENV npm_config_fetch_retries=5     npm_config_fetch_timeout=300000     npm_config_fetch_retry_mintimeout=20000
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w web
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts apps/web/
COPY apps/web/public apps/web/public
COPY apps/web/src apps/web/src
# tsc antes del build: si el tipado falla, la imagen no se construye
RUN npm run build -w web

# ---- Etapa 2: nginx sirve los estáticos y reenvía /api al BFF ----
FROM nginx:1.29-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
