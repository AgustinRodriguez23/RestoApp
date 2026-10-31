# Se construye desde la raíz del monorepo (ver "context" en docker-compose.yml), donde está el package-lock.json:
# npm ci instala exactamente las versiones que probó el CI. Solo hace falta el package.json de este servicio.

# ---- Etapa 1: build ----
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/web-bff/package.json services/web-bff/
RUN npm ci -w web-bff
COPY services/web-bff/tsconfig.json services/web-bff/tsconfig.build.json services/web-bff/nest-cli.json services/web-bff/
COPY services/web-bff/src services/web-bff/src
RUN npm run build -w web-bff

# ---- Etapa 2: imagen final (solo dependencias de producción) ----
FROM node:25-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/web-bff/package.json services/web-bff/
RUN npm ci -w web-bff --omit=dev && npm cache clean --force
COPY --from=build /app/services/web-bff/dist services/web-bff/dist
WORKDIR /app/services/web-bff
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
