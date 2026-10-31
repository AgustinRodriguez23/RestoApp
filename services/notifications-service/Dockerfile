# Se construye desde la raíz del monorepo (ver "context" en docker-compose.yml), donde está el package-lock.json:
# npm ci instala exactamente las versiones que probó el CI. Solo hace falta el package.json de este servicio.

# ---- Etapa 1: build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/notifications-service/package.json services/notifications-service/
RUN npm ci -w notifications-service
COPY services/notifications-service/tsconfig.json services/notifications-service/tsconfig.build.json services/notifications-service/nest-cli.json services/notifications-service/
COPY services/notifications-service/src services/notifications-service/src
RUN npm run build -w notifications-service

# ---- Etapa 2: imagen final (solo dependencias de producción) ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/notifications-service/package.json services/notifications-service/
RUN npm ci -w notifications-service --omit=dev && npm cache clean --force
COPY --from=build /app/services/notifications-service/dist services/notifications-service/dist
WORKDIR /app/services/notifications-service
USER node
EXPOSE 3005
CMD ["node", "dist/main"]
