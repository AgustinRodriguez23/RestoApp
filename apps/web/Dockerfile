# ---- Etapa 1: build de la app (Vite genera archivos estáticos) ----
FROM node:25-alpine AS build
WORKDIR /app
# Más paciencia con el registro de npm (en redes lentas el build cortaba con ETIMEDOUT)
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_timeout=300000 \
    npm_config_fetch_retry_mintimeout=20000
COPY package.json ./
RUN npm install
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
# tsc antes del build: si el tipado falla, la imagen no se construye
RUN npm run build

# ---- Etapa 2: nginx sirve los estáticos y reenvía /api al BFF ----
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
