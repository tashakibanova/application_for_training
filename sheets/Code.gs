/**
 * Apps Script Web App — приёмник данных от serverless-функции (yandex-function/).
 *
 * Разворачивается как Web App: Deploy → New deployment → Web app,
 * execute as "Me", access "Anyone" (или "Anyone with the link").
 * Подробная инструкция — в sheets/README.md.
 *
 * Контракт запроса/ответа — см. CONTRACT.md, раздел 4.
 */

var SHEET_UNBOUND = 'Незакреплённые заявки';
var SHEET_METRICS = 'Метрики эксперимента';

var HEADERS_UNBOUND = [
  'receivedAt',
  'organizationName',
  'inn',
  'contactEmail',
  'contactPhone',
  'listenersCount',
  'coursesSummary',
  'note',
  'rawPayloadJson'
];

var HEADERS_METRICS = [
  'dealId',
  'startedAt',
  'submittedAt',
  'listenersCount',
  'status',
  'durationSeconds'
];

/**
 * Точка входа Web App. Apps Script Web Apps всегда отвечают HTTP 200,
 * поэтому все ошибки (включая неверный secret) возвращаются как
 * {ok:false, error:'...'} в теле, а не через код статуса.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: 'empty_body' });
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse({ ok: false, error: 'invalid_json' });
    }

    var expectedSecret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!expectedSecret || payload.secret !== expectedSecret) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }

    var sheetKey = payload.sheet;
    var row = payload.row || {};

    if (sheetKey === 'unbound') {
      appendRow(SHEET_UNBOUND, HEADERS_UNBOUND, row);
      return jsonResponse({ ok: true });
    }

    if (sheetKey === 'metrics') {
      appendRow(SHEET_METRICS, HEADERS_METRICS, row);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: 'unknown_sheet' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * Дописывает строку в лист по заданному порядку заголовков.
 * Создаёт лист и заголовки, если листа ещё не существует.
 * LockService используется, чтобы конкурентные вызовы doPost (несколько
 * заявок подряд) не перезаписывали друг друга при поиске последней
 * свободной строки — Apps Script может обрабатывать запросы параллельно.
 */
function appendRow(sheetName, headers, row) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSheet(sheetName, headers);
    var values = headers.map(function (key) {
      var value = row[key];
      if (value === undefined || value === null) {
        return '';
      }
      return value;
    });
    sheet.appendRow(values);
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
