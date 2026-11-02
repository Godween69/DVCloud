# Структура репозитория

    apps/server   NestJS, API, работа с файлами и базой (pg, SQL-миграции, без ORM)
    apps/web      React + Vite, веб-интерфейс пользователя
    apps/admin    админка на чистом Node.js, без зависимостей
    apps/android  клиент для Android (позже)
    tools/        служебные скрипты (проверка лицензий)
    docs/         документация

## Порты для разработки (всё только на 127.0.0.1)

    3004  server
    3005  admin
    5177  web (Vite dev)
    5436  Postgres (docker-compose.dev.yml)

## Команды

    npm install        поставить зависимости всех приложений
    npm run build      собрать server и web
    npm test           тесты всех приложений (node --test)
    npm run licenses   проверка лицензий зависимостей

## База данных

SQL-миграции лежат в apps/server/migrations, имя NNNN_имя.sql. Применяются по порядку,
каждая в своей транзакции, применённые записываются в таблицу schema_migrations.
Запуск: npm run migrate --workspace @dvcloud/server (нужен DVCLOUD_DATABASE_URL).

## Лицензии зависимостей

Разрешены MIT, BSD, Apache-2.0, MPL-2.0. ISC и 0BSD разрешены и видны в отчёте.
AGPL, GPL и пакеты без лицензии не допускаются: tools/check-licenses.mjs завершается с ошибкой.
