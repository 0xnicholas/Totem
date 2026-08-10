# Multi-stage: build compiles TS to dist; the runtime image ships only
# compiled JS + production dependencies (T3, per T2 review follow-up).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY migrations ./migrations

EXPOSE 3000
# Migrations are applied by the compose `migrate` one-shot service, never by
# app replicas (parallel replicas would race on migrate:up).
CMD ["node", "dist/server/index.js"]
