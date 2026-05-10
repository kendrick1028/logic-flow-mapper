// ── Range Tree: 교재 탭 + 단원/지문 멀티체크 트리 ──
// 3 페이지 공용 컴포넌트 (워크북 · 변형문제 · 일괄꼼꼼분석)
//
// 사용법:
//   initRangeTree(containerEl, onChange?)  → 컨테이너에 트리 렌더
//   getRangeSelection(containerEl)         → [{book, unit, num, passage}, ...]
//   getRangeSelectionCount(containerEl)    → number
//
// 상태는 container._selectionMap 에 누적되므로 교재 탭을 전환해도
// 다른 교재의 선택이 유지된다.

function initRangeTree(container, onChange) {
  if (!container || typeof BOOKS === 'undefined') return;
  container._onChange = onChange || null;
  container._selectionMap = container._selectionMap || {};

  const books = Object.keys(BOOKS);
  container._activeBook = container._activeBook || books[0] || '';

  container.innerHTML = `
    <div class="range-tree-books-tab" data-role="book-tabs"></div>
    <div class="range-tree-toolbar">
      <button type="button" class="range-tree-btn" data-action="expand-all">전체 펼치기</button>
      <button type="button" class="range-tree-btn" data-action="collapse-all">전체 접기</button>
      <button type="button" class="range-tree-btn" data-action="toggle-all">전체 선택</button>
    </div>
    <div class="range-tree-body" data-role="body"></div>
  `;

  renderBookTabs(container);
  renderActiveBookBody(container);
  bindRangeTreeEvents(container);
  updateBookInfo(container);
}

function renderBookTabs(container) {
  const tabs = container.querySelector('[data-role="book-tabs"]');
  if (!tabs) return;
  const books = Object.keys(BOOKS);
  tabs.innerHTML = books.map(b => {
    const active = b === container._activeBook;
    const total = getBookPassageTotal(b);
    const selected = countSelectedInBook(container, b);
    return `
      <button type="button" class="range-tree-book-tab ${active ? 'active' : ''}" data-book="${escapeAttr(b)}">
        <span class="rt-tab-name">${escapeHtml(b)}</span>
        <span class="rt-tab-count">${selected ? `${selected}/` : ''}${total}</span>
      </button>
    `;
  }).join('');
}

function renderActiveBookBody(container) {
  const body = container.querySelector('[data-role="body"]');
  if (!body) return;
  const bookName = container._activeBook;
  const bookDB = BOOKS[bookName] || {};
  const units = sortUnitKeys(Object.keys(bookDB));

  body.innerHTML = units.map((unit, ui) => {
    const nums = sortNumKeys(Object.keys(bookDB[unit] || {}));
    const allChecked = nums.length > 0 && nums.every(n => !!container._selectionMap[selKey(bookName, unit, n)]);
    const someChecked = nums.some(n => !!container._selectionMap[selKey(bookName, unit, n)]);
    const indetAttr = !allChecked && someChecked ? 'data-indet="1"' : '';
    return `
      <div class="range-tree-unit" data-unit="${escapeAttr(unit)}">
        <div class="range-tree-unit-head">
          <input type="checkbox" class="rt-unit-chk" data-role="unit" ${allChecked ? 'checked' : ''} ${indetAttr}>
          <span class="rt-toggle" data-role="toggle">▸</span>
          <span class="rt-unit-name">${escapeHtml(unit)}</span>
          <span class="rt-count" data-role="unit-count"></span>
        </div>
        <div class="range-tree-passages" style="display:none">
          ${nums.map(n => {
            const checked = !!container._selectionMap[selKey(bookName, unit, n)];
            return `
              <label class="range-tree-passage ${checked ? 'checked' : ''}" data-num="${escapeAttr(n)}">
                <input type="checkbox" class="rt-passage-chk" data-role="passage" ${checked ? 'checked' : ''}>
                <span>${escapeHtml(n)}</span>
              </label>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');

  // indeterminate 속성은 DOM 에 직접 세팅해야 함
  body.querySelectorAll('.rt-unit-chk[data-indet="1"]').forEach(cb => {
    cb.indeterminate = true;
  });

  updateUnitCounts(container);
}

function bindRangeTreeEvents(container) {
  container.addEventListener('click', (e) => {
    // 교재 탭 전환
    const tab = e.target.closest('.range-tree-book-tab');
    if (tab) {
      const book = tab.dataset.book;
      if (book && book !== container._activeBook) {
        container._activeBook = book;
        renderBookTabs(container);
        renderActiveBookBody(container);
        updateBookInfo(container);
      }
      return;
    }

    // 툴바
    const btn = e.target.closest('.range-tree-btn');
    if (btn) {
      const action = btn.dataset.action;
      if (action === 'expand-all') setAllExpanded(container, true);
      else if (action === 'collapse-all') setAllExpanded(container, false);
      else if (action === 'toggle-all') toggleAllCheckboxes(container);
      else if (action === 'clear-all') clearAllCheckboxes(container);  // 레거시 호환
      return;
    }

    // 단원 헤더 토글 (체크박스/라벨 클릭 제외)
    const unitHead = e.target.closest('.range-tree-unit-head');
    if (unitHead) {
      if (e.target.tagName === 'INPUT' || e.target.closest('label')) return;
      const parent = unitHead.parentElement;
      const body = parent.querySelector('.range-tree-passages');
      if (!body) return;
      const isHidden = body.style.display === 'none' || !body.style.display;
      body.style.display = isHidden ? 'flex' : 'none';
      const toggle = unitHead.querySelector('.rt-toggle');
      if (toggle) toggle.textContent = isHidden ? '▾' : '▸';
    }
  });

  container.addEventListener('change', (e) => {
    const input = e.target;
    if (input.type !== 'checkbox') return;
    const role = input.dataset.role;
    const bookName = container._activeBook;

    if (role === 'unit') {
      const unitEl = input.closest('.range-tree-unit');
      const unit = unitEl.dataset.unit;
      const checked = input.checked;
      input.indeterminate = false;
      unitEl.querySelectorAll('.rt-passage-chk').forEach(cb => {
        cb.checked = checked;
        const num = cb.closest('.range-tree-passage').dataset.num;
        container._selectionMap[selKey(bookName, unit, num)] = checked;
        cb.closest('.range-tree-passage').classList.toggle('checked', checked);
      });
    } else if (role === 'passage') {
      const label = input.closest('.range-tree-passage');
      const unit = label.closest('.range-tree-unit').dataset.unit;
      const num = label.dataset.num;
      container._selectionMap[selKey(bookName, unit, num)] = input.checked;
      label.classList.toggle('checked', input.checked);
      // 단원 체크박스 상태 업데이트 (indeterminate 포함)
      propagateUpUnit(container, bookName, unit);
    }

    updateBookTabCount(container, bookName);
    updateUnitCounts(container);
    updateBookInfo(container);

    if (typeof container._onChange === 'function') container._onChange();
  });
}

function propagateUpUnit(container, bookName, unit) {
  const body = container.querySelector('[data-role="body"]');
  if (!body) return;
  const unitEl = body.querySelector(`.range-tree-unit[data-unit="${cssEscape(unit)}"]`);
  if (!unitEl) return;
  const passages = unitEl.querySelectorAll('.rt-passage-chk');
  const total = passages.length;
  const checked = Array.from(passages).filter(cb => cb.checked).length;
  const unitChk = unitEl.querySelector('.rt-unit-chk');
  if (!unitChk) return;
  unitChk.checked = total > 0 && checked === total;
  unitChk.indeterminate = checked > 0 && checked < total;
}

function updateUnitCounts(container) {
  const body = container.querySelector('[data-role="body"]');
  if (!body) return;
  body.querySelectorAll('.range-tree-unit').forEach(unitEl => {
    const passages = unitEl.querySelectorAll('.rt-passage-chk');
    const total = passages.length;
    const checked = Array.from(passages).filter(cb => cb.checked).length;
    const el = unitEl.querySelector('[data-role="unit-count"]');
    if (el) el.textContent = checked > 0 ? `${checked}/${total}` : `${total}`;
  });
}

function updateBookTabCount(container, bookName) {
  const tabs = container.querySelector('[data-role="book-tabs"]');
  if (!tabs) return;
  const tab = tabs.querySelector(`.range-tree-book-tab[data-book="${cssEscape(bookName)}"] .rt-tab-count`);
  if (!tab) return;
  const total = getBookPassageTotal(bookName);
  const sel = countSelectedInBook(container, bookName);
  tab.textContent = sel ? `${sel}/${total}` : `${total}`;
}

function updateBookInfo(container) {
  // 선택 수 캐시 갱신
  const total = countSelectedTotal(container);
  container._selectedTotal = total;
  container._allTotal = countAllTotal();
  // 레거시 label (book-info) 가 있으면 갱신 (현재는 제거됨)
  const info = container.querySelector('[data-role="book-info"]');
  if (info) {
    info.textContent = total > 0 ? `총 ${total}개 선택` : `전체 ${container._allTotal}개 지문`;
  }
  // 토글 버튼 상태 업데이트
  updateToggleAllBtn(container);
}

function getBookPassageTotal(bookName) {
  const bookDB = BOOKS[bookName] || {};
  let total = 0;
  Object.keys(bookDB).forEach(unit => {
    total += Object.keys(bookDB[unit] || {}).length;
  });
  return total;
}

function countSelectedInBook(container, bookName) {
  const prefix = bookName + '||';
  let n = 0;
  for (const k in container._selectionMap) {
    if (container._selectionMap[k] && k.indexOf(prefix) === 0) n++;
  }
  return n;
}

function countSelectedTotal(container) {
  let n = 0;
  for (const k in container._selectionMap) {
    if (container._selectionMap[k]) n++;
  }
  return n;
}

function countAllTotal() {
  let n = 0;
  Object.keys(BOOKS).forEach(b => { n += getBookPassageTotal(b); });
  return n;
}

function setAllExpanded(container, expanded) {
  const body = container.querySelector('[data-role="body"]');
  if (!body) return;
  body.querySelectorAll('.range-tree-passages').forEach(el => {
    el.style.display = expanded ? 'flex' : 'none';
  });
  body.querySelectorAll('.rt-toggle').forEach(el => {
    el.textContent = expanded ? '▾' : '▸';
  });
}

function clearAllCheckboxes(container) {
  // 모든 교재의 선택을 해제
  container._selectionMap = {};
  renderBookTabs(container);
  renderActiveBookBody(container);
  updateBookInfo(container);
  updateToggleAllBtn(container);
  if (typeof container._onChange === 'function') container._onChange();
}

function selectAllCheckboxes(container) {
  // 모든 교재의 모든 지문 선택
  if (typeof BOOKS === 'undefined') return;
  const selMap = {};
  Object.keys(BOOKS).forEach(book => {
    const bookDB = BOOKS[book] || {};
    Object.keys(bookDB).forEach(unit => {
      const bookUnit = bookDB[unit] || {};
      Object.keys(bookUnit).forEach(num => {
        selMap[selKey(book, unit, num)] = true;
      });
    });
  });
  container._selectionMap = selMap;
  renderBookTabs(container);
  renderActiveBookBody(container);
  updateBookInfo(container);
  updateToggleAllBtn(container);
  if (typeof container._onChange === 'function') container._onChange();
}

// 순환형 토글: 선택된 게 있으면 해제 모드, 아무것도 없으면 전체 선택 모드
function toggleAllCheckboxes(container) {
  const selected = countSelectedTotal(container);
  if (selected > 0) {
    clearAllCheckboxes(container);
  } else {
    selectAllCheckboxes(container);
  }
}

function updateToggleAllBtn(container) {
  const btn = container.querySelector('[data-action="toggle-all"]');
  if (!btn) return;
  const selected = countSelectedTotal(container);
  btn.textContent = selected > 0 ? '전체 해제' : '전체 선택';
}

function selKey(book, unit, num) { return `${book}||${unit}||${num}`; }

// 선택된 지문 리스트 반환
function getRangeSelection(container) {
  if (!container || typeof BOOKS === 'undefined') return [];
  if (!container._selectionMap) return [];
  const out = [];
  // 교재 → 단원 → 지문 순서로 정렬
  const books = Object.keys(BOOKS);
  for (const book of books) {
    const bookDB = BOOKS[book] || {};
    const units = sortUnitKeys(Object.keys(bookDB));
    for (const unit of units) {
      const bookUnit = bookDB[unit] || {};
      const nums = sortNumKeys(Object.keys(bookUnit));
      for (const num of nums) {
        if (container._selectionMap[selKey(book, unit, num)]) {
          const passage = bookUnit[num];
          if (passage != null) out.push({ book, unit, num, passage });
        }
      }
    }
  }
  return out;
}

function getRangeSelectionCount(container) {
  return container && typeof container._selectedTotal === 'number' ? container._selectedTotal : 0;
}

// ── Helpers ──
function sortUnitKeys(keys) {
  return keys.slice().sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}
function sortNumKeys(keys) {
  return keys.slice().sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
function cssEscape(s) {
  // CSS selector-safe escaping (제한적)
  return String(s == null ? '' : s).replace(/["\\]/g, '\\$&');
}
