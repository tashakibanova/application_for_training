# CONTRACT.md — контракты данных между компонентами

Единый источник правды для всех частей прототипа. Любое изменение полей — сначала здесь, потом в коде.

Компоненты:
- `site/` — статичная форма (HTML/CSS/JS, без сборки)
- `yandex-function/` — Yandex Cloud Function (serverless-прокси; изначально был Cloudflare Worker, заменён — Cloudflare недоступен без VPN у заказчика)
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
    "category": "labor_safety",
    "folder": "Охрана труда"
  },
  {
    "id": "456",
    "name": "Пожарно-технический минимум",
    "hours": 16,
    "category": "fire_safety",
    "folder": "Охрана труда"
  },
  {
    "id": "789",
    "name": "Оказание первой помощи",
    "hours": 8,
    "category": "first_aid",
    "folder": "Курсы повышения квалификации"
  },
  {
    "id": "101",
    "name": "Курс повышения квалификации по общему профилю",
    "hours": 72,
    "category": null,
    "folder": "Курсы повышения квалификации"
  }
]
```

- `category` ∈ `"labor_safety" | "fire_safety" | "first_aid" | null`.
- Если `category` не `null` — форма показывает у слушателя поля **Должность** и **Причина прохождения**.
- `hours` — подставляется в поле «Кол-во часов» автоматически при выборе курса (не редактируется руками).
- `folder` — человекочитаемое имя папки для группировки/фильтрации в попапе выбора курса (см. `scripts/export-catalog.js`, `COURSE_SECTIONS`). Не равно исходному названию раздела в Б24 — сделано специально понятнее для пользователя формы. Текущие значения: «Курсы повышения квалификации», «Программы профессиональной переподготовки», «Логопедия и дефектология», «Охрана труда», «Сколково», «Сколково: ПП».

---

## 2. POST `site` → `yandex-function` — `POST ?action=submit`

Тело запроса (`Content-Type: application/json`):

Пример для юридического лица (`applicantType: "legal_entity"`):

```json
{
  "dealId": "12345",
  "organization": {
    "applicantType": "legal_entity",
    "fullName": "МБОУ СОШ №1",
    "inn": "7701234567",
    "kpp": "770101001",
    "address": "г. Москва, ул. Ленина, д. 1",
    "documentType": "contract",
    "lawType": "44-fz",
    "ikzRequired": true,
    "ikzNumber": "223110123456712345100100000000000",
    "fundingSource": "Средства местного бюджета",
    "workplace": null,
    "workplaceInn": null,
    "selfEmployedOrUnemployed": null,
    "postalAddress": {
      "index": "123456",
      "address": "г. Москва, ул. Ленина, д. 1",
      "orgName": "МБОУ СОШ №1",
      "headFio": "Иванова Мария Петровна"
    },
    "headFio": "Иванова Мария Петровна",
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

Для физического лица (`applicantType: "individual"`) все поля-реквизиты учреждения (`fullName`, `inn`, `kpp`, `address`, `documentType`, `lawType`, `ikzRequired`, `ikzNumber`, `fundingSource`) — `null`, вместо них заполнены `workplace`/`selfEmployedOrUnemployed`, а `postalAddress.orgName` — тоже `null` (у физлица нет наименования учреждения-получателя):

```json
{
  "organization": {
    "applicantType": "individual",
    "fullName": null, "inn": null, "kpp": null, "address": null,
    "documentType": null, "lawType": null, "ikzRequired": null, "ikzNumber": null, "fundingSource": null,
    "workplace": "ООО «Ромашка», бухгалтер",
    "workplaceInn": "7707083893",
    "selfEmployedOrUnemployed": false,
    "postalAddress": { "index": "123456", "address": "...", "orgName": null, "headFio": "Петров Пётр Петрович" },
    "headFio": "Петров Пётр Петрович",
    "phone": null,
    "originalsDelivery": "sbis",
    "comment": null
  }
}
```

У `organization` намеренно нет `email` — email слушателей (`listeners[].email`) уже покрывает контакты по заявке, дублировать на уровне организации не нужно (решение заказчика). `phone` на уровне организации всё же есть, но только для ЮЛ (телефон контактного лица) — для ФЛ он не нужен отдельно (сам заявитель обычно фигурирует и как слушатель). Если понадобится контакт для заявок без сделки (см. §4.1) — используется `organization.phone` (если есть) или email/телефон первого слушателя.

Поля:
- `dealId`: строка или `null`, если параметра `?deal=` не было в URL.
- `organization.applicantType` ∈ `"legal_entity" | "individual"` — определяет, какие поля обязательны (см. ниже).
- Поля-реквизиты учреждения (`fullName`, `inn`, `kpp`, `address`, `documentType`, `lawType`, `ikzRequired`, `ikzNumber`, `fundingSource`) — заполнены и обязательны только при `applicantType === "legal_entity"`, иначе все `null`.
- `organization.documentType` ∈ `"contract" | "state_contract" | "municipal_contract"` | `null`.
- `organization.lawType` ∈ `"44-fz" | "223-fz"` | `null`.
- `organization.ikzRequired`: boolean | `null`; `ikzNumber` обязателен, только если `true`.
- `organization.workplace`: строка или `null` — заполняется только при `applicantType === "individual"`, необязательно (может быть пустым, если указан `selfEmployedOrUnemployed: true`).
- `organization.workplaceInn`: строка (10 или 12 цифр) или `null` — ИНН места работы физлица; заполняется только при `applicantType === "individual"` (для ЮЛ всегда `null`), автоподставляет название организации в `workplace` через DaData. Обязателен вместе с `workplace`, если `selfEmployedOrUnemployed !== true`.
- `organization.selfEmployedOrUnemployed`: boolean | `null` — только при `applicantType === "individual"`; при отправке обязательно `workplace` ИЛИ `selfEmployedOrUnemployed === true`.
- `organization.phone`: строка или `null` — телефон контактного лица; обязателен при `applicantType === "legal_entity"`, для `"individual"` всегда `null`.
- `organization.originalsDelivery` ∈ `"sbis" | "kontur"` — способ получения оригиналов договора, больше не связан с наличием почтового адреса (см. ниже).
- `organization.postalAddress`: объект, **всегда присутствует и обязателен** (независимо от `originalsDelivery` — почтовый адрес собирается всегда, не только при доставке почтой).
  - `postalAddress.address` — сам адрес (улица/дом), обязателен вместе с `index`/`headFio`.
  - `postalAddress.orgName` — наименование учреждения-получателя; заполняется только при `applicantType === "legal_entity"`, иначе `null`.
- `listeners[].position`: строка или `null` (только для курсов с `category != null`).
- `listeners[].reason` ∈ `"primary" | "regular" | "extraordinary"` или `null` (только для курсов с `category != null`).

Ответ функции: `200 { "ok": true, "target": "deal" | "sheet" }` или `4xx/5xx { "ok": false, "error": "..." }`.

xlsx, который генерирует функция из `listeners`, — один лист «Слушатели», колонки строго в порядке:
`Курс | Кол-во часов | Дата проведения | ФИО слушателя | Email | Личный телефон | Должность | Причина прохождения`
(последние две — пустые строки, если категория курса не требует их).

---

## 3. POST `site` → `yandex-function` — `POST ?action=track` (best-effort, `navigator.sendBeacon`)

Шлётся при `visibilitychange`/`beforeunload`, если форма начата, но не отправлена. Тело:

```json
{
  "dealId": "12345",
  "startedAt": "2026-07-07T10:00:00.000Z",
  "listenersCountSoFar": 2
}
```

Функция пишет это как строку «не завершено» в лист «Метрики эксперимента» (см. §5). Best-effort — ошибки не логируются пользователю, ответ не важен (`sendBeacon` не читает тело).

---

## 4. POST `yandex-function` → Apps Script Web App

URL и секрет — в переменных окружения функции (`SHEETS_WEBHOOK_URL`, `SHEETS_WEBHOOK_SECRET`). Формат тела всегда одинаковый конверт:

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
(xlsx в этом случае функция кладёт вложением в тот же комментарий не может — сделки нет; файл, если нужно сохранить, можно закодировать как base64 в отдельном поле `xlsxBase64`, но для прототипа обязателен только `rawPayloadJson`.)

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

## 5. Переменные окружения `yandex-function` (`--environment` при деплое, см. `yandex-function/README.md`)

| Имя | Назначение |
|---|---|
| `BITRIX_WEBHOOK_URL` | входящий вебхук Б24 (права `crm`) |
| `SHEETS_WEBHOOK_URL` | URL Apps Script Web App (`/exec`) |
| `SHEETS_WEBHOOK_SECRET` | общий секрет, который Apps Script проверяет в `secret` |
| `ALLOWED_ORIGIN` | домен(ы) статичной формы для CORS |

DaData-ключ используется прямо в браузере (см. `site/`), не проходит через `yandex-function` — если тариф требует ограничение по домену, а не по ключу в коде, это настраивается в личном кабинете DaData, ключ всё равно виден в клиентском JS (это ожидаемо и приемлемо для прототипа с бесплатным тарифом).

---

## 6. Переменные окружения generator-скрипта (`scripts/`)

| Имя | Назначение |
|---|---|
| `BITRIX_WEBHOOK_URL` | тот же вебхук, права `catalog` (чтение) |

Источник курсов — **iblockId 21** («Товарный каталог CRM»), отфильтрованный по конкретным разделам (ЦДО КПК/ПП в продаже, ЕРЛ Сколково/Сколково: ПП, ЕРЛ Логопедия/дефектология, ЕРЛ Охрана труда — id разделов зашиты в константу `COURSE_SECTIONS` в начале `scripts/export-catalog.js`). Часы почти всегда зашиты в название товара («... (108 часов)») и извлекаются регуляркой, отдельного поля для часов в карточке товара нет.

Категория (`labor_safety`/`fire_safety`/`first_aid`) определяется гибридно: в первую очередь по разделу (например, раздел «ЕРЛ. Охрана труда» → `labor_safety` — тексты названий там **не обязательно** содержат слова «охрана труда»), и дополнительно по ключевым словам в названии как запасной вариант для курсов вне выделенных разделов. Оба списка редактируются в начале `scripts/export-catalog.js`.
