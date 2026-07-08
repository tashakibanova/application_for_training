#!/usr/bin/env node
'use strict';

/**
 * export-catalog.js
 *
 * Разовый CLI-скрипт: тянет каталог курсов из Битрикс24 через входящий вебхук
 * и пишет результат в site/courses.json по схеме CONTRACT.md §1.
 *
 * Источник — iblockId 21 ("Товарный каталог CRM"), отфильтрованный по разделам
 * из COURSE_SECTIONS ниже. Это единственный надёжный способ выбрать именно
 * курсы: сам каталог iblockId 21 общий на весь Б24-аккаунт (там же, например,
 * лежит одежда и прочие непрофильные товары), а нужные курсы разложены по
 * разделам ЦДО/ЕРЛ.
 *
 * Запуск:
 *   BITRIX_WEBHOOK_URL=https://your.bitrix24.ru/rest/1/xxxxxxxx/ node export-catalog.js [путь-к-файлу]
 *
 * Подробности — см. README.md в этой папке.
 */

// ---------------------------------------------------------------------------
// НАСТРОЙКИ, КОТОРЫЕ, СКОРЕЕ ВСЕГО, ПРИДЁТСЯ ПОДКОРРЕКТИРОВАТЬ СО ВРЕМЕНЕМ —
// см. README.md, раздел "Если список курсов поменялся".
// ---------------------------------------------------------------------------

// Разделы iblockId 21, которые считаются актуальным каталогом курсов для формы.
// Уточнено вручную (2026-07-07) по факту навигации в Б24: ЦДО -> ЦДО КПК в
// продаже и ЦДО ПП в продаже, ЕРЛ Сколково (+ ЕРЛ Сколково: ПП), ЕРЛ
// Логопедия/дефектология, ЕРЛ Охрана труда.
// `folder` — человекочитаемое имя папки для группировки в UI формы (см.
// site/app.js, попап выбора курса). Отличается от исходного названия раздела
// в Б24 — так попросил заказчик, чтобы не путать пользователей формы
// служебными названиями вроде "ЦДО КПК В продаже".
const COURSE_SECTIONS = {
  719: { name: 'ЦДО КПК В продаже', category: null, folder: 'Курсы повышения квалификации' },
  721: { name: 'ЦДО ПП В продаже', category: null, folder: 'Программы профессиональной переподготовки' },
  1204: { name: 'ЕРЛ. Логопедия/дефектология', category: null, folder: 'Логопедия и дефектология' },
  1252: { name: 'ЕРЛ. Охрана труда', category: 'labor_safety', folder: 'Охрана труда' },
  1308: { name: 'ЕРЛ Сколково', category: null, folder: 'Сколково' },
  1330: { name: 'ЕРЛ Сколково: ПП', category: null, folder: 'Сколково: ПП' },
};

// Категория по разделу (см. выше) — основной, надёжный сигнал: названия курсов
// охраны труда часто НЕ содержат слов "охрана труда" (например, "Безопасные
// методы и приёмы выполнения газоопасных работ"), поэтому определять категорию
// только по тексту названия недостаточно.
//
// Ключевые слова — вторичный, дополняющий сигнал: ловит курсы по пожарной
// безопасности/первой помощи, если они появятся вне выделенного раздела, или
// новые разделы, которые ещё не добавлены в COURSE_SECTIONS выше.
const CATEGORY_KEYWORDS = [
  { category: 'labor_safety', keywords: ['охрана труда', 'охраны труда'] },
  { category: 'fire_safety', keywords: ['пожарн', 'огневых работ', 'пожароопасных работ'] },
  { category: 'first_aid', keywords: ['первой помощи', 'первую помощь'] },
];

// Размер страницы, который просим у Б24 (стандартный лимит catalog.* методов — 50).
const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------

function getWebhookUrl() {
  const url = process.env.BITRIX_WEBHOOK_URL;
  if (!url) {
    console.error('Ошибка: не задана переменная окружения BITRIX_WEBHOOK_URL.');
    console.error(
      'Пример запуска: BITRIX_WEBHOOK_URL=https://your.bitrix24.ru/rest/1/xxxxxxxx/ node export-catalog.js'
    );
    process.exit(1);
  }
  return url.endsWith('/') ? url : url + '/';
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/ё/g, 'е');
}

function detectCategory(name, sectionId) {
  const sectionCategory = COURSE_SECTIONS[sectionId] && COURSE_SECTIONS[sectionId].category;
  if (sectionCategory) return sectionCategory;

  const lower = normalize(name);
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return null;
}

// Часы почти всегда зашиты прямо в название товара: "... (108 ЧАСОВ)",
// "... (16 часов). СПЕЦИАЛЬНЫЙ" и т.п. Отдельного поля "часы" в карточке
// товара нет (проверено на реальном каталоге — есть только безымянные
// property1223.. свойства, в основном пустые).
function extractHours(name) {
  const match = normalize(name).match(/\((\d+(?:[.,]\d+)?)\s*час/);
  if (!match) return null;
  const num = Number(match[1].replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function mapProduct(product) {
  const name = (product.name || product.NAME || '').trim();
  const sectionId = product.iblockSectionId ?? product.IBLOCK_SECTION_ID;
  const section = COURSE_SECTIONS[sectionId];
  return {
    id: String(product.id ?? product.ID ?? ''),
    name,
    hours: extractHours(name),
    category: detectCategory(name, sectionId),
    folder: (section && section.folder) || null,
  };
}

async function fetchAllProducts(webhookUrl) {
  const endpoint = webhookUrl + 'catalog.product.list';
  const sectionIds = Object.keys(COURSE_SECTIONS).map(Number);
  const products = [];
  let start = 0;

  while (true) {
    const body = {
      select: ['id', 'iblockId', 'name', 'iblockSectionId'],
      filter: { iblockId: 21, iblockSectionId: sectionIds, active: 'Y' },
      start,
      order: { id: 'ASC' },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Б24 REST вернул HTTP ${response.status} на catalog.product.list: ${text}`);
    }

    const json = await response.json();

    if (json.error) {
      throw new Error(`Б24 REST вернул ошибку: ${json.error} ${json.error_description || ''}`);
    }

    const pageProducts = Array.isArray(json.result) ? json.result : json.result?.products ?? [];
    products.push(...pageProducts);

    console.error(`Загружено ${products.length} из ${json.total ?? '?'} товаров...`);

    if (typeof json.next === 'number') {
      start = json.next;
    } else {
      break;
    }
  }

  return products;
}

async function main() {
  const webhookUrl = getWebhookUrl();
  const outputPath = process.argv[2] || require('path').join(__dirname, '..', 'site', 'courses.json');

  console.error(`Запрос catalog.product.list (iblockId 21, разделы: ${Object.keys(COURSE_SECTIONS).join(', ')})...`);

  const products = await fetchAllProducts(webhookUrl);
  const courses = products.map(mapProduct).filter((c) => c.id && c.name);

  const missingHours = courses.filter((c) => c.hours === null);
  if (missingHours.length > 0) {
    console.error(
      `Внимание: у ${missingHours.length} из ${courses.length} курсов не удалось найти часы в названии ` +
        `(см. README.md, раздел "Если часы не подхватились"). Примеры ID: ` +
        missingHours.slice(0, 5).map((c) => c.id).join(', ')
    );
  }

  const byCategory = courses.reduce((acc, c) => {
    const key = c.category || 'null';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.error('Категории: ' + JSON.stringify(byCategory));

  const fs = require('fs');
  const outDir = require('path').dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(courses, null, 2) + '\n', 'utf8');

  console.error(`Готово: записано ${courses.length} курсов в ${outputPath}`);
}

main().catch((err) => {
  console.error('Ошибка выполнения export-catalog.js:', err.message);
  process.exit(1);
});
