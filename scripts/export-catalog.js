#!/usr/bin/env node
'use strict';

/**
 * export-catalog.js
 *
 * Разовый CLI-скрипт: тянет каталог товаров (курсов) из Битрикс24 через входящий
 * вебхук (метод catalog.product.list), маппит в схему CONTRACT.md §1 и пишет
 * результат в site/courses.json.
 *
 * Запуск:
 *   BITRIX_WEBHOOK_URL=https://your.bitrix24.ru/rest/1/xxxxxxxx/ node export-catalog.js [путь-к-файлу]
 *
 * Подробности — см. README.md в этой папке.
 */

// ---------------------------------------------------------------------------
// НАСТРОЙКИ, КОТОРЫЕ, СКОРЕЕ ВСЕГО, ПРИДЁТСЯ ПОДКОРРЕКТИРОВАТЬ ПОД КОНКРЕТНЫЙ
// КАТАЛОГ Б24 — см. README.md, раздел "Если часы не подхватились".
// ---------------------------------------------------------------------------

// Имя поля товара, где может лежать количество часов курса.
// В стандартном catalog.product.list такого поля нет "из коробки" — это либо
// одно из PROPERTY_* полей карточки товара (если включены свойства
// в торговом каталоге), либо часы придётся вписывать в это поле каталога
// вручную/другим способом. Значение ниже — только отправная точка.
const HOURS_PROPERTY_CODE = 'PROPERTY_HOURS';

// Дополнительные поля товара, которые стоит попробовать как источник часов,
// если основное свойство выше не найдено (порядок — приоритет проверки).
const HOURS_FALLBACK_FIELDS = ['PROPERTY_HOURS', 'PROPERTY_130', 'PROPERTY_CHASY'];

// Ключевые слова (в нижнем регистре) в названии товара -> категория курса.
// Схема категорий строго по CONTRACT.md §1: labor_safety | fire_safety | first_aid | null.
// Порядок проверки — сверху вниз, первое совпадение выигрывает.
const CATEGORY_KEYWORDS = [
  { category: 'labor_safety', keywords: ['охрана труда'] },
  { category: 'fire_safety', keywords: ['пожарн'] },
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

function detectCategory(name) {
  const lower = (name || '').toLowerCase();
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return null;
}

function extractHours(product) {
  // 1. Явное свойство HOURS_PROPERTY_CODE, если Б24 вернул его прямо в товаре.
  if (product[HOURS_PROPERTY_CODE] !== undefined && product[HOURS_PROPERTY_CODE] !== null) {
    const parsed = parseHoursValue(product[HOURS_PROPERTY_CODE]);
    if (parsed !== null) return parsed;
  }

  // 2. Перебор запасных полей.
  for (const field of HOURS_FALLBACK_FIELDS) {
    if (product[field] !== undefined && product[field] !== null) {
      const parsed = parseHoursValue(product[field]);
      if (parsed !== null) return parsed;
    }
  }

  // 3. Некоторые каталоги Б24 отдают свойства в виде массива PROPERTY_VALUES
  // или объекта PROPERTIES — на всякий случай пробуем поискать там что-то
  // похожее на "часы" по имени свойства.
  const propsContainer = product.PROPERTY_VALUES || product.PROPERTIES;
  if (propsContainer && typeof propsContainer === 'object') {
    for (const key of Object.keys(propsContainer)) {
      if (/hour|час/i.test(key)) {
        const value = propsContainer[key];
        const raw = value && typeof value === 'object' && 'value' in value ? value.value : value;
        const parsed = parseHoursValue(raw);
        if (parsed !== null) return parsed;
      }
    }
  }

  return null;
}

function parseHoursValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(String(value).replace(',', '.').match(/[\d.]+/)?.[0]);
  return Number.isFinite(num) ? num : null;
}

function mapProduct(product) {
  return {
    id: String(product.ID ?? product.id ?? ''),
    name: product.NAME ?? product.name ?? '',
    hours: extractHours(product),
    category: detectCategory(product.NAME ?? product.name ?? ''),
  };
}

async function fetchAllProducts(webhookUrl) {
  const endpoint = webhookUrl + 'catalog.product.list';
  const products = [];
  let start = 0;

  while (true) {
    const body = {
      select: ['ID', 'NAME', HOURS_PROPERTY_CODE, ...HOURS_FALLBACK_FIELDS],
      start,
      order: { ID: 'ASC' },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Б24 REST вернул HTTP ${response.status} на catalog.product.list: ${text}`
      );
    }

    const json = await response.json();

    if (json.error) {
      throw new Error(
        `Б24 REST вернул ошибку: ${json.error} ${json.error_description || ''}`
      );
    }

    // Стандартный формат ответа catalog.* методов Б24:
    // { result: { products: [...] }, total: N, next: 50 }
    // (в некоторых версиях REST — result: [...] напрямую, без обёртки products).
    const pageProducts = Array.isArray(json.result)
      ? json.result
      : json.result?.products ?? [];

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

  console.error(`Запрос catalog.product.list по вебхуку: ${webhookUrl}catalog.product.list`);

  const products = await fetchAllProducts(webhookUrl);
  const courses = products.map(mapProduct);

  const missingHours = courses.filter((c) => c.hours === null);
  if (missingHours.length > 0) {
    console.error(
      `Внимание: у ${missingHours.length} из ${courses.length} курсов не удалось определить hours ` +
        `(см. README.md, раздел "Если часы не подхватились"). Примеры ID: ` +
        missingHours.slice(0, 5).map((c) => c.id).join(', ')
    );
  }

  const unmatchedCategory = courses.filter((c) => c.category === null).length;
  console.error(
    `Категория не распознана по ключевым словам у ${unmatchedCategory} из ${courses.length} курсов (это нормально для курсов повышения квалификации общего профиля).`
  );

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
