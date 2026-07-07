'use strict';

/* =====================================================================
 * НАСТРОЙКИ ИНТЕГРАЦИИ — заменить перед реальным запуском
 * ===================================================================== */

// Публичный API-ключ DaData (Suggestions API), используется прямо в браузере —
// это ожидаемо для прототипа на бесплатном тарифе (см. CONTRACT.md §5).
// Если тариф потребует ограничение по домену — настраивается в ЛК DaData.
const DADATA_TOKEN = '9b5e9fcd88ba22b1bc16fc61eb2780db4d5b9862';

// TODO(integration): вписать реальный адрес Cloudflare Worker после деплоя.
const WORKER_URL = 'https://REPLACE-ME.workers.dev/submit';

// Эндпоинт /track того же Worker — выводится из WORKER_URL, отдельно менять не нужно.
const TRACK_URL = WORKER_URL.replace(/\/submit$/, '/track');

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
  renderDealNotice();

  wireOrgFieldMirroring();
  wireIkzToggle();
  wireInnLookup();
  wireAddressSuggest();
  wireMetricsTracking();

  const addBtn = document.getElementById('add-listener-btn');
  addBtn.addEventListener('click', () => addListenerRow());

  const form = document.getElementById('application-form');
  form.addEventListener('submit', handleSubmit);

  document.getElementById('submit-error-close').addEventListener('click', hideSubmitError);

  loadCourses();
}

function renderDealNotice() {
  const el = document.getElementById('deal-notice');
  if (state.dealId) {
    el.textContent = 'Заявка привязана к сделке № ' + state.dealId;
    el.classList.remove('deal-notice--missing');
  } else {
    el.textContent =
      'В ссылке не указана сделка — заявка попадёт в общий список необработанных заявок, ' +
      'менеджер свяжет её со сделкой вручную. Если у вас есть ссылка от менеджера с "?deal=...", ' +
      'используйте её.';
    el.classList.add('deal-notice--missing');
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

function wireOrgFieldMirroring() {
  const fullNameInput = document.getElementById('org-fullname');
  const headFioInput = document.getElementById('org-headfio');
  const postalOrgNameInput = document.getElementById('postal-orgname');
  const postalHeadFioInput = document.getElementById('postal-headfio');

  // Зеркалим значения в поля почтового адреса, только если те ещё не заполнены
  // вручную — чтобы не заставлять пользователя вводить одно и то же дважды,
  // но и не затирать его правки, если он решил указать другого получателя.
  fullNameInput.addEventListener('blur', () => {
    if (!postalOrgNameInput.value.trim()) {
      postalOrgNameInput.value = fullNameInput.value.trim();
    }
  });
  headFioInput.addEventListener('blur', () => {
    if (!postalHeadFioInput.value.trim()) {
      postalHeadFioInput.value = headFioInput.value.trim();
    }
  });
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

function wireInnLookup() {
  const innInput = document.getElementById('org-inn');
  const statusEl = document.getElementById('inn-status');

  innInput.addEventListener('input', () => {
    innInput.value = onlyDigits(innInput.value).slice(0, 12);
    const digits = innInput.value;
    if (digits.length === 10 || digits.length === 12) {
      lookupByInn(digits, statusEl);
    } else {
      statusEl.textContent = '';
      statusEl.className = 'hint';
    }
  });
}

const lookupByInnDebounced = debounce(async (inn, statusEl) => {
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
    applyPartySuggestion(suggestion);
    statusEl.textContent = 'Организация найдена, поля подставлены — проверьте и при необходимости поправьте.';
    statusEl.className = 'hint hint--ok';
  } catch (err) {
    console.error('DaData party lookup error:', err);
    statusEl.textContent = 'Не удалось обратиться к DaData. Заполните поля вручную.';
    statusEl.className = 'hint hint--error';
  }
}, 500);

function lookupByInn(inn, statusEl) {
  lookupByInnDebounced(inn, statusEl);
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

  if (d.address && d.address.value) addressInput.value = d.address.value;

  if (d.management && d.management.name && !headFioInput.value.trim()) {
    headFioInput.value = d.management.name;
  }
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

  wireListenerCourseSearch(rowEl);

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

// Каталог может содержать 500+ курсов — обычный <select> тут неюзабелен
// (особенно на телефоне), поэтому курс выбирается через комбобокс: текстовое
// поле с поиском по ключевым словам + скрытое поле с реальным courseId
// (класс .listener-course сохранён на скрытом поле, поэтому весь остальной
// код — validateForm, buildPayload, onListenerCourseChange — не меняется).
function wireListenerCourseSearch(rowEl) {
  const searchInput = rowEl.querySelector('.listener-course-search');
  const hiddenInput = rowEl.querySelector('.listener-course');
  const list = rowEl.querySelector('.listener-course-suggestions');
  const MAX_RESULTS = 40;
  let activeIndex = -1;
  let currentMatches = [];

  function normalize(s) {
    return (s || '').toLowerCase().replace(/ё/g, 'е').trim();
  }

  // "Умный" поиск по ключевым словам: все слова запроса должны встретиться
  // где угодно в названии курса (порядок не важен), совпадения ранжируются —
  // чем раньше в названии находится первое слово и чем короче название,
  // тем выше в списке.
  function matchCourses(query) {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return state.courses.slice(0, MAX_RESULTS);

    const scored = [];
    for (const course of state.courses) {
      const name = normalize(course.name);
      if (tokens.every((t) => name.includes(t))) {
        const firstIdx = Math.min(...tokens.map((t) => name.indexOf(t)));
        scored.push({ course, firstIdx });
      }
    }
    scored.sort((a, b) => a.firstIdx - b.firstIdx || a.course.name.length - b.course.name.length);
    return scored.slice(0, MAX_RESULTS).map((s) => s.course);
  }

  // position: fixed вместо absolute — список подсказок иначе может обрезаться
  // контейнером таблицы слушателей (.listeners-table получает overflow-x:auto
  // на десктопе), как это уже сделано для подсказок адреса организации.
  function positionList() {
    const rect = searchInput.getBoundingClientRect();
    list.style.position = 'fixed';
    list.style.left = rect.left + 'px';
    list.style.top = rect.bottom + 4 + 'px';
    list.style.width = rect.width + 'px';
  }

  function highlight(index) {
    const items = list.querySelectorAll('li[data-idx]');
    items.forEach((li) => li.classList.remove('is-active'));
    activeIndex = index;
    if (index >= 0 && items[index]) {
      items[index].classList.add('is-active');
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }

  function renderList(courses) {
    currentMatches = courses;
    activeIndex = -1;
    list.innerHTML = '';

    if (!courses || courses.length === 0) {
      const li = document.createElement('li');
      li.className = 'suggestions__empty';
      li.textContent = 'Курсы не найдены — попробуйте другое слово';
      list.appendChild(li);
    } else {
      courses.forEach((course, idx) => {
        const li = document.createElement('li');
        li.dataset.idx = String(idx);
        li.textContent = course.name + (course.hours != null ? ` — ${course.hours} ч.` : '');
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectCourse(course);
        });
        list.appendChild(li);
      });
    }

    positionList();
    list.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
  }

  function selectCourse(course) {
    hiddenInput.value = course.id;
    searchInput.value = course.name;
    hideList();
    onListenerCourseChange(rowEl);
  }

  function hideList() {
    list.hidden = true;
    list.innerHTML = '';
    searchInput.setAttribute('aria-expanded', 'false');
  }

  const runSearch = debounce(() => {
    if (hiddenInput.value) {
      // текст поменялся после того, как курс уже был выбран — привязку к
      // конкретному courseId сбрасываем, пока пользователь не выберет заново
      hiddenInput.value = '';
      onListenerCourseChange(rowEl);
    }
    renderList(matchCourses(searchInput.value));
  }, 150);

  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('focus', () => renderList(matchCourses(searchInput.value)));
  searchInput.addEventListener('blur', () => {
    // небольшая задержка, чтобы mousedown по подсказке успел сработать раньше скрытия списка
    setTimeout(hideList, 150);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Enter не должен отправлять форму — это просто выбор из списка подсказок
      e.preventDefault();
      if (!list.hidden && activeIndex >= 0 && currentMatches[activeIndex]) {
        selectCourse(currentMatches[activeIndex]);
      } else if (!list.hidden && currentMatches.length === 1) {
        selectCourse(currentMatches[0]);
      }
      return;
    }
    if (list.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight(Math.min(activeIndex + 1, currentMatches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Escape') {
      hideList();
    }
  });

  window.addEventListener('scroll', hideList, true);
  window.addEventListener('resize', hideList);
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

  const postalIndex = document.getElementById('postal-index');
  const postalIndexDigits = onlyDigits(postalIndex.value);
  if (!postalIndexDigits) {
    markInvalid(postalIndex, errors, 'Укажите индекс почтового адреса.');
  } else if (postalIndexDigits.length !== 6) {
    markInvalid(postalIndex, errors, 'Индекс должен содержать 6 цифр.');
  }

  const postalOrgName = document.getElementById('postal-orgname');
  if (!postalOrgName.value.trim()) markInvalid(postalOrgName, errors, 'Укажите наименование учреждения в почтовом адресе.');

  const postalHeadFio = document.getElementById('postal-headfio');
  if (!postalHeadFio.value.trim()) markInvalid(postalHeadFio, errors, 'Укажите ФИО получателя для почтового адреса.');

  const headFio = document.getElementById('org-headfio');
  if (!headFio.value.trim()) markInvalid(headFio, errors, 'Укажите ФИО руководителя.');

  const email = document.getElementById('org-email');
  if (!email.value.trim()) {
    markInvalid(email, errors, 'Укажите email для связи.');
  } else if (!isValidEmail(email.value)) {
    markInvalid(email, errors, 'Email организации указан в неверном формате.');
  }

  const phone = document.getElementById('org-phone');
  if (!phone.value.trim()) {
    markInvalid(phone, errors, 'Укажите телефон для связи.');
  } else if (!isValidPhoneDigits(phone.value)) {
    markInvalid(phone, errors, 'Телефон организации указан в неверном формате.');
  }

  const originalsDelivery = document.getElementById('org-originals-delivery');
  if (!originalsDelivery.value) markInvalid(originalsDelivery, errors, 'Выберите способ получения оригиналов договора.');

  const rows = Array.from(document.querySelectorAll('.listener-row'));
  if (rows.length === 0) {
    errors.push({ message: 'Добавьте хотя бы одного слушателя.', el: document.getElementById('add-listener-btn') });
  }

  rows.forEach((row, index) => {
    const n = index + 1;
    const courseSelect = row.querySelector('.listener-course');
    const courseSearchInput = row.querySelector('.listener-course-search');
    const course = state.courses.find((c) => c.id === courseSelect.value);
    if (!courseSelect.value) markInvalid(courseSearchInput, errors, `Слушатель ${n}: выберите курс.`);

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
  const ikzChecked = document.querySelector('input[name="ikzRequired"]:checked');
  const ikzRequired = !!ikzChecked && ikzChecked.value === 'yes';
  const lawTypeChecked = document.querySelector('input[name="lawType"]:checked');
  const comment = document.getElementById('org-comment').value.trim();

  const organization = {
    fullName: document.getElementById('org-fullname').value.trim(),
    inn: onlyDigits(document.getElementById('org-inn').value),
    kpp: document.getElementById('org-kpp').value.trim() || null,
    address: document.getElementById('org-address').value.trim() || null,
    documentType: document.getElementById('org-document-type').value,
    lawType: lawTypeChecked ? lawTypeChecked.value : null,
    ikzRequired: ikzRequired,
    ikzNumber: ikzRequired ? document.getElementById('org-ikz-number').value.trim() : null,
    fundingSource: document.getElementById('org-funding-source').value.trim(),
    postalAddress: {
      index: onlyDigits(document.getElementById('postal-index').value),
      orgName: document.getElementById('postal-orgname').value.trim(),
      headFio: document.getElementById('postal-headfio').value.trim(),
    },
    headFio: document.getElementById('org-headfio').value.trim(),
    email: document.getElementById('org-email').value.trim(),
    phone: normalizePhone(document.getElementById('org-phone').value),
    originalsDelivery: document.getElementById('org-originals-delivery').value,
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
