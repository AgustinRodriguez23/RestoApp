# Se construye desde la raíz del monorepo (ver "context" en docker-compose.yml), donde está el package-lock.json:
# npm ci instala exactamente las versiones que probó el CI. Solo hace falta el package.json de este servicio.

# ---- Etapa 1: build ----
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/payments-service/package.json services/payments-service/
RUN npm ci -w payments-service
COPY services/payments-service/tsconfig.json services/payments-service/tsconfig.build.json services/payments-service/nest-cli.json services/payments-service/
COPY services/payments-service/src services/payments-service/src
RUN npm run build -w payments-service

# ---- Etapa 2: imagen final (solo dependencias de producción) ----
FROM node:25-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/payments-service/package.json services/payments-service/
RUN npm ci -w payments-service --omit=dev && npm cache clean --force
COPY --from=build /app/services/payments-service/dist services/payments-service/dist
WORKDIR /app/services/payments-service
USER node
EXPOSE 3004
CMD ["node", "dist/main"]
