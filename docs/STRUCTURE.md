# Структура репозитория

    apps/server   NestJS, API, работа с файлами и базой (pg, SQL-миграции, без ORM)
    apps/web      React + Vite, веб-интерфейс пользователя
    apps/admin    админка на чистом Node.js, без зависимостей
    apps/android  клиент для Android (позже)
    tools/        служебные скрипты (проверка лицензий)
    docs/         документация

## Порты для разработки (всё только на 127.0.0.1)

    3004  server, публичный порт (вход, API)
    3005  admin
    3006  server, внутренний порт для админки (управление людьми)
    5177  web (Vite dev)
    5436  Postgres (docker-compose.dev.yml)
    3010  DV Auth, публичный порт (необязательно, docs/TWOFACTOR.md)
    3011  DV Auth, внутренний порт (его адрес задаётся в DVCLOUD_AUTH_URL)

## Команды

    npm install        поставить зависимости всех приложений
    npm run build      собрать server и web
    npm run dev:server / dev:admin / dev:web
                       запустить сервер, админку, сайт (сайт на http://127.0.0.1:5177)
    npm test           тесты всех приложений (node --test), без базы
    npm run test:db --workspace @dvcloud/server
                       тесты входа на настоящем Postgres (нужен DVCLOUD_TEST_DATABASE_URL)
    npm run licenses   проверка лицензий зависимостей

## База данных

SQL-миграции лежат в apps/server/migrations, имя NNNN_имя.sql. Применяются по порядку,
каждая в своей транзакции, применённые записываются в таблицу schema_migrations.
Запуск: npm run migrate --workspace @dvcloud/server (нужен DVCLOUD_DATABASE_URL).

## Лицензии зависимостей

Сам проект распространяется под AGPL-3.0 (файл LICENSE, подробности в docs/LICENSING.md).
Разрешены без оговорок MIT, BSD, Apache-2.0, MPL-2.0. ISC и 0BSD разрешены и видны в отчёте.
Копилефт, совместимый с AGPL-3.0 (LGPL-3.0, GPL-3.0, AGPL-3.0), разрешён и виден отдельным списком.
GPL-2.0-only, LGPL-2.1-only, несвободные лицензии и пакеты без лицензии не допускаются:
tools/check-licenses.mjs завершается с ошибкой.
