// ── Workbook Generation Engine ──
// 범위 선택(지문/단원/교재) + 유형 선택 → AI 병렬 호출 → 유형별/단원별 PDF 다운로드
// 기존 js/batch.js 패턴을 따름. analyses 캐시를 컨텍스트로 활용하고,
// 생성 결과는 Firestore `workbooks` 컬렉션에 캐시 저장.
//
// 다중 작업 지원: 여러 워크북을 동시에 생성 가능. 각 job 이 독립된 state 보유.

let workbookJobManager = null;

// ── 워크북 유형 정의 ──
const WB_TYPE_LIST = [
  { key: 'blank',    label: '빈칸 채우기',        hasOpts: 'diff' },
  { key: 'choice',   label: '선택형 (어법·어휘)', hasOpts: 'choice' },
  { key: 'match_en', label: '내용일치 (영문)',    hasOpts: null },
  { key: 'match_ko', label: '내용일치 (국문)',    hasOpts: null },
  { key: 'order',    label: '순서 배열',          hasOpts: null },
  { key: 'insert',   label: '문장 삽입',          hasOpts: null }
];

// ── Firestore 데이터 전처리: undefined 재귀 제거 ──
function stripUndefinedWb(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(stripUndefinedWb);
  if (typeof v === 'object') {
    const out = {};
    for (const k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        const val = v[k];
        if (val === undefined) continue;
        out[k] = stripUndefinedWb(val);
      }
    }
    return out;
  }
  return v;
}

// 일괄 다운로드 헬퍼 — 브라우저의 연속 다운로드 차단을 피하기 위해
// setTimeout 간격으로 blob + <a download> click 을 순차 트리거.
function triggerDownloadAll(files, getBlob, getName) {
  if (!Array.isArray(files) || !files.length) return;
  files.forEach((f, i) => {
    setTimeout(() => {
      try {
        const blob = getBlob(f);
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = getName(f);
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) {
        console.warn('[workbook] bulk download item failed', e);
      }
    }, i * 450);
  });
}

function initWorkbook() {
  const tree = document.getElementById('wbRangeTree');
  if (!tree || typeof BOOKS === 'undefined') return;

  // JobManager 초기화
  if (!workbookJobManager && typeof JobManager !== 'undefined') {
    workbookJobManager = new JobManager({
      featureKey: 'workbook',
      switcherId: 'wbJobSwitcher',
      progressBodyId: 'wbProgressBody',
      downloadCardId: 'wbDownloadsCard',
      downloadAreaId: 'wbDownloadArea',
      cancelBtnId: 'wbCancelBtn',
      emptyStateId: 'wbEmptyState',
      labelFn: (job) => {
        const books = job.items && job.items.length ? [...new Set(job.items.map(it => it.book))] : [];
        const title = books.length === 1 ? books[0] : (books.length > 1 ? `${books.length}개 교재` : '워크북');
        const progress = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
        const status = job.phase === 'cancelled' ? '중단' :
                       job.phase === 'done' ? '완료' :
                       `${progress}%`;
        return `${title} (${status})`;
      },
      renderFn: (job, body) => {
        updateWbUI(job);
      },
      onRemove: (job) => { /* cleanup */ }
    });
    if (typeof window !== 'undefined') {
      window._jobManagers = window._jobManagers || {};
      window._jobManagers.workbook = workbookJobManager;
    }
    workbookJobManager.renderSelected();
  }

  initRangeTree(tree, updateWbRangeSummary);
  updateWbRangeSummary();

  renderWbTypeDropdown();
  bindWbTypeDropdown();

  // Provider/Model selectors
  if (typeof AI_MODELS !== 'undefined') {
    const provSel = document.getElementById('wbProvider');
    const modelSel = document.getElementById('wbModel');
    if (provSel && modelSel) {
      const provLabels = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI' };
      const providers = [...new Set(AI_MODELS.map(m => m.provider))];
      provSel.innerHTML = '';
      providers.forEach(p => {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = provLabels[p] || p;
        provSel.appendChild(o);
      });
      provSel.addEventListener('change', updateWbModelOptions);
      updateWbModelOptions();
    }
  }
}

function updateWbModelOptions() {
  const provider = document.getElementById('wbProvider').value;
  const modelSel = document.getElementById('wbModel');
  if (!modelSel) return;
  modelSel.innerHTML = '';
  AI_MODELS.filter(m => m.provider === provider).forEach(m => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  });
}

function updateWbRangeSummary() {
  const el = document.getElementById('wbRangeSummary');
  const tree = document.getElementById('wbRangeTree');
  if (!el || !tree) return;
  const count = getRangeSelectionCount(tree);
  el.textContent = `선택된 지문: ${count}개`;
}

// ── 워크북 유형 드롭다운 렌더/바인딩 ──
function renderWbTypeDropdown() {
  const panel = document.querySelector('#wbTypeDropdown .multi-dropdown-panel');
  if (!panel) return;
  // "전체 선택" + divider 보존, 나머지 항목 재렌더
  const selectAll = panel.querySelector('.multi-dropdown-select-all');
  const divider = panel.querySelector('.multi-dropdown-divider');
  panel.innerHTML = '';
  if (selectAll) panel.appendChild(selectAll);
  if (divider) panel.appendChild(divider);
  WB_TYPE_LIST.forEach(t => {
    const lbl = document.createElement('label');
    lbl.className = 'multi-dropdown-item';
    lbl.innerHTML = `<input type="checkbox" data-wb-type="${t.key}"><span>${escapeHtmlWb(t.label)}</span>`;
    panel.appendChild(lbl);
  });
  const dd = document.getElementById('wbTypeDropdown');
  if (dd) dd.classList.remove('open');
  updateWbTypeDropdownLabel();
  renderWbTypeSubOptions();
}

function updateWbTypeDropdownLabel() {
  const labelEl = document.querySelector('#wbTypeDropdown .multi-dropdown-label');
  if (!labelEl) return;
  const selected = Array.from(document.querySelectorAll('#wbTypeDropdown input[data-wb-type]:checked'))
    .map(cb => {
      const key = cb.dataset.wbType;
      const t = WB_TYPE_LIST.find(x => x.key === key);
      return t ? t.label : key;
    });
  if (selected.length === 0) {
    labelEl.textContent = '선택하세요';
    labelEl.classList.add('placeholder');
  } else if (selected.length <= 2) {
    labelEl.textContent = selected.join(', ');
    labelEl.classList.remove('placeholder');
  } else {
    labelEl.textContent = `${selected.slice(0, 2).join(', ')} 외 ${selected.length - 2}`;
    labelEl.classList.remove('placeholder');
  }
}

function renderWbTypeSubOptions() {
  const box = document.getElementById('wbTypeSubOptions');
  if (!box) return;
  const selected = Array.from(document.querySelectorAll('#wbTypeDropdown input[data-wb-type]:checked'))
    .map(cb => cb.dataset.wbType);
  // 이전 선택 상태 보존
  const prevDiffs = new Set(
    Array.from(box.querySelectorAll('input[data-wb-diff]:checked')).map(cb => cb.dataset.wbDiff)
  );
  const prevChoiceCount = (box.querySelector('input[name="wbChoiceCount"]:checked') || {}).value || '2';

  const blocks = [];
  if (selected.includes('blank')) {
    const diffs = prevDiffs.size > 0 ? prevDiffs : new Set(['high']);
    blocks.push(`
      <div class="wb-sub-block" data-type="blank">
        <div class="wb-sub-title">빈칸 채우기 · 난이도 (복수 선택)</div>
        <div class="diff-row">
          <label class="diff-chip"><input type="checkbox" data-wb-diff="high" ${diffs.has('high') ? 'checked' : ''}><span>상</span></label>
          <label class="diff-chip"><input type="checkbox" data-wb-diff="mid" ${diffs.has('mid') ? 'checked' : ''}><span>중</span></label>
          <label class="diff-chip"><input type="checkbox" data-wb-diff="low" ${diffs.has('low') ? 'checked' : ''}><span>하</span></label>
        </div>
      </div>
    `);
  }
  if (selected.includes('choice')) {
    blocks.push(`
      <div class="wb-sub-block" data-type="choice">
        <div class="wb-sub-title">선택형 · 선택지 개수</div>
        <div class="diff-row">
          <label class="diff-chip"><input type="radio" name="wbChoiceCount" value="2" ${prevChoiceCount === '2' ? 'checked' : ''}><span>2지선다</span></label>
          <label class="diff-chip"><input type="radio" name="wbChoiceCount" value="3" ${prevChoiceCount === '3' ? 'checked' : ''}><span>3지선다</span></label>
        </div>
      </div>
    `);
  }
  if (!blocks.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = '';
  box.innerHTML = blocks.join('');
}

function bindWbTypeDropdown() {
  const dd = document.getElementById('wbTypeDropdown');
  if (!dd || dd._bound) return;
  dd._bound = true;
  dd.classList.remove('open');

  const btn = dd.querySelector('.multi-dropdown-btn');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dd.classList.toggle('open');
    });
  }

  dd.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.type !== 'checkbox') return;
    if (t.dataset && t.dataset.role === 'select-all') {
      dd.querySelectorAll('input[data-wb-type]').forEach(cb => cb.checked = t.checked);
    } else if (t.dataset && t.dataset.wbType) {
      // 개별 변경 시 전체선택 상태 동기화
      const all = dd.querySelectorAll('input[data-wb-type]');
      const checked = dd.querySelectorAll('input[data-wb-type]:checked');
      const sa = dd.querySelector('input[data-role="select-all"]');
      if (sa) {
        sa.checked = all.length > 0 && checked.length === all.length;
        sa.indeterminate = checked.length > 0 && checked.length < all.length;
      }
    }
    updateWbTypeDropdownLabel();
    renderWbTypeSubOptions();
  });

  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target)) dd.classList.remove('open');
  });
}

// ── 선택된 워크북 유형 추출 ──
function getSelectedWbTypes() {
  const types = [];
  const dd = document.getElementById('wbTypeDropdown');
  if (!dd) return types;
  const selected = Array.from(dd.querySelectorAll('input[data-wb-type]:checked'))
    .map(cb => cb.dataset.wbType);

  selected.forEach(key => {
    if (key === 'blank') {
      const diffs = Array.from(document.querySelectorAll('#wbTypeSubOptions input[data-wb-diff]:checked'))
        .map(d => d.dataset.wbDiff);
      if (diffs.length === 0) {
        types.push({ key: 'blank', opts: { diff: 'mid' } });
      } else {
        diffs.forEach(diff => types.push({ key: 'blank', opts: { diff } }));
      }
    } else if (key === 'choice') {
      const cnt = (document.querySelector('#wbTypeSubOptions input[name="wbChoiceCount"]:checked') || {}).value || '2';
      types.push({ key: 'choice', opts: { count: parseInt(cnt, 10) } });
    } else {
      types.push({ key, opts: {} });
    }
  });
  return types;
}

function wbTypeKey(type) {
  if (type.key === 'blank') return `blank_${type.opts.diff}`;
  if (type.key === 'choice') return `choice_${type.opts.count}`;
  return type.key;
}

function wbTypeLabel(type) {
  const diffMap = { high: '상', mid: '중', low: '하' };
  if (type.key === 'blank') return `빈칸 채우기 (${diffMap[type.opts.diff] || ''})`;
  if (type.key === 'choice') return `선택형 ${type.opts.count}지선다`;
  return {
    match_en: '내용일치 (영문)',
    match_ko: '내용일치 (국문)',
    order: '순서 배열',
    insert: '문장 삽입'
  }[type.key] || type.key;
}

// ══════════════════════════════════════
// Firestore 캐시
// ══════════════════════════════════════

async function loadAnalysisCache(item) {
  try {
    const docId = `${item.book}__${item.unit}__${item.num}`;
    const snap = await db.collection('analyses').doc(docId).get();
    return snap.exists ? snap.data() : null;
  } catch (e) { return null; }
}

async function loadWorkbookCache(docId) {
  try {
    const snap = await db.collection('workbooks').doc(docId).get();
    return snap.exists ? snap.data() : null;
  } catch (e) { return null; }
}

async function saveWorkbookCache(item, passageResult) {
  try {
    const docId = `${item.book}__${item.unit}__${item.num}`;
    // undefined 필드 재귀 제거 (Firestore 는 undefined 를 거부)
    const safeResult = stripUndefinedWb(passageResult || {});
    const payload = Object.assign({}, safeResult, {
      book: item.book,
      unit: item.unit,
      number: item.num,
      savedAt: firebase.firestore.FieldValue.serverTimestamp(),
      savedBy: typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : null
    });
    await db.collection('workbooks').doc(docId).set(payload, { merge: true });
  } catch (e) {
    console.warn('[workbook] saveWorkbookCache:', e.code || '', e.message);
  }
}

// ══════════════════════════════════════
// 메인 실행
// ══════════════════════════════════════

function startWorkbookJob() {
  const tree = document.getElementById('wbRangeTree');
  const items = getRangeSelection(tree);
  const types = getSelectedWbTypes();

  if (!items.length) { alert('지문을 한 개 이상 선택해주세요.'); return; }
  if (!types.length) { alert('워크북 유형을 한 개 이상 선택해주세요.'); return; }

  const provider = document.getElementById('wbProvider').value;
  const model = document.getElementById('wbModel').value;
  const splitMode = document.getElementById('wbSplitMode').value;
  const answerSeparate = document.getElementById('wbAnswerSeparate').checked;
  const answerInline = !answerSeparate;   // 별도 PDF 미체크 시 자동 합본

  const job = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `wb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'workbook',
    items, types,
    provider, model, splitMode, answerSeparate, answerInline,
    current: 0,
    done: 0,
    failed: 0,
    total: items.length * types.length,
    abortController: new AbortController(),
    results: {},  // { docId: { typeKey: data } }
    phase: 'prepare',
    phaseStates: { prepare: 'active', generate: 'pending', buildPdf: 'pending', done: 'pending' },
    subLabel: '준비 중...',
    _startedAt: Date.now(),
    _downloadsHtml: '',
    _bindDownloads: null
  };

  if (workbookJobManager) workbookJobManager.addJob(job);
  if (typeof setPanelRunning === 'function') setPanelRunning('workbook', true);

  runWorkbookPipeline(job).finally(() => {
    if (typeof updateSidebarIndicators === 'function') updateSidebarIndicators();
  });
}

async function runWorkbookPipeline(job) {
  const { items, types } = job;
  job.phase = 'generate';
  job.phaseStates.prepare = 'done';
  job.phaseStates.generate = 'active';
  updateWbUI(job);

  // 지문별 순차 처리 (유형별 병렬)
  for (let i = 0; i < items.length; i++) {
    if (job.abortController.signal.aborted) break;
    job.current = i;
    updateWbUI(job);

    const item = items[i];
    const docId = `${item.book}__${item.unit}__${item.num}`;

    // 1) analyses 캐시 (컨텍스트)
    const analysis = await loadAnalysisCache(item);

    // 2) workbook 캐시
    const cached = await loadWorkbookCache(docId);
    const passageResult = {};
    if (cached) {
      Object.keys(cached).forEach(k => {
        if (!['book','unit','number','savedAt','savedBy'].includes(k)) {
          passageResult[k] = cached[k];
        }
      });
    }

    // 3) 각 유형별 호출 (병렬) — 캐시 있으면 스킵
    const typeTasks = types.map(async (type) => {
      const key = wbTypeKey(type);
      if (passageResult[key]) return { ok: true, type, key, data: passageResult[key], cached: true };
      // 3회 재시도
      for (let attempt = 0; attempt < 3; attempt++) {
        if (job.abortController.signal.aborted) return { ok: false, type, key, err: 'aborted' };
        try {
          const data = await runWorkbookType(job, item, type, analysis);
          return { ok: true, type, key, data, cached: false };
        } catch (e) {
          if (job.abortController.signal.aborted) return { ok: false, type, key, err: 'aborted' };
          console.warn(`[workbook] ${docId} ${key} retry ${attempt + 1}/3:`, e.message);
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, attempt === 0 ? 2000 : 5000));
          } else {
            return { ok: false, type, key, err: e.message };
          }
        }
      }
      return { ok: false, type, key, err: 'unknown' };
    });

    const settled = await Promise.all(typeTasks);
    let anyNew = false;
    settled.forEach(r => {
      if (r.ok) {
        passageResult[r.key] = r.data;
        job.done++;
        if (!r.cached) anyNew = true;
      } else {
        job.failed++;
      }
    });
    job.results[docId] = passageResult;

    // 4) 캐시 저장 (신규 생성분이 있을 때만)
    if (anyNew && !job.abortController.signal.aborted) {
      await saveWorkbookCache(item, passageResult);
    }

    updateWbUI(job);
  }

  await finishWorkbookJob(job);
}

async function runWorkbookType(job, item, type, analysis) {
  const sig = job.abortController.signal;
  const prompt = buildWorkbookPrompt(type, analysis);
  const { parsed } = await callAI(job.provider, job.model, item.passage, prompt, sig, null);
  return parsed;
}

function buildWorkbookPrompt(type, analysis) {
  const ctx = analysis ? `\n[참고 분석 컨텍스트]\n${JSON.stringify({
    meta: analysis.meta || null,
    grammar: analysis.grammar || null,
    vocab: analysis.vocab || null
  }, null, 1)}\n\n` : '';
  switch (type.key) {
    case 'blank':
      return ctx + WB_BLANK_PROMPT.replace(/DIFFICULTY_PLACEHOLDER/g, type.opts.diff);
    case 'choice':
      return ctx + WB_CHOICE_PROMPT.replace(/CHOICE_COUNT_PLACEHOLDER/g, String(type.opts.count));
    case 'match_en':
      return ctx + WB_MATCH_EN_PROMPT;
    case 'match_ko':
      return ctx + WB_MATCH_KO_PROMPT;
    case 'order':
      return ctx + WB_ORDER_PROMPT;
    case 'insert':
      return ctx + WB_INSERT_PROMPT;
  }
  return ctx;
}

// ══════════════════════════════════════
// 진행 상황 UI
// ══════════════════════════════════════

function updateWbUI(job) {
  if (!job) return;

  // 선택되지 않은 job 은 state 만 갱신, DOM 렌더 스킵
  if (workbookJobManager && workbookJobManager.selectedId !== job.id) {
    if (workbookJobManager) workbookJobManager._updateSwitcherLabels();
    return;
  }

  const body = document.getElementById('wbProgressBody');
  if (!body || typeof renderJobChecklist !== 'function') return;
  const done = job.done || 0;
  const failed = job.failed || 0;
  const total = job.total || 0;
  const current = job.current || 0;
  const items = job.items || [];
  const types = job.types || [];
  const results = job.results || {};
  const cur = current < items.length ? items[current] : null;

  // 세부 항목 (지문 × 유형 n개)
  const itemList = items.map((it, i) => {
    const docId = `${it.book}__${it.unit}__${it.num}`;
    const r = results[docId] || {};
    const typeCount = types.length;
    const doneTypes = types.filter(t => r[wbTypeKey(t)]).length;
    let status = 'pending';
    if (i < current) {
      status = doneTypes === typeCount ? 'done' : (doneTypes > 0 ? 'done' : 'failed');
    } else if (i === current) {
      status = 'running';
    } else if (i === items.length - 1 && doneTypes === typeCount) {
      status = 'done';
    }
    return { book: it.book, unit: it.unit, num: it.num, status };
  });

  let headTitle = '워크북 생성 중';
  if (job.phase === 'cancelled') headTitle = '워크북 — 중단됨';
  else if (job.phase === 'done') headTitle = '워크북 — 완료';
  else if (job.phase === 'failed') headTitle = '워크북 — 실패';

  renderJobChecklist(body, {
    headTitle,
    subLabel: job.subLabel || (cur ? `${cur.unit} · ${cur.num}번 생성 중...` : ''),
    stats: { total, done, failed },
    phases: [
      { id: 'prepare', label: '범위·유형 확정' },
      { id: 'generate', label: 'AI 문항 생성', desc: `${types.length}종 유형 · ${items.length}지문` },
      { id: 'buildPdf', label: 'PDF 빌드' },
      { id: 'done', label: '완료' }
    ],
    phaseStates: job.phaseStates || {},
    currentItem: cur ? { book: cur.book, unit: cur.unit, num: cur.num } : null,
    items: itemList
  });

  if (workbookJobManager) {
    const cancelBtn = document.getElementById('wbCancelBtn');
    if (cancelBtn) {
      cancelBtn.style.visibility = workbookJobManager.isJobRunning(job) ? 'visible' : 'hidden';
      cancelBtn.style.display = '';
    }
    workbookJobManager._updateSwitcherLabels();
  }
}

function cancelWorkbookJob(jobId) {
  if (!workbookJobManager) return;
  const targetId = jobId || workbookJobManager.selectedId;
  if (!targetId) return;
  const job = workbookJobManager.getJob(targetId);
  if (job && job.abortController) {
    job.abortController.abort();
  }
}

async function finishWorkbookJob(job) {
  if (!job) return;
  const aborted = job.abortController.signal.aborted;

  let title = '워크북';
  let summary = '';

  const { done, failed, total, types } = job;
  summary = `성공 ${done} · 실패 ${failed} · 총 ${total} · 유형 ${types.length}종`;
  job.phaseStates.generate = aborted ? 'failed' : 'done';
  job.subLabel = aborted ? '중단됨' : 'PDF 빌드 중...';
  if (!aborted) {
    job.phase = 'buildPdf';
    job.phaseStates.buildPdf = 'active';
  }
  job.current = job.items.length;
  updateWbUI(job);

  if (!aborted && job.done > 0) {
    try {
      const built = await buildWorkbookDownloads(job);
      if (built) {
        title = built.title || title;
      }
    } catch (e) {
      console.warn('[workbook] buildWorkbookDownloads failed:', e && e.message);
    }
  }

  if (!aborted) {
    job.phaseStates.buildPdf = 'done';
    job.phase = 'done';
    job.phaseStates.done = 'done';
    job.subLabel = `완료! ${summary}`;
  } else {
    job.phase = 'cancelled';
    job.subLabel = `중단됨 — ${summary}`;
  }
  updateWbUI(job);

  if (workbookJobManager) {
    workbookJobManager.notifyPhaseChanged(job.id);
  }

  if (typeof dashboardRegisterCompleted === 'function') {
    try {
      dashboardRegisterCompleted({
        kind: '워크북 생성',
        title,
        summary,
        status: aborted ? 'aborted' : 'done',
        downloads: []
      });
    } catch (e) { /* ignore */ }
  }
}

// ══════════════════════════════════════
// PDF 다운로드 조립
// ══════════════════════════════════════

async function buildWorkbookDownloads(job) {
  if (!job) return null;
  const { items, types, splitMode, answerSeparate, answerInline, results } = job;

  // 파일 묶음 결정
  // groups: [{ label, items, types }]  — 각 그룹이 한 PDF에 대응
  let groups = [];
  if (splitMode === 'single') {
    groups = [{ label: '전체', items, types }];
  } else if (splitMode === 'by-type') {
    groups = types.map(t => ({ label: wbTypeLabel(t), items, types: [t] }));
  } else if (splitMode === 'by-unit') {
    const unitKey = it => `${it.book}__${it.unit}`;
    const unitsOrdered = [];
    const unitMap = {};
    items.forEach(it => {
      const k = unitKey(it);
      if (!unitMap[k]) {
        unitMap[k] = { label: `${it.book} · ${it.unit}`, items: [], types };
        unitsOrdered.push(k);
      }
      unitMap[k].items.push(it);
    });
    groups = unitsOrdered.map(k => unitMap[k]);
  }

  // 각 그룹별 PDF 생성
  const generatedFiles = []; // { label, pdf, answerPdf? }
  for (const g of groups) {
    const mainSections = buildWbSections(g.items, g.types, results, { showAnswer: false });
    const answerSections = buildWbSections(g.items, g.types, results, { showAnswer: true });

    const books = [...new Set(g.items.map(it => it.book))];
    const unitsCnt = new Set(g.items.map(it => `${it.book}__${it.unit}`)).size;
    const subtitleParts = [];
    if (books.length === 1) subtitleParts.push(books[0]);
    else subtitleParts.push(`${books.length}개 교재`);
    subtitleParts.push(`${unitsCnt}개 단원`);
    subtitleParts.push(`${g.items.length}개 지문`);

    const title = `워크북 · ${g.label}`;
    const subtitle = subtitleParts.join('  ·  ');

    // 같은 PDF 뒷부분 옵션
    let answerKey = null;
    if (answerInline) answerKey = answerSections;

    const pdf = await buildPdfFromSections(mainSections, {
      title,
      subtitle,
      filename: safePdfFilename(`워크북_${g.label}`) + '.pdf',
      answerKey
    });

    let answerPdf = null;
    if (answerSeparate) {
      answerPdf = await buildPdfFromSections(answerSections, {
        title: `[해설] ${title}`,
        subtitle,
        filename: safePdfFilename(`워크북_${g.label}_해설`) + '.pdf'
      });
    }

    generatedFiles.push({ label: g.label, pdf, answerPdf });
  }

  // job 에 다운로드 HTML + 바인딩 저장 → JobManager 가 렌더 시 사용
  let html = '<div class="wb-download-section"><div class="wb-download-title">문제집 다운로드</div><div class="wb-download-row">';
  generatedFiles.forEach((f, i) => {
    html += `<button class="wb-download-btn" data-idx="${i}" data-kind="main">${escapeHtmlWb(f.label)} (문제지)</button>`;
  });
  if (generatedFiles.length > 1) {
    html += `<button class="wb-download-btn bundle" data-kind="main-all">모두 다운로드</button>`;
  }
  html += '</div>';

  if (answerSeparate) {
    html += '<div class="wb-download-title" style="margin-top:10px">해설지 다운로드</div><div class="wb-download-row">';
    generatedFiles.forEach((f, i) => {
      if (f.answerPdf) {
        html += `<button class="wb-download-btn answer" data-idx="${i}" data-kind="answer">${escapeHtmlWb(f.label)} (해설지)</button>`;
      }
    });
    if (generatedFiles.length > 1) {
      html += `<button class="wb-download-btn bundle" data-kind="answer-all">모두 다운로드</button>`;
    }
    html += '</div>';
  }
  html += '</div>';

  job._downloadsHtml = html;
  job._generatedFiles = generatedFiles;
  job._bindDownloads = (area) => {
    area.querySelectorAll('.wb-download-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        if (kind === 'main-all') {
          triggerDownloadAll(
            generatedFiles.filter(f => f.pdf),
            f => f.pdf.output('blob'),
            f => safePdfFilename(`워크북_${f.label}`) + '.pdf'
          );
        } else if (kind === 'answer-all') {
          triggerDownloadAll(
            generatedFiles.filter(f => f.answerPdf),
            f => f.answerPdf.output('blob'),
            f => safePdfFilename(`워크북_${f.label}_해설`) + '.pdf'
          );
        } else {
          const idx = parseInt(btn.dataset.idx, 10);
          const target = generatedFiles[idx];
          if (kind === 'main') target.pdf.save();
          else if (kind === 'answer' && target.answerPdf) target.answerPdf.save();
        }
      });
    });
  };

  const overallTitle = groups.length === 1 ? `워크북 · ${groups[0].label}` : `워크북 · ${groups.length}묶음`;
  return { title: overallTitle };
}

function buildWbSections(items, types, results, { showAnswer }) {
  const sections = [];
  items.forEach((it, passageIdx) => {
    const docId = `${it.book}__${it.unit}__${it.num}`;
    const r = results[docId] || {};
    const passageHeader = `
      <div style="margin:${passageIdx > 0 ? '24px' : '0'} 0 10px 0;padding:8px 14px;background:#1a1a1a;color:#fff;border-radius:6px;display:inline-block">
        <span style="font-size:12px;font-weight:700;letter-spacing:0.04em">${escapeHtmlWb(it.book)} · ${escapeHtmlWb(it.unit)} · ${escapeHtmlWb(it.num)}</span>
      </div>
    `;
    sections.push({ html: passageHeader, pageBreakBefore: passageIdx > 0 });

    // 원문 지문
    sections.push({ html: `
      <div style="margin-bottom:14px;padding:12px 14px;background:#fafafa;border:1px solid #eee;border-radius:8px">
        <div style="font-size:10px;color:#999;font-weight:700;margin-bottom:4px;letter-spacing:0.05em">PASSAGE</div>
        <div style="font-size:13px;line-height:1.7;color:#333;word-break:keep-all">${escapeHtmlWb(it.passage).replace(/\n/g,'<br>')}</div>
      </div>
    `});

    // 각 유형별 섹션
    types.forEach(type => {
      const key = wbTypeKey(type);
      const data = r[key];
      if (!data) return;
      const sectionHtml = renderWbTypeSection(type, data, { showAnswer });
      if (sectionHtml) sections.push({ html: sectionHtml });
    });
  });
  return sections;
}

function renderWbTypeSection(type, data, { showAnswer }) {
  const label = wbTypeLabel(type);
  const header = `
    <div style="margin:14px 0 8px 0;padding:6px 12px;background:#eef1fd;border-left:4px solid #4f6ef7;border-radius:3px">
      <span style="font-size:13px;font-weight:800;color:#4f6ef7">${escapeHtmlWb(label)}</span>
    </div>
  `;
  let body = '';
  try {
    if (type.key === 'blank') body = renderBlankBody(data, showAnswer);
    else if (type.key === 'choice') body = renderChoiceBody(data, showAnswer);
    else if (type.key === 'match_en' || type.key === 'match_ko') body = renderMatchBody(data, showAnswer);
    else if (type.key === 'order') body = renderOrderBody(data, showAnswer);
    else if (type.key === 'insert') body = renderInsertBody(data, showAnswer);
  } catch (e) {
    body = `<div style="font-size:12px;color:#e04a4a">렌더링 오류: ${escapeHtmlWb(e.message)}</div>`;
  }
  return header + body;
}

// ── 각 유형별 HTML 렌더러 ──

function renderBlankBody(data, showAnswer) {
  const items = (data && data.items) || [];
  let h = '<ol style="padding-left:20px;margin:0;font-size:13px;line-height:1.8;color:#222">';
  items.forEach((it, i) => {
    const text = showAnswer
      ? fillBlanks(it.withBlanks || it.original, it.answers || [])
      : (it.withBlanks || '');
    h += `<li style="margin-bottom:6px">${escapeHtmlWb(text).replace(/__\[(\d+)\]__/g, '<span style="display:inline-block;min-width:50px;border-bottom:1.5px solid #333;text-align:center;padding:0 4px;color:#999">($1)</span>')}`;
    if (showAnswer) {
      h += `<div style="font-size:11px;color:#2da05a;margin-top:2px">정답: ${escapeHtmlWb((it.answers || []).join(' / '))}</div>`;
      if (it.explanation) h += `<div style="font-size:11px;color:#666;margin-top:2px">해설: ${escapeHtmlWb(it.explanation)}</div>`;
    }
    h += '</li>';
  });
  h += '</ol>';
  return h;
}

function fillBlanks(textWithBlanks, answers) {
  return String(textWithBlanks || '').replace(/__\[(\d+)\]__/g, (_, n) => {
    const idx = parseInt(n, 10) - 1;
    return `[${answers[idx] || '?'}]`;
  });
}

function renderChoiceBody(data, showAnswer) {
  const items = (data && data.items) || [];
  let h = '<ol style="padding-left:20px;margin:0;font-size:13px;line-height:1.8;color:#222">';
  items.forEach(it => {
    h += `<li style="margin-bottom:8px">${escapeHtmlWb(it.displayText || it.original || '')}`;
    if (showAnswer) {
      const picks = (it.picks || []).map(p => `${p.options ? p.options.join(' / ') : ''} → <b>${p.answer}</b>`).join('<br>');
      h += `<div style="font-size:11px;color:#2da05a;margin-top:2px">정답: ${picks}</div>`;
      if (it.explanation) h += `<div style="font-size:11px;color:#666;margin-top:2px">해설: ${escapeHtmlWb(it.explanation)}</div>`;
    }
    h += '</li>';
  });
  h += '</ol>';
  return h;
}

function renderMatchBody(data, showAnswer) {
  const items = (data && data.items) || [];
  let h = '<ol style="padding-left:20px;margin:0;font-size:13px;line-height:1.8;color:#222">';
  items.forEach(it => {
    h += `<li style="margin-bottom:8px;display:flex;gap:8px;align-items:flex-start">`;
    h += `<span style="display:inline-block;min-width:40px;padding:1px 6px;border:1px solid #ccc;border-radius:3px;font-size:11px;text-align:center">T / F</span>`;
    h += `<span style="flex:1">${escapeHtmlWb(it.statement || '')}</span>`;
    h += `</li>`;
    if (showAnswer) {
      h += `<div style="margin-left:50px;font-size:11px;color:#2da05a">정답: <b>${it.answer || ''}</b></div>`;
      if (it.evidence) h += `<div style="margin-left:50px;font-size:11px;color:#666">근거: ${escapeHtmlWb(it.evidence)}</div>`;
      if (it.explanation) h += `<div style="margin-left:50px;font-size:11px;color:#666;margin-bottom:4px">해설: ${escapeHtmlWb(it.explanation)}</div>`;
    }
  });
  h += '</ol>';
  return h;
}

function renderOrderBody(data, showAnswer) {
  const versions = (data && data.versions) || [];
  let h = '';
  versions.forEach((v, i) => {
    h += `<div style="margin-bottom:12px;padding:10px 12px;background:#fafafa;border:1px solid #eee;border-radius:6px">`;
    h += `<div style="font-size:11px;font-weight:700;color:#4f6ef7;margin-bottom:6px">버전 ${i + 1}</div>`;
    h += `<div style="font-size:12px;line-height:1.7;color:#333">`;
    h += `<div style="margin-bottom:6px"><b>[도입]</b> ${escapeHtmlWb(v.lead || '')}</div>`;
    h += `<div style="margin-bottom:4px"><b>(A)</b> ${escapeHtmlWb(v.A || '')}</div>`;
    h += `<div style="margin-bottom:4px"><b>(B)</b> ${escapeHtmlWb(v.B || '')}</div>`;
    h += `<div style="margin-bottom:4px"><b>(C)</b> ${escapeHtmlWb(v.C || '')}</div>`;
    h += '</div>';
    if (showAnswer) {
      h += `<div style="margin-top:6px;font-size:11px;color:#2da05a">정답: <b>${escapeHtmlWb(v.answerOrder || '')}</b></div>`;
      if (v.explanation) h += `<div style="font-size:11px;color:#666">해설: ${escapeHtmlWb(v.explanation)}</div>`;
    }
    h += '</div>';
  });
  return h;
}

function renderInsertBody(data, showAnswer) {
  const items = (data && data.items) || [];
  let h = '';
  items.forEach((it, i) => {
    h += `<div style="margin-bottom:12px;padding:10px 12px;background:#fafafa;border:1px solid #eee;border-radius:6px">`;
    h += `<div style="font-size:12px;font-weight:700;color:#333;margin-bottom:6px">문항 ${i + 1}. 다음 문장이 들어갈 위치로 가장 적절한 곳은?</div>`;
    h += `<div style="font-size:12px;padding:6px 10px;background:#fff;border:1px dashed #bbb;border-radius:4px;margin-bottom:8px">${escapeHtmlWb(it.removedSentence || '')}</div>`;
    h += `<div style="font-size:12px;line-height:1.8;color:#333">${escapeHtmlWb(it.textWithMarks || '')}</div>`;
    if (showAnswer) {
      h += `<div style="margin-top:6px;font-size:11px;color:#2da05a">정답: <b>${escapeHtmlWb(it.answer || '')}</b></div>`;
      if (it.explanation) h += `<div style="font-size:11px;color:#666">해설: ${escapeHtmlWb(it.explanation)}</div>`;
    }
    h += '</div>';
  });
  return h;
}

function escapeHtmlWb(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
