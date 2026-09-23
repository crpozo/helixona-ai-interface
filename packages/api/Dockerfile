# Contexto de build: raíz del monorepo.  docker build -f packages/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --workspace @helixona/core --workspace @helixona/api --workspace @helixona/web --include-workspace-root
COPY packages/core packages/core
COPY packages/api packages/api
COPY packages/web packages/web
RUN npm run build -w @helixona/core && npm run build -w @helixona/api && npm run build -w @helixona/web \
 && npm prune --omit=dev --workspace @helixona/core --workspace @helixona/api --include-workspace-root

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/packages/web/dist
WORKDIR /app/packages/api
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules /app/node_modules
COPY --from=build --chown=app:app /app/package.json /app/package.json
COPY --from=build --chown=app:app /app/packages/core/package.json /app/packages/core/package.json
COPY --from=build --chown=app:app /app/packages/core/dist /app/packages/core/dist
COPY --from=build --chown=app:app /app/packages/api/package.json /app/packages/api/package.json
COPY --from=build --chown=app:app /app/packages/api/dist /app/packages/api/dist
COPY --from=build --chown=app:app /app/packages/api/prompts /app/packages/api/prompts
COPY --from=build --chown=app:app /app/packages/api/agreements /app/packages/api/agreements
COPY --from=build --chown=app:app /app/packages/web/dist /app/packages/web/dist
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.js"]
