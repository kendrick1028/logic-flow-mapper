// ══════════════════════════════════════════════════════════════
// 어휘 문제(Vocab Quiz) — 단어장(지문과 별개) → 예문·문제 생성 → 변형문제 PDF/UI 재사용
// ══════════════════════════════════════════════════════════════

// 문제 유형 (key + 한국어 라벨)
const VQ_TYPE_LIST = [
  { key: 'vocab-usage',   label: '밑줄 단어 쓰임(문장)' },
  { key: 'vocab-blank',   label: '빈칸 단어 매칭' },
  { key: 'vocab-passage', label: '지문 밑줄 어휘(수능30형)' },
  { key: 'vocab-synonym', label: '동의어 고르기' },
  { key: 'vocab-antonym', label: '반의어 고르기' },
  { key: 'vocab-def',     label: '영영풀이 매칭' }
];
const VQ_LABEL_BY_KEY = Object.fromEntries(VQ_TYPE_LIST.map(t => [t.key, t.label]));

// ── 단어장 저장소 (Firestore word_banks + localStorage 미러) ──
let wordBanks = {};            // { id: {id,name,words:[{word,meaningKo}], ownerUid?} }
let _vqSelected = {};          // { bankId: true } — 출제에 사용할 단어장
let _editingBankId = null;
let vqJobManager = null;

const VQ_LS_KEY = 'lfm_word_banks';

function loadWordBanksLocal() {
  try { wordBanks = JSON.parse(localStorage.getItem(VQ_LS_KEY) || '{}') || {}; }
  catch (e) { wordBanks = {}; }
}
function saveWordBanksLocal() {
  try { localStorage.setItem(VQ_LS_KEY, JSON.stringify(wordBanks)); } catch (e) {}
}
async function loadWordBanksFromFirestore() {
  if (typeof db === 'undefined' || !currentUser) return;
  try {
    const snap = await db.collection('word_banks').where('ownerUid', '==', currentUser.uid).get();
    snap.forEach(doc => { const d = doc.data(); if (d && d.id) wordBanks[d.id] = d; });
    saveWordBanksLocal();
    renderVqBankList();
  } catch (e) { console.warn('[vocab] firestore load failed', e && e.message); }
}
async function persistWordBank(bank) {
  if (typeof db === 'undefined' || !currentUser) return;
  try {
    await db.collection('word_banks').doc(bank.id).set({
      ...bank,
      ownerUid: currentUser.uid,
      ownerEmail: currentUser.email || '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) { console.warn('[vocab] firestore save failed', e && e.message); }
}
async function deleteWordBankFromDb(id) {
  if (typeof db === 'undefined' || !currentUser) return;
  try { await db.collection('word_banks').doc(id).delete(); }
  catch (e) { console.warn('[vocab] firestore delete failed', e && e.message); }
}

// 텍스트 → [{word, meaningKo}]  (한 줄에 하나, "단어" 또는 "단어, 뜻" / 탭 구분)
function parseWordsText(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t) return;
    const m = t.split(/\s*[,\t]\s*|\s{2,}/);
    const word = (m[0] || '').trim();
    if (!word) return;
    const meaningKo = (m.slice(1).join(', ') || '').trim();
    out.push({ word, meaningKo });
  });
  return out;
}

// ── 초기화 ──
function initVocabQuiz() {
  if (!document.getElementById('vqBankList')) return;
  loadWordBanksLocal();
  renderVqBankList();
  loadWordBanksFromFirestore();   // 비동기 — 끝나면 재렌더

  if (!vqJobManager && typeof JobManager !== 'undefined') {
    vqJobManager = new JobManager({
      featureKey: 'vocabquiz',
      switcherId: 'vqJobSwitcher',
      progressBodyId: 'vqProgressBody',
      downloadCardId: 'vqDownloadsCard',
      downloadAreaId: 'vqDownloadArea',
      cancelBtnId: 'vqCancelBtn',
      emptyStateId: 'vqEmptyState',
      labelFn: (job) => {
        const pct = job.total ? Math.round((job.done + job.failed) / job.total * 100) : 0;
        const status = job.phase === 'cancelled' ? '중단' : job.phase === 'done' ? '완료' : `${pct}%`;
        return `${job.paperTitle || '어휘 문제'} (${status})`;
      },
      renderFn: (job) => updateVqUI(job),
      onRemove: (job) => { if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; } }
    });
    if (typeof window !== 'undefined') { window._jobManagers = window._jobManagers || {}; window._jobManagers.vocabquiz = vqJobManager; }
    vqJobManager.renderSelected();
  }

  // provider/model
  if (typeof AI_MODELS !== 'undefined') {
    const provSel = document.getElementById('vqProvider');
    const modelSel = document.getElementById('vqModel');
    if (provSel && modelSel && !provSel._filled) {
      provSel._filled = true;
      const provLabels = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI' };
      [...new Set(AI_MODELS.map(m => m.provider))].forEach(p => {
        const o = document.createElement('option'); o.value = p; o.textContent = provLabels[p] || p; provSel.appendChild(o);
      });
      provSel.addEventListener('change', updateVqModelOptions);
      if (typeof selectClaudeDefault === 'function') selectClaudeDefault('vqProvider', updateVqModelOptions);
      else updateVqModelOptions();
    }
  }
  if (typeof populateEffortSelect === 'function') populateEffortSelect('vqEffort');
  if (typeof wireFastToggle === 'function') wireFastToggle('vqFast', 'vqEffort');
  renderVqTypeDropdown();
  bindVqTypeDropdown();
}

function updateVqModelOptions() {
  const provider = document.getElementById('vqProvider').value;
  const modelSel = document.getElementById('vqModel');
  modelSel.innerHTML = '';
  AI_MODELS.filter(m => m.provider === provider).forEach(m => {
    const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; modelSel.appendChild(o);
  });
}

// ── 단어장 선택기 렌더 ──
function renderVqBankList() {
  const el = document.getElementById('vqBankList');
  if (!el) return;
  const ids = Object.keys(wordBanks);
  if (!ids.length) {
    el.innerHTML = '<div class="vq-bank-empty">저장된 단어장이 없습니다.<br>아래 [+ 새 단어장] 으로 추가하세요.</div>';
    updateVqBankSummary();
    return;
  }
  el.innerHTML = ids.map(id => {
    const b = wordBanks[id];
    const cnt = (b.words || []).length;
    const sel = _vqSelected[id] ? 'active' : '';
    return `<label class="vq-bank-item ${sel}" data-bank="${esc(id)}">
      <input type="checkbox" ${_vqSelected[id] ? 'checked' : ''} onchange="toggleVqBank('${esc(id)}', this.checked)">
      <span class="vq-bank-name">${esc(b.name || '(이름 없음)')}</span>
      <span class="vq-bank-count">${cnt}</span>
    </label>`;
  }).join('');
  updateVqBankSummary();
}
function toggleVqBank(id, checked) {
  if (checked) _vqSelected[id] = true; else delete _vqSelected[id];
  const item = document.querySelector(`.vq-bank-item[data-bank="${CSS.escape(id)}"]`);
  if (item) item.classList.toggle('active', !!checked);
  updateVqBankSummary();
}
function updateVqBankSummary() {
  const el = document.getElementById('vqBankSummary');
  if (!el) return;
  const ids = Object.keys(_vqSelected).filter(id => wordBanks[id]);
  const words = ids.reduce((s, id) => s + (wordBanks[id].words || []).length, 0);
  el.textContent = `선택된 단어장: ${ids.length}개 · 단어 ${words}개`;
}

// ── 단어장 관리 모달 ──
function openWordBankModal(id) {
  _editingBankId = id || null;
  const modal = document.getElementById('wordBankModal');
  const title = document.getElementById('wordBankModalTitle');
  const nameEl = document.getElementById('wordBankName');
  const wordsEl = document.getElementById('wordBankWords');
  const msg = document.getElementById('wordBankMsg');
  if (msg) msg.textContent = '';
  if (id && wordBanks[id]) {
    title.textContent = '단어장 편집';
    nameEl.value = wordBanks[id].name || '';
    wordsEl.value = (wordBanks[id].words || []).map(w => w.meaningKo ? `${w.word}, ${w.meaningKo}` : w.word).join('\n');
  } else {
    title.textContent = '새 단어장';
    nameEl.value = '';
    wordsEl.value = '';
  }
  modal.style.display = 'flex';
}
function closeWordBankModal() {
  const modal = document.getElementById('wordBankModal');
  if (modal) modal.style.display = 'none';
  _editingBankId = null;
}
async function saveWordBankFromModal() {
  const name = (document.getElementById('wordBankName').value || '').trim();
  const words = parseWordsText(document.getElementById('wordBankWords').value);
  const msg = document.getElementById('wordBankMsg');
  if (!name) { if (msg) msg.textContent = '단어장 이름을 입력하세요.'; return; }
  if (!words.length) { if (msg) msg.textContent = '단어를 한 개 이상 입력하세요.'; return; }
  const id = _editingBankId || `wb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const existing = wordBanks[id] || {};
  wordBanks[id] = { ...existing, id, name, words, createdAt: existing.createdAt || Date.now() };
  saveWordBanksLocal();
  await persistWordBank(wordBanks[id]);
  if (_editingBankId == null) _vqSelected[id] = true;  // 새로 만들면 자동 선택
  renderVqBankList();
  closeWordBankModal();
}
function editSelectedWordBank() {
  const ids = Object.keys(_vqSelected).filter(id => wordBanks[id]);
  if (ids.length !== 1) { alert('편집할 단어장 1개만 체크해주세요.'); return; }
  openWordBankModal(ids[0]);
}
async function deleteSelectedWordBank() {
  const ids = Object.keys(_vqSelected).filter(id => wordBanks[id]);
  if (!ids.length) { alert('삭제할 단어장을 체크해주세요.'); return; }
  if (!confirm(`${ids.length}개 단어장을 삭제할까요?`)) return;
  for (const id of ids) { delete wordBanks[id]; delete _vqSelected[id]; await deleteWordBankFromDb(id); }
  saveWordBanksLocal();
  renderVqBankList();
}

// ── 문제 유형 멀티드롭다운 ──
function renderVqTypeDropdown() {
  const panel = document.querySelector('#vqTypeDropdown .multi-dropdown-panel');
  if (!panel) return;
  const selectAll = panel.querySelector('.multi-dropdown-select-all');
  const divider = panel.querySelector('.multi-dropdown-divider');
  panel.innerHTML = '';
  if (selectAll) panel.appendChild(selectAll);
  if (divider) panel.appendChild(divider);
  VQ_TYPE_LIST.forEach(t => {
    const lbl = document.createElement('label');
    lbl.className = 'multi-dropdown-item';
    lbl.innerHTML = `<input type="checkbox" value="${esc(t.key)}"><span>${esc(t.label)}</span>`;
    panel.appendChild(lbl);
  });
  const dd = document.getElementById('vqTypeDropdown');
  if (dd) dd.classList.remove('open');
  updateVqTypeLabel();
}
function updateVqTypeLabel() {
  const labelEl = document.querySelector('#vqTypeDropdown .multi-dropdown-label');
  if (!labelEl) return;
  const sel = getSelectedVqTypes().map(k => VQ_LABEL_BY_KEY[k] || k);
  if (!sel.length) { labelEl.textContent = '선택하세요'; labelEl.classList.add('placeholder'); }
  else if (sel.length <= 2) { labelEl.textContent = sel.join(', '); labelEl.classList.remove('placeholder'); }
  else { labelEl.textContent = `${sel.slice(0, 2).join(', ')} 외 ${sel.length - 2}`; labelEl.classList.remove('placeholder'); }
}
function bindVqTypeDropdown() {
  const dd = document.getElementById('vqTypeDropdown');
  if (!dd || dd._bound) return;
  dd._bound = true;
  dd.classList.remove('open');
  const btn = dd.querySelector('.multi-dropdown-btn');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('open'); });
  dd.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.type !== 'checkbox') return;
    if (t.dataset && t.dataset.role === 'select-all') {
      dd.querySelectorAll('input[type=checkbox]:not([data-role="select-all"])').forEach(cb => { cb.checked = t.checked; });
    } else {
      const all = dd.querySelectorAll('input[type=checkbox]:not([data-role="select-all"])');
      const checked = dd.querySelectorAll('input[type=checkbox]:checked:not([data-role="select-all"])');
      const sa = dd.querySelector('input[data-role="select-all"]');
      if (sa) { sa.checked = all.length > 0 && checked.length === all.length; sa.indeterminate = checked.length > 0 && checked.length < all.length; }
    }
    updateVqTypeLabel();
  });
  document.addEventListener('click', (e) => { if (!dd.contains(e.target)) dd.classList.remove('open'); });
}
function getSelectedVqTypes() {
  const out = [];
  document.querySelectorAll('#vqTypeDropdown input[type=checkbox]:checked').forEach(cb => {
    if (cb.dataset && cb.dataset.role === 'select-all') return;
    out.push(cb.value);
  });
  return out;
}

// ── 출제 ──
function startVqJob() {
  const ids = Object.keys(_vqSelected).filter(id => wordBanks[id]);
  if (!ids.length) { alert('단어장을 한 개 이상 선택해주세요.'); return; }
  const types = getSelectedVqTypes();
  if (!types.length) { alert('문제 유형을 한 개 이상 선택해주세요.'); return; }
  const objN = parseInt(document.getElementById('vqObj').value || '0', 10);
  if (objN <= 0) { alert('객관식 개수를 입력해주세요.'); return; }

  // 단어 풀 평탄화 + 셔플
  const pool = [];
  ids.forEach(id => (wordBanks[id].words || []).forEach(w => pool.push(w)));
  if (pool.length < 5) { alert('선택한 단어장의 단어가 5개 이상이어야 합니다.'); return; }
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }

  const bankNames = ids.map(id => wordBanks[id].name).filter(Boolean);

  const job = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `vq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'vocabquiz', uiPrefix: 'vq',
    pool, bankNames,
    objN, total: objN, done: 0, failed: 0,
    diff: document.getElementById('vqDiff').value,
    typesSel: types,
    provider: document.getElementById('vqProvider').value,
    model: document.getElementById('vqModel').value,
    effort: (document.getElementById('vqEffort') || {}).value || (typeof DEFAULT_EFFORT !== 'undefined' ? DEFAULT_EFFORT : 'high'),
    fast: !!document.getElementById('vqFast')?.checked,
    includeCover: !!document.getElementById('vqIncludeCover')?.checked,
    answerSeparate: !!document.getElementById('vqAnswerSeparate')?.checked,
    answerInline: !document.getElementById('vqAnswerSeparate')?.checked,
    paperTitle: (document.getElementById('vqPaperTitle').value || '').trim() || '어휘 문제',
    paperSubtitle: (document.getElementById('vqPaperSubtitle').value || '').trim(),
    generated: [],
    abortController: new AbortController(),
    phase: 'prepare',
    phaseStates: { prepare: 'active', generate: 'pending', buildPdf: 'pending', done: 'pending' },
    _tokens: { input: 0, output: 0, calls: 0 },
    _startedAt: Date.now(), _timerInterval: null,
    _downloadsHtml: '', _bindDownloads: null, _mainPdf: null, _answerPdf: null
  };

  if (vqJobManager) vqJobManager.addJob(job);
  if (typeof setPanelRunning === 'function') setPanelRunning('vocabquiz', true);
  job._timerInterval = setInterval(() => updateVqUI(job), 1000);
  runVqPipeline(job).finally(() => { if (typeof updateSidebarIndicators === 'function') updateSidebarIndicators(); });
}

function cancelVqJob(jobId) {
  if (!vqJobManager) return;
  const job = vqJobManager.getJob(jobId || vqJobManager.selectedId);
  if (job && job.abortController) job.abortController.abort();
}

// 유형별 문항 수 균등 분배
function distributeVqTypes(total, types) {
  const per = {};
  types.forEach(t => per[t] = 0);
  for (let i = 0; i < total; i++) per[types[i % types.length]]++;
  // flat demand list
  const demand = [];
  types.forEach(t => { for (let i = 0; i < per[t]; i++) demand.push(t); });
  // 셔플 (유형 섞기)
  for (let i = demand.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [demand[i], demand[j]] = [demand[j], demand[i]]; }
  return demand;
}

async function runVqPipeline(job) {
  job.phase = 'running'; job.phaseStates.prepare = 'done'; job.phaseStates.generate = 'active';
  updateVqUI(job);
  const sig = job.abortController.signal;

  const demand = distributeVqTypes(job.objN, job.typesSel);
  let poolIdx = 0;
  const pickWords = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) { out.push(job.pool[poolIdx % job.pool.length]); poolIdx++; }
    return out;
  };

  const tasks = demand.map((type, qi) => async () => {
    if (sig.aborted) return;
    const words5 = pickWords(5);
    const prompt = buildVocabQuizPrompt(type, job.diff, 1);
    const wordsMsg = `단어 목록 JSON:\n${JSON.stringify(words5)}\n\n위 단어들로 문제를 출제하세요.`;
    let q = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && !q; attempt++) {
      if (sig.aborted) throw new Error('aborted');
      try {
        const r = await callAI(job.provider, job.model, wordsMsg, prompt, sig, null, job.effort, job.fast);
        if (r && r.usage) { job._tokens.input += r.usage.input_tokens || 0; job._tokens.output += r.usage.output_tokens || 0; job._tokens.calls++; }
        const arr = r && r.parsed && Array.isArray(r.parsed.questions) ? r.parsed.questions : (r && r.parsed && r.parsed.stem ? [r.parsed] : []);
        if (arr.length && arr[0] && arr[0].stem) q = arr[0];
      } catch (e) { lastErr = e; if (e && e.message === 'aborted') throw e; if (attempt < 2) await new Promise(rs => setTimeout(rs, attempt === 0 ? 2000 : 5000)); }
    }
    if (!q) { job.failed++; updateVqUI(job); return; }
    job.generated.push(Object.assign({}, q, { type, format: 'obj', id: `${job.id}_${qi}` }));
    job.done++;
    setPhaseProgress(job, 'generate', (job.done + job.failed) / Math.max(1, job.total));
    updateVqUI(job);
  });

  await Promise.all(tasks.map(t => t()));
  job.phaseStates.generate = 'done';
  await finishVqJob(job);
}

async function finishVqJob(job) {
  const aborted = job.abortController.signal.aborted;
  if (!aborted && job.generated.length > 0) {
    job.phase = 'buildPdf'; job.phaseStates.buildPdf = 'active'; updateVqUI(job);
    try { await buildVocabDownloads(job); }
    catch (e) { console.warn('[vocab] build downloads failed', e && e.message); }
    job.phaseStates.buildPdf = 'done';
  }
  job.phase = aborted ? 'cancelled' : 'done';
  job.phaseStates.done = aborted ? 'pending' : 'done';
  if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; }
  updateVqUI(job);
  if (vqJobManager) vqJobManager.notifyPhaseChanged(job.id);
}

// 문항 정렬 + 번호 부여 → paper (변형문제 조립과 호환되는 형태)
function assembleVocabPaper(job) {
  const items = job.generated.slice();
  // 같은 유형 연속 방지 셔플
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  items.forEach((q, i) => { q._num = i + 1; });
  return { items, total: items.length, objCount: items.length, subCount: 0 };
}

async function buildVocabDownloads(job) {
  const paper = assembleVocabPaper(job);
  const title = job.paperTitle || '어휘 문제';
  const subtitle = job.paperSubtitle ||
    `${job.bankNames.slice(0, 3).join(', ')}${job.bankNames.length > 3 ? ' 외 ' + (job.bankNames.length - 3) : ''}  ·  총 ${paper.total}문항`;

  // 변형문제 섹션 빌더/렌더 재사용 (지문 비종속)
  const mainSections = buildVariantSections(paper, [], { showAnswer: false }, job);
  const explainSections = buildVariantSections(paper, [], { showAnswer: true }, job);
  if (explainSections.length) explainSections[0].pageBreakBefore = true;

  if (job.includeCover) {
    const cover = `<div style="padding:60px 0 40px;text-align:center">
      <div style="font-size:30px;font-weight:800;color:#1a1a1a;letter-spacing:-.5px">${escVqHtml(title)}</div>
      <div style="font-size:14px;color:#666;margin-top:14px">${escVqHtml(subtitle)}</div>
    </div>`;
    mainSections.unshift({ fullWidth: true, html: cover, pageBreakAfter: true });
  }

  const quickSection = { html: buildQuickAnswerHtml(paper), fullWidth: true };
  const answerSections = [quickSection, ...explainSections];
  const answerKey = job.answerInline ? answerSections : null;

  const mainPdf = await buildPdfFromSections(mainSections, {
    title, subtitle, filename: (typeof safePdfFilename === 'function' ? safePdfFilename(title) : title) + '.pdf',
    columns: 2, columnGutter: 6, atomicSections: true, answerKey
  });
  let answerPdf = null;
  if (job.answerSeparate) {
    answerPdf = await buildPdfFromSections(answerSections, {
      title: '[해설] ' + title, subtitle,
      filename: (typeof safePdfFilename === 'function' ? safePdfFilename(title + '_해설') : title + '_해설') + '.pdf',
      columns: 2, columnGutter: 6, atomicSections: true
    });
  }

  let html = '<div class="wb-download-row">';
  html += `<button class="wb-download-btn" data-role="vq-dl-main">문제지</button>`;
  if (answerPdf) html += `<button class="wb-download-btn answer" data-role="vq-dl-answer">해설지</button>`;
  html += '</div>';
  job._downloadsHtml = html;
  job._mainPdf = mainPdf; job._answerPdf = answerPdf;
  job._bindDownloads = (area) => {
    const m = area.querySelector('[data-role="vq-dl-main"]');
    if (m) m.addEventListener('click', () => mainPdf.save());
    if (answerPdf) { const a = area.querySelector('[data-role="vq-dl-answer"]'); if (a) a.addEventListener('click', () => answerPdf.save()); }
  };
}

function escVqHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function updateVqUI(job) {
  if (!job) return;
  if (vqJobManager && vqJobManager.selectedId !== job.id) { vqJobManager._updateSwitcherLabels(); return; }
  const body = document.getElementById('vqProgressBody');
  if (!body || typeof renderJobChecklist !== 'function') return;
  const done = job.done || 0, failed = job.failed || 0, total = job.total || 0;
  let headTitle = '어휘 문제 생성 중';
  if (job.phase === 'cancelled') headTitle = '어휘 문제 — 중단됨';
  else if (job.phase === 'done') headTitle = '어휘 문제 — 완료';
  const elapsedMs = job._startedAt ? (Date.now() - job._startedAt) : 0;
  const tokens = job._tokens || { input: 0, output: 0 };
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;
  const costKrw = (typeof computeCostUsd === 'function') ? computeCostUsd(tokens, job.model) * rate : 0;
  renderJobChecklist(body, {
    headTitle,
    subLabel: job.phase === 'done' ? `✅ 완료 — ${done}문항${failed ? ` · 실패 ${failed}` : ''}` : `🔄 ${done + failed}/${total} 문항 생성`,
    elapsedMs,
    tokenUsage: (tokens.input || tokens.output) ? { input: tokens.input, output: tokens.output } : null,
    costKrw,
    stats: { total, done, failed },
    phases: [
      { id: 'prepare', label: '단어장·옵션 확정' },
      { id: 'generate', label: 'AI 어휘 문제 생성', desc: `${done + failed}/${total} 문항` },
      { id: 'buildPdf', label: 'PDF 빌드' },
      { id: 'done', label: '완료' }
    ],
    phaseStates: job.phaseStates || {}
  });
  if (vqJobManager) {
    const cancelBtn = document.getElementById('vqCancelBtn');
    if (cancelBtn) { cancelBtn.style.visibility = vqJobManager.isJobRunning(job) ? 'visible' : 'hidden'; cancelBtn.style.display = ''; }
    vqJobManager._updateSwitcherLabels();
  }
}

if (typeof window !== 'undefined') {
  window.initVocabQuiz = initVocabQuiz;
  window.startVqJob = startVqJob;
  window.cancelVqJob = cancelVqJob;
  window.toggleVqBank = toggleVqBank;
  window.openWordBankModal = openWordBankModal;
  window.closeWordBankModal = closeWordBankModal;
  window.saveWordBankFromModal = saveWordBankFromModal;
  window.editSelectedWordBank = editSelectedWordBank;
  window.deleteSelectedWordBank = deleteSelectedWordBank;
}
