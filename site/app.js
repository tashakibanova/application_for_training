'use strict';

/* =====================================================================
 * НАСТРОЙКИ ИНТЕГРАЦИИ — заменить перед реальным запуском
 * ===================================================================== */

// Публичный API-ключ DaData (Suggestions API), используется прямо в браузере —
// это ожидаемо для прототипа на бесплатном тарифе (см. CONTRACT.md §5).
// Если тариф потребует ограничение по домену — настраивается в ЛК DaData.
const DADATA_TOKEN = '9b5e9fcd88ba22b1bc16fc61eb2780db4d5b9862';

// TODO(integration): вписать реальный адрес Yandex Cloud Function после деплоя
// (см. yandex-function/README.md, шаг 6) — обычно вида
// 'https://functions.yandexcloud.net/xxxxxxxxxxxxxxxxxxxx'.
const FUNCTION_BASE_URL = 'https://functions.yandexcloud.net/d4eb9ra3isfnopa91cov';

// Роутинг на стороне функции — через query-параметр, а не путь (см. yandex-function/README.md).
const WORKER_URL = FUNCTION_BASE_URL + '?action=submit';
const TRACK_URL = FUNCTION_BASE_URL + '?action=track';

const DADATA_PARTY_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';
const DADATA_ADDRESS_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';

/* =====================================================================
 * Состояние приложения
 * ===================================================================== */

const state = {
  dealId: null,
  courses: [],
  startedAt: null,
  submittedAt: null,
  trackSent: false,
  submittedSuccessfully: false,
};

/* =====================================================================
 * Утилиты
 * ===================================================================== */

function debounce(fn, delay) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function onlyDigits(value) {
  return (value || '').replace(/\D/g, '');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim());
}

function normalizePhone(raw) {
  let digits = onlyDigits(raw);
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }
  if (digits.length === 10) {
    digits = '7' + digits;
  }
  return '+' + digits;
}

function isValidPhoneDigits(raw) {
  const digits = onlyDigits(raw);
  return digits.length === 10 || digits.length === 11;
}

/* =====================================================================
 * Инициализация после загрузки DOM
 * ===================================================================== */

document.addEventListener('DOMContentLoaded', init);

function init() {
  state.dealId = new URLSearchParams(window.location.search).get('deal') || null;
  wireDealIdInput();
  renderDealNotice();

  wireApplicantType();
  wireOrgFieldMirroring();
  wireIkzToggle();
  wireInnAutofill('org-inn', 'inn-status', applyPartySuggestion);
  wireInnAutofill('fl-inn', 'fl-inn-status', applyWorkplaceSuggestion);
  wireAddressSuggest();
  wireOriginalsDelivery();
  wireFlEmployment();
  wireCourseModal();
  wireMetricsTracking();

  const addBtn = document.getElementById('add-listener-btn');
  addBtn.addEventListener('click', () => addListenerRow());

  const form = document.getElementById('application-form');
  form.addEventListener('submit', handleSubmit);

  document.getElementById('submit-error-close').addEventListener('click', hideSubmitError);

  loadCourses();
}

// Поле «ID сделки» — подстраховка на случай, если менеджер не дописал ?deal= в
// ссылку. Значение обновляет state.dealId вживую (только цифры, до 9 знаков —
// как ID сделок Б24), чтобы оно гарантированно попало в buildPayload().dealId.
// Поле необязательное: пустое значение = null, форма отправляется и без него.
// Если ID пришёл из URL (?deal=) — он же подставляется в это поле, и его можно
// тут же поправить вручную, если менеджер ошибся; отдельного read-only режима
// нет специально — единое редактируемое поле проще и для 95% случаев (ссылка
// работает — просто видно подтверждение ниже) не мешает.
function wireDealIdInput() {
  const input = document.getElementById('deal-id-input');
  if (!input) return;

  if (state.dealId) input.value = onlyDigits(state.dealId);

  input.addEventListener('input', () => {
    input.value = onlyDigits(input.value).slice(0, 9);
    state.dealId = input.value || null;
    renderDealNotice();
  });
}

function renderDealNotice() {
  const el = document.getElementById('deal-notice');
  if (state.dealId) {
    // Позитивное подтверждение показываем, оно не запутывает пользователя.
    el.textContent = 'Заявка привязана к сделке № ' + state.dealId;
    el.classList.remove('deal-notice--missing');
    el.hidden = false;
  } else {
    // Нет сделки — подтверждение прячем (плашка-предупреждение только пугает
    // рядового пользователя; на бэкенде заявка без сделки всё равно уходит в
    // лист «Незакреплённые»). Соседнее поле ввода ID при этом остаётся видимым.
    el.textContent = '';
    el.hidden = true;
  }
}

/* =====================================================================
 * Загрузка каталога курсов
 * ===================================================================== */

async function loadCourses() {
  try {
    const res = await fetch('./courses.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.courses = Array.isArray(data) ? data : [];
  } catch (err) {
    state.courses = [];
    console.error('Не удалось загрузить courses.json:', err);
    showSubmitError(
      'Не удалось загрузить список курсов (courses.json). Обновите страницу или сообщите менеджеру.'
    );
  }
  // Всегда добавляем первую строку слушателя, даже если каталог пуст —
  // пользователь всё равно должен увидеть форму.
  addListenerRow();
}

/* =====================================================================
 * Блок 1: организация — автоподбор по ИНН и адрес-подсказки
 * ===================================================================== */

// Тип заявителя (ЮЛ/ФЛ) — переключает видимые секции блока 1 и подписи полей.
function wireApplicantType() {
  const radios = document.querySelectorAll('input[name="applicantType"]');
  const legalOnlyEls = document.querySelectorAll('.legal-entity-only');
  const individualOnlyEls = document.querySelectorAll('.individual-only');
  const orgHeadFioLabel = document.getElementById('org-headfio-label-text');

  function update() {
    const checked = document.querySelector('input[name="applicantType"]:checked');
    const isIndividual = !!checked && checked.value === 'individual';

    legalOnlyEls.forEach((el) => { el.hidden = isIndividual; });
    individualOnlyEls.forEach((el) => { el.hidden = !isIndividual; });

    // #postal-headfio-field теперь тоже .legal-entity-only (см. index.html) —
    // для ФЛ поле "ФИО получателя" скрыто целиком, значение берём из общего
    // "ФИО" напрямую в buildPayload()/validateForm(), дублировать подпись не нужно.
    orgHeadFioLabel.textContent = isIndividual ? 'ФИО' : 'ФИО руководителя';
  }

  radios.forEach((r) => r.addEventListener('change', update));
  update();
}

// Мутуальный выбор для физлица: указаны ИНН и место работы ИЛИ отмечено
// "самозанятый/не работаю". При отметке чекбокса оба поля очищаются и
// дизейблятся (и становятся необязательными в validateForm).
function wireFlEmployment() {
  const unemployedCheckbox = document.getElementById('fl-unemployed');
  const workplaceInput = document.getElementById('fl-workplace');
  const innInput = document.getElementById('fl-inn');
  const innStatus = document.getElementById('fl-inn-status');

  unemployedCheckbox.addEventListener('change', () => {
    const off = unemployedCheckbox.checked;
    if (off) {
      workplaceInput.value = '';
      innInput.value = '';
      innStatus.textContent = '';
      innStatus.className = 'hint';
    }
    workplaceInput.disabled = off;
    innInput.disabled = off;
  });
}

// Почтовый адрес нужен, только если оригиналы договора отправляются почтой.
function wireOriginalsDelivery() {
  const select = document.getElementById('org-originals-delivery');
  const postalSection = document.getElementById('postal-address-section');

  function update() {
    const show = select.value === 'russian_post';
    postalSection.hidden = !show;
    // В момент показа почтового блока подставляем юридический адрес: к этому
    // времени #org-address может быть уже заполнен (в т.ч. автоподбором по ИНН),
    // а blur по нему мог не сработать — пользователь просто выбрал способ
    // доставки, а не покидал поле адреса. mirrorPostalAddress не перезапишет,
    // если пользователь уже ввёл почтовый адрес вручную.
    if (show) {
      mirrorPostalAddress();
      mirrorPostalIndex();
    }
  }

  select.addEventListener('change', update);
  update();
}

function mirrorPostalOrgName() {
  const fullNameInput = document.getElementById('org-fullname');
  const postalOrgNameInput = document.getElementById('postal-orgname');
  if (!postalOrgNameInput.value.trim()) {
    postalOrgNameInput.value = fullNameInput.value.trim();
  }
}

function mirrorPostalHeadFio() {
  const headFioInput = document.getElementById('org-headfio');
  const postalHeadFioInput = document.getElementById('postal-headfio');
  if (!postalHeadFioInput.value.trim()) {
    postalHeadFioInput.value = headFioInput.value.trim();
  }
}

// Зеркалим юридический адрес организации (#org-address) в почтовый адрес
// (#postal-address), только если тот ещё пуст. #org-address есть только у ЮЛ —
// у ФЛ этого поля нет, поэтому для физлица ничего не подставится (это ожидаемо).
function mirrorPostalAddress() {
  const orgAddressInput = document.getElementById('org-address');
  const postalAddressInput = document.getElementById('postal-address');
  if (!orgAddressInput || !postalAddressInput) return;
  if (!postalAddressInput.value.trim()) {
    postalAddressInput.value = orgAddressInput.value.trim();
  }
}

// Индекс не вводится пользователем вручную в блоке "Юридический адрес" — это
// метаданные последней DaData-подсказки, которые applyPartySuggestion() кладёт
// в data-атрибут #org-address (см. ниже). Зеркалим их в #postal-index теми же
// двумя триггерами, что и mirrorPostalAddress — своего blur тут нет.
function mirrorPostalIndex() {
  const orgAddressInput = document.getElementById('org-address');
  const postalIndexInput = document.getElementById('postal-index');
  if (!orgAddressInput || !postalIndexInput) return;
  const postalCode = orgAddressInput.dataset.postalCode;
  if (postalCode && !postalIndexInput.value.trim()) {
    postalIndexInput.value = postalCode;
  }
}

function wireOrgFieldMirroring() {
  // Зеркалим значения в поля почтового адреса, только если те ещё не заполнены
  // вручную — чтобы не заставлять пользователя вводить одно и то же дважды,
  // но и не затирать его правки, если он решил указать другого получателя.
  // Те же функции дополнительно вызываются из applyPartySuggestion() — иначе
  // автоподстановка по ИНН не долетает до почтового блока: DaData пишет
  // значение в поле программно, а не через реальный blur пользователя.
  document.getElementById('org-fullname').addEventListener('blur', mirrorPostalOrgName);
  document.getElementById('org-headfio').addEventListener('blur', mirrorPostalHeadFio);
  document.getElementById('org-address').addEventListener('blur', mirrorPostalAddress);
}

function wireIkzToggle() {
  const radios = document.querySelectorAll('input[name="ikzRequired"]');
  const field = document.getElementById('ikz-number-field');
  const input = document.getElementById('org-ikz-number');

  function update() {
    const checked = document.querySelector('input[name="ikzRequired"]:checked');
    const show = !!checked && checked.value === 'yes';
    field.hidden = !show;
    input.required = show;
    if (!show) input.value = '';
  }

  radios.forEach((r) => r.addEventListener('change', update));
  update();
}

// Общий автоподбор организации по ИНН через DaData. Переиспользуется дважды:
// для ЮЛ (ИНН учреждения → реквизиты) и для ФЛ (ИНН места работы → «Место
// работы»). Параметры: id инпута с ИНН, id элемента статуса-подсказки и колбэк,
// который применяет найденную организацию к нужным полям формы.
function wireInnAutofill(innInputId, statusElId, applySuggestion) {
  const innInput = document.getElementById(innInputId);
  const statusEl = document.getElementById(statusElId);
  if (!innInput || !statusEl) return;

  const lookup = debounce(async (inn) => {
    if (DADATA_TOKEN.startsWith('REPLACE-ME')) {
      statusEl.textContent =
        'Автоподбор по ИНН недоступен: не задан ключ DaData (см. TODO в app.js). Заполните поля вручную.';
      statusEl.className = 'hint hint--error';
      return;
    }
    statusEl.textContent = 'Ищем организацию по ИНН...';
    statusEl.className = 'hint';
    try {
      const suggestion = await suggestPartyByInn(inn);
      if (!suggestion) {
        statusEl.textContent = 'Организация с таким ИНН не найдена, заполните поля вручную.';
        statusEl.className = 'hint hint--error';
        return;
      }
      applySuggestion(suggestion);
      statusEl.textContent = 'Организация найдена, поля подставлены — проверьте и при необходимости поправьте.';
      statusEl.className = 'hint hint--ok';
    } catch (err) {
      console.error('DaData party lookup error:', err);
      statusEl.textContent = 'Не удалось обратиться к DaData. Заполните поля вручную.';
      statusEl.className = 'hint hint--error';
    }
  }, 500);

  innInput.addEventListener('input', () => {
    innInput.value = onlyDigits(innInput.value).slice(0, 12);
    const digits = innInput.value;
    if (digits.length === 10 || digits.length === 12) {
      lookup(digits);
    } else {
      statusEl.textContent = '';
      statusEl.className = 'hint';
    }
  });
}

// Применение найденной по ИНН организации к полю «Место работы» физлица —
// в отличие от applyPartySuggestion (реквизиты ЮЛ) сюда пишем только название.
function applyWorkplaceSuggestion(suggestion) {
  const d = suggestion.data || {};
  const workplaceInput = document.getElementById('fl-workplace');
  const fullName = (d.name && (d.name.short_with_opf || d.name.full_with_opf)) || suggestion.value;
  if (fullName) workplaceInput.value = fullName;
}

async function suggestPartyByInn(inn) {
  const res = await fetch(DADATA_PARTY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Token ' + DADATA_TOKEN,
    },
    body: JSON.stringify({ query: inn, count: 1 }),
  });
  if (!res.ok) throw new Error('DaData HTTP ' + res.status);
  const data = await res.json();
  return data.suggestions && data.suggestions[0];
}

function applyPartySuggestion(suggestion) {
  const d = suggestion.data || {};
  const fullNameInput = document.getElementById('org-fullname');
  const kppInput = document.getElementById('org-kpp');
  const addressInput = document.getElementById('org-address');
  const headFioInput = document.getElementById('org-headfio');

  const fullName = (d.name && (d.name.full_with_opf || d.name.short_with_opf)) || suggestion.value;
  if (fullName) fullNameInput.value = fullName;

  if (d.kpp) kppInput.value = d.kpp;

  if (d.address && d.address.value) {
    addressInput.value = d.address.value;
    // Индекс — часть структурированных данных адреса DaData, отдельного видимого
    // поля для него в блоке "Юридический адрес" нет, поэтому кладём в
    // data-атрибут и переносим в #postal-index через mirrorPostalIndex().
    addressInput.dataset.postalCode = (d.address.data && d.address.data.postal_code) || '';
  }

  if (d.management && d.management.name && !headFioInput.value.trim()) {
    headFioInput.value = d.management.name;
  }

  // Значения выше подставлены программно, а не введены пользователем — событие
  // blur не сработает само, поэтому зеркалирование в почтовый блок вызываем явно.
  mirrorPostalOrgName();
  mirrorPostalHeadFio();
  mirrorPostalAddress();
  mirrorPostalIndex();
}

function wireAddressSuggest() {
  const addressInput = document.getElementById('org-address');
  const list = document.getElementById('org-address-suggestions');

  const runSuggest = debounce(async () => {
    const query = addressInput.value.trim();
    if (query.length < 3) {
      hideList();
      return;
    }
    if (DADATA_TOKEN.startsWith('REPLACE-ME')) {
      hideList();
      return;
    }
    try {
      const suggestions = await suggestAddress(query);
      renderList(suggestions);
    } catch (err) {
      console.error('DaData address suggest error:', err);
      hideList();
    }
  }, 300);

  addressInput.addEventListener('input', runSuggest);
  addressInput.addEventListener('blur', () => {
    // небольшая задержка, чтобы клик по подсказке успел сработать раньше скрытия списка
    setTimeout(hideList, 150);
  });

  function renderList(suggestions) {
    list.innerHTML = '';
    if (!suggestions || suggestions.length === 0) {
      hideList();
      return;
    }
    suggestions.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = s.value;
      li.tabIndex = 0;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        addressInput.value = s.value;
        hideList();
      });
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function hideList() {
    list.hidden = true;
    list.innerHTML = '';
  }
}

async function suggestAddress(query) {
  const res = await fetch(DADATA_ADDRESS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Token ' + DADATA_TOKEN,
    },
    body: JSON.stringify({ query, count: 5 }),
  });
  if (!res.ok) throw new Error('DaData HTTP ' + res.status);
  const data = await res.json();
  return data.suggestions || [];
}

/* =====================================================================
 * Блок 2: слушатели — динамические строки
 * ===================================================================== */

let listenerRowSeq = 0;

function addListenerRow() {
  const template = document.getElementById('listener-row-template');
  const rowEl = template.content.firstElementChild.cloneNode(true);
  listenerRowSeq += 1;
  rowEl.dataset.rowId = String(listenerRowSeq);

  // Радио-кнопки "причина прохождения" должны группироваться независимо в каждой
  // строке слушателя — иначе выбор в одной строке снимал бы выбор в другой,
  // так как группировка radio-input идёт по атрибуту name в рамках всей формы.
  rowEl.querySelectorAll('.listener-reason').forEach((radio) => {
    radio.name = 'listener-reason-' + listenerRowSeq;
  });

  rowEl.querySelector('.listener-course-btn').addEventListener('click', () => {
    openCourseModal(rowEl);
  });

  rowEl.querySelector('.remove-listener-btn').addEventListener('click', () => {
    rowEl.remove();
    updateListenerRemoveButtons();
    renumberListenerTitles();
  });

  document.getElementById('listeners-list').appendChild(rowEl);
  updateListenerRemoveButtons();
  renumberListenerTitles();
  return rowEl;
}

function onListenerCourseChange(rowEl) {
  const select = rowEl.querySelector('.listener-course');
  const hoursInput = rowEl.querySelector('.listener-hours');
  const course = state.courses.find((c) => c.id === select.value);

  hoursInput.value = course && course.hours != null ? course.hours + ' ч.' : '';

  const showExtra = !!(course && course.category != null);
  const positionField = rowEl.querySelector('.listener-position-field');
  const reasonField = rowEl.querySelector('.listener-reason-field');
  const positionInput = rowEl.querySelector('.listener-position');
  const reasonRadios = rowEl.querySelectorAll('.listener-reason');

  positionField.hidden = !showExtra;
  reasonField.hidden = !showExtra;
  positionInput.required = showExtra;
  reasonRadios.forEach((r) => (r.required = showExtra));

  if (!showExtra) {
    positionInput.value = '';
    reasonRadios.forEach((r) => (r.checked = false));
  }
}

/* ---------------------------------------------------------------------
 * Попап выбора курса
 *
 * Каталог может содержать 500+ курсов — обычный <select> тут неюзабелен, а
 * инлайн-дропдаун подсказок закрывался сам при попытке прокрутить список
 * (window scroll-listener на capture-фазе перехватывал скролл самого списка).
 * Поэтому выбор курса вынесен в модальное окно: умный поиск по ключевым словам
 * + вкладки по папкам + фильтр по часам. Скрытое поле .listener-course с
 * courseId сохранено, поэтому validateForm/buildPayload/onListenerCourseChange
 * не меняются. Попап закрывается только по явному действию (кнопка, фон,
 * Escape, выбор курса) — от скролла внутри списка НЕ закрывается.
 * ------------------------------------------------------------------- */

// Порядок вкладок-папок: сначала в этом «человеческом» порядке, всё, чего тут
// нет, — в конце по алфавиту. Реальный список берётся из данных (courses.json),
// не хардкодится.
// Примечание: разделы «Сколково»/«Сколково: ПП» намеренно идут с folder: null
// (см. scripts/export-catalog.js) — отдельной вкладки в попапе у них нет,
// поэтому и в порядке ниже их нет; courseFolders() всё равно отбрасывает null.
const COURSE_FOLDER_ORDER = [
  'Курсы повышения квалификации',
  'Программы профессиональной переподготовки',
  'Охрана труда',
  'Логопедия и дефектология',
];
const COURSE_MODAL_MAX = 60; // сколько совпадений максимум показываем в списке

const courseModal = {
  activeRow: null,
  folder: null, // null = «Все папки»
  hours: null, // null = любые часы; число — конкретные часы; 'none' — часы не указаны
};

function normalizeCourseText(s) {
  return (s || '').toLowerCase().replace(/ё/g, 'е').trim();
}

// Уникальные папки из данных, отсортированные по COURSE_FOLDER_ORDER.
function courseFolders() {
  const present = [...new Set(state.courses.map((c) => c.folder).filter(Boolean))];
  present.sort((a, b) => {
    const ia = COURSE_FOLDER_ORDER.indexOf(a);
    const ib = COURSE_FOLDER_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b, 'ru');
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return present;
}

// Курсы текущей папки (или весь каталог, если папка не выбрана) — база и для
// списка часов, и для поиска. Фильтр по часам сюда НЕ входит.
function courseFolderPool() {
  if (!courseModal.folder) return state.courses;
  return state.courses.filter((c) => c.folder === courseModal.folder);
}

// "Умный" поиск: все слова запроса должны встретиться в названии (порядок не
// важен), ранжирование — чем раньше первое совпадение и короче название, тем
// выше. Фильтры по папке и часам комбинируются с поиском по И (AND).
function matchCoursesInPool(pool, query) {
  const filtered = pool.filter((c) => {
    if (courseModal.hours === null) return true;
    if (courseModal.hours === 'none') return c.hours == null;
    return c.hours === courseModal.hours;
  });

  const tokens = normalizeCourseText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return filtered.slice(0, COURSE_MODAL_MAX);
  }

  const scored = [];
  for (const course of filtered) {
    const name = normalizeCourseText(course.name);
    if (tokens.every((t) => name.includes(t))) {
      const firstIdx = Math.min(...tokens.map((t) => name.indexOf(t)));
      scored.push({ course, firstIdx });
    }
  }
  scored.sort((a, b) => a.firstIdx - b.firstIdx || a.course.name.length - b.course.name.length);
  return scored.slice(0, COURSE_MODAL_MAX).map((s) => s.course);
}

function wireCourseModal() {
  const modal = document.getElementById('course-modal');
  const search = document.getElementById('course-modal-search');
  if (!modal || !search) return;

  modal.querySelectorAll('[data-course-close]').forEach((el) => {
    el.addEventListener('click', closeCourseModal);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeCourseModal();
  });

  search.addEventListener('input', debounce(renderCourseResults, 120));
}

function openCourseModal(rowEl) {
  const modal = document.getElementById('course-modal');
  const search = document.getElementById('course-modal-search');
  courseModal.activeRow = rowEl;
  courseModal.folder = null;
  courseModal.hours = null;
  search.value = '';

  renderCourseTabs();
  renderCourseHours();
  renderCourseResults();

  modal.hidden = false;
  document.body.classList.add('modal-open');
  // фокус в поле поиска — сразу можно печатать
  setTimeout(() => search.focus(), 0);
}

function closeCourseModal() {
  const modal = document.getElementById('course-modal');
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  courseModal.activeRow = null;
}

function renderCourseTabs() {
  const tabsEl = document.getElementById('course-modal-tabs');
  tabsEl.innerHTML = '';

  const makeTab = (label, folderValue) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'course-tab' + (courseModal.folder === folderValue ? ' is-active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      courseModal.folder = folderValue;
      courseModal.hours = null; // список часов зависит от папки — сбрасываем
      renderCourseTabs();
      renderCourseHours();
      renderCourseResults();
    });
    tabsEl.appendChild(btn);
  };

  makeTab('Все папки', null);
  courseFolders().forEach((f) => makeTab(f, f));
}

function renderCourseHours() {
  const hoursEl = document.getElementById('course-modal-hours');
  hoursEl.innerHTML = '';

  const pool = courseFolderPool();
  const hasNumeric = new Set();
  let hasNull = false;
  pool.forEach((c) => {
    if (c.hours == null) hasNull = true;
    else hasNumeric.add(c.hours);
  });
  const numeric = [...hasNumeric].sort((a, b) => a - b);

  const makeChip = (label, value) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const active = value === null ? courseModal.hours === null : courseModal.hours === value;
    btn.className = 'course-hour-chip' + (active ? ' is-active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      courseModal.hours = value;
      renderCourseHours();
      renderCourseResults();
    });
    hoursEl.appendChild(btn);
  };

  makeChip('Любые часы', null);
  numeric.forEach((h) => makeChip(h + ' ч.', h));
  if (hasNull) makeChip('Без часов', 'none');
}

function renderCourseResults() {
  const listEl = document.getElementById('course-modal-results');
  const countEl = document.getElementById('course-modal-count');
  const search = document.getElementById('course-modal-search');
  listEl.innerHTML = '';

  const matches = matchCoursesInPool(courseFolderPool(), search.value);

  if (matches.length === 0) {
    const li = document.createElement('li');
    li.className = 'course-result course-result--empty';
    li.textContent = 'Курсы не найдены — измените запрос, папку или фильтр по часам';
    listEl.appendChild(li);
    countEl.textContent = '';
    return;
  }

  countEl.textContent =
    matches.length >= COURSE_MODAL_MAX
      ? `Показаны первые ${COURSE_MODAL_MAX} — уточните запрос, чтобы увидеть остальные`
      : `Найдено: ${matches.length}`;

  matches.forEach((course) => {
    const li = document.createElement('li');
    li.className = 'course-result';
    const name = document.createElement('span');
    name.className = 'course-result__name';
    name.textContent = course.name;
    const meta = document.createElement('span');
    meta.className = 'course-result__meta';
    meta.textContent =
      (course.hours != null ? course.hours + ' ч.' : 'часы не указаны') +
      (course.folder ? ' · ' + course.folder : '');
    li.appendChild(name);
    li.appendChild(meta);
    li.addEventListener('click', () => selectCourseForRow(course));
    listEl.appendChild(li);
  });
}

function selectCourseForRow(course) {
  const rowEl = courseModal.activeRow;
  if (!rowEl) return;
  const hiddenInput = rowEl.querySelector('.listener-course');
  const btnText = rowEl.querySelector('.listener-course-btn__text');
  const btn = rowEl.querySelector('.listener-course-btn');

  hiddenInput.value = course.id;
  btnText.textContent = course.name;
  btn.classList.add('is-selected');
  btn.classList.remove('field-invalid');

  onListenerCourseChange(rowEl);
  closeCourseModal();
}

function updateListenerRemoveButtons() {
  const rows = document.querySelectorAll('.listener-row');
  rows.forEach((row) => {
    row.querySelector('.remove-listener-btn').hidden = rows.length <= 1;
  });
}

function renumberListenerTitles() {
  const rows = document.querySelectorAll('.listener-row');
  rows.forEach((row, index) => {
    row.querySelector('.listener-row__title').textContent = 'Слушатель ' + (index + 1);
  });
}

/* =====================================================================
 * Метрики: начало заполнения / отправка / незавершённое заполнение
 * ===================================================================== */

function wireMetricsTracking() {
  const form = document.getElementById('application-form');
  const markStarted = () => {
    if (!state.startedAt) {
      state.startedAt = new Date().toISOString();
    }
  };
  form.addEventListener('focusin', markStarted);
  form.addEventListener('input', markStarted);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendTrackBeacon();
  });
  window.addEventListener('pagehide', sendTrackBeacon);
  window.addEventListener('beforeunload', sendTrackBeacon);
}

function countListenersSoFar() {
  const rows = Array.from(document.querySelectorAll('.listener-row'));
  return rows.filter((row) => {
    const course = row.querySelector('.listener-course').value;
    const fio = row.querySelector('.listener-fio').value.trim();
    return course || fio;
  }).length;
}

function sendTrackBeacon() {
  if (!state.startedAt || state.submittedSuccessfully || state.trackSent) return;
  if (!('sendBeacon' in navigator)) return;

  const body = {
    dealId: state.dealId,
    startedAt: state.startedAt,
    listenersCountSoFar: countListenersSoFar(),
  };

  try {
    const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
    const ok = navigator.sendBeacon(TRACK_URL, blob);
    if (ok) state.trackSent = true;
  } catch (err) {
    // best-effort: ошибки трекинга не показываем пользователю (CONTRACT.md §3)
    console.error('sendBeacon /track failed:', err);
  }
}

/* =====================================================================
 * Валидация
 * ===================================================================== */

function clearInvalidMarks() {
  document.querySelectorAll('.field-invalid').forEach((el) => el.classList.remove('field-invalid'));
}

function markInvalid(el, errors, message) {
  if (!el) return;
  if (el.type === 'radio') {
    const fieldset = el.closest('fieldset');
    if (fieldset) fieldset.classList.add('field-invalid');
  } else {
    el.classList.add('field-invalid');
  }
  errors.push({ message, el });
}

function validateForm() {
  const errors = [];

  const applicantChecked = document.querySelector('input[name="applicantType"]:checked');
  if (!applicantChecked) {
    markInvalid(document.querySelector('input[name="applicantType"]'), errors, 'Укажите, кто подаёт заявку — юрлицо или физлицо.');
  }
  const isIndividual = !!applicantChecked && applicantChecked.value === 'individual';

  if (!isIndividual) {
    const fullName = document.getElementById('org-fullname');
    if (!fullName.value.trim()) markInvalid(fullName, errors, 'Укажите полное наименование учреждения.');

    const inn = document.getElementById('org-inn');
    const innDigits = onlyDigits(inn.value);
    if (!innDigits) {
      markInvalid(inn, errors, 'Укажите ИНН организации.');
    } else if (innDigits.length !== 10 && innDigits.length !== 12) {
      markInvalid(inn, errors, 'ИНН должен содержать 10 или 12 цифр.');
    }

    const documentType = document.getElementById('org-document-type');
    if (!documentType.value) markInvalid(documentType, errors, 'Выберите тип документа.');

    const lawTypeChecked = document.querySelector('input[name="lawType"]:checked');
    if (!lawTypeChecked) {
      markInvalid(document.querySelector('input[name="lawType"]'), errors, 'Укажите закон-основание (44-ФЗ или 223-ФЗ).');
    }

    const ikzChecked = document.querySelector('input[name="ikzRequired"]:checked');
    if (!ikzChecked) {
      markInvalid(document.querySelector('input[name="ikzRequired"]'), errors, 'Укажите, нужен ли ИКЗ.');
    } else if (ikzChecked.value === 'yes') {
      const ikzNumber = document.getElementById('org-ikz-number');
      if (!ikzNumber.value.trim()) markInvalid(ikzNumber, errors, 'Укажите номер ИКЗ.');
    }

    const fundingSource = document.getElementById('org-funding-source');
    if (!fundingSource.value.trim()) markInvalid(fundingSource, errors, 'Укажите источник финансирования услуг.');
  } else {
    const workplace = document.getElementById('fl-workplace');
    const unemployed = document.getElementById('fl-unemployed');
    const flInn = document.getElementById('fl-inn');
    if (!unemployed.checked) {
      const flInnDigits = onlyDigits(flInn.value);
      if (!flInnDigits) {
        markInvalid(flInn, errors, 'Укажите ИНН места работы или отметьте «Самозанятый(ая) или временно не работаю».');
      } else if (flInnDigits.length !== 10 && flInnDigits.length !== 12) {
        markInvalid(flInn, errors, 'ИНН места работы должен содержать 10 или 12 цифр.');
      }
      if (!workplace.value.trim()) {
        markInvalid(workplace, errors, 'Укажите место работы или отметьте «Самозанятый(ая) или временно не работаю».');
      }
    }
  }

  const originalsDelivery = document.getElementById('org-originals-delivery');
  if (!originalsDelivery.value) markInvalid(originalsDelivery, errors, 'Выберите способ получения оригиналов договора.');

  if (originalsDelivery.value === 'russian_post') {
    const postalIndex = document.getElementById('postal-index');
    const postalIndexDigits = onlyDigits(postalIndex.value);
    if (!postalIndexDigits) {
      markInvalid(postalIndex, errors, 'Укажите индекс почтового адреса.');
    } else if (postalIndexDigits.length !== 6) {
      markInvalid(postalIndex, errors, 'Индекс должен содержать 6 цифр.');
    }

    const postalAddressLine = document.getElementById('postal-address');
    if (!postalAddressLine.value.trim()) markInvalid(postalAddressLine, errors, 'Укажите почтовый адрес (улица, дом).');

    if (!isIndividual) {
      const postalOrgName = document.getElementById('postal-orgname');
      if (!postalOrgName.value.trim()) markInvalid(postalOrgName, errors, 'Укажите наименование учреждения в почтовом адресе.');
    }

    // Для ФЛ поле "ФИО получателя" скрыто и не редактируется отдельно — значение
    // всегда берётся из общего "ФИО" (см. buildPayload()), которое и так
    // валидируется ниже как обязательное для обоих типов заявителя.
    if (!isIndividual) {
      const postalHeadFio = document.getElementById('postal-headfio');
      if (!postalHeadFio.value.trim()) markInvalid(postalHeadFio, errors, 'Укажите ФИО получателя для почтового адреса.');
    }
  }

  const headFio = document.getElementById('org-headfio');
  if (!headFio.value.trim()) {
    markInvalid(headFio, errors, isIndividual ? 'Укажите ФИО.' : 'Укажите ФИО руководителя.');
  }

  const rows = Array.from(document.querySelectorAll('.listener-row'));
  if (rows.length === 0) {
    errors.push({ message: 'Добавьте хотя бы одного слушателя.', el: document.getElementById('add-listener-btn') });
  }

  rows.forEach((row, index) => {
    const n = index + 1;
    const courseSelect = row.querySelector('.listener-course');
    const courseBtn = row.querySelector('.listener-course-btn');
    const course = state.courses.find((c) => c.id === courseSelect.value);
    if (!courseSelect.value) markInvalid(courseBtn, errors, `Слушатель ${n}: выберите курс.`);

    const dateInput = row.querySelector('.listener-date');
    if (!dateInput.value) markInvalid(dateInput, errors, `Слушатель ${n}: укажите дату проведения.`);

    const fioInput = row.querySelector('.listener-fio');
    if (!fioInput.value.trim()) markInvalid(fioInput, errors, `Слушатель ${n}: укажите ФИО.`);

    const emailInput = row.querySelector('.listener-email');
    if (!emailInput.value.trim()) {
      markInvalid(emailInput, errors, `Слушатель ${n}: укажите email.`);
    } else if (!isValidEmail(emailInput.value)) {
      markInvalid(emailInput, errors, `Слушатель ${n}: email указан в неверном формате.`);
    }

    const phoneInput = row.querySelector('.listener-phone');
    if (!phoneInput.value.trim()) {
      markInvalid(phoneInput, errors, `Слушатель ${n}: укажите личный телефон.`);
    } else if (!isValidPhoneDigits(phoneInput.value)) {
      markInvalid(phoneInput, errors, `Слушатель ${n}: телефон указан в неверном формате.`);
    }

    if (course && course.category != null) {
      const positionInput = row.querySelector('.listener-position');
      if (!positionInput.value.trim()) markInvalid(positionInput, errors, `Слушатель ${n}: укажите должность.`);

      const reasonChecked = row.querySelector('.listener-reason:checked');
      if (!reasonChecked) {
        markInvalid(row.querySelector('.listener-reason'), errors, `Слушатель ${n}: укажите причину прохождения.`);
      }
    }
  });

  // Повтор email у слушателей — НЕ ошибка сам по себе: один человек может
  // записаться на несколько курсов (одинаковые ФИО + одинаковый email в разных
  // строках). Ошибка только если email совпадает, а ФИО РАЗНОЕ — это похоже на
  // опечатку/перепутанные данные. Всё сравниваем без учёта регистра и пробелов.
  const emailsNorm = rows.map((row) => row.querySelector('.listener-email').value.trim().toLowerCase());
  const fiosNorm = rows.map((row) => row.querySelector('.listener-fio').value.trim().replace(/\s+/g, ' ').toLowerCase());

  rows.forEach((row, index) => {
    const email = emailsNorm[index];
    if (!email) return;
    // Ищем среди ПРЕДЫДУЩИХ строк такую же почту, но с другим ФИО.
    for (let j = 0; j < index; j += 1) {
      if (emailsNorm[j] === email && fiosNorm[j] !== fiosNorm[index]) {
        const emailInput = row.querySelector('.listener-email');
        markInvalid(
          emailInput,
          errors,
          `Email слушателя ${index + 1} совпадает с email слушателя ${j + 1}, но ФИО разные — проверьте данные.`
        );
        // строку-«первоисточник» тоже подсвечиваем, чтобы было видно обе
        rows[j].querySelector('.listener-email').classList.add('field-invalid');
        break; // одного совпадения достаточно, чтобы пометить строку
      }
    }
  });

  return errors;
}

function renderErrors(errors) {
  const box = document.getElementById('form-errors');
  const list = document.getElementById('form-errors-list');
  list.innerHTML = '';

  if (!errors || errors.length === 0) {
    box.hidden = true;
    return;
  }

  errors.forEach((err) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'error-link';
    btn.textContent = err.message;
    btn.addEventListener('click', () => {
      if (err.el && typeof err.el.scrollIntoView === 'function') {
        err.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        err.el.focus();
      }
    });
    li.appendChild(btn);
    list.appendChild(li);
  });

  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* =====================================================================
 * Сбор payload строго по CONTRACT.md §2
 * ===================================================================== */

function buildPayload() {
  const applicantChecked = document.querySelector('input[name="applicantType"]:checked');
  const applicantType = applicantChecked ? applicantChecked.value : null;
  const isIndividual = applicantType === 'individual';

  const ikzChecked = document.querySelector('input[name="ikzRequired"]:checked');
  const ikzRequired = !isIndividual && !!ikzChecked && ikzChecked.value === 'yes';
  const lawTypeChecked = document.querySelector('input[name="lawType"]:checked');
  const comment = document.getElementById('org-comment').value.trim();
  const originalsDelivery = document.getElementById('org-originals-delivery').value;
  const needsPostalAddress = originalsDelivery === 'russian_post';

  const organization = {
    applicantType,

    fullName: isIndividual ? null : document.getElementById('org-fullname').value.trim(),
    inn: isIndividual ? null : onlyDigits(document.getElementById('org-inn').value),
    kpp: isIndividual ? null : document.getElementById('org-kpp').value.trim() || null,
    address: isIndividual ? null : document.getElementById('org-address').value.trim() || null,
    documentType: isIndividual ? null : document.getElementById('org-document-type').value,
    lawType: isIndividual ? null : (lawTypeChecked ? lawTypeChecked.value : null),
    ikzRequired: isIndividual ? null : ikzRequired,
    ikzNumber: ikzRequired ? document.getElementById('org-ikz-number').value.trim() : null,
    fundingSource: isIndividual ? null : document.getElementById('org-funding-source').value.trim() || null,

    workplace: isIndividual ? document.getElementById('fl-workplace').value.trim() || null : null,
    workplaceInn: isIndividual ? onlyDigits(document.getElementById('fl-inn').value) || null : null,
    selfEmployedOrUnemployed: isIndividual ? document.getElementById('fl-unemployed').checked : null,

    postalAddress: needsPostalAddress ? {
      index: onlyDigits(document.getElementById('postal-index').value),
      address: document.getElementById('postal-address').value.trim(),
      orgName: isIndividual ? null : document.getElementById('postal-orgname').value.trim(),
      // Для ФЛ поле "ФИО получателя" не показывается отдельно — тот же человек,
      // что и в общем "ФИО" (org-headfio), объединили по просьбе заказчика.
      headFio: isIndividual
        ? document.getElementById('org-headfio').value.trim()
        : document.getElementById('postal-headfio').value.trim(),
    } : null,

    headFio: document.getElementById('org-headfio').value.trim(),
    originalsDelivery,
    comment: comment || null,
  };

  const listeners = Array.from(document.querySelectorAll('.listener-row')).map((row) => {
    const courseSelect = row.querySelector('.listener-course');
    const course = state.courses.find((c) => c.id === courseSelect.value);
    const hasExtra = !!(course && course.category != null);
    const reasonChecked = row.querySelector('.listener-reason:checked');

    return {
      courseId: courseSelect.value || null,
      courseName: course ? course.name : null,
      hours: course ? course.hours : null,
      date: row.querySelector('.listener-date').value || null,
      fio: row.querySelector('.listener-fio').value.trim(),
      email: row.querySelector('.listener-email').value.trim(),
      phone: normalizePhone(row.querySelector('.listener-phone').value),
      position: hasExtra ? row.querySelector('.listener-position').value.trim() || null : null,
      reason: hasExtra ? (reasonChecked ? reasonChecked.value : null) : null,
    };
  });

  return {
    dealId: state.dealId,
    organization,
    listeners,
    metrics: {
      startedAt: state.startedAt,
      submittedAt: null, // подставляется непосредственно перед отправкой
    },
  };
}

/* =====================================================================
 * Отправка формы
 * ===================================================================== */

async function handleSubmit(event) {
  event.preventDefault();
  clearInvalidMarks();
  hideSubmitError();

  const errors = validateForm();
  if (errors.length > 0) {
    renderErrors(errors);
    return;
  }
  renderErrors([]);

  const payload = buildPayload();
  state.submittedAt = new Date().toISOString();
  payload.metrics.submittedAt = state.submittedAt;

  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Отправка...';

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let serverMessage = 'HTTP ' + res.status;
      try {
        const errJson = await res.json();
        if (errJson && errJson.error) serverMessage = errJson.error;
      } catch (_) {
        /* тело не JSON — используем HTTP-статус */
      }
      throw new Error(serverMessage);
    }

    state.submittedSuccessfully = true;
    showSuccessScreen();
  } catch (err) {
    console.error('Submit failed:', err);
    showSubmitError(
      'Не удалось отправить заявку. Проверьте подключение к интернету и повторите попытку. ' +
        'Если ошибка повторится — сообщите менеджеру. (' + (err && err.message ? err.message : err) + ')'
    );
    submitBtn.disabled = false;
    submitBtn.textContent = 'Отправить заявку';
  }
}

function showSuccessScreen() {
  document.getElementById('application-form').hidden = true;
  document.getElementById('form-errors').hidden = true;
  document.getElementById('submit-error').hidden = true;
  document.getElementById('success-screen').hidden = false;
  document.getElementById('success-screen').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showSubmitError(message) {
  const box = document.getElementById('submit-error');
  box.querySelector('p').textContent = message;
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideSubmitError() {
  const box = document.getElementById('submit-error');
  box.hidden = true;
}
