// ── Variant Problem Generation Engine ──
// 범위 선택 + 유형/수량/난이도 → AI 변형문제 생성 → 누적 저장 → 시험지 PDF
// - Firestore `variants/{book__unit__num}` 컬렉션에 questions 배열을 append-only 로 저장
// - "이전에 출제한 문제 제외" 토글: 체크 시 풀 무시, 미체크 시 풀에서 먼저 채우고 부족분만 신규 생성
//
// ── 다중 작업 지원 ──
// variantJobManager 가 여러 job 을 동시 관리. 각 job 은 독립된 state/abortController/timer 보유.
// 모든 helper 함수는 job 을 첫 번째 인자로 받아 해당 job 의 상태만 조작함.

let variantJobManager = null;   // JobManager 인스턴스. initVariant() 에서 생성.

// ── Firestore 데이터 전처리: undefined 재귀 제거 ──
// AI 응답에 포함된 undefined 필드는 Firestore set/arrayUnion 을 거부시키므로 저장 전에 strip.
function stripUndefined(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (typeof v === 'object') {
    const out = {};
    for (const k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        const val = v[k];
        if (val === undefined) continue;
        out[k] = stripUndefined(val);
      }
    }
    return out;
  }
  return v;
}

// ── 라운드 9: 토큰 사용량 추적 + 비용 계산 ──
// 모델별 토큰 단가 (USD 1M tokens 기준, 대략치) → 원화 환산
// Gemini 3.1 Pro: ~$1.25 input / $10 output per 1M tokens
// Claude Opus: ~$15 / $75
// Claude Sonnet: ~$3 / $15
// GPT-5.4: ~$10 / $40
// 모델별 토큰 단가 (USD per 1M tokens)
// cachedInput: prompt 캐시 적중 시 할인가 (OpenAI 공식)
const TOKEN_PRICING = {
  'gemini-3.1-pro-preview': { input: 1.25, output: 10 },
  'gemini-3-flash-preview': { input: 0.075, output: 0.3 },
  'gemini-3.1-flash-image-preview': { input: 0.5, output: 3 },     // 나노바나나 2 (텍스트 토큰 부분)
  'gemini-3-pro-image-preview': { input: 2, output: 12 },          // 나노바나나 Pro (텍스트 토큰 부분)
  'gemini-2.5-flash-image': { input: 0.3, output: 2.5 },            // 나노바나나 1 (텍스트 토큰 부분)
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'gpt-5.4': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.4-pro': { input: 15, cachedInput: 1.5, output: 60 },
  'gpt-5.4-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5.4-nano': { input: 0.20, cachedInput: 0.02, output: 1.25 }
};

// 이미지 생성 모델: output 이미지당 USD 단가 (1024×1024 기준)
const IMAGE_PRICING = {
  'gemini-3.1-flash-image-preview': 0.0672,   // 나노바나나 2
  'gemini-3-pro-image-preview': 0.134,         // 나노바나나 Pro
  'gemini-2.5-flash-image': 0.039,             // 나노바나나 1
  'gpt-image-1': 0.04,                         // 구 OpenAI gpt-image-1 (medium)
  'gpt-image-1.5-low': 0.009,                  // GPT Image 1.5 Low
  'gpt-image-1.5-medium': 0.034,               // GPT Image 1.5 Medium
  'gpt-image-1.5-high': 0.133                  // GPT Image 1.5 High
};
function computeImageCostUsd(count, model) {
  if (!count || !model) return 0;
  const price = IMAGE_PRICING[model] || 0;
  return count * price;
}
let USD_TO_KRW = 1380;   // 기본값 (실시간 환율 로드 전 폴백)

// 실시간 환율 로드 (ExchangeRate-API, 키 불필요)
(async function loadExchangeRate() {
  try {
    const cached = sessionStorage.getItem('_usdKrwRate');
    const cachedAt = Number(sessionStorage.getItem('_usdKrwRateAt') || 0);
    if (cached && Date.now() - cachedAt < 3600_000) { USD_TO_KRW = Number(cached); return; }
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) return;
    const data = await res.json();
    if (data.rates && data.rates.KRW) {
      USD_TO_KRW = data.rates.KRW;
      sessionStorage.setItem('_usdKrwRate', String(USD_TO_KRW));
      sessionStorage.setItem('_usdKrwRateAt', String(Date.now()));
      console.log('[환율] USD/KRW =', USD_TO_KRW);
    }
  } catch (e) { /* 폴백 1380 유지 */ }
})();

// 대략 4 chars ≈ 1 token (한국어는 2~3 chars/token 이지만 영어 위주 지문이라 평균 4)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// callAI 를 감싸서 토큰 사용량을 해당 job 에 누적
// API 응답의 실제 usage 데이터 우선 사용, 없으면 추정치 폴백
async function callAITracked(job, provider, model, userMsg, systemPrompt, signal, option) {
  const estIn = estimateTokens(userMsg) + estimateTokens(systemPrompt);
  try {
    const { parsed, usage } = await callAI(provider, model, userMsg, systemPrompt, signal, option);
    const inTokens = (usage && usage.input_tokens) ? usage.input_tokens : estIn;
    const outTokens = (usage && usage.output_tokens) ? usage.output_tokens : estimateTokens(JSON.stringify(parsed || ''));
    const cachedTokens = (usage && usage.cached_tokens) ? usage.cached_tokens : 0;
    if (job) {
      job._tokens = job._tokens || { input: 0, output: 0, cached: 0, calls: 0 };
      job._tokens.input += inTokens;
      job._tokens.output += outTokens;
      job._tokens.cached = (job._tokens.cached || 0) + cachedTokens;
      job._tokens.calls = (job._tokens.calls || 0) + 1;
    }
    return parsed;
  } catch (e) {
    // 실패해도 입력 토큰은 카운트 (이미 전송됨)
    if (job) {
      job._tokens = job._tokens || { input: 0, output: 0, calls: 0 };
      job._tokens.input += estIn;
      job._tokens.calls = (job._tokens.calls || 0) + 1;
    }
    throw e;
  }
}

// tokens: { input, output, cached?, calls? } — cached 는 캐시 적중 토큰 (OpenAI)
function computeCostUsd(tokens, model) {
  if (!tokens || !tokens.input && !tokens.output) return 0;
  const pricing = TOKEN_PRICING[model] || TOKEN_PRICING['gemini-3.1-pro-preview'];
  const cached = Math.max(0, tokens.cached || 0);
  const uncachedInput = Math.max(0, (tokens.input || 0) - cached);
  const cachedRate = (typeof pricing.cachedInput === 'number') ? pricing.cachedInput : pricing.input;
  const inCost = (uncachedInput / 1_000_000) * pricing.input + (cached / 1_000_000) * cachedRate;
  const outCost = ((tokens.output || 0) / 1_000_000) * pricing.output;
  return inCost + outCost;
}

function computeCostKrw(tokens, model) {
  return computeCostUsd(tokens, model) * USD_TO_KRW;
}

// Firestore 에 월별 + 일별 사용량 누적 기록
async function recordUsageToFirestore(job) {
  if (typeof db === 'undefined' || !db) return;
  const tokens = job._tokens || { input: 0, output: 0, calls: 0 };
  if (!tokens.input && !tokens.output) return;

  const model = job.model || 'unknown';
  const costUsd = computeCostUsd(tokens, model);
  const calls = tokens.calls || 0;
  const qCount = (job.generated || []).length + (job.reusedFromCache || []).length;
  const inc = firebase.firestore.FieldValue.increment;

  const now = new Date();
  const monthId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dayId = `${monthId}-${String(now.getDate()).padStart(2, '0')}`;

  // 모델명에 점이 있으면 Firestore 가 평면 key 로 저장하므로 nested 객체 사용
  const byModelMonthly = { [model]: {
    input: inc(tokens.input),
    output: inc(tokens.output),
    costUsd: inc(costUsd),
    calls: inc(calls),
    questionCount: inc(qCount)
  }};
  const byModelDaily = { [model]: {
    costUsd: inc(costUsd),
    calls: inc(calls),
    questionCount: inc(qCount)
  }};

  try {
    // 월별 누적 (USD 기준, 원화 환산은 대시보드에서 실시간 환율 적용)
    await db.collection('usage_monthly').doc(monthId).set({
      totalInputTokens: inc(tokens.input),
      totalOutputTokens: inc(tokens.output),
      totalCostUsd: inc(costUsd),
      calls: inc(calls),
      questionCount: inc(qCount),
      byModel: byModelMonthly,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // 일별 누적 (USD 기준)
    await db.collection('usage_daily').doc(dayId).set({
      totalCostUsd: inc(costUsd),
      calls: inc(calls),
      questionCount: inc(qCount),
      totalInputTokens: inc(tokens.input),
      totalOutputTokens: inc(tokens.output),
      byModel: byModelDaily,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('[variant] usage recording failed:', e.message);
  }
}

// ── 라운드 9: Phase 가중치 기반 전체 진행도 ──
// 각 phase 의 상대 비중 — 총합이 100 이 되도록
const PHASE_WEIGHTS = {
  prepare: 2,
  scorePassages: 10,
  loadPrev: 3,
  variatePassages: 15,
  generate: 40,
  reviewQuality: 23,   // 품질 검토 + 재출제 통합 (기존 15 + 8)
  finalReview: 2,
  buildPdf: 5,
  done: 0
};

function computeOverallPct(job) {
  if (!job) return 0;
  const states = job.phaseStates || {};
  const progressByPhase = job._phaseProgress || {};
  let total = 0;
  let done = 0;
  Object.entries(PHASE_WEIGHTS).forEach(([id, w]) => {
    const st = states[id];
    if (st == null) return;   // phase 미사용 (옵션 phase)
    total += w;
    if (st === 'done') done += w;
    else if (st === 'active') done += w * (progressByPhase[id] || 0);
  });
  if (total === 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

// Phase 별 detail items push helper
// item.id 가 있으면 동일 id 항목이 있을 때 덮어쓰기 (중복 push 방지 + 병렬 워커 running→done 전환)
function pushPhaseDetail(job, phaseId, item) {
  if (!job) return;
  job._phaseDetails = job._phaseDetails || {};
  const arr = job._phaseDetails[phaseId] || [];
  if (item && item.id) {
    const existing = arr.findIndex(x => x && x.id === item.id);
    if (existing !== -1) {
      arr[existing] = Object.assign({}, arr[existing], item);
      job._phaseDetails[phaseId] = arr;
      return;
    }
  }
  arr.push(item);
  // 최대 300 개로 제한 (성능)
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  job._phaseDetails[phaseId] = arr;
}

// 특정 id 항목을 찾아 업데이트 (주로 running → done/failed 전환)
function updatePhaseDetail(job, phaseId, id, updates) {
  if (!job || !id) return;
  job._phaseDetails = job._phaseDetails || {};
  const arr = job._phaseDetails[phaseId] || [];
  const idx = arr.findIndex(x => x && x.id === id);
  if (idx !== -1) {
    arr[idx] = Object.assign({}, arr[idx], updates);
  } else {
    arr.push(Object.assign({ id }, updates));
  }
  job._phaseDetails[phaseId] = arr;
}

// Phase 종료 시 running 으로 남은 detail 을 정리 (병렬 워커 안전망)
function finalizePhaseDetails(job, phaseId, fallbackStatus = 'done') {
  if (!job) return;
  const details = job._phaseDetails || {};
  const arr = details[phaseId] || [];
  let changed = 0;
  for (const it of arr) {
    if (it && it.status === 'running') {
      it.status = fallbackStatus;
      if (fallbackStatus === 'done' && !it.desc) it.desc = '완료';
      changed++;
    }
  }
  if (changed) {
    details[phaseId] = arr;
    job._phaseDetails = details;
  }
}

function setPhaseProgress(job, phaseId, ratio) {
  if (!job) return;
  job._phaseProgress = job._phaseProgress || {};
  job._phaseProgress[phaseId] = Math.max(0, Math.min(1, ratio));
}

const VARIANT_TYPE_LIST = [
  '내용유추',
  '내용일치/불일치',
  '밑줄함의/지칭추론',
  '분위기/어조/심경',
  '순서',
  '연결어',
  '문장삽입',
  '삭제',
  '빈칸추론',
  '어법',
  '어휘/영영풀이',
  '제목/주제/목적/요약/주장',
  '영작(서술형)'
];

function initVariant() {
  const tree = document.getElementById('varRangeTree');
  if (!tree || typeof BOOKS === 'undefined') return;

  // JobManager 초기화 (전역 window._jobManagers 에 등록)
  if (!variantJobManager && typeof JobManager !== 'undefined') {
    variantJobManager = new JobManager({
      featureKey: 'variant',
      switcherId: 'varJobSwitcher',
      progressBodyId: 'varProgressBody',
      downloadCardId: 'varDownloadsCard',
      downloadAreaId: 'varDownloadArea',
      cancelBtnId: 'varCancelBtn',
      emptyStateId: 'varEmptyState',
      labelFn: (job) => {
        const title = job.paperTitle || job.studentName || '변형문제';
        const progress = computeOverallPct(job);
        const status = job._cancelled || job.phase === 'cancelled' ? '중단' :
                       job.phase === 'done' ? '완료' :
                       `${progress}%`;
        return `${title} (${status})`;
      },
      renderFn: (job, body) => {
        updateVarUI(job);
      },
      onRemove: (job) => {
        if (job._timerInterval) {
          clearInterval(job._timerInterval);
          job._timerInterval = null;
        }
      }
    });
    if (typeof window !== 'undefined') {
      window._jobManagers = window._jobManagers || {};
      window._jobManagers.variant = variantJobManager;
    }
    // 초기 empty state 표시
    variantJobManager.renderSelected();
  }

  initRangeTree(tree, updateVarRangeSummary);
  updateVarRangeSummary();

  renderVariantTypeDropdown();
  bindVariantTypeDropdown();

  // Provider / Model
  if (typeof AI_MODELS !== 'undefined') {
    const provSel = document.getElementById('varProvider');
    const modelSel = document.getElementById('varModel');
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
      provSel.addEventListener('change', updateVarModelOptions);
      updateVarModelOptions();
    }
  }

  // 초기 호출: 총문항/객관식/주관식 검증 상태 표시
  onVariantCountsChange();
}

function updateVarModelOptions() {
  const provider = document.getElementById('varProvider').value;
  const modelSel = document.getElementById('varModel');
  if (!modelSel) return;
  modelSel.innerHTML = '';
  AI_MODELS.filter(m => m.provider === provider).forEach(m => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  });
}

function updateVarRangeSummary() {
  const el = document.getElementById('varRangeSummary');
  const tree = document.getElementById('varRangeTree');
  if (!el || !tree) return;
  const count = getRangeSelectionCount(tree);
  el.textContent = `선택된 지문: ${count}개`;
}

function renderVariantTypeDropdown() {
  const panel = document.querySelector('#varTypeDropdown .multi-dropdown-panel');
  if (!panel) return;
  // 상단 "전체 선택" + divider 보존, 나머지 항목 재렌더
  const selectAll = panel.querySelector('.multi-dropdown-select-all');
  const divider = panel.querySelector('.multi-dropdown-divider');
  panel.innerHTML = '';
  if (selectAll) panel.appendChild(selectAll);
  if (divider) panel.appendChild(divider);
  VARIANT_TYPE_LIST.forEach(t => {
    const lbl = document.createElement('label');
    lbl.className = 'multi-dropdown-item';
    lbl.innerHTML = `<input type="checkbox" value="${escapeHtmlVar(t)}"><span>${escapeHtmlVar(t)}</span>`;
    panel.appendChild(lbl);
  });
  // 기본 닫힘 명시
  const dd = document.getElementById('varTypeDropdown');
  if (dd) dd.classList.remove('open');
  updateVariantTypeDropdownLabel();
}

function updateVariantTypeDropdownLabel() {
  const labelEl = document.querySelector('#varTypeDropdown .multi-dropdown-label');
  if (!labelEl) return;
  const selected = getSelectedVariantTypes();
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

function bindVariantTypeDropdown() {
  const dd = document.getElementById('varTypeDropdown');
  if (!dd || dd._bound) return;
  dd._bound = true;
  dd.classList.remove('open');   // 초기 상태 명시
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
      dd.querySelectorAll('input[type=checkbox]:not([data-role="select-all"])').forEach(cb => {
        cb.checked = t.checked;
      });
    } else {
      // 개별 체크 변경 시 전체선택 상태 동기화
      const all = dd.querySelectorAll('input[type=checkbox]:not([data-role="select-all"])');
      const checked = dd.querySelectorAll('input[type=checkbox]:checked:not([data-role="select-all"])');
      const sa = dd.querySelector('input[data-role="select-all"]');
      if (sa) {
        sa.checked = all.length > 0 && checked.length === all.length;
        sa.indeterminate = checked.length > 0 && checked.length < all.length;
      }
    }
    updateVariantTypeDropdownLabel();
  });
  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target)) dd.classList.remove('open');
  });
}

function getSelectedVariantTypes() {
  const out = [];
  document.querySelectorAll('#varTypeDropdown input[type=checkbox]:checked').forEach(cb => {
    if (cb.dataset && cb.dataset.role === 'select-all') return;
    out.push(cb.value);
  });
  return out;
}

// oninput 핸들러 — 객관식/주관식 입력 검증 (총 문항 수는 자동 = obj + sub)
function onVariantCountsChange() {
  const objEl = document.getElementById('varObj');
  const subEl = document.getElementById('varSub');
  if (!objEl || !subEl) return;

  const obj = parseInt(objEl.value || '0', 10);
  const sub = parseInt(subEl.value || '0', 10);

  const startBtn = document.getElementById('varStartBtn');
  if (startBtn) {
    if (obj + sub <= 0) {
      startBtn.style.opacity = '0.55';
      startBtn.title = '객관식 + 주관식 개수를 1개 이상 입력하세요.';
    } else {
      startBtn.style.opacity = '';
      startBtn.title = '';
    }
  }
}

// ══════════════════════════════════════
// Firestore 캐시 / 풀
// ══════════════════════════════════════

async function loadVariantPool(items) {
  // items: [{book, unit, num, passage}, ...]
  // 각 문서에서 questions 배열을 읽어 평탄화 (원본 지문도 함께 붙여줌)
  const pool = [];
  for (const it of items) {
    try {
      const docId = `${it.book}__${it.unit}__${it.num}`;
      const snap = await db.collection('variants').doc(docId).get();
      if (snap.exists) {
        const data = snap.data();
        const qs = Array.isArray(data.questions) ? data.questions : [];
        qs.forEach(q => {
          pool.push(Object.assign({}, q, {
            book: it.book,
            unit: it.unit,
            num: it.num,
            _passage: it.passage
          }));
        });
      }
    } catch (e) {
      console.warn('[variant] loadVariantPool:', e.message);
    }
  }
  return pool;
}

async function saveVariantQuestions(item, newQuestions) {
  try {
    const docId = `${item.book}__${item.unit}__${item.num}`;
    const ref = db.collection('variants').doc(docId);
    // undefined 필드 재귀 제거 (Firestore 는 undefined 를 거부)
    const safeQs = (newQuestions || []).map(stripUndefined);
    const snap = await ref.get();
    const base = {
      book: item.book,
      unit: item.unit,
      number: item.num,
      savedAt: firebase.firestore.FieldValue.serverTimestamp(),
      savedBy: typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : null
    };
    if (!snap.exists) {
      await ref.set(Object.assign({}, base, { questions: safeQs }));
    } else {
      await ref.update({
        questions: firebase.firestore.FieldValue.arrayUnion(...safeQs),
        savedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    return true;
  } catch (e) {
    console.warn('[variant] saveVariantQuestions:', e.code || '', e.message);
    // 저장 실패는 개별 job 에 누적 불가 — 현재 실행 중인 모든 job 에 부분적으로 실패 카운트 반영
    if (variantJobManager) {
      for (const j of variantJobManager.listJobs()) {
        if (variantJobManager.isJobRunning(j)) {
          j._saveFailed = (j._saveFailed || 0) + (newQuestions ? newQuestions.length : 0);
        }
      }
    }
    return false;
  }
}

// 단일 문항 즉시 저장 래퍼 (병렬 환경에서 문항 단위 저장용)
async function saveVariantQuestion(item, oneQuestion) {
  return saveVariantQuestions(item, [oneQuestion]);
}

// Concurrency-limited 병렬 실행 헬퍼 (job 별 abort signal 지원)
async function runWithConcurrency(job, tasks, limit, worker) {
  let i = 0;
  const next = async () => {
    while (true) {
      if (job && job.abortController && job.abortController.signal.aborted) return;
      const idx = i++;
      if (idx >= tasks.length) return;
      try { await worker(tasks[idx], idx); }
      catch (e) {
        if (e && e.message === 'aborted') return;
        console.warn('[variant] worker failed:', e && e.message);
      }
    }
  };
  const runners = Math.min(Math.max(1, limit), tasks.length || 1);
  await Promise.all(Array.from({ length: runners }, next));
}

// ── 전면 병렬화 (OpenAI Tier 3 = 5000 RPM 기준) ──
// 동시 실행되는 phase 는 없음 (phase 간 await 직렬), 각 phase 내부에서만 병렬화.
const VARIANT_AI_CONCURRENCY = 50;        // Phase 5: 문제 생성
const VARIANT_SCORE_CONCURRENCY = 50;     // Phase 1: 지문 점수화
const VARIANT_VARIATE_CONCURRENCY = 30;   // Phase 4: 지문 변형 (긴 응답)
const VARIANT_REVIEW_CONCURRENCY = 40;    // Phase 6: 품질 검토
const VARIANT_REGEN_CONCURRENCY = 30;     // Phase 7: 재출제

// ══════════════════════════════════════
// 유틸: 유형별 수량 분배 / 지문 선택 / 풀 픽
// ══════════════════════════════════════

// 유형별 가중치 — 수능·내신 중요도 반영
// 핵심 3종 (순서/빈칸/어법) 은 합 ≥50%, 2순위 (제목/주제 등) 충분히, 내용유추+일치 ≤10% 캡
const TYPE_PRIORITY_WEIGHTS = {
  '순서': 12,
  '연결어': 8,
  '문장삽입': 10,
  '삭제': 8,
  '빈칸추론': 18,
  '어법': 18,
  '제목/주제/목적/요약/주장': 16,
  '밑줄함의/지칭추론': 6,
  '분위기/어조/심경': 4,
  '어휘/영영풀이': 5,
  '내용유추': 5,            // 내용유추+내용일치 합계 10% 캡
  '내용일치/불일치': 5,     // 내용유추+내용일치 합계 10% 캡
  '영작(서술형)': 0         // 주관식 전용 (obj 배분 제외)
};

const LOW_PRIORITY_TYPES = new Set(['내용유추', '내용일치/불일치']);
const CORE_TYPES = new Set(['순서', '연결어', '문장삽입', '삭제', '빈칸추론', '어법']);

function distributeQuota(totalObj, totalSub, typesSel) {
  const quota = {};
  typesSel.forEach(t => { quota[t] = { obj: 0, sub: 0 }; });
  if (!typesSel.length) return quota;

  // ── 주관식 배정 ──
  // '영작(서술형)' 이 선택되면 주관식 전량 배정, 아니면 우선순위대로 배정
  const subjectiveFirst = typesSel.includes('영작(서술형)') ? '영작(서술형)' : null;
  let remainSub = totalSub;
  if (subjectiveFirst) {
    quota[subjectiveFirst].sub = totalSub;
    remainSub = 0;
  } else if (remainSub > 0) {
    // 가중치 기반으로 균등 분배
    const weightedTypes = typesSel.slice().sort((a, b) => (TYPE_PRIORITY_WEIGHTS[b] || 1) - (TYPE_PRIORITY_WEIGHTS[a] || 1));
    for (let i = 0; i < remainSub; i++) {
      quota[weightedTypes[i % weightedTypes.length]].sub += 1;
    }
  }

  // ── 객관식 배정 (가중치 + 캡 + 핵심 최소보장) ──
  const objTypes = typesSel.filter(t => t !== '영작(서술형)');
  if (!objTypes.length || totalObj === 0) return quota;

  // 1) 가중치 비율로 초기 배정
  const weights = objTypes.map(t => TYPE_PRIORITY_WEIGHTS[t] || 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const raw = objTypes.map((t, i) => (weights[i] / totalWeight) * totalObj);

  // 2) 바닥 정수화 + 잔여 재분배
  const alloc = raw.map(r => Math.floor(r));
  let assigned = alloc.reduce((a, b) => a + b, 0);
  const residuals = raw.map((r, i) => ({ i, frac: r - Math.floor(r), type: objTypes[i] }));
  residuals.sort((a, b) => b.frac - a.frac);
  let idx = 0;
  while (assigned < totalObj && idx < residuals.length) {
    alloc[residuals[idx].i] += 1;
    assigned++;
    idx++;
  }
  // 여전히 부족하면 핵심 유형에 추가
  while (assigned < totalObj) {
    const coreIdx = objTypes.findIndex(t => CORE_TYPES.has(t));
    const target = coreIdx !== -1 ? coreIdx : 0;
    alloc[target] += 1;
    assigned++;
  }

  // 3) 저우선 유형 캡 적용 (내용유추+내용일치 ≤ 10%)
  const lowCap = Math.max(0, Math.floor(totalObj * 0.10));
  let lowTotal = 0;
  objTypes.forEach((t, i) => { if (LOW_PRIORITY_TYPES.has(t)) lowTotal += alloc[i]; });
  if (lowTotal > lowCap) {
    // 초과분을 핵심 유형으로 이동
    let excess = lowTotal - lowCap;
    objTypes.forEach((t, i) => {
      if (excess <= 0) return;
      if (LOW_PRIORITY_TYPES.has(t) && alloc[i] > 0) {
        const take = Math.min(alloc[i], excess);
        alloc[i] -= take;
        excess -= take;
      }
    });
    // 초과분을 가중치 큰 유형부터 재분배 (핵심 먼저)
    let toRedistribute = lowTotal - lowCap;
    const targetOrder = objTypes
      .map((t, i) => ({ t, i, w: TYPE_PRIORITY_WEIGHTS[t] || 1, core: CORE_TYPES.has(t) }))
      .filter(x => !LOW_PRIORITY_TYPES.has(x.t))
      .sort((a, b) => (b.core - a.core) || (b.w - a.w));
    let roundIdx = 0;
    while (toRedistribute > 0 && targetOrder.length) {
      alloc[targetOrder[roundIdx % targetOrder.length].i] += 1;
      toRedistribute--;
      roundIdx++;
    }
  }

  // 4) 핵심 유형 합 ≥ 50% 보장 (저우선 캡 적용 후)
  const coreMin = Math.ceil(totalObj * 0.50);
  let coreTotal = 0;
  objTypes.forEach((t, i) => { if (CORE_TYPES.has(t)) coreTotal += alloc[i]; });
  if (coreTotal < coreMin) {
    let need = coreMin - coreTotal;
    // 비핵심·비저우선 유형에서 빼서 핵심에 추가
    const nonCoreTypes = objTypes
      .map((t, i) => ({ t, i, w: TYPE_PRIORITY_WEIGHTS[t] || 1 }))
      .filter(x => !CORE_TYPES.has(x.t) && !LOW_PRIORITY_TYPES.has(x.t))
      .sort((a, b) => a.w - b.w);   // 가중치 낮은 순으로 빼오기
    const coreIndices = objTypes
      .map((t, i) => ({ t, i, w: TYPE_PRIORITY_WEIGHTS[t] || 1 }))
      .filter(x => CORE_TYPES.has(x.t))
      .sort((a, b) => b.w - a.w);   // 가중치 높은 순으로 주기

    if (coreIndices.length) {
      let srcIdx = 0;
      while (need > 0 && nonCoreTypes.length) {
        const src = nonCoreTypes[srcIdx % nonCoreTypes.length];
        if (alloc[src.i] > 0) {
          alloc[src.i] -= 1;
          alloc[coreIndices[0].i] += 1;
          need--;
        }
        srcIdx++;
        if (srcIdx > nonCoreTypes.length * 10) break;   // safety
      }
    }
  }

  // 5) 최종 quota 반영
  objTypes.forEach((t, i) => { quota[t].obj = alloc[i]; });

  return quota;
}

function pickFromPool(poolList, needObj, needSub) {
  // poolList: [{ format:'obj'|'sub', ...}]
  // 랜덤 셔플 후 need 개수만큼 꺼냄
  const objs = poolList.filter(q => q.format === 'obj');
  const subs = poolList.filter(q => q.format === 'sub');
  shuffleInPlace(objs);
  shuffleInPlace(subs);
  const pickedObjs = objs.slice(0, needObj);
  const pickedSubs = subs.slice(0, needSub);
  return {
    items: [...pickedObjs, ...pickedSubs],
    objCount: pickedObjs.length,
    subCount: pickedSubs.length
  };
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickPassagesForType(items, count) {
  // (deprecated, Round 8 에서는 selectPassagesForJob + assignTypesToPassages 사용)
  // 하위 호환을 위해 남김
  if (!items.length || count <= 0) return [];
  const out = [];
  if (count <= items.length) {
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      let idx = Math.floor(i * items.length / count);
      while (seen.has(idx) && idx < items.length - 1) idx++;
      if (seen.has(idx)) {
        idx = 0;
        while (seen.has(idx) && idx < items.length) idx++;
      }
      if (idx >= items.length) break;
      seen.add(idx);
      out.push(items[idx]);
    }
  } else {
    for (let i = 0; i < count; i++) out.push(items[i % items.length]);
  }
  return shuffleInPlace(out);
}

// ══════════════════════════════════════
// 라운드 8: 지문 점수화 + 선별 (핵심)
// ══════════════════════════════════════

function keyOf(item) {
  return `${item.book}__${item.unit}__${item.num}`;
}

function defaultPassageMeta(item) {
  return {
    book: item.book, unit: item.unit, number: item.num,
    importance: 5, difficulty: 5,
    typeSuitability: {
      '내용유추': 5, '내용일치/불일치': 5, '밑줄함의/지칭추론': 5,
      '분위기/어조/심경': 5, '순서': 5, '연결어': 5, '문장삽입': 5, '삭제': 5,
      '빈칸추론': 5, '어법': 5, '어휘/영영풀이': 5,
      '제목/주제/목적/요약/주장': 5, '영작(서술형)': 5
    },
    reasons: [], sampleCount: 0
  };
}

function diffLabel(d) {
  return { low: '하', mid: '중', high: '상 (수능 최고난도)' }[d] || '중';
}

function diffBand(difficulty) {
  // 0~10 점수를 5 단계 밴드로
  if (difficulty <= 3) return 'low';
  if (difficulty <= 5) return 'midLow';
  if (difficulty <= 6.5) return 'mid';
  if (difficulty <= 8) return 'midHigh';
  return 'high';
}

function rankPassagesByScore(items, meta) {
  // 중요도 * 0.6 + 난이도 * 0.4 기반 내림차순
  return items.slice().sort((a, b) => {
    const ma = meta[keyOf(a)] || defaultPassageMeta(a);
    const mb = meta[keyOf(b)] || defaultPassageMeta(b);
    const sa = (ma.importance || 5) * 0.6 + (ma.difficulty || 5) * 0.4;
    const sb = (mb.importance || 5) * 0.6 + (mb.difficulty || 5) * 0.4;
    return sb - sa;
  });
}

// ── 난이도 분포 목표 (사용자 설정 반영) ──
const DIFFICULTY_DIST = {
  low:  { low: 0.35, midLow: 0.30, mid: 0.20, midHigh: 0.10, high: 0.05 },
  mid:  { low: 0.20, midLow: 0.25, mid: 0.30, midHigh: 0.15, high: 0.10 },
  high: { low: 0.05, midLow: 0.15, mid: 0.25, midHigh: 0.30, high: 0.25 }
};

function matchTargetDistribution(rankedItems, targetDist, totalQ, meta) {
  // 목표 분포에 따라 지문을 밴드별로 분류한 후 쿼터를 채움
  // rankedItems: 점수 내림차순 정렬된 지문 리스트
  const byBand = { low: [], midLow: [], mid: [], midHigh: [], high: [] };
  rankedItems.forEach(it => {
    const m = meta[keyOf(it)] || defaultPassageMeta(it);
    const band = diffBand(m.difficulty || 5);
    byBand[band].push(it);
  });
  // 각 밴드에서 필요 개수만큼 뽑기
  const picked = [];
  const quotas = {};
  let remainder = totalQ;
  Object.entries(targetDist).forEach(([band, ratio]) => {
    quotas[band] = Math.round(totalQ * ratio);
  });
  // 반올림 오차 보정
  const sumQuota = Object.values(quotas).reduce((a, b) => a + b, 0);
  quotas.mid += totalQ - sumQuota;
  Object.entries(quotas).forEach(([band, q]) => {
    const pool = byBand[band];
    for (let i = 0; i < q && i < pool.length; i++) {
      picked.push(pool[i]);
      remainder--;
    }
  });
  // 부족분은 점수 상위에서 중복 없이 채우기
  if (remainder > 0) {
    const pickedSet = new Set(picked.map(keyOf));
    for (const it of rankedItems) {
      if (remainder <= 0) break;
      if (!pickedSet.has(keyOf(it))) {
        picked.push(it);
        pickedSet.add(keyOf(it));
        remainder--;
      }
    }
  }
  return picked.slice(0, totalQ);
}

// 1지문 = 1 API 호출 (병렬)
async function callScorePassageSingle(job, item) {
  const userMsg = `${item.book} · ${item.unit} · ${item.num}\n\n${item.passage}`;
  const res = await callAITracked(job, job.provider, job.model, userMsg, PASSAGE_SCORING_PROMPT, job.abortController.signal, 'high');
  if (!res || typeof res !== 'object') return null;
  return Object.assign({}, item, {
    importance: Number(res.importance) || 5,
    difficulty: Number(res.difficulty) || 5,
    typeSuitability: res.typeSuitability || {}
  });
}

async function loadOrScorePassages(job, items) {
  const results = {};
  const toScore = [];
  // Firestore 캐시 조회 전면 병렬화 (기존: for...of 직렬)
  await Promise.all(items.map(async (it) => {
    const docId = keyOf(it);
    try {
      const snap = await db.collection('passage_meta').doc(docId).get();
      if (snap.exists) {
        results[docId] = snap.data();
        pushPhaseDetail(job, 'scorePassages', {
          status: 'done',
          label: `${it.book} · ${it.unit} · ${it.num}번`,
          desc: `저장된 점수 활용 — 중요도 ${(results[docId].importance || 0).toFixed(1)} / 난이도 ${(results[docId].difficulty || 0).toFixed(1)}`
        });
      } else {
        toScore.push(it);
      }
    } catch (e) { toScore.push(it); }
  }));

  // 초기 progress 반영 (저장된 점수 활용 만큼)
  const totalItems = items.length;
  setPhaseProgress(job, 'scorePassages', (totalItems - toScore.length) / Math.max(1, totalItems));
  updateVarUI(job);

  if (toScore.length) {
    let processedCount = 0;
    const totalToScore = toScore.length;

    // 1지문 = 1 API 호출, 전체 병렬 실행
    await runWithConcurrency(job, toScore, VARIANT_SCORE_CONCURRENCY, async (it) => {
      if (job.abortController.signal.aborted) return;
      if (job._apiBudgetReached) return;

      const docId = keyOf(it);
      const rid = `score_${docId}`;
      pushPhaseDetail(job, 'scorePassages', {
        id: rid,
        status: 'running',
        label: `${it.book} · ${it.unit} · ${it.num}번`,
        desc: 'AI 채점 중...'
      });
      updateVarUI(job);

      try {
        const scored = await callScorePassageSingle(job, it);
        if (scored) {
          const payload = stripUndefined({
            book: scored.book, unit: scored.unit, number: scored.num,
            importance: scored.importance,
            difficulty: scored.difficulty,
            typeSuitability: scored.typeSuitability || {},
            sampleCount: 1,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          try { await db.collection('passage_meta').doc(docId).set(payload); } catch (e) { /* */ }
          results[docId] = payload;
          updatePhaseDetail(job, 'scorePassages', rid, {
            status: 'done',
            desc: `중요도 ${scored.importance} / 난이도 ${scored.difficulty}`
          });
        } else {
          results[docId] = defaultPassageMeta(it);
          updatePhaseDetail(job, 'scorePassages', rid, {
            status: 'failed',
            desc: '응답 누락 — 기본값 사용'
          });
        }
      } catch (e) {
        console.warn('[variant] passage scoring failed:', e.code || '', e.message);
        if (/quota|rate limit|exhausted/i.test(e.message)) job._apiBudgetReached = true;
        results[docId] = defaultPassageMeta(it);
        updatePhaseDetail(job, 'scorePassages', rid, {
          status: 'failed',
          desc: '채점 실패 — 기본값 사용'
        });
      } finally {
        processedCount++;
        setPhaseProgress(job, 'scorePassages',
          (totalItems - totalToScore + processedCount) / Math.max(1, totalItems));
        job.subLabel = `지문 점수화 ${processedCount}/${totalToScore} (지문별 병렬)`;
        updateVarUI(job);
      }
    });
  }
  setPhaseProgress(job, 'scorePassages', 1);
  finalizePhaseDetails(job, 'scorePassages');
  return results;
}

// ── 지문 → count 배정 ──
function selectPassagesForJob(items, meta, totalQ, userDiff, focusKeys) {
  const targetDist = DIFFICULTY_DIST[userDiff] || DIFFICULTY_DIST.mid;
  const assignments = new Map();
  items.forEach(it => assignments.set(keyOf(it), 0));

  if (totalQ <= items.length) {
    // 엄격 모드: 1 문항/지문 max
    const ranked = rankPassagesByScore(items, meta);
    const picked = matchTargetDistribution(ranked, targetDist, totalQ, meta);
    picked.forEach(it => assignments.set(keyOf(it), 1));
    // 사용자 중점 지문 우선 (focusKeys 가 있으면 non-picked 의 1점을 focus 로 이동)
    if (focusKeys && focusKeys.size) {
      const pickedKeys = new Set(picked.map(keyOf));
      const unpicked = Array.from(pickedKeys).filter(k => !focusKeys.has(k));
      Array.from(focusKeys).forEach(fk => {
        if (!pickedKeys.has(fk) && unpicked.length) {
          const swapOut = unpicked.pop();
          assignments.set(swapOut, 0);
          assignments.set(fk, 1);
        }
      });
    }
  } else {
    // 커버리지 모드: 모든 지문 최소 1회 + 초과분 점수순 라운드 로빈 배분
    // 지문 수보다 문제 수가 많으면 지문 중복 허용 (사용자 요구사항)
    items.forEach(it => assignments.set(keyOf(it), 1));
    let remaining = totalQ - items.length;
    const ranked = rankPassagesByScore(items, meta);
    // 지문당 최대 문제 수: 총 문제 수를 지문 수로 나눈 값 + 여유 2
    const maxPerPassage = Math.ceil(totalQ / Math.max(1, items.length)) + 2;
    let i = 0;
    while (remaining > 0) {
      const it = ranked[i % ranked.length];
      const cur = assignments.get(keyOf(it));
      if (cur < maxPerPassage) {
        assignments.set(keyOf(it), cur + 1);
        remaining--;
      }
      i++;
      // safety: 무한 루프 방지
      if (i >= ranked.length * maxPerPassage + ranked.length) break;
    }
  }

  const usage = Array.from(assignments.entries()).filter(([, c]) => c > 0);
  console.info('[variant] passage usage plan:', usage);
  return assignments;
}

function assignTypesToPassages(assignments, quotaPerType, meta, items) {
  const tasks = [];
  const itemMap = {};
  items.forEach(it => { itemMap[keyOf(it)] = it; });

  // demand flat list
  const typeDemand = [];
  Object.entries(quotaPerType).forEach(([type, q]) => {
    for (let i = 0; i < (q.obj || 0); i++) typeDemand.push({ type, format: 'obj' });
    for (let i = 0; i < (q.sub || 0); i++) typeDemand.push({ type, format: 'sub' });
  });

  // 유형별로 적합도 높은 지문에 할당 — 항상 1문제 = 1태스크 (완전 병렬)
  typeDemand.forEach(d => {
    const eligible = [];
    assignments.forEach((c, k) => {
      if (c <= 0) return;
      const m = meta[k] || {};
      const s = (m.typeSuitability || {})[d.type];
      const score = (typeof s === 'number') ? s : 5;
      if (score >= 4) eligible.push({ k, score, c });
    });
    if (!eligible.length) {
      // 적합도 4 미만이어도 배정 (fallback, 빈 결과 방지)
      assignments.forEach((c, k) => { if (c > 0) eligible.push({ k, score: 3, c }); });
    }
    if (!eligible.length) return;
    eligible.sort((a, b) => b.score - a.score || b.c - a.c);
    const chosen = eligible[0];
    const passage = itemMap[chosen.k];
    // 1문제 = 1태스크 (묶지 않음 → 완전 병렬 실행)
    tasks.push({
      type: d.type, passage,
      thisObj: d.format === 'obj' ? 1 : 0,
      thisSub: d.format === 'sub' ? 1 : 0
    });
    assignments.set(chosen.k, chosen.c - 1);
  });

  return tasks;
}

function verifyPassageUsage(generated, plannedAssignments) {
  const actual = new Map();
  generated.forEach(q => {
    const k = keyOf(q);
    actual.set(k, (actual.get(k) || 0) + 1);
  });
  const issues = [];
  plannedAssignments.forEach((planCount, k) => {
    const got = actual.get(k) || 0;
    if (planCount > 0 && got === 0) issues.push({ key: k, type: 'missing', planned: planCount });
  });
  actual.forEach((count, k) => {
    if (count > 3) issues.push({ key: k, type: 'overuse', count });
  });
  if (issues.length) console.warn('[variant] passage usage verification issues:', issues);
  else console.info('[variant] passage usage verified OK');
  return issues;
}

// ══════════════════════════════════════
// 라운드 8: 지문 변형 (paraphrasing)
// ══════════════════════════════════════

async function loadOrCreateVariation(job, item, level) {
  if (level === 'none') return { passage: item.passage, isVariant: false };
  const docId = `${keyOf(item)}__${level}`;
  try {
    const snap = await db.collection('passage_variants').doc(docId).get();
    if (snap.exists) {
      const d = snap.data();
      pushPhaseDetail(job, 'variatePassages', {
        status: 'done',
        label: `${item.book} · ${item.unit} · ${item.num}번`,
        desc: `저장된 점수 활용 (${level})`,
        extra: d.changeNotes || ''
      });
      return { passage: d.variantPassage, isVariant: true, original: item.passage, changeNotes: d.changeNotes || '' };
    }
  } catch (e) { /* fall through */ }

  pushPhaseDetail(job, 'variatePassages', {
    status: 'running',
    label: `${item.book} · ${item.unit} · ${item.num}번`,
    desc: `AI 변형 중 (${level})...`
  });
  updateVarUI(job);

  const prompt = PASSAGE_VARIATION_PROMPT.replace(/LEVEL_PLACEHOLDER/g, level);
  try {
    const res = await callAITracked(job, job.provider, job.model, item.passage, prompt, job.abortController.signal, 'high');
    const variantPassage = String(res.variantPassage || '').trim();
    if (!variantPassage) throw new Error('empty variant');
    const changeNotes = String(res.changeNotes || '');
    try {
      await db.collection('passage_variants').doc(docId).set(stripUndefined({
        book: item.book, unit: item.unit, number: item.num, level,
        variantPassage, changeNotes,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }));
    } catch (e) { /* */ }
    pushPhaseDetail(job, 'variatePassages', {
      status: 'done',
      label: `${item.book} · ${item.unit} · ${item.num}번`,
      desc: `변형 완료 (${level})`,
      extra: changeNotes.slice(0, 120)
    });
    return { passage: variantPassage, isVariant: true, original: item.passage, changeNotes };
  } catch (e) {
    console.warn('[variant] variation failed, fallback to original:', e.message);
    if (/quota|rate limit|exhausted/i.test(e.message)) job._apiBudgetReached = true;
    pushPhaseDetail(job, 'variatePassages', {
      status: 'failed',
      label: `${item.book} · ${item.unit} · ${item.num}번`,
      desc: '변형 실패 — 원문 사용'
    });
    return { passage: item.passage, isVariant: false };
  }
}

// ══════════════════════════════════════
// 라운드 8: 품질 검토 에이전트
// ══════════════════════════════════════

// markedPassage 의 HTML 태그를 리뷰어가 이해하기 좋은 평문으로 변환
// - <u>①&nbsp;xxx</u> → [①: xxx]
// - <u>xxx</u> → __xxx__ (밑줄 표기)
// - <b>(A)</b> → (A)
// - _______ → __BLANK__ (빈칸 마커)
// - &nbsp; → 공백
// - 나머지 태그 제거
function normalizeMarkedPassageForReview(html) {
  if (!html) return '';
  let s = String(html);
  // 순서: ①②③④⑤ 밑줄 → [번호: 내용]
  s = s.replace(/<u>\s*([①②③④⑤])\s*(?:&nbsp;)?\s*([\s\S]*?)<\/u>/g, (_, mark, inner) => `[${mark}: ${inner.replace(/<[^>]+>/g, '').trim()}]`);
  // 일반 밑줄 → __내용__
  s = s.replace(/<u>([\s\S]*?)<\/u>/g, (_, inner) => `__${inner.replace(/<[^>]+>/g, '').trim()}__`);
  // <b>, <strong> → 그냥 내용 유지 (태그만 제거)
  s = s.replace(/<\/?(?:b|strong|em|br|sub|sup)>/gi, (m) => m === '<br>' || m === '<BR>' ? '\n' : '');
  // &nbsp; → 공백
  s = s.replace(/&nbsp;/g, ' ');
  // 빈칸 표시 강조
  s = s.replace(/_{5,}/g, ' [빈칸] ');
  // 나머지 HTML 엔티티/태그 제거
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.trim();
}

async function callQualityReview(job, questions) {
  const userMsg = questions.map((q, i) => {
    const choices = Array.isArray(q.choices) && q.choices.length
      ? '\n선지:\n' + q.choices.join('\n')
      : '';
    // 중요: 리뷰어에게 markedPassage 를 전달 (원본 _passage 는 포맷팅 누락)
    // markedPassage 가 없으면 원본 fallback
    const passageForReview = q.markedPassage
      ? normalizeMarkedPassageForReview(q.markedPassage)
      : (q._passage || '');
    return `[${i}] 유형: ${q.type} · 형식: ${q.format}\n발문: ${q.stem || ''}${choices}\n정답: ${q.answer || ''}\n해설: ${q.explanation || ''}\n지문(문항용으로 가공됨):\n${passageForReview.slice(0, 2000)}`;
  }).join('\n\n---\n\n');
  const res = await callAITracked(job, job.provider, job.model, userMsg, QUALITY_REVIEW_PROMPT, job.abortController.signal, 'high');
  return res;
}

// ══════════════════════════════════════
// 품질 검토 & 재출제 통합 파이프라인 (문항별 독립 병렬)
// ──────────────────────────────────────
// 각 문항이 자기만의 검토 → (실패 시) 재출제 → 재검토 → … 파이프라인을 타고,
// 모든 문항이 runWithConcurrency 로 완전 병렬 실행됨.
// 기존 reviewQuestionsBatch + regenerateFailedQuestions 를 대체.
async function runQualityPipeline(job, questions, options) {
  const opts = options || {};
  const maxAttempts = opts.maxAttempts || 3;
  const intent = job.intent || '';
  const reviews = new Array(questions.length);
  let doneCount = 0;
  const total = questions.length;

  const tasks = questions.map((q, i) => ({ index: i, initial: q }));

  await runWithConcurrency(job, tasks, VARIANT_REVIEW_CONCURRENCY, async (task) => {
    if (job.abortController.signal.aborted) return;
    if (job._apiBudgetReached) {
      reviews[task.index] = { index: task.index, passed: true, overall: 7, issues: [], notes: 'API 한도 도달로 검토 생략' };
      return;
    }

    const rid = `pipeline_${task.index}`;
    let current = questions[task.index];
    let finalReview = null;

    // 모든 시도의 결과를 저장 (Best-of-N fallback 용)
    // attempts[i] = { question, review, score }
    const attempts = [];
    // 이전 실패 사유 누적 (메가 프롬프트 용)
    const failureHistory = [];

    pushPhaseDetail(job, 'reviewQuality', {
      id: rid,
      status: 'running',
      label: `${current._num || task.index + 1}번 [${current.type}]`,
      desc: '1차 검토 대기...'
    });
    updateVarUI(job);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (job.abortController.signal.aborted) return;
      if (job._apiBudgetReached) break;

      // ── 검토 단계 ──
      updatePhaseDetail(job, 'reviewQuality', rid, {
        desc: attempt === 1 ? '1차 검토 중...' : `${attempt}차 재검토 중...`
      });
      updateVarUI(job);

      let review = null;
      try {
        const res = await callQualityReview(job, [current]);
        const list = Array.isArray(res.reviews) ? res.reviews : [];
        review = list[0] || { passed: true, overall: 7, issues: [], notes: '검토 응답 누락' };
        review = Object.assign({}, review, { index: task.index });
      } catch (e) {
        console.warn('[variant] pipeline review failed:', e.message);
        if (/quota|rate limit|exhausted/i.test(e.message || '')) {
          job._apiBudgetReached = true;
          finalReview = { index: task.index, passed: true, overall: 7, issues: [], notes: 'API 한도 도달' };
          updatePhaseDetail(job, 'reviewQuality', rid, {
            status: 'skipped',
            desc: 'API 한도 도달 — 통과 처리'
          });
          break;
        }
        finalReview = { index: task.index, passed: true, overall: 7, issues: [], notes: '검토 실패 (통과 처리)' };
        updatePhaseDetail(job, 'reviewQuality', rid, {
          status: 'skipped',
          desc: '검토 실패 — 통과 처리'
        });
        break;
      }

      // 현재 시도 결과 저장 (Best-of-N 용)
      attempts.push({
        question: current,
        review,
        score: Number(review.overall) || 0
      });

      if (review.passed) {
        finalReview = review;
        updatePhaseDetail(job, 'reviewQuality', rid, {
          status: 'done',
          desc: attempt === 1
            ? `통과 (${(review.overall || 0).toFixed(1)}/10)`
            : `${attempt - 1}차 재출제 → 통과 (${(review.overall || 0).toFixed(1)}/10)`,
          extra: ''
        });
        break;
      }

      // 실패 히스토리에 추가 (다음 재출제 시 메가 프롬프트 용)
      failureHistory.push({
        attempt,
        overall: review.overall || 0,
        issues: review.issues || [],
        suggestion: review.suggestion || ''
      });

      // 검토 실패 — 마지막 시도면 Best-of-N 으로 최고 점수 선택
      if (attempt === maxAttempts) {
        // 모든 시도 중 overall 점수 가장 높은 것 선택
        const best = attempts.slice().sort((a, b) => b.score - a.score)[0];
        if (best) {
          // questions 배열도 best 로 교체
          questions[task.index] = best.question;
          finalReview = Object.assign({}, best.review, {
            index: task.index,
            _bestOfN: true,
            _attemptCount: attempts.length
          });
          updatePhaseDetail(job, 'reviewQuality', rid, {
            status: 'failed',
            desc: `${attempt}차 실패 → Best-of-${attempts.length} 선택 (${best.score.toFixed(1)}/10)`,
            extra: `${attempts.length}번 시도 중 최고점. ${(best.review.issues || [])[0] || ''}`
          });
        } else {
          finalReview = review;
          updatePhaseDetail(job, 'reviewQuality', rid, {
            status: 'failed',
            desc: `${attempt}차까지 실패 (${(review.overall || 0).toFixed(1)}/10)`,
            extra: (review.issues || [])[0] || '기준 미달'
          });
        }
        break;
      }

      // ── 재출제 단계 ──
      updatePhaseDetail(job, 'reviewQuality', rid, {
        desc: `${attempt}차 실패 → 재출제 중... (${(review.issues || [])[0] || '기준 미달'})`,
        extra: review.suggestion || ''
      });
      updateVarUI(job);

      try {
        const passage = {
          book: current.book, unit: current.unit, num: current.num,
          passage: current._passage || '',
          _isVariant: current._isVariant,
          _original: current._original,
          _changeNotes: current._changeNotes
        };
        const analysis = await loadAnalysisCache(passage).catch(() => null);

        // 메가 프롬프트: 모든 이전 시도의 실패 사유를 누적해서 전달
        // 2차 이상이면 "여러 번 실패했다 → 다음 실수들을 모두 피해야 함" 강조
        let previousContext;
        if (failureHistory.length === 1) {
          previousContext = `\n[이전 출제 시 지적된 문제점]\n- ${(review.issues || []).join('\n- ')}\n\n[개선 방향]\n${review.suggestion || ''}\n\n위 문제점을 반드시 피해서 새로 출제해주세요.`;
        } else {
          // 2차 이상 — 누적된 모든 실패 사유를 메가 프롬프트로 전달
          const historyBlocks = failureHistory.map(h =>
            `[${h.attempt}차 시도 실패 (${h.overall.toFixed(1)}/10)]\n- 문제점: ${(h.issues || []).join('; ') || '기준 미달'}\n- 가이드: ${h.suggestion || '구체적 가이드 없음'}`
          ).join('\n\n');
          previousContext = `\n[누적 실패 기록 — 총 ${failureHistory.length}번 시도했는데 모두 실패했습니다]\n${historyBlocks}\n\n[필수 지시]\n위 ${failureHistory.length}개 실패 사유를 **모두 동시에** 피해서 새로 출제해야 합니다.\n특히 반복된 실수 패턴을 인지하고 **구조 자체를 바꿔서** 접근하세요.\n- 같은 지문이라도 빈칸 위치, 정답 표현, 오답 구성을 완전히 다른 방향으로 재설계하세요.\n- 직전 시도와 똑같은 패턴의 답을 피하세요.`;
        }

        const combinedIntent = (intent + previousContext).trim();
        const thisObj = current.format === 'obj' ? 1 : 0;
        const thisSub = current.format === 'sub' ? 1 : 0;
        const prompt = buildVariantPrompt(current.type, job.diff, analysis, thisObj, thisSub, combinedIntent);

        let result = null;
        for (let att = 0; att < 3; att++) {
          try {
            result = await callAITracked(job, job.provider, job.model, passage.passage, prompt, job.abortController.signal, 'high');
            break;
          } catch (e) {
            if (/quota|rate limit|exhausted/i.test(e.message || '')) {
              job._apiBudgetReached = true;
              throw e;
            }
            if (att < 2) await new Promise(r => setTimeout(r, 2000));
          }
        }
        if (!result || !Array.isArray(result.questions) || !result.questions.length) {
          throw new Error('재출제 응답 비어있음');
        }

        const newQ = Object.assign({}, result.questions[0], {
          id: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: current.type, book: current.book, unit: current.unit, num: current.num,
          _passage: passage.passage,
          _isVariant: current._isVariant || false,
          _original: current._original || null,
          _changeNotes: current._changeNotes || '',
          _num: current._num,
          createdAt: Date.now(),
          _fromCache: false,
          _regenerated: true
        });

        current = newQ;
        questions[task.index] = newQ;   // 병렬 안전 (각 워커가 서로 다른 index 슬롯)

        try {
          const clean = Object.assign({}, newQ);
          delete clean._passage; delete clean._isVariant; delete clean._original;
          delete clean._changeNotes; delete clean._fromCache; delete clean._regenerated;
          await saveVariantQuestion(passage, clean);
        } catch (e) { /* */ }

        // 다음 루프에서 재검토
      } catch (e) {
        console.warn('[variant] pipeline regenerate failed:', e.message);
        finalReview = review;   // 마지막 리뷰를 최종값으로
        updatePhaseDetail(job, 'reviewQuality', rid, {
          status: 'failed',
          desc: `${attempt}차 재출제 실패 — ${e.message}`,
          extra: review.suggestion || ''
        });
        break;
      }
    }

    reviews[task.index] = finalReview || { index: task.index, passed: true, overall: 7, issues: [], notes: '검토 누락' };
    doneCount++;
    setPhaseProgress(job, 'reviewQuality', doneCount / Math.max(1, total));
    job.subLabel = `품질 파이프라인 ${doneCount}/${total} (문항 단위 병렬)`;
    updateVarUI(job);
  });

  // 누락된 슬롯 pass-through
  for (let i = 0; i < reviews.length; i++) {
    if (!reviews[i]) reviews[i] = { index: i, passed: true, overall: 7, issues: [], notes: '미검토' };
  }
  setPhaseProgress(job, 'reviewQuality', 1);
  return reviews;
}

const GRAMMAR_POINTS = ['수일치','시제','태','관계사','분사','to부정사','동명사','병렬','비교','접속사','대명사','형용사/부사'];

function enforceGrammarPointDiversity(questions) {
  const grammarQs = questions.filter(q => q.type === '어법');
  if (grammarQs.length < 2) return { ok: true, duplicates: [], usedPoints: [] };
  const usedPoints = new Set();
  const duplicates = [];
  grammarQs.forEach(q => {
    const point = GRAMMAR_POINTS.find(p => (q.explanation || '').includes(p));
    if (!point) return;
    if (usedPoints.has(point)) duplicates.push(q);
    else usedPoints.add(point);
  });
  const enoughVariety = usedPoints.size >= Math.min(3, grammarQs.length);
  return { ok: duplicates.length === 0 && enoughVariety, duplicates, usedPoints: Array.from(usedPoints) };
}

function validateChoices(questions) {
  const objs = questions.filter(q => q.format === 'obj' && Array.isArray(q.choices) && q.choices.length === 5);
  const issues = [];

  // 1) 정답 위치 분산
  if (objs.length >= 5) {
    const posCount = { '①': 0, '②': 0, '③': 0, '④': 0, '⑤': 0 };
    objs.forEach(q => {
      const p = String(q.answer || '').trim().charAt(0);
      if (posCount[p] != null) posCount[p]++;
    });
    const expected = objs.length / 5;
    Object.entries(posCount).forEach(([p, c]) => {
      if (expected > 0 && Math.abs(c - expected) > expected * 0.8) {
        issues.push({ type: 'positionSkew', pos: p, count: c });
      }
    });
  }

  // 2) 연속 동일 정답 3회 이상 금지
  let streak = 1;
  for (let i = 1; i < objs.length; i++) {
    if (objs[i].answer === objs[i - 1].answer) {
      streak++;
      if (streak >= 3) issues.push({ type: 'consecutiveAnswer', from: i - 2, to: i });
    } else streak = 1;
  }

  // 3) 정답 선지 길이 편차
  objs.forEach(q => {
    const lens = q.choices.map(c => String(c).length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (avg === 0) return;
    const idx = ['①', '②', '③', '④', '⑤'].indexOf(String(q.answer).charAt(0));
    if (idx >= 0 && Math.abs(lens[idx] - avg) / avg > 0.5) {
      issues.push({ type: 'answerLengthSkew', num: q._num });
    }
  });

  return { ok: issues.length === 0, issues };
}

// 최종 시험지 검토 이슈를 사람이 읽기 좋은 { label, desc } 로 포맷팅
function formatFinalIssue(issue) {
  if (!issue || !issue.type) return { label: '알 수 없는 이슈', desc: '' };
  const BAND_LABEL = { low: '하', midLow: '중하', mid: '중', midHigh: '중상', high: '상' };
  switch (issue.type) {
    case 'difficultyDistSkew':
      return {
        label: '난이도 분포 편향',
        desc: `${BAND_LABEL[issue.band] || issue.band} 난이도: 실제 ${issue.actual}% (목표 ${issue.target}%)`
      };
    case 'positionSkew':
      return {
        label: '정답 위치 편향',
        desc: issue.count === 0
          ? `${issue.pos} 번이 정답인 문항이 하나도 없습니다`
          : `${issue.pos} 번이 정답인 문항이 ${issue.count}개로 편중되어 있습니다`
      };
    case 'consecutiveAnswer':
      return {
        label: '연속 동일 정답',
        desc: `${issue.from + 1}번 ~ ${issue.to + 1}번 문항의 정답이 3개 이상 연속 동일합니다`
      };
    case 'answerLengthSkew':
      return {
        label: '정답 선지 길이 편차',
        desc: `${issue.num || '?'}번 문항의 정답 선지 길이가 다른 선지들과 크게 다릅니다`
      };
    case 'grammarPointDuplicate':
      return {
        label: '어법 포인트 중복',
        desc: `어법 문항이 동일 포인트를 반복합니다 (중복 ${issue.count}개 · 사용: ${(issue.used || []).join(', ')})`
      };
    default:
      return { label: issue.type, desc: JSON.stringify(issue).slice(0, 150) };
  }
}

// ══════════════════════════════════════
// 최종 시험지 자동 수정 (API 호출 없이 로컬 로직)
// ──────────────────────────────────────
// 1. positionSkew: 정답 위치가 ① 에 몰리거나 ⑤ 가 0개면 선지 순서 회전
// 2. consecutiveAnswer: 연속 3개 이상 동일 정답이면 문항 순서 재배열
const CHOICE_MARKS = ['①', '②', '③', '④', '⑤'];
const CHOICE_MARK_SET = new Set(CHOICE_MARKS);

// 선지 순서를 회전해서 정답 위치를 targetPos 로 옮김.
// choices 배열과 answer 필드 둘 다 업데이트. 내용은 그대로, 번호 매핑만 바뀜.
function rotateChoicesToPosition(q, targetIdx) {
  if (!q || q.format !== 'obj') return false;
  const choices = Array.isArray(q.choices) ? q.choices : [];
  if (choices.length !== 5) return false;
  const currentAnswer = String(q.answer || '').trim().charAt(0);
  const currentIdx = CHOICE_MARKS.indexOf(currentAnswer);
  if (currentIdx === -1 || currentIdx === targetIdx) return false;

  // 각 choice 에서 앞의 ①②③④⑤ 마크 제거 후 내용만 추출
  const stripped = choices.map(c => {
    const s = String(c == null ? '' : c);
    // ①, ② ... 혹은 "① " / "①" 형태 제거
    return s.replace(/^\s*[①②③④⑤]\s*/, '').trim();
  });

  // swap currentIdx <-> targetIdx
  const tmp = stripped[currentIdx];
  stripped[currentIdx] = stripped[targetIdx];
  stripped[targetIdx] = tmp;

  // 새 번호 부여
  q.choices = stripped.map((c, i) => `${CHOICE_MARKS[i]} ${c}`);
  // 정답 갱신 (원래 정답 뒤에 추가 설명이 있었을 수 있으니 앞글자만 바꿈)
  const rest = String(q.answer || '').slice(1);
  q.answer = CHOICE_MARKS[targetIdx] + rest;
  q._autoFixed = true;
  return true;
}

// 정답 위치가 한 쪽에 몰려있거나 특정 번호가 0개면 자동 회전으로 분산
function autoFixPositionSkew(items) {
  const objs = items.filter(q => q && q.format === 'obj' && Array.isArray(q.choices) && q.choices.length === 5);
  if (objs.length < 5) return { fixed: 0, summary: '' };

  const posCount = { '①': 0, '②': 0, '③': 0, '④': 0, '⑤': 0 };
  objs.forEach(q => {
    const p = String(q.answer || '').trim().charAt(0);
    if (posCount[p] != null) posCount[p]++;
  });
  const expected = objs.length / 5;

  // 어떤 번호가 편중됐는지, 어떤 번호가 부족한지 찾기
  const overused = [];
  const underused = [];
  CHOICE_MARKS.forEach(p => {
    if (expected > 0 && posCount[p] - expected > expected * 0.6) overused.push(p);
    if (expected > 0 && expected - posCount[p] > expected * 0.6) underused.push(p);
  });

  if (!overused.length || !underused.length) return { fixed: 0, summary: '' };

  let fixedCount = 0;
  // 편중된 번호의 문항들을 부족한 번호로 회전 이동
  for (const overP of overused) {
    const targetsForOver = objs.filter(q => String(q.answer || '').trim().charAt(0) === overP);
    while (targetsForOver.length > 0 && underused.length > 0) {
      const underP = underused[0];
      const underIdx = CHOICE_MARKS.indexOf(underP);
      const q = targetsForOver.shift();
      if (rotateChoicesToPosition(q, underIdx)) {
        fixedCount++;
        posCount[overP]--;
        posCount[underP]++;
        // under 가 충분히 채워졌으면 리스트에서 제거
        if (expected - posCount[underP] <= expected * 0.6) underused.shift();
        // over 가 충분히 빠졌으면 중단
        if (posCount[overP] - expected <= expected * 0.6) break;
      }
    }
    if (!underused.length) break;
  }

  return {
    fixed: fixedCount,
    summary: fixedCount ? `정답 위치 회전 ${fixedCount}개 (편중 ${overused.join(',')} → 부족 ${underused.join(',')})` : ''
  };
}

// 연속 동일 정답 3개 이상이 있으면 해당 구간 내 한 문항을 swap 으로 이동
function autoFixConsecutiveAnswer(items) {
  const objs = items.filter(q => q && q.format === 'obj');
  if (objs.length < 3) return { fixed: 0, summary: '' };

  let fixedCount = 0;
  let maxPasses = 10;
  while (maxPasses-- > 0) {
    // 연속 동일 정답 구간 찾기
    let foundStreak = -1;
    let streak = 1;
    for (let i = 1; i < objs.length; i++) {
      if (String(objs[i].answer || '').charAt(0) === String(objs[i - 1].answer || '').charAt(0)) {
        streak++;
        if (streak >= 3) {
          foundStreak = i;   // 연속 구간의 끝 index
          break;
        }
      } else {
        streak = 1;
      }
    }
    if (foundStreak === -1) break;

    // 연속 구간의 가운데 문항을 구간 밖의 다른 정답과 swap
    const midIdx = foundStreak - 1;
    const streakAnswer = String(objs[midIdx].answer || '').charAt(0);
    // 가장 가까운 구간 밖 (다른 정답 가진) 문항 찾기
    let swapIdx = -1;
    for (let offset = 1; offset < objs.length; offset++) {
      const candidates = [midIdx - offset, midIdx + offset];
      for (const ci of candidates) {
        if (ci < 0 || ci >= objs.length) continue;
        if (ci >= foundStreak - 2 && ci <= foundStreak) continue;   // 연속 구간 내는 제외
        const candAnswer = String(objs[ci].answer || '').charAt(0);
        if (candAnswer !== streakAnswer) {
          swapIdx = ci;
          break;
        }
      }
      if (swapIdx !== -1) break;
    }

    if (swapIdx === -1) break;

    // items 배열에서 실제 위치 찾기 (objs 는 filtered 배열이라 원본 items 에서 swap 해야 함)
    const qA = objs[midIdx];
    const qB = objs[swapIdx];
    const iA = items.indexOf(qA);
    const iB = items.indexOf(qB);
    if (iA === -1 || iB === -1) break;

    items[iA] = qB;
    items[iB] = qA;
    objs[midIdx] = qB;
    objs[swapIdx] = qA;
    fixedCount++;
  }

  if (fixedCount) {
    // 문항 순서가 바뀌었으므로 _num 재부여
    items.forEach((q, i) => { if (q) q._num = i + 1; });
  }

  return {
    fixed: fixedCount,
    summary: fixedCount ? `연속 정답 분산 ${fixedCount}개 문항 재배치` : ''
  };
}

// 최종 시험지 자동 수정 통합 엔트리
function autoFixPaperIssues(items) {
  const results = [];
  const pos = autoFixPositionSkew(items);
  if (pos.fixed > 0) results.push(pos);
  const cons = autoFixConsecutiveAnswer(items);
  if (cons.fixed > 0) results.push(cons);
  return results;
}

function reviewPaper(paper, meta, userDiff) {
  const issues = [];
  const items = paper.items || [];

  // 1) 난이도 분포 (지문 meta 기반)
  const targetDist = DIFFICULTY_DIST[userDiff] || DIFFICULTY_DIST.mid;
  const bandCount = { low: 0, midLow: 0, mid: 0, midHigh: 0, high: 0 };
  items.forEach(q => {
    const m = meta[keyOf(q)] || {};
    const d = m.difficulty || 5;
    bandCount[diffBand(d)]++;
  });
  const totalQ = items.length;
  Object.entries(targetDist).forEach(([band, ratio]) => {
    const actual = (bandCount[band] || 0) / totalQ;
    if (Math.abs(actual - ratio) > 0.15) {
      issues.push({ type: 'difficultyDistSkew', band, actual: +(actual * 100).toFixed(1), target: +(ratio * 100).toFixed(1) });
    }
  });

  // 2) 어법 포인트 다양성
  const grammarCheck = enforceGrammarPointDiversity(items);
  if (!grammarCheck.ok) {
    issues.push({ type: 'grammarPointDuplicate', count: grammarCheck.duplicates.length, used: grammarCheck.usedPoints });
  }

  // 3) 선지 규칙
  const choiceCheck = validateChoices(items);
  if (!choiceCheck.ok) issues.push(...choiceCheck.issues);

  console.info('[variant] reviewPaper:', { bandCount, issues });
  return issues;
}

// ══════════════════════════════════════
// 라운드 8: 표지 + 총평
// ══════════════════════════════════════

function computeDifficultyDistribution(paper, meta) {
  const bandCount = { low: 0, midLow: 0, mid: 0, midHigh: 0, high: 0 };
  (paper.items || []).forEach(q => {
    const m = (meta && meta[keyOf(q)]) || {};
    const d = m.difficulty || 5;
    bandCount[diffBand(d)]++;
  });
  return bandCount;
}

function renderSummaryTable(opts) {
  const { books, total, obj, sub } = opts;
  return `
    <table class="summary-table">
      <tr><td>교재</td><td>${books.map(escapeHtmlVar).join(', ')}</td></tr>
      <tr><td>총 문항</td><td>${total}문항 (객관식 ${obj} · 주관식 ${sub})</td></tr>
    </table>
  `;
}

// Round 9: 도넛 차트 (SVG)
function renderDonutChart(title, dataEntries, colors) {
  // dataEntries: [[label, count], ...]
  const total = dataEntries.reduce((s, [, c]) => s + c, 0);
  if (total === 0) return '';
  const CX = 55, CY = 55, R = 40, STROKE = 16;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segments = dataEntries.map(([label, count], i) => {
    const frac = count / total;
    const len = C * frac;
    const color = colors[i % colors.length];
    const circle = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${CX} ${CY})"/>`;
    offset += len;
    return circle;
  }).join('');
  const legendItems = dataEntries.map(([label, count], i) => {
    const color = colors[i % colors.length];
    const pct = Math.round((count / total) * 100);
    return `
      <div class="summary-donut-legend-item">
        <span class="dot" style="background:${color}"></span>
        <span class="legend-label">${escapeHtmlVar(label)}</span>
        <span class="legend-count">${count}</span>
      </div>
    `;
  }).join('');
  return `
    <div class="summary-donut-block">
      <svg class="summary-donut-svg" viewBox="0 0 110 110">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#eef0f7" stroke-width="${STROKE}"/>
        ${segments}
        <text x="${CX}" y="${CY - 3}" text-anchor="middle" font-size="16" font-weight="800" fill="#1a1a1a">${total}</text>
        <text x="${CX}" y="${CY + 11}" text-anchor="middle" font-size="7" fill="#8992a8" font-weight="700" letter-spacing="0.5">TOTAL</text>
      </svg>
      <div class="summary-donut-legend">
        <div class="summary-donut-title">${escapeHtmlVar(title)}</div>
        ${legendItems}
      </div>
    </div>
  `;
}

const DONUT_COLORS_TYPE = ['#4f6ef7', '#7c5cbf', '#2da05a', '#e08a2a', '#3a8fd6', '#e04a4a', '#00a2b8', '#8e44ad', '#d35400', '#16a085'];
const DONUT_COLORS_DIFF = ['#2da05a', '#5cb85c', '#4f6ef7', '#e08a2a', '#e04a4a'];

function buildCoverHtml(job, paper) {
  const studentName = (job.studentName || '').trim();
  const userTitle = (document.getElementById('varPaperTitle').value || '').trim();
  const title = studentName
    ? `${studentName} 학생 개인별 맞춤 모의고사`
    : (userTitle || '변형문제');
  const unitSummary = [...new Set(job.items.map(it => `${it.book} · ${it.unit}`))].slice(0, 6).join(' / ');
  const dateStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  return `
    <div class="cover-page">
      <div class="cover-header" style="display:flex;justify-content:space-between;align-items:center">
        <span>LOGIC FLOW MAPPER</span>
        <img src="${encodeURIComponent('송유근영어[가로].png')}" style="height:28px;object-fit:contain" onerror="this.style.display='none'" />
      </div>
      <div class="cover-title">${escapeHtmlVar(title)}</div>
      <div class="cover-meta">
        <div class="cover-row"><span class="cover-label">교재 범위</span><span>${escapeHtmlVar(unitSummary)}</span></div>
        <div class="cover-row"><span class="cover-label">총 문항 수</span><span>${paper.total}문항 (객 ${paper.objCount} · 주 ${paper.subCount})</span></div>
        <div class="cover-row"><span class="cover-label">난이도</span><span>${escapeHtmlVar(diffLabel(job.diff))}</span></div>
        ${studentName ? `<div class="cover-row"><span class="cover-label">학생</span><span>${escapeHtmlVar(studentName)}</span></div>` : ''}
        <div class="cover-row"><span class="cover-label">날짜</span><span>${escapeHtmlVar(dateStr)}</span></div>
      </div>
      <div class="cover-footer">송유근 영어 · 최고의 강의 &amp; 철저한 관리</div>
    </div>
  `;
}

async function generateSummaryCommentaryAI(job, paper) {
  if (!job) return null;
  if (job._apiBudgetReached) return null;
  const byType = {};
  (paper.items || []).forEach(q => { byType[q.type] = (byType[q.type] || 0) + 1; });
  const diffDist = computeDifficultyDistribution(paper, job._meta || {});
  const books = [...new Set(job.items.map(it => it.book))];
  const metadata = {
    books, totalQ: paper.total, objCount: paper.objCount, subCount: paper.subCount,
    difficultyLevel: diffLabel(job.diff),
    difficultyDistribution: diffDist,
    typeBreakdown: byType,
    variationLevel: job.variation,
    studentName: job.studentName || '',
    studentWeakness: job.studentWeakness || '',
    userIntent: job.intent || ''
  };
  try {
    const res = await callAITracked(job, job.provider, job.model,
      `아래 시험지 메타데이터:\n${JSON.stringify(metadata, null, 2)}`,
      SUMMARY_COMMENTARY_PROMPT, job.abortController.signal, 'medium');
    return res;
  } catch (e) {
    console.warn('[variant] summary commentary AI failed:', e.message);
    if (/quota|rate limit|exhausted/i.test(e.message)) job._apiBudgetReached = true;
    return null;
  }
}

function buildSummaryCommentary(job, paper, reviews) {
  const byType = {};
  (paper.items || []).forEach(q => { byType[q.type] = (byType[q.type] || 0) + 1; });
  const diffDist = computeDifficultyDistribution(paper, job._meta || {});
  const books = [...new Set(job.items.map(it => it.book))];
  const diffLabels = { low: '하', midLow: '중하', mid: '중', midHigh: '중상', high: '상' };

  const parts = [];
  parts.push(`<h2 class="summary-h2">출제 총평</h2>`);

  // AI 생성 출제 의도 우선, 없으면 사용자 intent
  const aiSummary = job._summaryAi || {};
  if (aiSummary.intentExplanation) {
    parts.push(`<div class="summary-intent">${escapeHtmlVar(aiSummary.intentExplanation)}</div>`);
  } else if (job.intent) {
    parts.push(`<div class="summary-intent">${escapeHtmlVar(job.intent)}</div>`);
  }

  parts.push(renderSummaryTable({ books, total: paper.total, obj: paper.objCount, sub: paper.subCount }));

  // 도넛 차트 (유형 분포 + 난이도 분포)
  const typeEntries = Object.entries(byType).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const diffEntries = Object.entries(diffDist).filter(([, c]) => c > 0).map(([k, v]) => [diffLabels[k] || k, v]);
  parts.push(`
    <div class="summary-donut-row">
      ${renderDonutChart('유형별 분포', typeEntries, DONUT_COLORS_TYPE)}
      ${renderDonutChart('난이도 분포', diffEntries, DONUT_COLORS_DIFF)}
    </div>
  `);

  // AI 생성 중점 학습 포인트
  if (aiSummary.focusAreas && aiSummary.focusAreas.length) {
    parts.push(`<div class="summary-section-label">중점 학습 포인트</div>`);
    parts.push(`<ul style="margin:0 0 18px 18px;font-size:12px;line-height:1.7;color:#333">`);
    aiSummary.focusAreas.forEach(f => {
      parts.push(`<li>${escapeHtmlVar(f)}</li>`);
    });
    parts.push(`</ul>`);
  }

  // AI 생성 학습 가이드
  if (aiSummary.learningGuide) {
    parts.push(`<div class="summary-section-label">학습 가이드</div>`);
    parts.push(`<div style="font-size:12px;line-height:1.75;color:#333;margin-bottom:18px">${escapeHtmlVar(aiSummary.learningGuide)}</div>`);
  }

  // 학생 개인 맞춤 조언
  if (aiSummary.personalNote) {
    parts.push(`<div class="summary-student">${escapeHtmlVar(aiSummary.personalNote)}</div>`);
  } else if (job.studentName && job.studentWeakness) {
    parts.push(`<div class="summary-student">${escapeHtmlVar(job.studentName)} 학생의 취약점(${escapeHtmlVar(job.studentWeakness)})을 중점 출제하였습니다.</div>`);
  } else if (job.studentName) {
    parts.push(`<div class="summary-student">${escapeHtmlVar(job.studentName)} 학생을 위한 맞춤 시험지입니다.</div>`);
  }

  // 품질 통과율 표시 X (라운드 9: 요청사항)
  return parts.join('');
}

// ══════════════════════════════════════
// 메인 실행
// ══════════════════════════════════════

// ── 다중 작업: config 읽기 → job 생성 → 비동기 파이프라인 실행 ──
function startVariantJob() {
  const tree = document.getElementById('varRangeTree');
  const items = getRangeSelection(tree);
  const objN = parseInt(document.getElementById('varObj').value || '0', 10);
  const subN = parseInt(document.getElementById('varSub').value || '0', 10);
  const totalQ = objN + subN;
  const diff = document.getElementById('varDiff').value;
  const typesSel = getSelectedVariantTypes();
  const excludePrev = document.getElementById('varExcludePrev').checked;
  const provider = document.getElementById('varProvider').value;
  const model = document.getElementById('varModel').value;
  const answerSeparate = document.getElementById('varAnswerSeparate').checked;
  const answerInline = !answerSeparate;
  const intentEl = document.getElementById('varIntent');
  const intent = intentEl ? (intentEl.value || '').trim() : '';
  const variation = (document.getElementById('varVariation') || {}).value || 'none';
  const showVariationBadge = (document.getElementById('varShowVariationBadge') || {}).checked || false;
  const qualityReview = (document.getElementById('varQualityReview') || {}).checked || false;
  const includeCover = (document.getElementById('varIncludeCover') || {}).checked || false;
  const studentName = ((document.getElementById('varStudentName') || {}).value || '').trim();
  const studentWeakness = ((document.getElementById('varStudentWeakness') || {}).value || '').trim();
  const paperTitle = ((document.getElementById('varPaperTitle') || {}).value || '').trim();
  const paperSubtitle = ((document.getElementById('varPaperSubtitle') || {}).value || '').trim();

  if (!items.length) { alert('지문을 한 개 이상 선택해주세요.'); return; }
  if (!typesSel.length) { alert('문제 유형을 한 개 이상 선택해주세요.'); return; }
  if (totalQ <= 0) { alert('객관식 + 주관식 개수를 입력해주세요.'); return; }

  const phaseStates = {
    prepare: 'active',
    scorePassages: 'pending',
    loadPrev: 'pending',
    generate: 'pending',
    buildPdf: 'pending',
    done: 'pending'
  };
  if (variation !== 'none') phaseStates.variatePassages = 'pending';
  if (qualityReview) {
    phaseStates.reviewQuality = 'pending';
    phaseStates.finalReview = 'pending';
  }

  const job = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `var_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'variant',
    items, totalQ, objN, subN, diff, typesSel, intent,
    excludePrev, provider, model, answerSeparate, answerInline,
    variation, showVariationBadge, qualityReview, includeCover,
    studentName, studentWeakness, paperTitle, paperSubtitle,
    _meta: {},
    _plannedAssignments: null,
    _reviews: null,
    _apiBudgetReached: false,
    _tokens: { input: 0, output: 0 },
    _phaseProgress: {},
    _phaseDetails: {},
    _startedAt: Date.now(),
    _timerInterval: null,
    _finalCostLine: '',
    _summaryAi: null,
    _downloadsHtml: '',
    _bindDownloads: null,
    generated: [],
    reusedFromCache: [],
    abortController: new AbortController(),
    currentLabel: '',
    totalSteps: 0,
    doneSteps: 0,
    phase: 'prepare',
    phaseStates,
    subLabel: '준비 중...',
    _currentItem: null
  };

  // Manager 에 추가 (자동 선택 + 드롭다운 렌더)
  if (variantJobManager) variantJobManager.addJob(job);
  if (typeof setPanelRunning === 'function') setPanelRunning('variant', true);
  updateVarUI(job, '준비 중...');

  // 실시간 타이머 (1초마다 UI 갱신)
  job._timerInterval = setInterval(() => tickVariantTimer(job), 1000);

  // 비동기 파이프라인 — job 참조 캡처, 완료 후 finishVariantJob(job) 자동 호출
  runVariantPipeline(job).finally(() => {
    if (typeof updateSidebarIndicators === 'function') updateSidebarIndicators();
  });
}

async function runVariantPipeline(job) {
  const {
    items, objN, subN, diff, typesSel, intent,
    excludePrev, variation, qualityReview
  } = job;

  // 난이도별 변형 비율
  const VARIATION_RATIOS = { low: 0.10, mid: 0.25, high: 0.40 };

  try {
    // ── Phase 1: scorePassages ──
    job.phase = 'scorePassages';
    job.phaseStates.prepare = 'done';
    job.phaseStates.scorePassages = 'active';
    updateVarUI(job, '지문 점수화 준비 중...');
    const meta = await loadOrScorePassages(job, items);
    job._meta = meta;
    job.phaseStates.scorePassages = 'done';

    if (job.abortController.signal.aborted) throw new Error('aborted');

    // ── Phase 2: loadPrev ──
    job.phase = 'loadPrev';
    job.phaseStates.loadPrev = 'active';
    updateVarUI(job, '이전 문제 풀 로드 중...');
    const prevPool = excludePrev ? [] : await loadVariantPool(items);
    const prevByType = groupByType(prevPool);
    console.info('[variant] pool loaded:', prevPool.length, 'questions');
    job.phaseStates.loadPrev = 'done';

    // ── 이전 풀에서 우선 채우기 ──
    const quotaPerType = distributeQuota(objN, subN, typesSel);
    const adjustedQuota = {};
    for (const type of typesSel) {
      const need = quotaPerType[type] || { obj: 0, sub: 0 };
      let fromCacheObj = 0, fromCacheSub = 0;
      if (!excludePrev) {
        const pool = prevByType[type] || [];
        const pick = pickFromPool(pool, need.obj, need.sub);
        pick.items.forEach(q => {
          job.reusedFromCache.push(Object.assign({}, q, { type, _fromCache: true }));
        });
        fromCacheObj = pick.objCount;
        fromCacheSub = pick.subCount;
      }
      adjustedQuota[type] = {
        obj: Math.max(0, need.obj - fromCacheObj),
        sub: Math.max(0, need.sub - fromCacheSub)
      };
    }

    const remainingTotal = Object.values(adjustedQuota).reduce((sum, q) => sum + q.obj + q.sub, 0);

    // ── Phase 3: 지문 선별 + 유형 배정 ──
    let taskQueue = [];
    if (remainingTotal > 0) {
      const assignments = selectPassagesForJob(items, meta, remainingTotal, diff, null);
      job._plannedAssignments = assignments;
      taskQueue = assignTypesToPassages(assignments, adjustedQuota, meta, items);
    }

    // ── Phase 4: variatePassages (옵션) ──
    if (variation !== 'none' && taskQueue.length && !job._apiBudgetReached) {
      job.phase = 'variatePassages';
      job.phaseStates.variatePassages = 'active';
      const itemMap = {};
      items.forEach(it => { itemMap[keyOf(it)] = it; });
      const uniqueKeys = [...new Set(taskQueue.map(t => keyOf(t.passage)))];
      const variationRatio = VARIATION_RATIOS[diff] || 0.25;
      const variateCount = Math.max(1, Math.round(uniqueKeys.length * variationRatio));
      const rankedKeys = uniqueKeys.slice().sort((a, b) => {
        const ma = job._meta[a] || {};
        const mb = job._meta[b] || {};
        return (mb.importance || 0) - (ma.importance || 0);
      });
      const keysToVariate = new Set(rankedKeys.slice(0, variateCount));
      job.subLabel = `지문 변형 예정: ${variateCount}/${uniqueKeys.length} (${diff}=${Math.round(variationRatio*100)}%)`;

      const variantMap = {};
      let processed = 0;
      const variateTasks = rankedKeys.map(k => ({ key: k, shouldVariate: keysToVariate.has(k) }));

      await runWithConcurrency(job, variateTasks, VARIANT_VARIATE_CONCURRENCY, async (task) => {
        if (job.abortController.signal.aborted) return;
        if (job._apiBudgetReached) return;

        const k = task.key;
        const item = itemMap[k];

        if (task.shouldVariate) {
          const rid = `var_${k}`;
          pushPhaseDetail(job, 'variatePassages', {
            id: rid,
            status: 'running',
            label: `${item.book} · ${item.unit} · ${item.num}번`,
            desc: `변형 중 (${variation})...`
          });
          updateVarUI(job);
          try {
            variantMap[k] = await loadOrCreateVariation(job, item, variation);
            updatePhaseDetail(job, 'variatePassages', rid, {
              status: (variantMap[k] && variantMap[k].isVariant) ? 'done' : 'skipped',
              desc: (variantMap[k] && variantMap[k].isVariant) ? '변형 완료' : '원문 사용'
            });
          } catch (e) {
            updatePhaseDetail(job, 'variatePassages', rid, {
              status: 'failed',
              desc: e.message || '변형 실패'
            });
          }
        } else {
          pushPhaseDetail(job, 'variatePassages', {
            status: 'skipped',
            label: `${item.book} · ${item.unit} · ${item.num}번`,
            desc: `변형 대상 아님 (${Math.round(variationRatio * 100)}% 범위 밖)`
          });
        }
        processed++;
        setPhaseProgress(job, 'variatePassages', processed / rankedKeys.length);
        job.subLabel = `지문 변형 ${processed}/${rankedKeys.length} (병렬)`;
        updateVarUI(job);
      });

      taskQueue.forEach(t => {
        const v = variantMap[keyOf(t.passage)];
        if (v && v.isVariant) {
          t.passage = Object.assign({}, t.passage, {
            passage: v.passage,
            _isVariant: true,
            _original: v.original,
            _changeNotes: v.changeNotes || ''
          });
        }
      });
      setPhaseProgress(job, 'variatePassages', 1);
      finalizePhaseDetails(job, 'variatePassages');
      job.phaseStates.variatePassages = 'done';
    }

    job.totalSteps = taskQueue.length;
    job.doneSteps = 0;
    job.phase = 'generate';
    job.phaseStates.generate = 'active';
    updateVarUI(job, `병렬 생성 시작: ${taskQueue.length}개 작업 · 재사용 ${job.reusedFromCache.length}문항`);

    // ── Phase 5: generate ──
    await runWithConcurrency(job, taskQueue, VARIANT_AI_CONCURRENCY, async (task) => {
      const { type, passage: p, thisObj, thisSub } = task;
      const sig = job.abortController.signal;
      if (sig.aborted) throw new Error('aborted');

      job._currentItem = { book: p.book, unit: p.unit, num: p.num };
      const genId = `gen_${type}_${keyOf(p)}_${thisObj}_${thisSub}`;
      pushPhaseDetail(job, 'generate', {
        id: genId,
        status: 'running',
        label: `[${type}] ${p.book} · ${p.unit} · ${p.num}번`,
        desc: `객 ${thisObj} · 주 ${thisSub} 생성 중...`
      });
      updateVarUI(job, `[${type}] ${p.unit}/${p.num} 생성 중... (객 ${thisObj}, 주 ${thisSub})`);

      const analysis = await loadAnalysisCache(p).catch(() => null);
      const combinedIntent = (job.studentWeakness
        ? `${intent}\n[학생 취약점: ${job.studentWeakness}] — 이 취약점을 겨냥한 문항으로 출제해주세요.`
        : intent);
      const prompt = buildVariantPrompt(type, diff, analysis, thisObj, thisSub, combinedIntent);

      let result = null, lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (sig.aborted) throw new Error('aborted');
        try {
          result = await callAITracked(job, job.provider, job.model, p.passage, prompt, sig, 'high');
          break;
        } catch (e) {
          lastErr = e;
          if (e && e.name === 'AbortError') throw new Error('aborted');
          if (/quota|rate limit|exhausted/i.test(e.message || '')) {
            job._apiBudgetReached = true;
            throw e;
          }
          if (attempt < 2) await new Promise(r => setTimeout(r, attempt === 0 ? 2000 : 5000));
        }
      }
      if (!result) {
        updatePhaseDetail(job, 'generate', genId, {
          status: 'failed',
          desc: (lastErr && lastErr.message) || '생성 실패'
        });
        throw lastErr || new Error('생성 실패');
      }

      const qs = Array.isArray(result.questions) ? result.questions : [];
      const stamped = qs.map(q => Object.assign({}, q, {
        id: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        book: p.book,
        unit: p.unit,
        num: p.num,
        _passage: p.passage,
        _isVariant: p._isVariant || false,
        _original: p._original || null,
        _changeNotes: p._changeNotes || '',
        createdAt: Date.now(),
        _fromCache: false
      }));

      const objGot = stamped.filter(q => q.format === 'obj').slice(0, thisObj);
      const subGot = stamped.filter(q => q.format === 'sub').slice(0, thisSub);
      const accepted = [...objGot, ...subGot];

      job.generated.push(...accepted);

      for (const q of accepted) {
        if (sig.aborted) return;
        const clean = Object.assign({}, q);
        delete clean._fromCache;
        delete clean._passage;
        delete clean._isVariant;
        delete clean._original;
        delete clean._changeNotes;
        await saveVariantQuestion(p, clean);
      }

      job.doneSteps++;
      const stemPreview = (accepted[0] && accepted[0].stem) ? String(accepted[0].stem).slice(0, 80) : '';
      updatePhaseDetail(job, 'generate', genId, {
        status: 'done',
        label: `[${type}] ${p.book} · ${p.unit} · ${p.num}번 · ${accepted.length}문항`,
        desc: stemPreview
      });
      setPhaseProgress(job, 'generate', job.doneSteps / Math.max(1, job.totalSteps));
      updateVarUI(job, `[${type}] ${p.unit}/${p.num} 완료`);
    });
    job.phaseStates.generate = 'done';
    setPhaseProgress(job, 'generate', 1);
    finalizePhaseDetails(job, 'generate');

    // ── 검증 ──
    if (job._plannedAssignments) {
      verifyPassageUsage(job.generated, job._plannedAssignments);
    }

    // ── Phase 6: 품질 검토 & 재출제 통합 파이프라인 ──
    if (qualityReview && job.generated.length && !job._apiBudgetReached) {
      job.phase = 'reviewQuality';
      job.phaseStates.reviewQuality = 'active';
      updateVarUI(job, '품질 파이프라인 시작 (문항별 병렬)...');
      let reviews = await runQualityPipeline(job, job.generated, { maxAttempts: 3 });
      const finalPassedCount = reviews.filter(r => r.passed).length;
      const finalFailedCount = reviews.length - finalPassedCount;
      const regeneratedCount = job.generated.filter(q => q && q._regenerated).length;
      console.info(`[variant] pipeline: ${finalPassedCount}/${reviews.length} passed, ${finalFailedCount} failed, ${regeneratedCount} regenerated`);
      job._reviewSummaryDesc = `${finalPassedCount}/${reviews.length} 통과 · ${finalFailedCount} 실패 · ${regeneratedCount}개 재출제`;
      job.phaseStates.reviewQuality = 'done';
      finalizePhaseDetails(job, 'reviewQuality');
      updateVarUI(job);

      // ── Phase 7: finalReview (시험지 전체 검토 + 자동 수정) ──
      job.phase = 'finalReview';
      job.phaseStates.finalReview = 'active';
      updateVarUI(job, '최종 시험지 검토 중...');

      const initialIssues = reviewPaper({ items: job.generated }, job._meta, diff);

      const fixResults = autoFixPaperIssues(job.generated);
      fixResults.forEach(r => {
        pushPhaseDetail(job, 'finalReview', {
          status: 'done',
          label: '자동 수정 적용',
          desc: r.summary
        });
      });

      const finalIssues = fixResults.length
        ? reviewPaper({ items: job.generated }, job._meta, diff)
        : initialIssues;

      const finalPassed = reviews.filter(r => r.passed).length;
      const fixedCount = fixResults.reduce((a, r) => a + (r.fixed || 0), 0);
      job._finalReviewDesc = `최종: ${finalPassed}/${reviews.length} 통과 · ${finalIssues.length}개 시험지 이슈${fixedCount ? ` · 자동 수정 ${fixedCount}건` : ''}`;

      finalIssues.forEach(issue => {
        const formatted = formatFinalIssue(issue);
        pushPhaseDetail(job, 'finalReview', {
          status: 'failed',
          label: formatted.label,
          desc: formatted.desc
        });
      });
      if (!finalIssues.length) {
        pushPhaseDetail(job, 'finalReview', {
          status: 'done',
          label: '시험지 전체 검토 완료',
          desc: `${finalPassed}/${reviews.length} 문항 통과 · 시험지 이슈 없음${fixedCount ? ` (자동 수정 ${fixedCount}건 적용됨)` : ''}`
        });
      }
      job._reviews = reviews;
      job.phaseStates.finalReview = 'done';
      setPhaseProgress(job, 'finalReview', 1);
      updateVarUI(job);
    } else if (job._apiBudgetReached && qualityReview) {
      job.phaseStates.reviewQuality = 'failed';
      job.phaseStates.finalReview = 'failed';
      job.subLabel = 'API 한도 도달 — 품질 검토 생략';
    }
  } catch (e) {
    if (e && e.message !== 'aborted') {
      console.error('[variant] runVariantPipeline error:', e);
    }
  }

  await finishVariantJob(job);
}

function groupByType(list) {
  const out = {};
  list.forEach(q => {
    const t = q.type || 'unknown';
    if (!out[t]) out[t] = [];
    out[t].push(q);
  });
  return out;
}

function buildVariantPrompt(type, diff, analysis, objCount, subCount, intent) {
  const diffMap = { low: '쉬움', mid: '보통', high: '어려움(수능 최고난도)' };
  const ctx = analysis ? `\n[참고 분석 컨텍스트]\n${JSON.stringify({
    meta: analysis.meta || null,
    grammar: analysis.grammar || null,
    vocab: analysis.vocab || null
  }, null, 1)}\n\n` : '';
  const tpl = VAR_PROMPTS[type] || VAR_PROMPTS['내용유추'];
  const base = ctx + tpl
    .replace(/DIFFICULTY_PLACEHOLDER/g, diffMap[diff] || '보통')
    .replace(/OBJ_COUNT_PLACEHOLDER/g, String(objCount))
    .replace(/SUB_COUNT_PLACEHOLDER/g, String(subCount));
  if (intent && intent.trim()) {
    return base + `\n\n[출제 의도 / 추가 요청]\n${intent.trim()}\n위 요청에 중점을 두어 문항을 출제해주세요.\n`;
  }
  return base;
}

// ══════════════════════════════════════
// 진행 UI
// ══════════════════════════════════════

// 특정 job 의 state 를 읽어 진행 카드에 렌더 (선택된 job 에만 DOM 반영)
function updateVarUI(job, label) {
  if (!job) return;
  if (label) {
    job.currentLabel = label;
    job.subLabel = label;
  }

  // 선택되지 않은 job 은 state 만 갱신, DOM 렌더 스킵
  if (variantJobManager && variantJobManager.selectedId !== job.id) {
    // 드롭다운 label 변경 반영 — in-place 업데이트 (열려있는 드롭다운 안 닫힘)
    if (variantJobManager) variantJobManager._updateSwitcherLabels();
    return;
  }

  const body = document.getElementById('varProgressBody');
  if (!body || typeof renderJobChecklist !== 'function') return;

  const done = job.doneSteps || 0;
  const genCnt = (job.generated || []).length;
  const reuseCnt = (job.reusedFromCache || []).length;
  const saveFailed = job._saveFailed || 0;

  const generateDesc = saveFailed > 0
    ? `신규 ${genCnt} · 재사용 ${reuseCnt} · 저장실패 ${saveFailed}`
    : `신규 ${genCnt} · 재사용 ${reuseCnt}`;

  const details = job._phaseDetails || {};
  const phaseProgress = job._phaseProgress || {};

  // Phase 리스트 구성
  const phases = [
    { id: 'prepare', label: '범위·옵션 확정', weight: PHASE_WEIGHTS.prepare },
    { id: 'scorePassages', label: '지문 점수화', desc: '중요도 · 난이도 · 유형 적합도', weight: PHASE_WEIGHTS.scorePassages, detailItems: details.scorePassages },
    { id: 'loadPrev', label: '이전 문제 풀 로드', desc: job.excludePrev ? '제외 옵션 (스킵)' : undefined, weight: PHASE_WEIGHTS.loadPrev }
  ];
  if (job.variation && job.variation !== 'none') {
    phases.push({ id: 'variatePassages', label: '지문 변형', desc: `변형도: ${job.variation}`, weight: PHASE_WEIGHTS.variatePassages, detailItems: details.variatePassages });
  }
  phases.push({ id: 'generate', label: 'AI 문항 생성', desc: generateDesc, weight: PHASE_WEIGHTS.generate, detailItems: details.generate });
  if (job.qualityReview) {
    phases.push({ id: 'reviewQuality', label: '품질 검토 & 재출제', desc: job._reviewSummaryDesc || undefined, weight: PHASE_WEIGHTS.reviewQuality, detailItems: details.reviewQuality });
    phases.push({ id: 'finalReview', label: '최종 시험지 검토', desc: job._finalReviewDesc || undefined, weight: PHASE_WEIGHTS.finalReview, detailItems: details.finalReview });
  }
  phases.push({ id: 'buildPdf', label: 'PDF 빌드', weight: PHASE_WEIGHTS.buildPdf });
  phases.push({ id: 'done', label: '완료', weight: PHASE_WEIGHTS.done });

  phases.forEach(p => { p.progress = phaseProgress[p.id] || 0; });

  const overallPct = computeOverallPct(job);

  const elapsedMs = job._startedAt ? (Date.now() - job._startedAt) : 0;
  const tokens = job._tokens || { input: 0, output: 0 };
  const costKrw = computeCostKrw(tokens, job.model);

  // headTitle: phase 상태에 따라 동적 결정
  let headTitle = '변형문제 생성 중';
  if (job.phase === 'cancelled') headTitle = '변형문제 — 중단됨';
  else if (job.phase === 'done') headTitle = '변형문제 — 완료';
  else if (job.phase === 'failed') headTitle = '변형문제 — 실패';

  renderJobChecklist(body, {
    headTitle,
    subLabel: job.subLabel || job.currentLabel || '',
    overallPct,
    elapsedMs,
    tokenUsage: tokens,
    costKrw,
    finalCostLine: job._finalCostLine || '',
    stats: {
      total: job.totalSteps || job.totalQ || 0,
      done,
      failed: 0
    },
    phases,
    phaseStates: job.phaseStates || {}
  });

  // 다운로드 영역 / 취소 버튼 상태는 JobManager 가 관리
  if (variantJobManager) {
    const cancelBtn = document.getElementById('varCancelBtn');
    if (cancelBtn) {
      // 레이아웃 시프트 방지 — display 대신 visibility 사용
      cancelBtn.style.visibility = variantJobManager.isJobRunning(job) ? 'visible' : 'hidden';
      cancelBtn.style.display = '';
    }
    // 드롭다운 라벨 갱신 (% 변화 반영) — in-place 업데이트 (드롭다운 안 닫힘)
    variantJobManager._updateSwitcherLabels();
  }
}

// 타이머 틱 — 특정 job 의 실시간 시간 업데이트
function tickVariantTimer(job) {
  if (!job) return;
  updateVarUI(job);
}

// 취소: 선택된 job 만 abort (또는 지정 id)
function cancelVariantJob(jobId) {
  if (!variantJobManager) return;
  const targetId = jobId || variantJobManager.selectedId;
  if (!targetId) return;
  const job = variantJobManager.getJob(targetId);
  if (job && job.abortController) {
    job.abortController.abort();
  }
}

async function finishVariantJob(job) {
  if (!job) return;
  const aborted = job.abortController.signal.aborted;

  let title = job.paperTitle || '변형문제';
  let summary = '';

  const genCnt = job.generated.length;
  const reuseCnt = job.reusedFromCache.length;
  summary = `신규 ${genCnt}문항 · 재사용 ${reuseCnt}문항 · 총 ${genCnt + reuseCnt}`;
  job._currentItem = null;
  job.subLabel = aborted ? '중단됨' : 'PDF 빌드 중...';
  if (!aborted) {
    job.phase = 'buildPdf';
    job.phaseStates.buildPdf = 'active';
  }
  updateVarUI(job);

  // PDF 빌드 (선택된 job 만 실제 DOM 에 다운로드 버튼 렌더됨)
  if (!aborted && (genCnt + reuseCnt) > 0) {
    try {
      const built = await buildVariantDownloads(job);
      if (built) {
        title = built.title || title;
      }
    } catch (e) {
      console.warn('[variant] buildVariantDownloads failed:', e && e.message);
    }
  }

  if (!aborted) {
    job.phaseStates.buildPdf = 'done';
    setPhaseProgress(job, 'buildPdf', 1);
    job.phase = 'done';
    job.phaseStates.done = 'done';
    const elapsed = Math.round((Date.now() - (job._startedAt || Date.now())) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const tokens = job._tokens || { input: 0, output: 0 };
    const costKrw = computeCostKrw(tokens, job.model);
    job._finalCostLine = `⏱ ${mins}분 ${secs}초 · 토큰 ${tokens.input.toLocaleString()}+${tokens.output.toLocaleString()} · 비용 ₩${Math.round(costKrw).toLocaleString()}`;
    job.subLabel = `완료! ${summary}`;
    // Firestore 에 사용량 기록
    recordUsageToFirestore(job).catch(() => {});
  } else {
    job.phase = 'cancelled';
    job.subLabel = `중단됨 — ${summary}`;
  }
  updateVarUI(job);

  // 타이머 정지
  if (job._timerInterval) {
    clearInterval(job._timerInterval);
    job._timerInterval = null;
  }

  // Manager 업데이트 (running count 변화 → 사이드바 인디케이터)
  if (variantJobManager) {
    variantJobManager.notifyPhaseChanged(job.id);
  }

  // 대시보드 완료 작업 등록
  if (typeof dashboardRegisterCompleted === 'function') {
    try {
      dashboardRegisterCompleted({
        kind: '변형문제 생성',
        title,
        summary,
        status: aborted ? 'aborted' : 'done',
        downloads: []
      });
    } catch (e) { /* ignore */ }
  }
}

// ══════════════════════════════════════
// 시험지 조립 + PDF
// ══════════════════════════════════════

function assembleTestPaper(job) {
  // Round 10 — 유형 그룹핑 제거. 객관식/서술형 섞어서 난이도 순으로 배치.
  // 연속으로 같은 유형/지문이 반복되지 않도록 분산 셔플 적용.
  const all = [...job.generated, ...job.reusedFromCache];
  if (!all.length) return { items: [], total: 0, objCount: 0, subCount: 0 };

  // 1) 난이도 기준 정렬 (쉬움 → 어려움)
  const sorted = all.slice().sort((a, b) => {
    const da = estimateDifficulty(a, job._meta);
    const db = estimateDifficulty(b, job._meta);
    return da - db;
  });

  // 2) 연속 분산: 같은 유형 또는 같은 지문이 연달아 오지 않도록 인접 교체
  //    단, 전체 난이도 흐름(쉬움→어려움)은 큰 틀에서 유지
  const spread = spreadQuestions(sorted);

  // 3) 번호 부여
  spread.forEach((q, i) => { q._num = i + 1; });

  const objCount = spread.filter(q => q.format === 'obj').length;
  const subCount = spread.filter(q => q.format === 'sub').length;
  return { items: spread, total: spread.length, objCount, subCount };
}

// 연속으로 같은 유형 또는 같은 지문이 반복되지 않도록 분산
// 알고리즘: 한 번의 패스로 인접한 문항 중 type/passageKey 가 동일하면
// 뒤쪽에서 다른 문항을 찾아 swap. 단, swap 거리는 짧게 유지해서 난이도 흐름 보존.
function spreadQuestions(list) {
  const out = list.slice();
  const passageKey = (q) => `${q.book}|${q.unit}|${q.num}`;
  const MAX_LOOKAHEAD = 4;   // 멀리 swap 안 함

  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const sameType = prev.type === cur.type;
    const samePassage = passageKey(prev) === passageKey(cur);
    if (!sameType && !samePassage) continue;

    // 뒤쪽 MAX_LOOKAHEAD 내에서 다른 유형 & 다른 지문 찾기
    for (let j = i + 1; j < Math.min(out.length, i + 1 + MAX_LOOKAHEAD); j++) {
      const cand = out[j];
      const candSameType = cand.type === prev.type;
      const candSamePassage = passageKey(cand) === passageKey(prev);
      if (!candSameType && !candSamePassage) {
        out[i] = cand;
        out[j] = cur;
        break;
      }
    }
  }
  return out;
}

// 문항별 난이도 추정 (AI 응답의 _difficulty 또는 지문 meta 기반)
function estimateDifficulty(q, meta) {
  if (typeof q._difficulty === 'number') return q._difficulty;
  if (meta) {
    const m = meta[keyOf(q)];
    if (m && typeof m.difficulty === 'number') return m.difficulty;
  }
  // fallback: stem 길이 + 지문 길이 단순 휴리스틱
  const stemLen = (q.stem || '').length;
  const passageLen = (q._passage || '').length;
  return 3 + Math.min(7, stemLen / 40 + passageLen / 600);
}

async function buildVariantDownloads(job) {
  if (!job) return null;
  const paper = assembleTestPaper(job);

  // 자동 부제목: 교재 + 단원명 나열 + 총 문항 수
  const items = job.items;
  const books = [...new Set(items.map(it => it.book))];
  const unitNamesOrdered = [];
  const seen = new Set();
  items.forEach(it => {
    const key = `${it.book}__${it.unit}`;
    if (!seen.has(key)) { seen.add(key); unitNamesOrdered.push(it.unit); }
  });
  const autoSubtitleParts = [];
  if (books.length === 1) autoSubtitleParts.push(books[0]);
  else autoSubtitleParts.push(`${books.length}개 교재`);
  if (unitNamesOrdered.length <= 6) {
    autoSubtitleParts.push(unitNamesOrdered.join(', '));
  } else {
    autoSubtitleParts.push(`${unitNamesOrdered.slice(0, 5).join(', ')} 외 ${unitNamesOrdered.length - 5}`);
  }
  autoSubtitleParts.push(`총 ${paper.total}문항 (객 ${paper.objCount} · 주 ${paper.subCount})`);
  const autoSubtitle = autoSubtitleParts.join('  ·  ');

  // 학생 이름이 있으면 title 자동 치환
  const title = job.studentName
    ? `${job.studentName} 학생 개인별 맞춤 모의고사`
    : (job.paperTitle || '변형문제');
  const subtitle = job.paperSubtitle || autoSubtitle;

  const mainSections = buildVariantSections(paper, items, { showAnswer: false }, job);
  const explainSections = buildVariantSections(paper, items, { showAnswer: true }, job);

  // Round 9 — 총평 AI 생성 (가능한 경우)
  if (!job._summaryAi) {
    try {
      const aiSummary = await generateSummaryCommentaryAI(job, paper);
      if (aiSummary) job._summaryAi = aiSummary;
    } catch (e) { /* fallback to local */ }
  }

  // Round 8 — 표지 + 총평 주입
  const coverHtml = job.includeCover ? buildCoverHtml(job, paper) : null;
  const summaryHtml = buildSummaryCommentary(job, paper, job._reviews);

  if (coverHtml) {
    mainSections.unshift({ fullWidth: true, html: coverHtml, pageBreakAfter: true });
    mainSections.splice(1, 0, { fullWidth: true, html: summaryHtml, pageBreakAfter: true });
  }

  const quickSection = { html: buildQuickAnswerHtml(paper), fullWidth: true };
  if (explainSections.length) explainSections[0].pageBreakBefore = true;
  let answerSections;
  if (coverHtml) {
    answerSections = [quickSection, ...explainSections];
  } else {
    answerSections = [
      { fullWidth: true, html: summaryHtml, pageBreakAfter: true },
      quickSection,
      ...explainSections
    ];
  }

  let answerKey = null;
  if (job.answerInline) answerKey = answerSections;

  const mainPdf = await buildPdfFromSections(mainSections, {
    title,
    subtitle,
    filename: safePdfFilename(title) + '.pdf',
    columns: 2,
    columnGutter: 6,
    atomicSections: true,
    answerKey,
    logoSrc: encodeURIComponent('송유근영어[가로].png')
  });

  let answerPdf = null;
  if (job.answerSeparate) {
    answerPdf = await buildPdfFromSections(answerSections, {
      title: '[해설] ' + title,
      subtitle,
      filename: safePdfFilename(title + '_해설') + '.pdf',
      columns: 2,
      columnGutter: 6,
      atomicSections: true,
      logoSrc: encodeURIComponent('송유근영어[가로].png')
    });
  }

  // job 에 다운로드 정보 저장 → JobManager 가 렌더 시 사용
  const mainId = `varDlMain_${job.id}`;
  const answerId = `varDlAnswer_${job.id}`;
  let html = '<div class="wb-download-row">';
  html += `<button class="wb-download-btn" data-role="var-dl-main">문제지</button>`;
  if (answerPdf) {
    html += `<button class="wb-download-btn answer" data-role="var-dl-answer">해설지</button>`;
  }
  html += '</div>';
  job._downloadsHtml = html;
  job._mainPdf = mainPdf;
  job._answerPdf = answerPdf;
  job._bindDownloads = (area) => {
    const dlMain = area.querySelector('[data-role="var-dl-main"]');
    if (dlMain) dlMain.addEventListener('click', () => mainPdf.save());
    if (answerPdf) {
      const dlAns = area.querySelector('[data-role="var-dl-answer"]');
      if (dlAns) dlAns.addEventListener('click', () => answerPdf.save());
    }
  };

  return { title };
}

// ── 시험지 섹션 빌드 ──
// 객관식과 주관식을 섞어서 하나의 리스트로 출제 (별도 섹션 헤더 없음).
function buildVariantSections(paper, items, { showAnswer }, job) {
  const sections = [];
  // 참고용 지문 맵 (원본 passage 조회용)
  const passageByKey = {};
  items.forEach((it, i) => {
    const key = `${it.book}__${it.unit}__${it.num}`;
    passageByKey[key] = Object.assign({}, it, { _pIdx: i + 1 });
  });

  // 섞인 문항 순서대로 렌더 (obj/sub 구분 헤더 없음)
  (paper.items || []).forEach(q => {
    const key = `${q.book}__${q.unit}__${q.num}`;
    const srcPassage = q._passage || (passageByKey[key] && passageByKey[key].passage) || '';
    const html = renderVariantQuestion(q, { showAnswer, srcPassage, job });
    sections.push({ html });
  });

  return sections;
}

// 안전한 HTML 허용 태그만 통과시키는 간단 sanitizer (markedPassage 용)
function sanitizeMarkedHtml(raw) {
  if (!raw) return '';
  // script/style 제거
  let s = String(raw).replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  // on* 속성 제거
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  // 허용 태그/엔티티 외는 모두 이스케이프 — 화이트리스트 방식
  const allowed = /<\/?(u|b|strong|em|br|sub|sup)\s*\/?>/gi;
  // 임시 placeholder 교체 → 이스케이프 → 복원
  const tokens = [];
  s = s.replace(allowed, (m) => {
    const i = tokens.length;
    tokens.push(m);
    return `\u0000TAG${i}\u0000`;
  });
  s = s.replace(/&(?!(?:amp|lt|gt|quot|#39|nbsp|#\d+);)/g, '&amp;')
       .replace(/</g, '&lt;')
       .replace(/>/g, '&gt;');
  s = s.replace(/\u0000TAG(\d+)\u0000/g, (_, i) => tokens[parseInt(i, 10)]);
  // <br> 정규화
  s = s.replace(/<br\s*\/?\s*>/gi, '<br>');
  return s;
}

// 원문 passage를 HTML로 안전 변환 (개행 → <br>)
function passageToHtml(text) {
  return escapeHtmlVar(text).replace(/\n/g, '<br>');
}

// 발문 내 부정·주의 키워드에 밑줄 (학생 실수 방지)
// escape 된 문자열에 적용 — 안전하게 <u> 만 삽입.
const STEM_HIGHLIGHT_PATTERN = /(가장 적절하지 않은|적절하지 않은|일치하지 않는|어법상 틀린|문맥상 적절하지 않은|틀린 것|잘못된 것|아닌 것|옳지 않은|않는|아닌|틀린|잘못된|NOT)/g;
function highlightStemKeywords(escapedStem) {
  return String(escapedStem || '').replace(STEM_HIGHLIGHT_PATTERN, '<u>$1</u>');
}

// 선지 블록 렌더 생략 판정 — 어법/어휘처럼 지문 내 <u>①②...</u>로 선지가 구성되는 유형
const TYPES_WITH_PASSAGE_CHOICES = new Set(['어법', '어휘/영영풀이', '삭제', '문장삽입']);
function shouldSkipChoicesBlock(q) {
  if (TYPES_WITH_PASSAGE_CHOICES.has(q.type)) return true;
  if (Array.isArray(q.choices) && q.choices.length) {
    const stripped = q.choices.map(c => String(c || '').replace(/[①②③④⑤\s.·、·]+/g, '').trim());
    if (stripped.every(s => !s)) return true;
  }
  return false;
}

// 빠른 정답(Quick Answer Key) HTML — 해설지 맨 앞에 전폭 배치
function buildQuickAnswerHtml(paper) {
  const all = paper.items ? [...paper.items].sort((a, b) => (a._num || 0) - (b._num || 0)) : [];
  const rows = all.map(q => {
    const ans = String(q.answer || '').trim() || '—';
    // 주관식 답은 긴 경우가 있어 앞 40자까지만 요약
    const shortAns = ans.length > 40 ? ans.slice(0, 40) + '…' : ans;
    return `
      <div style="display:flex;align-items:baseline;gap:6px;padding:4px 8px;border-bottom:1px dashed #e0e0e0">
        <span style="font-weight:800;color:#1a1a1a;min-width:26px">${q._num}.</span>
        <span style="color:#222;word-break:break-word">${escapeHtmlVar(shortAns)}</span>
      </div>
    `;
  }).join('');
  return `
    <div style="padding:8px 0 4px 0">
      <div style="font-size:15px;font-weight:800;color:#1a1a1a;margin:0 0 10px;padding-bottom:5px;border-bottom:2px solid #1a1a1a">
        빠른 정답
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0 12px;font-size:11px;line-height:1.5">
        ${rows}
      </div>
    </div>
  `;
}

function renderVariantQuestion(q, { showAnswer, srcPassage, job }) {
  const num = q._num || '?';
  const typeLabel = q.type || '';
  const stem = q.stem || '';
  const choices = Array.isArray(q.choices) ? q.choices : [];
  const passageSnippet = q.passageRef || '';

  // markedPassage 우선, 없으면 원본 passage
  const passageHtml = q.markedPassage
    ? sanitizeMarkedHtml(q.markedPassage)
    : passageToHtml(srcPassage || '');

  // stem/choices/explanation 내부의 HTML 태그(<br>, <b>, <u> 등)를 통과시키기 위해 sanitizer 사용
  const stemHtml = highlightStemKeywords(sanitizeMarkedHtml(stem));

  // 변형 뱃지 표시 조건: question 에 _isVariant 가 있고 showVariationBadge 가 true
  const showVariantBadge = q._isVariant && (job ? job.showVariationBadge : true);

  // Round 9: overflow 방지 — 긴 인라인 단어/브래킷 리스트도 줄바꿈되도록 overflow-wrap:anywhere
  const WRAP_STYLE = 'word-break:break-word;overflow-wrap:anywhere;';

  // 출처 라벨 ([수능특강(영어) 05강 04번 변형] 같은 표기)
  const sourceLabel = (q.book || q.unit || q.num)
    ? `[${escapeHtmlVar(q.book || '')}${q.unit ? ' ' + escapeHtmlVar(q.unit) : ''}${q.num != null ? ' ' + escapeHtmlVar(q.num) + '번' : ''} 변형]`
    : '';

  let h = `<div style="margin:6px 0 10px 0;padding:10px 12px;border:1px solid #e8e8e8;border-radius:6px;background:#fff;break-inside:avoid;max-width:100%;${WRAP_STYLE}">`;

  // 출처 (오른쪽 정렬, 주황색, 문제 헤더 위)
  if (sourceLabel) {
    h += `<div style="text-align:right;font-size:9px;font-weight:700;color:#d4620a;margin-bottom:3px;${WRAP_STYLE}">${sourceLabel}</div>`;
  }

  // 문제 헤더: 번호 + 유형 라벨 (+ 변형 뱃지)
  h += `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">`;
  h += `<div style="font-size:12px;font-weight:800;color:#1a1a1a;line-height:1.45;flex:1;min-width:0;${WRAP_STYLE}">${num}. ${stemHtml}${showVariantBadge ? '<span style="display:inline-block;font-size:8.5px;font-weight:800;color:#fff;background:linear-gradient(135deg,#e08a2a,#d4620a);padding:1px 6px;border-radius:3px;letter-spacing:0.04em;margin-left:5px;vertical-align:middle">변형</span>' : ''}</div>`;
  h += `<div style="font-size:9px;font-weight:700;color:#4f6ef7;background:#eef1fd;padding:2px 6px;border-radius:8px;white-space:nowrap;flex-shrink:0">${escapeHtmlVar(typeLabel)}</div>`;
  h += `</div>`;

  // ── 본문 지문 ──
  if (passageHtml) {
    h += `<div style="font-size:10.5px;line-height:1.7;color:#222;background:#fafafa;border:1px solid #eee;border-radius:4px;padding:8px 10px;margin-bottom:6px;text-align:justify;${WRAP_STYLE}">${passageHtml}</div>`;
  }

  // passageRef
  if (passageSnippet && !q.markedPassage) {
    h += `<div style="font-size:10px;line-height:1.6;color:#555;background:#fff;border-left:2px solid #bbb;padding:3px 8px;margin-bottom:6px;${WRAP_STYLE}"><b>참고:</b> ${sanitizeMarkedHtml(passageSnippet)}</div>`;
  }

  if (q.format === 'obj') {
    if (!shouldSkipChoicesBlock(q) && choices.length) {
      h += `<div style="font-size:10.5px;line-height:1.75;color:#222;${WRAP_STYLE}">`;
      choices.forEach(c => {
        h += `<div style="margin:2px 0;padding-left:14px;text-indent:-14px;${WRAP_STYLE}">${sanitizeMarkedHtml(String(c == null ? '' : c))}</div>`;
      });
      h += `</div>`;
    }
  } else {
    h += `<div style="margin-top:4px;border:1px dashed #bbb;border-radius:4px;padding:16px 8px;min-height:45px;font-size:9px;color:#bbb;text-align:center">답란</div>`;
  }

  if (showAnswer) {
    h += `<div style="margin-top:8px;padding:6px 8px;background:#edfcf2;border-left:3px solid #2da05a;border-radius:3px;${WRAP_STYLE}">`;
    h += `<div style="font-size:10px;font-weight:700;color:#2da05a;margin-bottom:3px;${WRAP_STYLE}">정답: ${sanitizeMarkedHtml(String(q.answer == null ? '' : q.answer))}</div>`;
    if (q.explanation) {
      h += `<div style="font-size:9.5px;color:#444;line-height:1.55;white-space:pre-wrap;${WRAP_STYLE}">${sanitizeMarkedHtml(String(q.explanation))}</div>`;
    }
    h += `</div>`;

    if (q._isVariant && q._original) {
      h += `<div style="margin-top:8px;padding:8px 10px;background:#fef6ec;border:1px solid #fbe0bc;border-radius:5px;${WRAP_STYLE}">`;
      h += `<div style="font-size:9px;font-weight:800;color:#d4620a;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:4px">원문</div>`;
      h += `<div style="font-size:9.5px;line-height:1.6;color:#333;background:#fff;border:1px solid #efe5d5;border-radius:3px;padding:6px 8px;${WRAP_STYLE}">${passageToHtml(String(q._original))}</div>`;
      if (q._changeNotes) {
        h += `<div style="font-size:9px;font-weight:800;color:#d4620a;letter-spacing:0.05em;text-transform:uppercase;margin:6px 0 3px">주요 변경</div>`;
        h += `<div style="font-size:9px;line-height:1.5;color:#6b5628;font-style:italic;white-space:pre-wrap;${WRAP_STYLE}">${sanitizeMarkedHtml(String(q._changeNotes))}</div>`;
      }
      h += `</div>`;
    }
  }

  h += `</div>`;
  return h;
}

function escapeHtmlVar(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
