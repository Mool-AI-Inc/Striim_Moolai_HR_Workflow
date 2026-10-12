# Image for the employee sync demo.
#
# Runs the TypeScript directly with tsx rather than building to dist/. The repo's tsconfig is
# noEmit and the whole project shares one dependency tree, so adding a build step for this one app
# would mean either a second tsconfig or emitting the entire repo. tsx starts in well under a
# second and the container is a demo, not a latency-sensitive service. Type safety is not lost —
# `npm run typecheck` still covers these files, and CI runs it.
FROM node:22-slim

WORKDIR /app

# Dependencies first so a source edit does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

# Only what this app needs at runtime: its own tree, the two platform clients it reuses, and the
# tsconfig tsx reads. Copying the whole repo would pull in the Temporal workflows and the approval
# SPA for no reason.
COPY tsconfig.json ./
COPY src/platform/hris ./src/platform/hris
COPY src/platform/db ./src/platform/db
COPY src/platform/config ./src/platform/config
COPY src/platform/domain ./src/platform/domain
COPY src/syncdemo ./src/syncdemo

ENV NODE_ENV=production
ENV SYNCDEMO_PORT=3000
EXPOSE 3000

# Binds 0.0.0.0 (see index.ts) so the port is reachable from the host, not just the container.
CMD ["npx", "tsx", "src/syncdemo/server/index.ts"]
