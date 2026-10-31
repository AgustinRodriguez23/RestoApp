# Se construye desde la raíz del monorepo (ver "context" en docker-compose.yml), donde está el package-lock.json:
# npm ci instala exactamente las versiones que probó el CI. Solo hace falta el package.json de este servicio.

# ---- Etapa 1: build ----
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/restaurants-service/package.json services/restaurants-service/
RUN npm ci -w restaurants-service
COPY services/restaurants-service/tsconfig.json services/restaurants-service/tsconfig.build.json services/restaurants-service/nest-cli.json services/restaurants-service/
COPY services/restaurants-service/src services/restaurants-service/src
RUN npm run build -w restaurants-service

# ---- Etapa 2: imagen final (solo dependencias de producción) ----
FROM node:25-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/restaurants-service/package.json services/restaurants-service/
RUN npm ci -w restaurants-service --omit=dev && npm cache clean --force
COPY --from=build /app/services/restaurants-service/dist services/restaurants-service/dist
WORKDIR /app/services/restaurants-service
USER node
EXPOSE 3002
CMD ["node", "dist/main"]
