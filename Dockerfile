# Totem API image — MIGRATION-ONLY temporary state (T2).
#
# There is no HTTP server yet: the container's job on startup is applying
# migrations (spec T2 acceptance). When the admin API lands (T3) and the MCP
# server (T5), evolve this into a multi-stage build:
#   stage 1 (build): tsc -p tsconfig.build.json + npm ci
#   stage 2 (runtime): dist/ + production deps only + CMD node dist/index.js
# Until then, keep it minimal — do not build a server entry that does not
# exist yet.
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only (the migration runner needs `pg`).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY migrations ./migrations

CMD ["npm", "run", "migrate:up"]
