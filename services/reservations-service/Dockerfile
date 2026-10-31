# Se construye desde la raíz del monorepo (ver "context" en docker-compose.yml), donde está el package-lock.json:
# npm ci instala exactamente las versiones que probó el CI. Solo hace falta el package.json de este servicio.

# ---- Etapa 1: build ----
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/reservations-service/package.json services/reservations-service/
RUN npm ci -w reservations-service
COPY services/reservations-service/tsconfig.json services/reservations-service/tsconfig.build.json services/reservations-service/nest-cli.json services/reservations-service/
COPY services/reservations-service/src services/reservations-service/src
RUN npm run build -w reservations-service

# ---- Etapa 2: imagen final (solo dependencias de producción) ----
FROM node:25-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/reservations-service/package.json services/reservations-service/
RUN npm ci -w reservations-service --omit=dev && npm cache clean --force
COPY --from=build /app/services/reservations-service/dist services/reservations-service/dist
WORKDIR /app/services/reservations-service
USER node
EXPOSE 3003
CMD ["node", "dist/main"]
