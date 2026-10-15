# Stage 1: install every workspace's dependencies (dev included — needed to
# typecheck and bundle in the next stage). npm workspaces require all member
# package.jsons to be present even when only building one of them.
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci

# Stage 2: compile packages/db (plain JS output, run directly for migrations)
# and bundle the api into apps/api/dist/server.js.
FROM deps AS build

WORKDIR /app

COPY . .

RUN npm run build --workspace packages/db && npm run build --workspace apps/api

# Stage 3: runtime image — production dependencies only, plus the build output.
FROM node:20-alpine AS runtime

WORKDIR /app

# pg_dump for the in-app database backup (System → Säkerhetskopiering). Pin the
# client to the SAME major as the postgres:16 server — a newer pg_dump emits
# GUCs (e.g. transaction_timeout) that a v16 server rejects on restore.
RUN apk add --no-cache postgresql16-client

COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci --omit=dev

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle

ENV NODE_ENV=production

EXPOSE 4000

# Migrate before serving. Drizzle records what it has applied, so this is a
# no-op on every start after the first — see docker-compose.yml for why that
# makes `docker compose up -d` on an empty database the whole install.
CMD ["sh", "-c", "node packages/db/dist/migrate.js && node apps/api/dist/server.js"]
