# Stage 1: install every workspace's dependencies (dev included — needed to
# typecheck and build in the next stage). npm workspaces require all member
# package.jsons to be present even when only building one of them.
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci

# Stage 2: production Next.js build (.next/).
#
# INTERNAL_API_URL must be set HERE, at build time: Next.js evaluates
# next.config.js's rewrites() during `next build` and bakes the result into
# the build output — `next start` does NOT re-run it. Without this, the
# localhost:4000 fallback gets baked in and every browser API call through
# the /api/v1 proxy dies with ECONNREFUSED inside the container. The value
# is the compose service name, which is stable for this deployment.
FROM deps AS build

WORKDIR /app

COPY . .

ENV INTERNAL_API_URL=http://api:4000

RUN npm run build --workspace apps/web

# Stage 3: runtime image — production dependencies only, plus the build output.
FROM node:24-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci --omit=dev

# Owned by "node" (see USER below): next start writes its runtime cache
# under .next/cache.
COPY --from=build --chown=node:node /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/next.config.js ./apps/web/next.config.js

# The manual pages read docs/manual/*.md at request time (apps/web/lib/manual.ts
# resolves cwd/../../docs/manual) — without this COPY every /hjalp chapter 500s.
COPY --from=build /app/docs/manual ./docs/manual

ENV NODE_ENV=production

# Run as the image's unprivileged "node" user.
USER node

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace", "apps/web"]
