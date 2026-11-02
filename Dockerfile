# DV Cloud: сборка образов server и admin. Образ node уже лежит локально.
# Сборка: docker build --target server -t dvcloud-server:dev .
#         docker build --target admin  -t dvcloud-admin:dev .
FROM node:22.23.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm ci --ignore-scripts
COPY apps ./apps
RUN npm run build --workspace @dvcloud/server

FROM node:22.23.1-alpine AS server
ENV NODE_ENV=production DVCLOUD_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --ignore-scripts --workspace @dvcloud/server --include-workspace-root=false \
 && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/migrations apps/server/migrations
USER node
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3004/api/health || exit 1
CMD ["node", "apps/server/dist/src/main.js"]

FROM node:22.23.1-alpine AS admin
ENV NODE_ENV=production DVCLOUD_ADMIN_HOST=0.0.0.0
WORKDIR /app
COPY apps/admin apps/admin
USER node
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3005/health || exit 1
CMD ["node", "apps/admin/server.mjs"]
