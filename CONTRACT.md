# CONTRACT.md — контракты данных между компонентами

Единый источник правды для всех частей прототипа. Любое изменение полей — сначала здесь, потом в коде.

Компоненты:
- `site/` — статичная форма (HTML/CSS/JS, без сборки)
- `worker/` — Cloudflare Worker (serverless-прокси)
- `scripts/` — генератор `site/courses.json` из Б24
- `sheets/` — Google Apps Script (Web App), приёмник в Google Sheets

---

## 1. `site/courses.json`

Генерируется скриптом из `scripts/`, лежит в `site/courses.json`, форма читает его через `fetch('./courses.json')`.

```json
[
  {
    "id": "123",
    "name": "Охрана труда для руководителей и специалистов",
    "hours": 40,
    "category": "labor_safety"
  },
  {
    "id": "456",
    "name": "Пожарно-технический минимум",
    "hours": 16,
    "category": "fire_safety"
  },
  {
    "id": "789",
    "name": "Оказание первой помощи",
    "hours": 8,
    "category": "first_aid"
  },
  {
    "id": "101",
    "name": "Курс повышения квалификации по общему профилю",
    "hours": 72,
    "category": null
  }
]
```

- `category` ∈ `"labor_safety" | "fire_safety" | "first_aid" | null`.
- Если `category` не `null` — форма показывает у слушателя поля **Должность** и **Причина прохождения**.
- `hours` — подставляется в поле «Кол-во часов» автоматически при выборе курса (не редактируется руками).

---

## 2. POST `site` → `worker` — `POST /submit`

Тело запроса (`Content-Type: application/json`):

```json
{
  "dealId": "12345",
  "organization": {
    "fullName": "МБОУ СОШ №1",
    "inn": "7701234567",
    "kpp": "770101001",
    "address": "г. Москва, ул. Ленина, д. 1",
    "documentType": "contract",
    "lawType": "44-fz",
    "ikzRequired": true,
    "ikzNumber": "223110123456712345100100000000000",
    "fundingSource": "Средства местного бюджета",
    "postalAddress": {
      "index": "123456",
      "orgName": "МБОУ СОШ №1",
      "headFio": "Иванова Мария Петровна"
    },
    "headFio": "Иванова Мария Петровна",
    "email": "school1@example.com",
    "phone": "+79991234567",
    "originalsDelivery": "sbis",
    "comment": "Свободный текст комментария"
  },
  "listeners": [
    {
      "courseId": "123",
      "courseName": "Охрана труда для руководителей и специалистов",
      "hours": 40,
      "date": "2026-08-15",
      "fio": "Петров Иван Сергеевич",
      "email": "petrov@example.com",
      "phone": "+79997654321",
      "position": "Заместитель директора",
      "reason": "primary"
    }
  ],
  "metrics": {
    "startedAt": "2026-07-07T10:00:00.000Z",
    "submittedAt": "2026-07-07T10:07:32.000Z"
  }
}
```

Поля:
- `dealId`: строка или `null`, если параметра `?deal=` не было в URL.
- `organization.documentType` ∈ `"contract" | "state_contract" | "municipal_contract"`.
- `organization.lawType` ∈ `"44-fz" | "223-fz"`.
- `organization.ikzRequired`: boolean; `ikzNumber` обязателен, только если `true`.
- `organization.originalsDelivery` ∈ `"sbis" | "kontur"`.
- `listeners[].position`: строка или `null` (только для курсов с `category != null`).
- `listeners[].reason` ∈ `"primary" | "regular" | "extraordinary"` или `null` (только для курсов с `category != null`).

Ответ Worker: `200 { "ok": true, "target": "deal" | "sheet" }` или `4xx/5xx { "ok": false, "error": "..." }`.

xlsx, который генерирует Worker из `listeners`, — один лист «Слушатели», колонки строго в порядке:
`Курс | Кол-во часов | Дата проведения | ФИО слушателя | Email | Личный телефон | Должность | Причина прохождения`
(последние две — пустые строки, если категория курса не требует их).

---

## 3. POST `site` → `worker` — `POST /track` (best-effort, `navigator.sendBeacon`)

Шлётся при `visibilitychange`/`beforeunload`, если форма начата, но не отправлена. Тело:

```json
{
  "dealId": "12345",
  "startedAt": "2026-07-07T10:00:00.000Z",
  "listenersCountSoFar": 2
}
```

Worker пишет это как строку «не завершено» в лист «Метрики эксперимента» (см. §5). Best-effort — ошибки не логируются пользователю, ответ не важен (`sendBeacon` не читает тело).

---

## 4. POST `worker` → Apps Script Web App

URL и секрет — в env Worker (`SHEETS_WEBHOOK_URL`, `SHEETS_WEBHOOK_SECRET`). Формат тела всегда одинаковый конверт:

```json
{
  "secret": "shared-secret-from-env",
  "sheet": "unbound" | "metrics",
  "row": { }
}
```

### 4.1 `sheet: "unbound"` → лист «Незакреплённые заявки»

`row`:
```json
{
  "receivedAt": "2026-07-07T10:07:33.000Z",
  "organizationName": "МБОУ СОШ №1",
  "inn": "7701234567",
  "contactEmail": "school1@example.com",
  "contactPhone": "+79991234567",
  "listenersCount": 3,
  "coursesSummary": "Охрана труда для руководителей и специалистов",
  "note": "не привязано к сделке",
  "rawPayloadJson": "{...весь исходный payload как строка, для ручной разборки...}"
}
```
(xlsx в этом случае Worker кладёт вложением в тот же комментарий не может — сделки нет; файл, если нужно сохранить, можно закодировать как base64 в отдельном поле `xlsxBase64`, но для прототипа обязателен только `rawPayloadJson`.)

### 4.2 `sheet: "metrics"` → лист «Метрики эксперимента»

`row`:
```json
{
  "dealId": "12345",
  "startedAt": "2026-07-07T10:00:00.000Z",
  "submittedAt": "2026-07-07T10:07:32.000Z",
  "listenersCount": 3,
  "status": "completed" | "abandoned",
  "durationSeconds": 452
}
```
- `status: "abandoned"` пишется из `/track` (beacon), `submittedAt` в этом случае `null`.
- `status: "completed"` пишется при успешной обработке `/submit`.

---

## 5. Переменные окружения Worker (`wrangler secret put ...`)

| Имя | Назначение |
|---|---|
| `BITRIX_WEBHOOK_URL` | входящий вебхук Б24 (права `crm`) |
| `SHEETS_WEBHOOK_URL` | URL Apps Script Web App (`/exec`) |
| `SHEETS_WEBHOOK_SECRET` | общий секрет, который Apps Script проверяет в `secret` |

DaData-ключ используется прямо в браузере (см. `site/`), не проходит через Worker — если тариф требует ограничение по домену, а не по ключу в коде, это настраивается в личном кабинете DaData, ключ всё равно виден в клиентском JS (это ожидаемо и приемлемо для прототипа с бесплатным тарифом).

---

## 6. Переменные окружения generator-скрипта (`scripts/`)

| Имя | Назначение |
|---|---|
| `BITRIX_WEBHOOK_URL` | тот же вебхук, права `catalog` (чтение) |

Категории (`labor_safety`/`fire_safety`/`first_aid`) в Б24 не хранятся напрямую — скрипт определяет категорию по ключевым словам в названии секции/товара (см. README в `scripts/`) и оставляет `category: null`, если не распознал; список ключевых слов должен быть легко редактируемым в начале файла скрипта.
