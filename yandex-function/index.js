'use strict';

// Yandex Cloud Function — прокси между статичной формой (site/), Bitrix24 и
// Google Sheets. Замена Cloudflare Worker (недоступен без VPN у заказчика) —
// та же роль, тот же контракт данных, см. CONTRACT.md в корне репозитория.
//
// Реализована как ОДНА функция с роутингом через query-параметр ?action=submit
// или ?action=track (а не через путь /submit — прямой URL вызова функции вида
// https://functions.yandexcloud.net/<id> не даёт управлять под-путями без
// API Gateway, а заводить API Gateway ради двух маршрутов избыточно для
// прототипа).
//
// В отличие от Cloudflare Workers, здесь нет ctx.waitUntil — рантайм обычного
// Node.js, поэтому все асинхронные вызовы (Б24, Sheets) дожидаются завершения
// перед тем, как функция вернёт ответ. Это немного увеличивает время ответа
// клиенту, но для прототипа не критично.

const XLSX = require('xlsx');

const REASON_LABELS = {
  primary: 'первичная',
  regular: 'очередная',
  extraordinary: 'внеочередная',
};

const XLSX_HEADER = [
  'Курс',
  'Кол-во часов',
  'Дата проведения',
  'ФИО слушателя',
  'Email',
  'Личный телефон',
  'Должность',
  'Причина прохождения',
];

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function resolveAllowedOrigin(requestOrigin) {
  const configured = (process.env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length === 0 || configured.includes('*')) return '*';
  if (requestOrigin && configured.includes(requestOrigin)) return requestOrigin;
  return configured[0];
}

function corsHeaders(allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(statusCode, data, cors) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
    body: JSON.stringify(data),
    isBase64Encoded: false,
  };
}

function emptyResponse(statusCode, cors) {
  return { statusCode, headers: cors, body: '', isBase64Encoded: false };
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

function buildListenersXlsxBase64(listeners) {
  const rows = listeners.map((l) => [
    l.courseName || '',
    typeof l.hours === 'number' ? l.hours : '',
    l.date || '',
    l.fio || '',
    l.email || '',
    l.phone || '',
    l.position || '',
    l.reason ? REASON_LABELS[l.reason] || l.reason : '',
  ]);

  const worksheet = XLSX.utils.aoa_to_sheet([XLSX_HEADER, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Слушатели');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return buffer.toString('base64');
}

function applicantDisplayName(organization) {
  return (organization && (organization.fullName || organization.headFio)) || 'zayavka';
}

function buildFileName(organization) {
  const safe = applicantDisplayName(organization)
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .trim()
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 10);
  return `Заявка_${safe || 'zayavka'}_${stamp}.xlsx`;
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

const DOCUMENT_TYPE_LABELS = {
  contract: 'Договор',
  state_contract: 'Контракт',
  municipal_contract: 'Муниципальный контракт',
};
const LAW_TYPE_LABELS = { '44-fz': '44-ФЗ', '223-fz': '223-ФЗ' };
const DELIVERY_LABELS = { sbis: 'СБИС', kontur: 'Контур', russian_post: 'Почтой России' };

// xlsx-вложение содержит только данные слушателей (см. CONTRACT.md §2, колонки
// фиксированы) — реквизиты организации/условия договора в него не попадают.
// Поэтому комментарий в сделке должен быть самодостаточным: менеджер готовит
// договор по тексту комментария, не открывая исходный payload формы.
function buildCommentText(organization, listeners, coursesSummary, submittedAt) {
  const lines = ['Заявка на обучение через веб-форму.', ''];
  const isIndividual = organization.applicantType === 'individual';

  if (isIndividual) {
    lines.push(`Физлицо: ${organization.headFio}`);
    if (organization.selfEmployedOrUnemployed) {
      lines.push('Занятость: самозанятый(ая) / временно не работает');
    } else if (organization.workplace) {
      lines.push(
        `Место работы: ${organization.workplace}` +
          (organization.workplaceInn ? ` (ИНН ${organization.workplaceInn})` : '')
      );
    }
  } else {
    lines.push(`Организация: ${organization.fullName}`);
    lines.push(`ИНН: ${organization.inn}` + (organization.kpp ? `, КПП: ${organization.kpp}` : ''));
    if (organization.address) lines.push(`Юр. адрес: ${organization.address}`);
    if (organization.bankName) {
      lines.push('');
      lines.push(`Банк: ${organization.bankName}`);
      lines.push(`БИК ${organization.bik}`);
      lines.push(`Р/с ${organization.settlementAccount}`);
      lines.push(`Кор.счет ${organization.correspondentAccount}`);
      if (organization.personalAccount) lines.push(`Л/с ${organization.personalAccount}`);
      if (organization.bankExtra) lines.push(`Доп. данные: ${organization.bankExtra}`);
    }
    lines.push('');
    lines.push(`Тип документа: ${DOCUMENT_TYPE_LABELS[organization.documentType] || organization.documentType}`);
    lines.push(`Закон-основание: ${LAW_TYPE_LABELS[organization.lawType] || organization.lawType}`);
    lines.push(organization.ikzRequired ? `ИКЗ: ${organization.ikzNumber}` : 'ИКЗ не требуется');
    lines.push(`Источник финансирования: ${organization.fundingSource}`);
    lines.push('');
    lines.push(`Контактное лицо: ${organization.headFio}`);
    lines.push(`Телефон: ${organization.phone}`);
    if (organization.email) lines.push(`Email: ${organization.email}`);
  }

  lines.push('');
  lines.push(
    `Способ получения оригиналов: ${DELIVERY_LABELS[organization.originalsDelivery] || organization.originalsDelivery}`
  );
  if (organization.postalAddress) {
    const p = organization.postalAddress;
    const recipient = [p.orgName, p.headFio].filter(Boolean).join(', ');
    lines.push(
      `Почтовый адрес: ${p.index}, ${p.address}` + (recipient ? ` — получатель: ${recipient}` : '')
    );
  }

  if (organization.comment) {
    lines.push('');
    lines.push(`Комментарий заявителя: ${organization.comment}`);
  }

  lines.push('');
  lines.push(`Слушателей: ${listeners.length}`);
  lines.push(`Курс(ы): ${coursesSummary || '—'}`);
  lines.push(`Отправлено: ${submittedAt}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Валидация входного payload (§2 CONTRACT.md)
// ---------------------------------------------------------------------------

function validateSubmitPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'invalid_payload';

  if (payload.dealId !== null && payload.dealId !== undefined && typeof payload.dealId !== 'string') {
    return 'invalid_dealId';
  }

  const org = payload.organization;
  if (!org || typeof org !== 'object') return 'missing_organization';

  if (org.applicantType !== 'legal_entity' && org.applicantType !== 'individual') {
    return 'invalid_organization.applicantType';
  }

  if (org.applicantType === 'legal_entity') {
    const requiredOrgFields = [
      'fullName', 'inn', 'documentType', 'lawType', 'fundingSource', 'phone', 'email',
      'bankName', 'bik', 'settlementAccount', 'correspondentAccount',
    ];
    for (const field of requiredOrgFields) {
      if (!org[field]) return `missing_organization.${field}`;
    }
    if (typeof org.ikzRequired !== 'boolean') return 'missing_organization.ikzRequired';
    if (org.ikzRequired && !org.ikzNumber) return 'missing_organization.ikzNumber';
  }

  // email/phone на уровне organization — контакты контактного лица, обязательны
  // для ЮЛ (проверены выше в requiredOrgFields); для ФЛ их нет вообще, роль
  // контактов выполняет email/телефон слушателей (см. CONTRACT.md §2).
  const requiredContactFields = ['headFio', 'originalsDelivery'];
  for (const field of requiredContactFields) {
    if (!org[field]) return `missing_organization.${field}`;
  }

  // Почтовый адрес больше не завязан на originalsDelivery — форма всегда его
  // собирает, поэтому он всегда обязателен (см. CONTRACT.md §2).
  if (!org.postalAddress || typeof org.postalAddress !== 'object') {
    return 'missing_organization.postalAddress';
  }
  if (!org.postalAddress.index || !org.postalAddress.address || !org.postalAddress.headFio) {
    return 'missing_organization.postalAddress_fields';
  }

  if (!Array.isArray(payload.listeners) || payload.listeners.length === 0) {
    return 'missing_listeners';
  }
  for (let i = 0; i < payload.listeners.length; i++) {
    const l = payload.listeners[i];
    if (!l || typeof l !== 'object') return `invalid_listener_${i}`;
    if (!l.courseId || !l.courseName || !l.date || !l.fio || !l.email || !l.phone) {
      return `missing_listener_fields_${i}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Bitrix24 REST
// ---------------------------------------------------------------------------

async function callBitrixAddComment(dealId, commentText, fileName, xlsxBase64) {
  const webhookUrl = process.env.BITRIX_WEBHOOK_URL;
  if (!webhookUrl) return { ok: false, error: 'BITRIX_WEBHOOK_URL is not configured' };

  const entityId = Number(dealId);
  if (!Number.isFinite(entityId)) return { ok: false, error: 'dealId is not a valid number' };

  const endpoint = webhookUrl.replace(/\/?$/, '/') + 'crm.timeline.comment.add';

  // Формат вложения файла: поле FILES — массив пар [имяФайла, base64].
  // apidocs.bitrix24.com/api-reference/crm/timeline/comments/crm-timeline-comment-add.html
  const body = {
    fields: {
      ENTITY_ID: entityId,
      ENTITY_TYPE: 'deal',
      COMMENT: commentText,
      FILES: [[fileName, xlsxBase64]],
    },
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) {
      const errText = (data && (data.error_description || data.error)) || `HTTP ${resp.status}`;
      return { ok: false, error: errText };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'network_error' };
  }
}

// ---------------------------------------------------------------------------
// Apps Script Web App (Google Sheets)
// ---------------------------------------------------------------------------

async function sendToAppsScript(sheet, row) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  const secret = process.env.SHEETS_WEBHOOK_SECRET;
  if (!url || !secret) return { ok: false, error: 'SHEETS_WEBHOOK_URL/SHEETS_WEBHOOK_SECRET is not configured' };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, sheet, row }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status} ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'network_error' };
  }
}

async function sendUnboundRow(payload, coursesSummary, xlsxBase64, note) {
  // Контакты контактного лица (email/phone) есть только у ЮЛ — используем их,
  // если есть, иначе для ручной разборки незакреплённой заявки берём email/
  // телефон первого слушателя (ФЛ или fallback), см. CONTRACT.md §2.
  const firstListener = payload.listeners && payload.listeners[0];
  const row = {
    receivedAt: new Date().toISOString(),
    organizationName: applicantDisplayName(payload.organization),
    inn: payload.organization.inn,
    contactEmail: payload.organization.email || (firstListener && firstListener.email) || null,
    contactPhone: payload.organization.phone || (firstListener && firstListener.phone) || null,
    listenersCount: payload.listeners.length,
    coursesSummary,
    note,
    rawPayloadJson: JSON.stringify(payload),
    xlsxBase64,
  };
  return sendToAppsScript('unbound', row);
}

function computeDurationSeconds(startedAt, submittedAt) {
  if (!startedAt || !submittedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(submittedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

// ---------------------------------------------------------------------------
// Тело запроса: Yandex Cloud Functions отдают event.body как строку,
// возможно в base64 (event.isBase64Encoded).
// ---------------------------------------------------------------------------

function parseJsonBody(event) {
  if (!event.body) return null;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// /submit (?action=submit)
// ---------------------------------------------------------------------------

async function handleSubmit(event, cors) {
  let payload;
  try {
    payload = parseJsonBody(event);
  } catch (e) {
    return jsonResponse(400, { ok: false, error: 'invalid_json' }, cors);
  }

  const validationError = validateSubmitPayload(payload);
  if (validationError) {
    return jsonResponse(400, { ok: false, error: validationError }, cors);
  }

  const { dealId, organization, listeners, metrics } = payload;
  const submittedAt = (metrics && metrics.submittedAt) || new Date().toISOString();

  let xlsxBase64;
  try {
    xlsxBase64 = buildListenersXlsxBase64(listeners);
  } catch (e) {
    console.error('xlsx build failed:', e && e.message);
    return jsonResponse(500, { ok: false, error: 'xlsx_generation_failed' }, cors);
  }

  const coursesSummary = uniqueCourseNames(listeners).join(', ');
  const fileName = buildFileName(organization);

  let target = null;
  let submitError = null;

  if (dealId) {
    const commentText = buildCommentText(organization, listeners, coursesSummary, submittedAt);
    const bitrixResult = await callBitrixAddComment(dealId, commentText, fileName, xlsxBase64);

    if (bitrixResult.ok) {
      target = 'deal';
    } else {
      console.error('Bitrix call failed, falling back to sheet:', bitrixResult.error);
      const sheetResult = await sendUnboundRow(
        payload,
        coursesSummary,
        xlsxBase64,
        `не привязано к сделке (ошибка Б24 для dealId=${dealId}: ${bitrixResult.error})`
      );
      if (sheetResult.ok) {
        target = 'sheet';
      } else {
        submitError = 'bitrix_and_sheet_failed';
      }
    }
  } else {
    const sheetResult = await sendUnboundRow(payload, coursesSummary, xlsxBase64, 'не привязано к сделке');
    if (sheetResult.ok) {
      target = 'sheet';
    } else {
      submitError = 'sheet_failed';
    }
  }

  const metricsResult = await sendToAppsScript('metrics', {
    dealId: dealId || null,
    startedAt: (metrics && metrics.startedAt) || null,
    submittedAt,
    listenersCount: listeners.length,
    status: 'completed',
    durationSeconds: computeDurationSeconds(metrics && metrics.startedAt, submittedAt),
  });
  if (!metricsResult.ok) console.error('metrics(completed) logging failed:', metricsResult.error);

  if (submitError) {
    return jsonResponse(502, { ok: false, error: submitError }, cors);
  }
  return jsonResponse(200, { ok: true, target }, cors);
}

// ---------------------------------------------------------------------------
// /track (?action=track, best-effort, sendBeacon)
// ---------------------------------------------------------------------------

async function handleTrack(event, cors) {
  let payload;
  try {
    payload = parseJsonBody(event);
  } catch (e) {
    return emptyResponse(204, cors);
  }

  const startedAt = payload && payload.startedAt ? payload.startedAt : null;
  const row = {
    dealId: (payload && payload.dealId) || null,
    startedAt,
    submittedAt: null,
    listenersCount: payload && typeof payload.listenersCountSoFar === 'number' ? payload.listenersCountSoFar : 0,
    status: 'abandoned',
    durationSeconds: computeDurationSeconds(startedAt, new Date().toISOString()),
  };

  const result = await sendToAppsScript('metrics', row);
  if (!result.ok) console.error('/track: Apps Script call failed:', result.error);

  return emptyResponse(204, cors);
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

module.exports.handler = async function (event, context) {
  const headers = event.headers || {};
  const requestOrigin = headers.Origin || headers.origin || '';
  const allowedOrigin = resolveAllowedOrigin(requestOrigin);
  const cors = corsHeaders(allowedOrigin);

  const method = event.httpMethod || 'GET';
  if (method === 'OPTIONS') {
    return emptyResponse(204, cors);
  }

  const action = (event.queryStringParameters && event.queryStringParameters.action) || '';

  try {
    if (method === 'POST' && action === 'submit') {
      return await handleSubmit(event, cors);
    }
    if (method === 'POST' && action === 'track') {
      return await handleTrack(event, cors);
    }
  } catch (err) {
    console.error('Unhandled error:', err && err.message ? err.message : String(err));
    return jsonResponse(500, { ok: false, error: 'internal_error' }, cors);
  }

  return jsonResponse(404, { ok: false, error: 'not_found' }, cors);
};
