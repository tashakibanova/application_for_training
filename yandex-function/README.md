# yandex-function — serverless-прокси на Yandex Cloud Functions

Замена Cloudflare Worker (недоступен без VPN у заказчика). Та же роль: принимает заявку от статичной формы (`site/`), генерирует xlsx, пишет комментарий со вложением в сделку Б24 или (если сделки нет/вызов не удался) — строку в Google Sheet, плюс всегда логирует метрики эксперимента. Контракт данных — `CONTRACT.md` в корне репозитория.

Код рассчитан на **одну** функцию с роутингом через query-параметр `?action=submit` / `?action=track` (без API Gateway — для двух маршрутов он избыточен).

⚠️ Ниже — рабочая последовательность действий, но точные названия флагов CLI могут немного отличаться в зависимости от версии `yc`. Если команда не сработает как есть — смотрите `yc serverless function version create --help` или используйте веб-консоль Yandex Cloud (Cloud Functions → Создать функцию), логика та же.

## 1. Установка `yc` CLI и вход

```
# Windows PowerShell
irm https://storage.yandexcloud.net/yandexcloud-yc/install.ps1 | iex
yc init
```
`yc init` откроет браузер для входа в аккаунт Yandex Cloud (это ваша собственная авторизация, не требует передачи паролей куда-либо ещё) и попросит выбрать/создать облако, каталог (folder) и зону по умолчанию.

## 2. Создать функцию

```
yc serverless function create --name zayavka-function
```

## 3. Задеплоить версию

Из папки `yandex-function/`:

```
yc serverless function version create \
  --function-name zayavka-function \
  --runtime nodejs18 \
  --entrypoint index.handler \
  --memory 128m \
  --execution-timeout 15s \
  --source-path . \
  --environment BITRIX_WEBHOOK_URL="https://ваш-портал.bitrix24.ru/rest/1/xxxxxxxx/",SHEETS_WEBHOOK_URL="https://script.google.com/macros/s/xxx/exec",SHEETS_WEBHOOK_SECRET="ваш-секрет",ALLOWED_ORIGIN="https://ваш-домен-формы"
```

`--source-path .` — Yandex Cloud сам установит зависимости из `package.json` при сборке. Если по какой-то причине автосборка зависимостей не сработает — выполните `npm install` локально в этой папке и передеплойте (тогда `node_modules` уедет вместе с исходниками).

Секреты (`BITRIX_WEBHOOK_URL`, `SHEETS_WEBHOOK_URL`, `SHEETS_WEBHOOK_SECRET`) — только через `--environment`, никогда не хардкодить в `index.js`.

## 4. Разрешить публичный вызов (без IAM-токена)

Форма на статичном хостинге не может подписывать запросы IAM-токеном, поэтому нужен публичный доступ:

```
yc serverless function allow-unauthenticated-invoke --name zayavka-function
```

(Эквивалент в консоли: Функция → вкладка "Триггеры/Обзор" → "Публичный доступ" → включить, либо через IAM — роль `serverless.functions.invoker` для `system:allUsers`.)

## 5. Получить URL функции

```
yc serverless function get --name zayavka-function
```

Прямой URL вызова обычно имеет вид:
```
https://functions.yandexcloud.net/<function_id>
```
(`<function_id>` — id из вывода команды выше, начинается на `d4e...` или похоже).

## 6. Прописать URL во фронтенде

В `site/app.js`:
```js
const FUNCTION_BASE_URL = 'https://functions.yandexcloud.net/<function_id>';
```
`SUBMIT_URL` и `TRACK_URL` собираются из неё автоматически (`?action=submit` / `?action=track`).

## 7. Проверка

```
curl -X POST "https://functions.yandexcloud.net/<function_id>?action=submit" \
  -H "Content-Type: application/json" \
  -d "{}"
```
Ожидаемый ответ — `400 {"ok":false,"error":"missing_organization"}` (пустой payload не проходит валидацию, но сама функция отвечает — значит, деплой и публичный доступ настроены верно).

## Отличия от Cloudflare-версии (для контекста, если сравниваете код)

- Обычный Node.js-рантайм, а не ограниченная среда Workers — поэтому `xlsx` собирается через `type: "buffer"` напрямую, без обхода через base64-режим.
- Нет `ctx.waitUntil` — все вызовы к Б24/Sheets дожидаются завершения до того, как функция вернёт ответ (чуть медленнее, но не критично для прототипа).
- Роутинг через `?action=`, а не через путь `/submit` — прямой URL вызова функции не поддерживает под-пути без API Gateway.
