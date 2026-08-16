# Container for the local HTTP API.
#
# Deliberately minimal: the engine has no dependencies and needs no system
# tools, so the runtime layer is Node and four JavaScript files. Nothing else
# is installed: nothing extra to keep patched, and nothing with access to the
# documents that pass through.

FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/cli/package.json ./packages/cli/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @unmark/core build && pnpm --filter @unmark/server build
RUN pnpm deploy --filter @unmark/server --prod /output


FROM node:22-alpine AS runtime
WORKDIR /app

# Run as an unprivileged user. The process needs no file-system access beyond
# its own code: request bodies are held in memory and never written to disk.
RUN addgroup -S unmark && adduser -S -G unmark unmark
COPY --from=build --chown=unmark:unmark /output ./
USER unmark

ENV NODE_ENV=production \
    UNMARK_HOST=0.0.0.0 \
    UNMARK_PORT=8765

# UNMARK_HOST is 0.0.0.0 because a container cannot be reached on its own
# loopback. That makes the network boundary the container's, not the process's —
# publish the port only where you trust the clients, and set UNMARK_API_KEY.
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.UNMARK_PORT||8765)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
