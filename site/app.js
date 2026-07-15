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
const DADATA_BANK_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/bank';

/* =====================================================================
 * Состояние приложения
 * ===================================================================== */

const state = {
  dealId: null,
  // true, если dealId пришёл из ?deal= в URL (клиент открыл готовую ссылку от
  // менеджера) — тогда блок "Ссылка для клиента" ему самому показывать незачем.
  dealIdFromUrl: false,
  courses: [],
  // Расписание запусков/выпусков по группам часов (site/course-dates.json).
  // Может остаться null, если файл не загрузился — тогда доступен только
  // ручной ввод даты ("Другие сроки"), см. updateListenerDateOptions().
  courseDateBuckets: [],
  startedAt: null,
  submittedAt: null,
  trackSent: false,
  submittedSuccessfully: false,
  // true во время программного восстановления черновика — автосохранение (см.
  // wireDraftAutosave()) в этот момент пропускает saveDraft(), иначе события
  // change/input, которые сама же реставрация диспатчит для переключения
  // видимости полей, писали бы в localStorage промежуточное, ещё неполное
  // состояние формы.
  restoringDraft: false,
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

// Частые почтовые домены — только для мягкой подсказки об опечатке
// (например gmial.com -> gmail.com). Список НЕ ограничивает разрешённые
// домены: письмо на неизвестный домен (корпоративная почта и т.п.)
// проходит валидацию как обычно, isValidEmail() тут не меняется.
const COMMON_EMAIL_DOMAINS = [
  'gmail.com', 'yandex.ru', 'ya.ru', 'mail.ru', 'bk.ru', 'inbox.ru',
  'list.ru', 'rambler.ru', 'outlook.com', 'hotmail.com', 'icloud.com',
  'yahoo.com', 'mail.com',
];

// Расстояние Дамерау-Левенштейна (с учётом соседних перестановок букв —
// самая частая опечатка при наборе, напр. "mial" вместо "mail").
function damerauLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[m][n];
}

// Если домен похож на один из частых доменов (но не совпадает с ним) —
// возвращает исправленный email, иначе null. Порог "похожести": короткие
// домены (до 6 символов, напр. ya.ru, bk.ru) — 1 опечатка, домены длиннее —
// до 2, иначе слишком много ложных срабатываний на реально другие домены.
function suggestEmailFix(value) {
  const trimmed = (value || '').trim();
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!domain || COMMON_EMAIL_DOMAINS.includes(domain)) return null;

  let best = null;
  let bestDistance = Infinity;
  for (const candidate of COMMON_EMAIL_DOMAINS) {
    const distance = damerauLevenshtein(domain, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const threshold = best && best.length <= 6 ? 1 : 2;
  if (best && bestDistance > 0 && bestDistance <= threshold) {
    return local + '@' + best;
  }
  return null;
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
  state.dealIdFromUrl = !!state.dealId;
  wireDealIdInput();
  renderDealNotice();

  wireApplicantType();
  wireOrgFieldMirroring();
  wireIkzToggle();
  wireInnAutofill('org-inn', 'inn-status', applyPartySuggestion);
  wireInnAutofill('fl-inn', 'fl-inn-status', applyWorkplaceSuggestion);
  wireBikAutofill();
  // Юр.адрес: выбор подсказки только подставляет сам адрес (индекс тут отдельного
  // поля не имеет — он уходит в data-атрибут для зеркалирования, см. ниже).
  wireAddressSuggest('org-address', 'org-address-suggestions', (s) => {
    const addressInput = document.getElementById('org-address');
    addressInput.value = s.value;
    addressInput.dataset.postalCode = (s.data && s.data.postal_code) || '';
    mirrorPostalAddress();
    mirrorPostalIndex();
    recompute();
  });
  // Почтовый адрес: выбор подсказки подставляет адрес И сразу перезаписывает
  // индекс (осознанный выбор пользователя — можно перезаписать без оглядки на
  // прежнее значение, в отличие от пассивного mirrorPostalIndex()).
  wireAddressSuggest('postal-address', 'postal-address-suggestions', (s) => {
    document.getElementById('postal-address').value = s.value;
    const postalCode = s.data && s.data.postal_code;
    if (postalCode) document.getElementById('postal-index').value = postalCode;
    recompute();
  });
  // Почтовый адрес больше не завязан на способ получения оригиналов — блок
  // всегда виден (см. index.html), поэтому просто пробуем смёрджить значения
  // один раз на старте (на случай, если браузер восстановил org-address
  // автозаполнением до того, как отработал остальной JS).
  mirrorPostalAddress();
  mirrorPostalIndex();
  wireFlEmployment();
  wirePostalHeadFioSelfCheck();
  wireOriginalsDeliveryOther();
  wireCourseModal();
  wireMetricsTracking();

  const addBtn = document.getElementById('add-listener-btn');
  addBtn.addEventListener('click', () => addListenerRow());

  const form = document.getElementById('application-form');
  form.addEventListener('submit', handleSubmit);

  document.getElementById('submit-error-close').addEventListener('click', hideSubmitError);

  wireTheme();
  wireProgress();
  wireDraftRestoredNotice();

  loadCourses().then(() => wireDraftAutosave());
}

/* =====================================================================
 * Переключатель темы. По умолчанию сайт светлый — index.html ставит
 * data-theme="light" до отрисовки. Кнопка в шапке переключает свет/тьму.
 * ===================================================================== */
function wireTheme() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  const root = document.documentElement;
  btn.addEventListener('click', () => {
    let cur = root.getAttribute('data-theme');
    if (!cur) cur = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  });
}

// Поле «ID сделки» — подстраховка на случай, если менеджер не дописал ?deal= в
// ссылку. Значение обновляет state.dealId вживую (только цифры, до 9 знаков —
// как ID сделок Б24), чтобы оно гарантированно попало в buildPayload().dealId.
// Поле необязательное: пустое значение = null, форма отправляется и без него.
//
// Как только значение зафиксировано (пришло из ?deal= в URL, либо менеджер
// ввёл его вручную и увёл фокус с поля) — поле блокируется от дальнейшего
// редактирования (readOnly), чтобы привязку к сделке нельзя было случайно
// поменять/стереть после того, как она уже установлена.
function wireDealIdInput() {
  const input = document.getElementById('deal-id-input');
  if (!input) return;

  function lock() {
    input.readOnly = true;
    input.classList.add('is-locked');
  }

  if (state.dealId) {
    input.value = onlyDigits(state.dealId);
    lock();
  }

  input.addEventListener('input', () => {
    input.value = onlyDigits(input.value).slice(0, 9);
    state.dealId = input.value || null;
    renderDealNotice();
  });

  input.addEventListener('blur', () => {
    if (input.value) lock();
  });
}

function renderDealNotice() {
  const el = document.getElementById('deal-notice');
  if (state.dealId && !state.dealIdFromUrl) {
    // Показываем менеджеру готовую ссылку с номером договора — чтобы отправить
    // её клиенту, а не голый URL сайта (иначе заявка придёт непривязанной).
    // Если dealId уже пришёл из ?deal= (клиент открыл готовую ссылку) — блок
    // ему самому не нужен, это видно из условия выше.
    const link = location.origin + location.pathname + '?deal=' + encodeURIComponent(state.dealId);
    el.innerHTML = '';

    const hint = document.createElement('span');
    hint.className = 'deal-notice__hint';
    hint.textContent = 'Ссылка для клиента:';

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'deal-notice__link';
    field.readOnly = true;
    field.value = link;
    field.addEventListener('focus', () => field.select());

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn--ghost btn--small deal-notice__copy';
    copyBtn.textContent = 'Скопировать';
    copyBtn.addEventListener('click', () => copyDealLink(link, copyBtn));

    el.append(hint, field, copyBtn);
    el.classList.remove('deal-notice--missing');
    el.hidden = false;
  } else {
    // Нет сделки — плашку прячем (предупреждение только пугает рядового
    // пользователя; на бэкенде заявка без сделки всё равно уходит в лист
    // «Незакреплённые»). Соседнее поле ввода ID при этом остаётся видимым.
    el.innerHTML = '';
    el.hidden = true;
  }
}

// Копирует ссылку в буфер обмена. Основной путь — navigator.clipboard; на
// старых браузерах / http-контексте, где его нет, — запасной execCommand.
function copyDealLink(link, btn) {
  const original = btn.textContent;
  const confirm = () => {
    btn.textContent = 'Скопировано';
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(confirm).catch(() => fallbackCopy(link, confirm));
  } else {
    fallbackCopy(link, confirm);
  }
}

function fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    onDone();
  } catch (e) {
    /* буфер недоступен — пользователь может выделить ссылку и скопировать вручную */
  }
  document.body.removeChild(ta);
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

  // Необязательный файл: если не загрузился — просто остаётся пустой список
  // диапазонов, и выбор даты у слушателей сводится к "Другие сроки" (см.
  // updateListenerDateOptions()), форму это не блокирует.
  try {
    const res = await fetch('./course-dates.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.courseDateBuckets = Array.isArray(data.buckets) ? data.buckets : [];
  } catch (err) {
    state.courseDateBuckets = [];
    console.error('Не удалось загрузить course-dates.json:', err);
  }

  // Восстанавливаем черновик, если он есть (нужен уже загруженный каталог —
  // иначе выбор курса у слушателей восстановить нечем), иначе — как раньше,
  // всегда добавляем первую пустую строку слушателя.
  const draft = loadDraft();
  if (draft) {
    restoreDraft(draft);
  } else {
    addListenerRow();
  }
}

/* =====================================================================
 * Блок 1: организация — автоподбор по ИНН и адрес-подсказки
 * ===================================================================== */

// Тип заявителя (ЮЛ/ФЛ) — переключает видимые секции блока 1 и подписи полей.
function wireApplicantType() {
  const radios = document.querySelectorAll('input[name="applicantType"]');
  const legalOnlyEls = document.querySelectorAll('.legal-entity-only');
  const individualOnlyEls = document.querySelectorAll('.individual-only');

  function update() {
    const checked = document.querySelector('input[name="applicantType"]:checked');
    const isIndividual = !!checked && checked.value === 'individual';

    legalOnlyEls.forEach((el) => { el.hidden = isIndividual; });
    individualOnlyEls.forEach((el) => { el.hidden = !isIndividual; });

    // Чекбокс "Это я" в строках слушателей — только для ФЛ (компания не может
    // быть слушателем). Проходим по ВСЕМ строкам, включая уже добавленные,
    // чтобы переключение ЮЛ/ФЛ показывало/прятало его везде.
    document.querySelectorAll('.listener-row').forEach((row) => {
      applyListenerSelfFioVisibility(row, isIndividual);
    });

    recompute();
  }

  radios.forEach((r) => r.addEventListener('change', update));
  update();
}

// Показывает/прячет чекбокс "Это я" в одной строке слушателя. При скрытии
// (переключились на ЮЛ) снимаем отметку, чтобы не осталось «зависшего» состояния.
function applyListenerSelfFioVisibility(row, isIndividual) {
  const wrap = row.querySelector('.listener-self-fio');
  if (!wrap) return;
  wrap.hidden = !isIndividual;
  if (!isIndividual) {
    const check = row.querySelector('.listener-self-fio-check');
    if (check) check.checked = false;
  }
}

function currentApplicantIsIndividual() {
  const checked = document.querySelector('input[name="applicantType"]:checked');
  return !!checked && checked.value === 'individual';
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

// Поле "ФИО получателя" в почтовом блоке для ФЛ управляется чекбоксом
// "Получатель — это я": по умолчанию отмечен — тогда сам инпут скрыт/задизейблен,
// а его значение живьём равно "ФИО заявителя" (#fl-headfio). При снятии галочки
// инпут открывается для независимого редактирования (стартовое значение —
// текущее ФИО заявителя). Для ЮЛ чекбокс скрыт (.individual-only), а инпут
// работает по-старому (виден, зеркалирование по blur из #org-headfio).
function wirePostalHeadFioSelfCheck() {
  const checkbox = document.getElementById('postal-headfio-selfcheck');
  const postalHeadFio = document.getElementById('postal-headfio');
  const flHeadFio = document.getElementById('fl-headfio');
  const postalHeadFioLabel = document.querySelector('#postal-headfio-field label[for="postal-headfio"]');
  if (!checkbox || !postalHeadFio || !flHeadFio) return;

  function update() {
    const isIndividual = currentApplicantIsIndividual();
    if (!isIndividual) {
      // ЮЛ: инпут всегда виден и активен, поведение по blur не трогаем.
      postalHeadFio.hidden = false;
      postalHeadFio.disabled = false;
      if (postalHeadFioLabel) postalHeadFioLabel.hidden = false;
      return;
    }
    const self = checkbox.checked;
    if (self) {
      postalHeadFio.value = flHeadFio.value.trim();
      postalHeadFio.hidden = true;
      postalHeadFio.disabled = true;
      if (postalHeadFioLabel) postalHeadFioLabel.hidden = true;
    } else {
      postalHeadFio.hidden = false;
      postalHeadFio.disabled = false;
      if (postalHeadFioLabel) postalHeadFioLabel.hidden = false;
    }
  }

  checkbox.addEventListener('change', () => {
    // При снятии галочки предзаполняем текущим ФИО заявителя как стартовую точку.
    if (!checkbox.checked && !postalHeadFio.value.trim()) {
      postalHeadFio.value = flHeadFio.value.trim();
    }
    update();
  });

  // Пока галочка отмечена — держим значение почтового ФИО синхронным с ФИО заявителя.
  flHeadFio.addEventListener('input', () => {
    if (currentApplicantIsIndividual() && checkbox.checked) {
      postalHeadFio.value = flHeadFio.value.trim();
    }
  });

  // Пересчёт при переключении ЮЛ/ФЛ.
  document.querySelectorAll('input[name="applicantType"]').forEach((r) => {
    r.addEventListener('change', update);
  });

  update();
}

// Переключает видимость поля ручного уточнения при выборе "Другое" в
// способе получения оригиналов договора (см. wireListenerDateSelect() —
// тот же паттерн для дат обучения).
function wireOriginalsDeliveryOther() {
  const select = document.getElementById('org-originals-delivery');
  const field = document.getElementById('org-originals-delivery-other-field');
  const input = document.getElementById('org-originals-delivery-other');
  if (!select || !field || !input) return;

  select.addEventListener('change', () => {
    field.hidden = select.value !== 'other';
    if (select.value !== 'other') input.value = '';
    recompute();
  });
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
    recompute();
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

  recompute();
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

  recompute();
}

// Автоподбор банка по БИК через DaData (findById/bank). При полном вводе 9 цифр
// подставляет полное наименование банка (#org-bank-name) и корреспондентский
// счёт (#org-corr-account). Расчётный/казначейский и лицевой счета DaData не
// знает — их вводят только вручную. По стилю совпадает с wireInnAutofill.
function wireBikAutofill() {
  const bikInput = document.getElementById('org-bik');
  const statusEl = document.getElementById('bik-status');
  if (!bikInput || !statusEl) return;

  const lookup = debounce(async (bik) => {
    if (DADATA_TOKEN.startsWith('REPLACE-ME')) {
      statusEl.textContent =
        'Автоподбор по БИК недоступен: не задан ключ DaData (см. TODO в app.js). Заполните поля вручную.';
      statusEl.className = 'hint hint--error';
      return;
    }
    statusEl.textContent = 'Ищем банк по БИК...';
    statusEl.className = 'hint';
    try {
      const suggestion = await suggestBankByBik(bik);
      if (!suggestion) {
        statusEl.textContent = 'Банк с таким БИК не найден, заполните поля вручную.';
        statusEl.className = 'hint hint--error';
        return;
      }
      applyBankSuggestion(suggestion);
      statusEl.textContent = 'Банк найден, поля подставлены — проверьте и при необходимости поправьте.';
      statusEl.className = 'hint hint--ok';
    } catch (err) {
      console.error('DaData bank lookup error:', err);
      statusEl.textContent = 'Не удалось обратиться к DaData. Заполните поля вручную.';
      statusEl.className = 'hint hint--error';
    }
  }, 500);

  bikInput.addEventListener('input', () => {
    bikInput.value = onlyDigits(bikInput.value).slice(0, 9);
    if (bikInput.value.length === 9) {
      lookup(bikInput.value);
    } else {
      statusEl.textContent = '';
      statusEl.className = 'hint';
    }
  });
}

async function suggestBankByBik(bik) {
  const res = await fetch(DADATA_BANK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Token ' + DADATA_TOKEN,
    },
    body: JSON.stringify({ query: bik, count: 1 }),
  });
  if (!res.ok) throw new Error('DaData HTTP ' + res.status);
  const data = await res.json();
  return data.suggestions && data.suggestions[0];
}

function applyBankSuggestion(suggestion) {
  const d = suggestion.data || {};
  const bankNameInput = document.getElementById('org-bank-name');
  const corrAccountInput = document.getElementById('org-corr-account');

  const bankName = (d.name && (d.name.payment || d.name.full)) || suggestion.value;
  if (bankName) bankNameInput.value = bankName;

  // У казначейских БИК (УФК и т.п. — именно такие в примерах реквизитов
  // заказчика) DaData отдаёт корсчёт не в correspondent_account (он там null),
  // а в treasury_accounts. У обычных банков — наоборот, treasury_accounts нет.
  const correspondentAccount = d.correspondent_account || (d.treasury_accounts && d.treasury_accounts[0]);
  if (correspondentAccount) corrAccountInput.value = correspondentAccount;

  recompute();
}

// Общий DaData-автоподбор адреса. Переиспользуется для #org-address (юр.адрес)
// и #postal-address (почтовый адрес). onSelect(suggestion) вызывается при выборе
// подсказки — там задаётся, что делать с выбранным адресом (у почтового, помимо
// value, ещё и подстановка индекса).
function wireAddressSuggest(inputId, listId, onSelect) {
  const addressInput = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!addressInput || !list) return;

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
        onSelect(s);
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

  wireListenerDateSelect(rowEl);

  // Чекбокс "Это я" — только для ФЛ. Разовое копирование ФИО заявителя в ФИО
  // слушателя (не постоянная привязка). Email/телефон копировать не из чего —
  // на уровне заявителя их нет, поэтому подставляется только ФИО.
  const selfFioCheck = rowEl.querySelector('.listener-self-fio-check');
  if (selfFioCheck) {
    selfFioCheck.addEventListener('change', () => {
      if (selfFioCheck.checked) {
        const flHeadFio = document.getElementById('fl-headfio');
        const fioInput = rowEl.querySelector('.listener-fio');
        fioInput.value = (flHeadFio ? flHeadFio.value : '').trim();
        fioInput.classList.remove('field-invalid');
      }
    });
  }
  // Видимость чекбокса по текущему типу заявителя (важно для строк, добавленных
  // уже после переключения на ФЛ/ЮЛ).
  applyListenerSelfFioVisibility(rowEl, currentApplicantIsIndividual());

  rowEl.querySelector('.remove-listener-btn').addEventListener('click', () => {
    rowEl.remove();
    updateListenerRemoveButtons();
    renumberListenerTitles();
    recompute();
  });

  document.getElementById('listeners-list').appendChild(rowEl);
  updateListenerRemoveButtons();
  renumberListenerTitles();
  recompute();
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

  updateListenerDateOptions(rowEl, course);

  // Показ/скрытие доп.полей меняет число видимых обязательных полей — пересчёт.
  recompute();
}

// "2026-01-13" -> "13.01.2026" — форматирование только строковой нарезкой (без
// Date/Intl), чтобы не словить сдвиг на часовой пояс браузера у date-only ISO.
function formatRuDate(iso) {
  const [y, m, d] = (iso || '').split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso || '';
}

// Сегодняшняя дата в ISO (без времени) — для отсечения прошедших дат запуска.
function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Группа длительности по часам курса (см. site/course-dates.json). Диапазоны
// hoursMin/hoursMax не пересекаются, поэтому подходит первая совпавшая.
function findDateBucket(hours) {
  if (typeof hours !== 'number') return null;
  return state.courseDateBuckets.find(
    (b) => hours <= b.hoursMax && (b.hoursMin == null || hours >= b.hoursMin)
  ) || null;
}

// Перестраивает выпадающий список дат под выбранный курс: варианты из
// подходящей группы часов (только с датой начала не раньше сегодня) + всегда
// "Другие сроки" последним пунктом (ручной ввод, см. wireListenerDateSelect()).
function updateListenerDateOptions(rowEl, course) {
  const select = rowEl.querySelector('.listener-date-select');
  const manualInput = rowEl.querySelector('.listener-date-manual');
  const previousValue = select.value;

  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.textContent = course ? 'Выберите даты' : 'Сначала выберите курс';
  select.appendChild(placeholder);

  const bucket = course ? findDateBucket(course.hours) : null;
  const today = todayIso();
  const ranges = bucket ? bucket.ranges.filter((r) => r.start >= today) : [];

  ranges.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.start + '_' + r.end;
    opt.dataset.start = r.start;
    opt.dataset.end = r.end;
    opt.textContent = formatRuDate(r.start) + ' – ' + formatRuDate(r.end);
    select.appendChild(opt);
  });

  const otherOpt = document.createElement('option');
  otherOpt.value = 'other';
  otherOpt.textContent = 'Другие сроки';
  select.appendChild(otherOpt);

  // Смена курса всегда сбрасывает выбранные даты — старый диапазон мог
  // относиться к другой группе часов и не подходить новому курсу.
  if (previousValue && ranges.some((r) => r.start + '_' + r.end === previousValue)) {
    select.value = previousValue;
  } else {
    select.value = '';
    manualInput.hidden = true;
    manualInput.value = '';
  }
}

// Переключает видимость ручного поля даты при выборе "Другие сроки".
function wireListenerDateSelect(rowEl) {
  const select = rowEl.querySelector('.listener-date-select');
  const manualInput = rowEl.querySelector('.listener-date-manual');
  select.addEventListener('change', () => {
    manualInput.hidden = select.value !== 'other';
    if (select.value !== 'other') manualInput.value = '';
    recompute();
  });
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

// Общая часть выбора курса для строки слушателя — используется и явным
// выбором из попапа (selectCourseForRow), и восстановлением черновика
// (restoreListenerRow), где попап вообще не открывается.
function applyCourseToRow(rowEl, course) {
  const hiddenInput = rowEl.querySelector('.listener-course');
  const btnText = rowEl.querySelector('.listener-course-btn__text');
  const btn = rowEl.querySelector('.listener-course-btn');

  hiddenInput.value = course.id;
  btnText.textContent = course.name;
  btn.classList.add('is-selected');
  btn.classList.remove('field-invalid');

  onListenerCourseChange(rowEl);
}

function selectCourseForRow(course) {
  const rowEl = courseModal.activeRow;
  if (!rowEl) return;
  applyCourseToRow(rowEl, course);
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
 * Живой прогресс: мини-бар в шапке + сайдбар-чеклист
 *
 * Считаем только видимые обязательные поля (.field[data-req]) в каждой
 * карточке-разделе (.card[data-section]). recompute() вызывается на любое
 * изменение формы (input/change/focusout), а также вручную после
 * программных подстановок (DaData, выбор курса, добавление/удаление
 * слушателя, переключатели ИКЗ/типа заявителя) — там DOM-события не летят.
 * ===================================================================== */

function wireProgress() {
  const form = document.getElementById('application-form');
  if (!form) return;
  // focusout ловит зеркалирование почтовых полей по blur (значение туда
  // проставляется программно, без input-события у самого поля-приёмника).
  ['input', 'change', 'focusout'].forEach((evt) => form.addEventListener(evt, recompute));
  recompute();
}

// Заполнено ли обязательное поле. Радиогруппы — по выбранному input; курс — по
// скрытому input.listener-course; остальное — по первому «настоящему» контролу
// (пропускаем скрытые checkbox/radio-переключатели вроде «Получатель — это я»,
// иначе отмеченный по умолчанию чекбокс ложно считался бы заполнением поля).
function fieldFilled(field) {
  if (field.querySelector('.radios')) {
    return !!field.querySelector('.radios input:checked');
  }
  const dateSelect = field.querySelector('.listener-date-select');
  if (dateSelect) {
    if (!dateSelect.value) return false;
    if (dateSelect.value === 'other') {
      return field.querySelector('.listener-date-manual').value.trim() !== '';
    }
    return true;
  }
  const controls = field.querySelectorAll('input, select, textarea');
  for (const c of controls) {
    if (c.type === 'hidden') {
      if (c.classList.contains('listener-course')) return c.value.trim() !== '';
      continue;
    }
    if (c.type === 'checkbox' || c.type === 'radio') continue;
    if (c.disabled) continue;
    if (c.hasAttribute('readonly')) return true;
    return c.value.trim() !== '';
  }
  return false;
}

function isFieldCountable(field) {
  return !field.hidden && !field.closest('[hidden]');
}

function recompute() {
  const navList = document.getElementById('nav-list');
  const cards = document.querySelectorAll('.card[data-section]');
  if (!navList) return;
  navList.innerHTML = '';

  let totalReq = 0;
  let totalDone = 0;
  let secLeft = 0;

  cards.forEach((card) => {
    let n = 0;
    let done = 0;
    card.querySelectorAll('.field[data-req]').forEach((f) => {
      if (!isFieldCountable(f)) return;
      n += 1;
      const ok = fieldFilled(f);
      const plain = !f.querySelector('.radios') && !f.querySelector('.listener-course');
      f.classList.toggle('is-filled', ok && plain);
      if (ok) done += 1;
    });

    totalReq += n;
    totalDone += done;
    const complete = n > 0 && done === n;
    if (!complete) secLeft += 1;
    card.classList.toggle('is-complete', complete);

    const status = card.querySelector('[data-status]');
    if (status) {
      status.classList.toggle('is-done', complete);
      const ring = status.querySelector('.ring');
      if (ring) ring.style.setProperty('--p', n ? (done / n) * 100 : 0);
      const label = status.querySelector('.status__label');
      if (label) label.textContent = done + ' из ' + n;
    }

    const pctSection = n ? (done / n) * 100 : 0;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav__item' + (complete ? ' is-done' : '');
    btn.innerHTML =
      '<span class="nav__ico" style="--p:' + pctSection + '"></span>' +
      '<span class="nav__txt"><span class="nav__name"></span><span class="nav__meta"></span></span>';
    btn.querySelector('.nav__name').textContent = card.getAttribute('data-section');
    btn.querySelector('.nav__meta').textContent = complete ? 'заполнено' : done + ' из ' + n + ' полей';
    btn.addEventListener('click', () => card.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    li.appendChild(btn);
    navList.appendChild(li);
  });

  const pct = totalReq ? Math.round((totalDone / totalReq) * 100) : 0;
  const left = totalReq - totalDone;

  setTextById('bar-pct', pct + '%');
  setTextById('nav-pct', pct + '%');
  const fill = document.getElementById('bar-fill');
  if (fill) fill.style.width = pct + '%';
  setTextById(
    'bar-left',
    left === 0
      ? 'всё готово к отправке'
      : 'осталось ' + left + ' ' + plural(left, 'обязательное поле', 'обязательных поля', 'обязательных полей')
  );
  setTextById('nav-left', left + ' ' + plural(left, 'поле', 'поля', 'полей'));
  setTextById('nav-sec-left', secLeft + ' ' + plural(secLeft, 'разделе', 'разделах', 'разделах'));
}

function setTextById(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* =====================================================================
 * Черновик формы в localStorage — переживает перезагрузку страницы до
 * отправки. Хранится «сырыми» значениями полей (без нормализации digits-only
 * и т.п., как в buildPayload()) — так восстановление один в один возвращает
 * то, что пользователь напечатал, а не отформатированное представление.
 * ===================================================================== */

const DRAFT_STORAGE_KEY = 'zayavkaDraftV1';
// Старше суток — не подставляем: скорее всего, уже неактуально (сменился
// прайс/каталог, пользователь просто забыл про старую вкладку и т.п.).
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Простые текстовые/select-поля, которые можно восстановить прямым
// присваиванием .value — без сопутствующих обработчиков (автоподбор по ИНН/БИК
// вешается на 'input' и в черновик не должен дёргаться заново при каждой
// перезагрузке). Радио-группы, чекбоксы и select с видимость-переключателями
// (applicantType, ikzRequired, originalsDelivery, fl-unemployed,
// postal-headfio-selfcheck) обрабатываются отдельно в restoreDraft().
const DRAFT_FIELD_IDS = [
  'org-headfio', 'org-phone', 'org-email', 'org-comment',
  'org-inn', 'org-kpp', 'org-fullname', 'org-address',
  'org-bank-name', 'org-bik', 'org-corr-account', 'org-settlement-account', 'org-personal-account', 'org-bank-extra',
  'org-document-type', 'org-ikz-number', 'org-funding-source',
  'fl-headfio', 'fl-inn', 'fl-workplace',
  'org-originals-delivery', 'org-originals-delivery-other',
  'postal-index', 'postal-address', 'postal-orgname', 'postal-headfio',
];

function buildDraft() {
  const applicantChecked = document.querySelector('input[name="applicantType"]:checked');
  const lawTypeChecked = document.querySelector('input[name="lawType"]:checked');
  const ikzChecked = document.querySelector('input[name="ikzRequired"]:checked');
  const postalSelfCheck = document.getElementById('postal-headfio-selfcheck');

  const fields = {};
  DRAFT_FIELD_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) fields[id] = el.value;
  });

  const listeners = Array.from(document.querySelectorAll('.listener-row')).map((row) => {
    const reasonChecked = row.querySelector('.listener-reason:checked');
    const selfFioCheck = row.querySelector('.listener-self-fio-check');
    return {
      courseId: row.querySelector('.listener-course').value || null,
      dateSelectValue: row.querySelector('.listener-date-select').value || null,
      dateManualValue: row.querySelector('.listener-date-manual').value || null,
      fio: row.querySelector('.listener-fio').value,
      email: row.querySelector('.listener-email').value,
      phone: row.querySelector('.listener-phone').value,
      position: row.querySelector('.listener-position').value,
      reason: reasonChecked ? reasonChecked.value : null,
      selfFio: !!(selfFioCheck && selfFioCheck.checked),
    };
  });

  return {
    savedAt: new Date().toISOString(),
    // dealId, пришедший из ?deal= в URL, восстанавливать не нужно — он и так
    // будет в адресе при следующем открытии той же ссылки.
    dealId: state.dealIdFromUrl ? null : state.dealId,
    applicantType: applicantChecked ? applicantChecked.value : null,
    lawType: lawTypeChecked ? lawTypeChecked.value : null,
    ikzRequired: ikzChecked ? ikzChecked.value : null,
    flUnemployed: document.getElementById('fl-unemployed').checked,
    postalHeadFioSelfCheck: postalSelfCheck ? postalSelfCheck.checked : true,
    fields,
    listeners,
  };
}

function saveDraft() {
  if (state.restoringDraft || state.submittedSuccessfully) return;
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(buildDraft()));
  } catch (err) {
    // localStorage бывает недоступен (приватный режим, забита квота) —
    // черновик просто не сохранится, саму форму это не должно ломать.
    console.error('Не удалось сохранить черновик формы:', err);
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch (err) {
    /* нечего чистить, если localStorage недоступен */
  }
}

function loadDraft() {
  let raw;
  try {
    raw = localStorage.getItem(DRAFT_STORAGE_KEY);
  } catch (err) {
    return null;
  }
  if (!raw) return null;

  let draft;
  try {
    draft = JSON.parse(raw);
  } catch (err) {
    clearDraft();
    return null;
  }
  if (!draft || typeof draft !== 'object') return null;

  const savedAt = Date.parse(draft.savedAt);
  if (!Number.isFinite(savedAt) || Date.now() - savedAt > DRAFT_MAX_AGE_MS) {
    clearDraft();
    return null;
  }
  return draft;
}

function restoreListenerRow(rowEl, listenerDraft) {
  const course = listenerDraft.courseId && state.courses.find((c) => c.id === listenerDraft.courseId);
  if (course) {
    applyCourseToRow(rowEl, course);

    const dateSelect = rowEl.querySelector('.listener-date-select');
    const dateManual = rowEl.querySelector('.listener-date-manual');
    const hasOption = listenerDraft.dateSelectValue
      && Array.from(dateSelect.options).some((o) => o.value === listenerDraft.dateSelectValue);
    // Если сохранённый диапазон дат уже пропал из расписания (даты прошли) —
    // оставляем поле пустым, пользователь выберет заново; это единственный
    // случай частичной потери данных при восстановлении, и он ожидаем.
    if (hasOption) {
      dateSelect.value = listenerDraft.dateSelectValue;
      if (listenerDraft.dateSelectValue === 'other') {
        dateManual.hidden = false;
        dateManual.value = listenerDraft.dateManualValue || '';
      }
    }
  }

  rowEl.querySelector('.listener-fio').value = listenerDraft.fio || '';
  rowEl.querySelector('.listener-email').value = listenerDraft.email || '';
  rowEl.querySelector('.listener-phone').value = listenerDraft.phone || '';
  const positionInput = rowEl.querySelector('.listener-position');
  if (positionInput) positionInput.value = listenerDraft.position || '';
  if (listenerDraft.reason) {
    const reasonRadio = rowEl.querySelector('.listener-reason[value="' + listenerDraft.reason + '"]');
    if (reasonRadio) reasonRadio.checked = true;
  }
  const selfFioCheck = rowEl.querySelector('.listener-self-fio-check');
  if (selfFioCheck) selfFioCheck.checked = !!listenerDraft.selfFio;
}

// Применяет сохранённый черновик к форме. Вызывается из loadCourses() — уже
// после того, как загружен каталог курсов (нужен для восстановления выбора
// курса у слушателей) и добавлена стартовая пустая строка слушателя (которую
// эта функция удаляет и пересоздаёт под сохранённые данные).
function restoreDraft(draft) {
  state.restoringDraft = true;

  // applicantType — первым: от него зависит видимость блоков ЮЛ/ФЛ и часть
  // остальных переключателей (см. wirePostalHeadFioSelfCheck).
  if (draft.applicantType) {
    const applicantRadio = document.querySelector(
      'input[name="applicantType"][value="' + draft.applicantType + '"]'
    );
    if (applicantRadio) {
      applicantRadio.checked = true;
      applicantRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  Object.keys(draft.fields || {}).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = draft.fields[id];
  });

  if (draft.lawType) {
    const lawRadio = document.querySelector('input[name="lawType"][value="' + draft.lawType + '"]');
    if (lawRadio) lawRadio.checked = true;
  }

  if (draft.ikzRequired) {
    const ikzRadio = document.querySelector('input[name="ikzRequired"][value="' + draft.ikzRequired + '"]');
    if (ikzRadio) {
      ikzRadio.checked = true;
      ikzRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  if (draft.flUnemployed) {
    const unemployedCheckbox = document.getElementById('fl-unemployed');
    if (unemployedCheckbox) {
      unemployedCheckbox.checked = true;
      unemployedCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Флажок "Получатель — это я" по умолчанию уже отмечен разметкой — событие
  // нужно только когда черновик его явно снимал.
  if (draft.postalHeadFioSelfCheck === false) {
    const postalSelfCheck = document.getElementById('postal-headfio-selfcheck');
    if (postalSelfCheck) {
      postalSelfCheck.checked = false;
      postalSelfCheck.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  const originalsSelect = document.getElementById('org-originals-delivery');
  if (originalsSelect) originalsSelect.dispatchEvent(new Event('change', { bubbles: true }));

  if (!state.dealIdFromUrl && draft.dealId) {
    const dealInput = document.getElementById('deal-id-input');
    if (dealInput) {
      dealInput.value = draft.dealId;
      dealInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  document.querySelectorAll('.listener-row').forEach((row) => row.remove());
  const listenerDrafts = draft.listeners && draft.listeners.length ? draft.listeners : [null];
  listenerDrafts.forEach((listenerDraft) => {
    const rowEl = addListenerRow();
    if (listenerDraft) restoreListenerRow(rowEl, listenerDraft);
  });

  state.restoringDraft = false;
  recompute();

  const notice = document.getElementById('draft-restored-notice');
  if (notice) notice.hidden = false;
}

function wireDraftAutosave() {
  const form = document.getElementById('application-form');
  if (!form) return;
  const debouncedSave = debounce(saveDraft, 400);
  ['input', 'change'].forEach((evt) => form.addEventListener(evt, debouncedSave));
}

function wireDraftRestoredNotice() {
  const dismissBtn = document.getElementById('draft-restored-dismiss');
  if (!dismissBtn) return;
  dismissBtn.addEventListener('click', () => {
    clearDraft();
    location.reload();
  });
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

    // КПП и юр.адрес теперь обязательны для ЮЛ (см. CONTRACT.md §2 и
    // validateSubmitPayload в yandex-function). КПП — ровно 9 символов
    // (обычно цифры, но у обособленных/иностранных возможны буквы, поэтому
    // проверяем длину, а не «только цифры»).
    const kpp = document.getElementById('org-kpp');
    const kppVal = kpp.value.trim();
    if (!kppVal) {
      markInvalid(kpp, errors, 'Укажите КПП организации.');
    } else if (kppVal.length !== 9) {
      markInvalid(kpp, errors, 'КПП должен содержать 9 символов.');
    }

    const address = document.getElementById('org-address');
    if (!address.value.trim()) {
      markInvalid(address, errors, 'Укажите юридический адрес организации.');
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

    const bankName = document.getElementById('org-bank-name');
    if (!bankName.value.trim()) markInvalid(bankName, errors, 'Укажите наименование банка.');

    const bik = document.getElementById('org-bik');
    const bikDigits = onlyDigits(bik.value);
    if (!bikDigits) {
      markInvalid(bik, errors, 'Укажите БИК банка.');
    } else if (bikDigits.length !== 9) {
      markInvalid(bik, errors, 'БИК должен содержать 9 цифр.');
    }

    const settlementAccount = document.getElementById('org-settlement-account');
    if (!onlyDigits(settlementAccount.value)) {
      markInvalid(settlementAccount, errors, 'Укажите расчётный / казначейский счёт.');
    }

    const corrAccount = document.getElementById('org-corr-account');
    if (!onlyDigits(corrAccount.value)) {
      markInvalid(corrAccount, errors, 'Укажите корреспондентский счёт.');
    }
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
  if (originalsDelivery.value === 'other') {
    const originalsDeliveryOther = document.getElementById('org-originals-delivery-other');
    if (!originalsDeliveryOther.value.trim()) {
      markInvalid(originalsDeliveryOther, errors, 'Уточните способ получения оригиналов договора.');
    }
  }

  // Почтовый адрес больше не завязан на способ получения оригиналов — блок
  // всегда виден в форме, поэтому и проверяется всегда, а не только при
  // выборе конкретного способа доставки.
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

  // ФИО получателя. Для ЮЛ — отдельное обязательное поле. Для ФЛ проверяем,
  // только если снят чекбокс "Получатель — это я": если он отмечен, значение
  // берётся из "ФИО заявителя" (#fl-headfio), которое валидируется ниже.
  const selfCheck = document.getElementById('postal-headfio-selfcheck');
  const postalSelf = isIndividual && selfCheck && selfCheck.checked;
  if (!postalSelf) {
    const postalHeadFio = document.getElementById('postal-headfio');
    if (!postalHeadFio.value.trim()) markInvalid(postalHeadFio, errors, 'Укажите ФИО получателя для почтового адреса.');
  }

  if (!isIndividual) {
    const orgPhone = document.getElementById('org-phone');
    if (!orgPhone.value.trim()) {
      markInvalid(orgPhone, errors, 'Укажите телефон контактного лица.');
    } else if (!isValidPhoneDigits(orgPhone.value)) {
      markInvalid(orgPhone, errors, 'Телефон указан в неверном формате.');
    }

    const orgEmail = document.getElementById('org-email');
    if (!orgEmail.value.trim()) {
      markInvalid(orgEmail, errors, 'Укажите email контактного лица.');
    } else if (!isValidEmail(orgEmail.value)) {
      markInvalid(orgEmail, errors, 'Email контактного лица указан в неверном формате.');
    } else {
      const orgEmailFix = suggestEmailFix(orgEmail.value);
      if (orgEmailFix) {
        markInvalid(orgEmail, errors, `Похоже, опечатка в email контактного лица. Возможно, вы имели в виду ${orgEmailFix}?`);
      }
    }
  }

  // ФИО: для ФЛ — "ФИО заявителя" (#fl-headfio), для ЮЛ — "ФИО руководителя"
  // (#org-headfio).
  const headFio = document.getElementById(isIndividual ? 'fl-headfio' : 'org-headfio');
  if (!headFio.value.trim()) {
    markInvalid(headFio, errors, isIndividual ? 'Укажите ФИО заявителя.' : 'Укажите ФИО руководителя.');
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

    const dateSelect = row.querySelector('.listener-date-select');
    const dateManual = row.querySelector('.listener-date-manual');
    if (!dateSelect.value) {
      markInvalid(dateSelect, errors, `Слушатель ${n}: укажите даты обучения.`);
    } else if (dateSelect.value === 'other' && !dateManual.value) {
      markInvalid(dateManual, errors, `Слушатель ${n}: укажите дату вручную.`);
    }

    const fioInput = row.querySelector('.listener-fio');
    if (!fioInput.value.trim()) markInvalid(fioInput, errors, `Слушатель ${n}: укажите ФИО.`);

    const emailInput = row.querySelector('.listener-email');
    if (!emailInput.value.trim()) {
      markInvalid(emailInput, errors, `Слушатель ${n}: укажите email.`);
    } else if (!isValidEmail(emailInput.value)) {
      markInvalid(emailInput, errors, `Слушатель ${n}: email указан в неверном формате.`);
    } else {
      const emailFix = suggestEmailFix(emailInput.value);
      if (emailFix) {
        markInvalid(emailInput, errors, `Слушатель ${n}: похоже, опечатка в email. Возможно, вы имели в виду ${emailFix}?`);
      }
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

// ФИО получателя для payload. Для ФЛ с отмеченным чекбоксом "Получатель — это я"
// значение берётся из "ФИО заявителя", иначе из самого поля #postal-headfio.
function postalHeadFioValue(isIndividual) {
  const selfCheck = document.getElementById('postal-headfio-selfcheck');
  if (isIndividual && selfCheck && selfCheck.checked) {
    return document.getElementById('fl-headfio').value.trim();
  }
  return document.getElementById('postal-headfio').value.trim();
}

function buildPayload() {
  const applicantChecked = document.querySelector('input[name="applicantType"]:checked');
  const applicantType = applicantChecked ? applicantChecked.value : null;
  const isIndividual = applicantType === 'individual';

  const ikzChecked = document.querySelector('input[name="ikzRequired"]:checked');
  const ikzRequired = !isIndividual && !!ikzChecked && ikzChecked.value === 'yes';
  const lawTypeChecked = document.querySelector('input[name="lawType"]:checked');
  const comment = document.getElementById('org-comment').value.trim();
  const originalsDelivery = document.getElementById('org-originals-delivery').value;
  const originalsDeliveryOther = originalsDelivery === 'other'
    ? document.getElementById('org-originals-delivery-other').value.trim()
    : null;

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

    bankName: isIndividual ? null : document.getElementById('org-bank-name').value.trim() || null,
    bik: isIndividual ? null : onlyDigits(document.getElementById('org-bik').value) || null,
    settlementAccount: isIndividual ? null : onlyDigits(document.getElementById('org-settlement-account').value) || null,
    correspondentAccount: isIndividual ? null : onlyDigits(document.getElementById('org-corr-account').value) || null,
    personalAccount: isIndividual ? null : onlyDigits(document.getElementById('org-personal-account').value) || null,
    bankExtra: isIndividual ? null : document.getElementById('org-bank-extra').value.trim() || null,

    workplace: isIndividual ? document.getElementById('fl-workplace').value.trim() || null : null,
    workplaceInn: isIndividual ? onlyDigits(document.getElementById('fl-inn').value) || null : null,
    selfEmployedOrUnemployed: isIndividual ? document.getElementById('fl-unemployed').checked : null,

    // Почтовый адрес больше не завязан на способ доставки — собирается всегда.
    postalAddress: {
      index: onlyDigits(document.getElementById('postal-index').value),
      address: document.getElementById('postal-address').value.trim(),
      orgName: isIndividual ? null : document.getElementById('postal-orgname').value.trim(),
      // ФИО получателя. Для ФЛ: если отмечен "Получатель — это я" — берём "ФИО
      // заявителя" (#fl-headfio), иначе — то, что вписано вручную в #postal-headfio.
      // Для ЮЛ — как раньше, из #postal-headfio.
      headFio: postalHeadFioValue(isIndividual),
    },

    headFio: isIndividual
      ? document.getElementById('fl-headfio').value.trim()
      : document.getElementById('org-headfio').value.trim(),
    phone: isIndividual ? null : normalizePhone(document.getElementById('org-phone').value),
    email: isIndividual ? null : document.getElementById('org-email').value.trim(),
    originalsDelivery,
    originalsDeliveryOther,
    comment: comment || null,
  };

  const listeners = Array.from(document.querySelectorAll('.listener-row')).map((row) => {
    const courseSelect = row.querySelector('.listener-course');
    const course = state.courses.find((c) => c.id === courseSelect.value);
    const hasExtra = !!(course && course.category != null);
    const reasonChecked = row.querySelector('.listener-reason:checked');

    // "Другие сроки" — только дата начала (ручной ввод), dateEnd null.
    // Выбор из расписания — обе даты берутся из data-атрибутов опции.
    const dateSelect = row.querySelector('.listener-date-select');
    const isOtherDate = dateSelect.value === 'other';
    const selectedOption = dateSelect.selectedOptions[0] || null;
    const date = isOtherDate
      ? row.querySelector('.listener-date-manual').value || null
      : (selectedOption && selectedOption.dataset.start) || null;
    const dateEnd = isOtherDate ? null : (selectedOption && selectedOption.dataset.end) || null;

    return {
      courseId: courseSelect.value || null,
      courseName: course ? course.name : null,
      hours: course ? course.hours : null,
      date,
      dateEnd,
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
    clearDraft();
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
  // Прогресс (сайдбар-чеклист + мини-бар в шапке) после отправки не нужен —
  // заполнять больше нечего, показывать "100%" незачем.
  document.getElementById('progress-side').hidden = true;
  document.getElementById('appbar-progress').hidden = true;
  document.getElementById('draft-restored-notice').hidden = true;
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
