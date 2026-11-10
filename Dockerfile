# DV Cloud: сборка образов server, admin и web. Образ node уже лежит локально.
# Сборка: docker build --target server -t dvcloud-server:dev .
#         docker build --target admin  -t dvcloud-admin:dev .
#         docker build --target web    -t dvcloud-web:dev .
#         docker build --target login  -t dvcloud-login:dev .   (необязательно: вход в Яндекс по QR, см. docs/YANDEX.md)
FROM node:22.23.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm ci --ignore-scripts
COPY apps ./apps
RUN npm run build --workspace @dvcloud/server \
 && npm run build --workspace @dvcloud/web

FROM node:22.23.1-alpine AS server
ENV NODE_ENV=production DVCLOUD_HOST=0.0.0.0 DVCLOUD_INTERNAL_HOST=0.0.0.0
# ffmpeg нужен для кадра-постера видео; запускается отдельным процессом, в код проекта не входит.
# Для резервной копии из админки (docs/BACKUP.md): rsync переносит файлы, openssh-client нужен для копии на другой сервер,
# postgresql17-client выгружает базу (версия клиента должна быть не ниже версии базы: в примере postgres:17).
# libheif-tools (heif-dec) превращает фото HEIC в JPEG для миниатюр и поиска лиц; запускается отдельным процессом (LGPL).
RUN apk add --no-cache ffmpeg libheif-tools rsync openssh-client postgresql17-client
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
# Миграции применяются при каждом старте (повторный запуск безопасен), потом запускается сервер.
CMD ["sh", "-c", "node apps/server/dist/src/db/migrate-cli.js && exec node apps/server/dist/src/main.js"]

FROM node:22.23.1-alpine AS admin
ENV NODE_ENV=production DVCLOUD_ADMIN_HOST=0.0.0.0
WORKDIR /app
COPY apps/admin apps/admin
USER node
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3005/health || exit 1
CMD ["node", "apps/admin/server.mjs"]

# Сайт: готовая сборка React и Caddy, который отдаёт её и пересылает /api на сервер (адрес в DVCLOUD_UPSTREAM).
FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:80/ >/dev/null || exit 1

# Помощник входа в Яндекс по QR (необязательно, см. docs/YANDEX.md): маленькая служба и браузер Chromium без окна.
# Тот же базовый образ node, что и у остальных; Chromium берётся из пакетов Alpine и в коде проекта не лежит.
FROM node:22.23.1-alpine AS login
ENV NODE_ENV=production CHROMIUM_PATH=/usr/bin/chromium-browser
RUN apk add --no-cache chromium font-noto
WORKDIR /app
COPY apps/login/package.json apps/login/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY apps/login/server.mjs ./
USER node
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8099/health || exit 1
CMD ["node", "server.mjs"]
