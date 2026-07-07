// Cloudflare Worker — прокси между статичной формой (site/), Bitrix24 и Google Sheets.
// Схема данных — см. CONTRACT.md в корне репозитория. Любое изменение полей
// сначала фиксируется там, потом здесь.
//
// Прототип: приоритет — простота и скорость, а не полнота обработки ошибок.

import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function resolveAllowedOrigin(requestOrigin, env) {
  const configured = (env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length === 0 || configured.includes("*")) return "*";
  if (requestOrigin && configured.includes(requestOrigin)) return requestOrigin;
  // Origin не входит в список разрешённых — не отражаем его, чтобы не давать
  // ложное ощущение разрешённого доступа. Браузер сам заблокирует запрос,
  // так как заголовок не будет совпадать с Origin страницы.
  return configured[0];
}

function corsHeaders(allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

// ---------------------------------------------------------------------------
// Вспомогательные функции — xlsx
// ---------------------------------------------------------------------------

const REASON_LABELS = {
  primary: "первичная",
  regular: "очередная",
  extraordinary: "внеочередная",
};

const XLSX_HEADER = [
  "Курс",
  "Кол-во часов",
  "Дата проведения",
  "ФИО слушателя",
  "Email",
  "Личный телефон",
  "Должность",
  "Причина прохождения",
];

// Возвращает base64-строку готового .xlsx (лист "Слушатели").
// Используем XLSX.write(..., { type: "base64" }) намеренно: этот режим
// SheetJS не требует Node Buffer (в отличие от type: "buffer"), а значит
// безопасен в Workers runtime без гарантий на глобальный Buffer.
// Подробнее — см. README.md, раздел "Известные риски".
function buildListenersXlsxBase64(listeners) {
  const rows = listeners.map((l) => [
    l.courseName || "",
    typeof l.hours === "number" ? l.hours : "",
    l.date || "",
    l.fio || "",
    l.email || "",
    l.phone || "",
    l.position || "",
    l.reason ? REASON_LABELS[l.reason] || l.reason : "",
  ]);

  const worksheet = XLSX.utils.aoa_to_sheet([XLSX_HEADER, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Слушатели");

  return XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
}

function buildFileName(organization) {
  const safe = (organization && organization.fullName ? organization.fullName : "zayavka")
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .trim()
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 10);
  return `Заявка_${safe || "zayavka"}_${stamp}.xlsx`;
}

function uniqueCourseNames(listeners) {
  const seen = new Set();
  const names = [];
  for (const l of listeners) {
    if (l && l.courseName && !seen.has(l.courseName)) {
      seen.add(l.courseName);
      names.push(l.courseName);
    }
  }
  return names;
}

function buildCommentText(organization, listeners, coursesSummary, submittedAt) {
  return [
    "Заявка на обучение через веб-форму.",
    `Организация: ${organization.fullName}`,
    `Слушателей: ${listeners.length}`,
    `Курс(ы): ${coursesSummary || "—"}`,
    `Отправлено: ${submittedAt}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Валидация входного payload (§2 CONTRACT.md) — лёгкая, без внешних зависимостей
// ---------------------------------------------------------------------------

function validateSubmitPayload(payload) {
  if (!payload || typeof payload !== "object") return "invalid_payload";

  if (payload.dealId !== null && payload.dealId !== undefined && typeof payload.dealId !== "string") {
    return "invalid_dealId";
  }

  const org = payload.organization;
  if (!org || typeof org !== "object") return "missing_organization";

  const requiredOrgFields = [
    "fullName",
    "inn",
    "documentType",
    "lawType",
    "fundingSource",
    "headFio",
    "email",
    "phone",
    "originalsDelivery",
  ];
  for (const field of requiredOrgFields) {
    if (!org[field]) return `missing_organization.${field}`;
  }
  if (typeof org.ikzRequired !== "boolean") return "missing_organization.ikzRequired";
  if (org.ikzRequired && !org.ikzNumber) return "missing_organization.ikzNumber";
  if (!org.postalAddress || typeof org.postalAddress !== "object") {
    return "missing_organization.postalAddress";
  }

  if (!Array.isArray(payload.listeners) || payload.listeners.length === 0) {
    return "missing_listeners";
  }
  for (let i = 0; i < payload.listeners.length; i++) {
    const l = payload.listeners[i];
    if (!l || typeof l !== "object") return `invalid_listener_${i}`;
    if (!l.courseId || !l.courseName || !l.date || !l.fio || !l.email || !l.phone) {
      return `missing_listener_fields_${i}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Bitrix24 REST
// ---------------------------------------------------------------------------

async function callBitrixAddComment(env, dealId, commentText, fileName, xlsxBase64) {
  if (!env.BITRIX_WEBHOOK_URL) {
    return { ok: false, error: "BITRIX_WEBHOOK_URL is not configured" };
  }
  const entityId = Number(dealId);
  if (!Number.isFinite(entityId)) {
    return { ok: false, error: "dealId is not a valid number" };
  }

  const endpoint = env.BITRIX_WEBHOOK_URL.replace(/\/?$/, "/") + "crm.timeline.comment.add";

  // Формат вложения файла для crm.timeline.comment.add: поле FILES — массив
  // пар [имяФайла, base64Содержимое]. Подтверждено официальной документацией
  // Б24 REST (apidocs.bitrix24.com/api-reference/crm/timeline/comments/
  // crm-timeline-comment-add.html) — без дополнительной обёртки вида
  // "fileContent".
  const body = {
    fields: {
      ENTITY_ID: entityId,
      ENTITY_TYPE: "deal",
      COMMENT: commentText,
      FILES: [[fileName, xlsxBase64]],
    },
  };

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) {
      const errText = (data && (data.error_description || data.error)) || `HTTP ${resp.status}`;
      return { ok: false, error: errText };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "network_error" };
  }
}

// ---------------------------------------------------------------------------
// Apps Script Web App (Google Sheets)
// ---------------------------------------------------------------------------

async function sendToAppsScript(env, sheet, row) {
  if (!env.SHEETS_WEBHOOK_URL || !env.SHEETS_WEBHOOK_SECRET) {
    return { ok: false, error: "SHEETS_WEBHOOK_URL/SHEETS_WEBHOOK_SECRET is not configured" };
  }
  try {
    const resp = await fetch(env.SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.SHEETS_WEBHOOK_SECRET, sheet, row }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status} ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "network_error" };
  }
}

async function sendUnboundRow(env, payload, coursesSummary, xlsxBase64, note) {
  const row = {
    receivedAt: new Date().toISOString(),
    organizationName: payload.organization.fullName,
    inn: payload.organization.inn,
    contactEmail: payload.organization.email,
    contactPhone: payload.organization.phone,
    listenersCount: payload.listeners.length,
    coursesSummary,
    note,
    rawPayloadJson: JSON.stringify(payload),
    // Не входит в обязательный набор §4.1 CONTRACT.md, но контракт явно
    // допускает такое поле для ручного восстановления файла, если сделки нет.
    xlsxBase64,
  };
  return sendToAppsScript(env, "unbound", row);
}

// ---------------------------------------------------------------------------
// Метрики
// ---------------------------------------------------------------------------

function computeDurationSeconds(startedAt, submittedAt) {
  if (!startedAt || !submittedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(submittedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

// ---------------------------------------------------------------------------
// /submit
// ---------------------------------------------------------------------------

async function handleSubmit(request, env, ctx, cors) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400, cors);
  }

  const validationError = validateSubmitPayload(payload);
  if (validationError) {
    return jsonResponse({ ok: false, error: validationError }, 400, cors);
  }

  const { dealId, organization, listeners, metrics } = payload;
  const submittedAt = (metrics && metrics.submittedAt) || new Date().toISOString();

  let xlsxBase64;
  try {
    xlsxBase64 = buildListenersXlsxBase64(listeners);
  } catch (e) {
    console.error("xlsx build failed:", e && e.message);
    return jsonResponse({ ok: false, error: "xlsx_generation_failed" }, 500, cors);
  }

  const coursesSummary = uniqueCourseNames(listeners).join(", ");
  const fileName = buildFileName(organization);

  let target = null;
  let submitError = null;

  if (dealId) {
    const commentText = buildCommentText(organization, listeners, coursesSummary, submittedAt);
    const bitrixResult = await callBitrixAddComment(env, dealId, commentText, fileName, xlsxBase64);

    if (bitrixResult.ok) {
      target = "deal";
    } else {
      // Не теряем данные, если сделка указана, но вызов Б24 не удался
      // (например, неверный dealId, недоступен вебхук): пишем в тот же лист
      // "Незакреплённые заявки" с пояснением, чтобы менеджер разобрал вручную.
      console.error("Bitrix call failed, falling back to sheet:", bitrixResult.error);
      const sheetResult = await sendUnboundRow(
        env,
        payload,
        coursesSummary,
        xlsxBase64,
        `не привязано к сделке (ошибка Б24 для dealId=${dealId}: ${bitrixResult.error})`
      );
      if (sheetResult.ok) {
        target = "sheet";
      } else {
        submitError = "bitrix_and_sheet_failed";
      }
    }
  } else {
    const sheetResult = await sendUnboundRow(env, payload, coursesSummary, xlsxBase64, "не привязано к сделке");
    if (sheetResult.ok) {
      target = "sheet";
    } else {
      submitError = "sheet_failed";
    }
  }

  // Независимо от исхода — всегда логируем метрики (§4.2). Делаем это через
  // ctx.waitUntil, чтобы не задерживать ответ клиенту; ошибка здесь не должна
  // ронять основной ответ пользователю.
  ctx.waitUntil(
    sendToAppsScript(env, "metrics", {
      dealId: dealId || null,
      startedAt: (metrics && metrics.startedAt) || null,
      submittedAt,
      listenersCount: listeners.length,
      status: "completed",
      durationSeconds: computeDurationSeconds(metrics && metrics.startedAt, submittedAt),
    }).then((r) => {
      if (!r.ok) console.error("metrics(completed) logging failed:", r.error);
    })
  );

  if (submitError) {
    return jsonResponse({ ok: false, error: submitError }, 502, cors);
  }
  return jsonResponse({ ok: true, target }, 200, cors);
}

// ---------------------------------------------------------------------------
// /track (best-effort, sendBeacon)
// ---------------------------------------------------------------------------

async function handleTrack(request, env, ctx, cors) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    // sendBeacon не читает тело/статус ответа — просто отвечаем быстро.
    return new Response(null, { status: 204, headers: cors });
  }

  const startedAt = payload && payload.startedAt ? payload.startedAt : null;
  const row = {
    dealId: (payload && payload.dealId) || null,
    startedAt,
    submittedAt: null,
    listenersCount:
      payload && typeof payload.listenersCountSoFar === "number" ? payload.listenersCountSoFar : 0,
    status: "abandoned",
    durationSeconds: computeDurationSeconds(startedAt, new Date().toISOString()),
  };

  // Best-effort: не блокируем ответ на запросе к Apps Script, ошибки только
  // логируем в консоль Worker (никогда не в ответ клиенту — sendBeacon его и
  // не прочитает).
  ctx.waitUntil(
    sendToAppsScript(env, "metrics", row).then((r) => {
      if (!r.ok) console.error("/track: Apps Script call failed:", r.error);
    })
  );

  return new Response(null, { status: 204, headers: cors });
}

// ---------------------------------------------------------------------------
// Роутинг
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const requestOrigin = request.headers.get("Origin") || "";
    const allowedOrigin = resolveAllowedOrigin(requestOrigin, env);
    const cors = corsHeaders(allowedOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/submit") {
        return await handleSubmit(request, env, ctx, cors);
      }
      if (request.method === "POST" && url.pathname === "/track") {
        return await handleTrack(request, env, ctx, cors);
      }
    } catch (err) {
      // Никогда не логируем значения секретов — только сообщение ошибки.
      console.error("Unhandled error:", err && err.message ? err.message : String(err));
      return jsonResponse({ ok: false, error: "internal_error" }, 500, cors);
    }

    return jsonResponse({ ok: false, error: "not_found" }, 404, cors);
  },
};
