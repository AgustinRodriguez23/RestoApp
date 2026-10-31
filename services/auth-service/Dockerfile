# Se construye desde la raíz del monorepo (ver "context" en docker-compose.yml), donde está el package-lock.json:
# npm ci instala exactamente las versiones que probó el CI. Solo hace falta el package.json de este servicio.

# ---- Etapa 1: build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/auth-service/package.json services/auth-service/
RUN npm ci -w auth-service
COPY services/auth-service/tsconfig.json services/auth-service/tsconfig.build.json services/auth-service/nest-cli.json services/auth-service/
COPY services/auth-service/src services/auth-service/src
RUN npm run build -w auth-service

# ---- Etapa 2: imagen final (solo dependencias de producción) ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/auth-service/package.json services/auth-service/
RUN npm ci -w auth-service --omit=dev && npm cache clean --force
COPY --from=build /app/services/auth-service/dist services/auth-service/dist
WORKDIR /app/services/auth-service
USER node
EXPOSE 3001
CMD ["node", "dist/main"]
