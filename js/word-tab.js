// ══════════════════════════════════════
// 단어 탭 — 어휘 전용 일괄 생성
// ──────────────────────────────────────
// 일괄 상세분석과 동일한 범위선택 UI. 선택 지문에서 VOCABULARY_PROMPT 만 호출해
// 어휘를 추출/정리하고, 기존 .vocab-grid 양식으로 2열 PDF 를 만든다.
// Firestore analyses/{docId}.vocab 에 병합 저장 (기존 캐시 활용).
// ══════════════════════════════════════

let wordJobManager = null;

function initWordTab() {
  const tree = document.getElementById('wordRangeTree');
  if (!tree || typeof BOOKS === 'undefined') return;

  if (!wordJobManager && typeof JobManager !== 'undefined') {
    wordJobManager = new JobManager({
      featureKey: 'word',
      switcherId: 'wordJobSwitcher',
      progressBodyId: 'wordProgressBody',
      downloadCardId: 'wordDownloadsCard',
      downloadAreaId: 'wordDownloadArea',
      cancelBtnId: 'wordCancelBtn',
      emptyStateId: 'wordEmptyState',
      labelFn: (job) => {
        const pct = job.total ? Math.round((job.done + job.failed) / job.total * 100) : 0;
        const status = job.phase === 'cancelled' ? '중단' : job.phase === 'done' ? '완료' : `${pct}%`;
        return `단어 (${status})`;
      },
      renderFn: (job) => updateWordUI(job),
      onRemove: (job) => { if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; } }
    });
    if (typeof window !== 'undefined') {
      window._jobManagers = window._jobManagers || {};
      window._jobManagers.word = wordJobManager;
    }
    wordJobManager.renderSelected();
  }

  initRangeTree(tree, updateWordRangeSummary);
  updateWordRangeSummary();

  if (typeof AI_MODELS !== 'undefined') {
    const provSel = document.getElementById('wordProvider');
    const modelSel = document.getElementById('wordModel');
    if (provSel && modelSel) {
      const provLabels = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI' };
      [...new Set(AI_MODELS.map(m => m.provider))].forEach(p => {
        const o = document.createElement('option'); o.value = p; o.textContent = provLabels[p] || p; provSel.appendChild(o);
      });
      provSel.addEventListener('change', updateWordModelOptions);
      if (typeof selectClaudeDefault === 'function') selectClaudeDefault('wordProvider', updateWordModelOptions);
      else updateWordModelOptions();
    }
  }
  if (typeof populateEffortSelect === 'function') populateEffortSelect('wordEffort');
  if (typeof wireFastToggle === 'function') wireFastToggle('wordFast', 'wordEffort');
}

function updateWordModelOptions() {
  const provider = document.getElementById('wordProvider').value;
  const modelSel = document.getElementById('wordModel');
  modelSel.innerHTML = '';
  AI_MODELS.filter(m => m.provider === provider).forEach(m => {
    const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; modelSel.appendChild(o);
  });
}

function updateWordRangeSummary() {
  const el = document.getElementById('wordRangeSummary');
  const tree = document.getElementById('wordRangeTree');
  if (!el || !tree) return;
  const n = (typeof getRangeSelectionCount === 'function') ? getRangeSelectionCount(tree) : 0;
  el.textContent = `선택된 지문: ${n}개`;
}

function startWordJob() {
  const tree = document.getElementById('wordRangeTree');
  const items = (typeof getRangeSelection === 'function') ? getRangeSelection(tree) : [];
  if (!items.length) { alert('지문을 한 개 이상 선택해주세요.'); return; }

  const provider = document.getElementById('wordProvider').value;
  const model = document.getElementById('wordModel').value;
  const fast = !!document.getElementById('wordFast')?.checked;
  const effort = (document.getElementById('wordEffort') || {}).value || DEFAULT_EFFORT;
  const force = !!document.getElementById('wordForce')?.checked;

  const job = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `word_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'word',
    queue: items, total: items.length, done: 0, failed: 0, skipped: 0,
    provider, model, effort, fast, force,
    results: {},      // docId → 'done'|'skipped'|'failed'|'running'
    vocabByDoc: {},   // docId → { item, titleKo, vocabulary }
    abortController: new AbortController(),
    phase: 'prepare',
    phaseStates: { prepare: 'active', generate: 'pending', buildPdf: 'pending', done: 'pending' },
    _tokens: { input: 0, output: 0, calls: 0 },
    _startedAt: Date.now(), _timerInterval: null,
    _downloadsHtml: '', _bindDownloads: null
  };

  if (wordJobManager) wordJobManager.addJob(job);
  if (typeof setPanelRunning === 'function') setPanelRunning('word', true);
  job._timerInterval = setInterval(() => updateWordUI(job), 1000);
  runWordPipeline(job).finally(() => { if (typeof updateSidebarIndicators === 'function') updateSidebarIndicators(); });
}

function cancelWordJob(jobId) {
  if (!wordJobManager) return;
  const targetId = jobId || wordJobManager.selectedId;
  const job = wordJobManager.getJob(targetId);
  if (job && job.abortController) job.abortController.abort();
}

async function runWordPipeline(job) {
  job.phase = 'running';
  job.phaseStates.prepare = 'done';
  job.phaseStates.generate = 'active';
  updateWordUI(job);

  const sig = job.abortController.signal;
  const tasks = job.queue.map((item) => async () => {
    if (sig.aborted) return;
    const docId = `${item.book}__${item.unit}__${item.num}`;
    job.results[docId] = 'running';
    updateWordUI(job);
    try {
      let vocabulary = null, titleKo = '';
      // 기존 분석 캐시 활용
      let existing = null;
      try { const snap = await db.collection('analyses').doc(docId).get(); if (snap.exists) existing = snap.data(); } catch (e) {}
      if (existing && existing.logic && existing.logic.titleKo) titleKo = existing.logic.titleKo;
      if (!job.force && existing && existing.vocab && Array.isArray(existing.vocab.vocabulary) && existing.vocab.vocabulary.length) {
        vocabulary = existing.vocab.vocabulary;
        job.results[docId] = 'skipped';
        job.skipped++;
      } else {
        // VOCABULARY_PROMPT 호출 (3회 백오프)
        let parsed = null, lastErr = null;
        for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
          if (sig.aborted) throw new Error('aborted');
          try {
            const r = await callAI(job.provider, job.model, item.passage, VOCABULARY_PROMPT, sig, null, job.effort, job.fast);
            if (r && r.parsed && Array.isArray(r.parsed.vocabulary)) parsed = r.parsed;
            if (r && r.usage) { job._tokens.input += r.usage.input_tokens || 0; job._tokens.output += r.usage.output_tokens || 0; job._tokens.calls++; }
          } catch (e) { lastErr = e; if (attempt < 2) await new Promise(rs => setTimeout(rs, attempt === 0 ? 2000 : 5000)); }
        }
        if (!parsed) throw lastErr || new Error('vocab 생성 실패');
        vocabulary = parsed.vocabulary;
        // Firestore 병합 저장
        try {
          await db.collection('analyses').doc(docId).set({
            vocab: { vocabulary },
            savedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } catch (e) { console.warn('[word] save failed', e && e.message); }
        job.results[docId] = 'done';
        job.done++;
      }
      job.vocabByDoc[docId] = { item, titleKo, vocabulary };
    } catch (e) {
      if (e && e.message === 'aborted') return;
      job.results[docId] = 'failed';
      job.failed++;
    }
    setPhaseProgress(job, 'generate', (job.done + job.skipped + job.failed) / Math.max(1, job.total));
    updateWordUI(job);
  });

  // callAI 의 claude 세마포어가 동시성 제어 → 전부 병렬 fire
  await Promise.all(tasks.map(t => t()));
  job.phaseStates.generate = 'done';

  await finishWordJob(job);
}

async function finishWordJob(job) {
  const aborted = job.abortController.signal.aborted;
  const okDocs = Object.keys(job.vocabByDoc).length;
  if (!aborted && okDocs > 0) {
    job.phase = 'buildPdf'; job.phaseStates.buildPdf = 'active';
    updateWordUI(job);
    try {
      job._downloadsHtml = `<button class="wb-download-btn" data-role="word-dl-pdf">단어 PDF 다운로드 (${okDocs}개 지문)</button>`;
      job._bindDownloads = (area) => {
        const btn = area.querySelector('[data-role="word-dl-pdf"]');
        if (btn) btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = 'PDF 생성 중...';
          try { const pdf = await buildWordPdf(job); pdf.save(); }
          catch (e) { alert('PDF 생성 실패: ' + e.message); }
          btn.disabled = false; btn.textContent = `단어 PDF 다운로드 (${okDocs}개 지문)`;
        });
      };
    } catch (e) { console.warn('[word] build downloads', e); }
    job.phaseStates.buildPdf = 'done';
  }
  job.phase = aborted ? 'cancelled' : 'done';
  job.phaseStates.done = aborted ? 'pending' : 'done';
  if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; }
  updateWordUI(job);
  if (wordJobManager) wordJobManager.notifyPhaseChanged(job.id);
}

// .vcell 마크업 — renderVocabulary 와 동일 양식
function _wordVocabHtml(vocabulary, item, titleKo) {
  const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const numText = (String(item.num).match(/\d+/) ? String(item.num).match(/\d+/)[0] + '번' : item.num);
  const posChip = (p) => { const ch = String(p || '').trim().charAt(0) || ''; return ch ? `<span class="vp-chip">${e(ch)}</span>` : ''; };
  const cell = (v) => {
    if (!v) return '<div class="vcell vcell-empty"></div>';
    const star = v.isStarred ? '<sup class="vstar">★</sup>' : '';
    const syn = Array.isArray(v.synonyms) && v.synonyms.length ? `<div class="vsyn"><span class="vsign vsign-syn">≡</span>${e(v.synonyms.join(', '))}</div>` : '';
    const ant = Array.isArray(v.antonyms) && v.antonyms.length ? `<div class="vant"><span class="vsign vsign-ant">↔</span>${e(v.antonyms.join(', '))}</div>` : '';
    return `<div class="vcell"><div class="vleft"><span class="vword">${e(v.word || '')}${star}</span></div>` +
      `<div class="vright"><div class="vmeaning">${posChip(v.pos)}<span class="vmean-text">${e(v.meaningKo || '')}</span></div>${syn}${ant}</div></div>`;
  };
  let h = `<div style="display:flex;align-items:baseline;gap:12px;padding:2px 0 12px;border-bottom:1px solid #ebebeb;margin-bottom:12px">` +
    `<span style="font-size:22px;font-weight:800;color:#4f6ef7">${e(numText)}</span>` +
    (titleKo ? `<span style="font-size:15px;font-weight:700;color:#1a1a1a">${e(titleKo)}</span>` : '') + `</div>`;
  h += `<div style="font-size:16px;font-weight:800;color:#1a1a1a;padding:0 0 8px">핵심단어</div>`;
  h += `<div class="vocab-grid">`;
  for (let i = 0; i < vocabulary.length; i += 2) h += cell(vocabulary[i]) + cell(vocabulary[i + 1]);
  h += `</div>`;
  return h;
}

async function buildWordPdf(job) {
  const sections = [];
  const docIds = job.queue.map(it => `${it.book}__${it.unit}__${it.num}`).filter(d => job.vocabByDoc[d]);
  docIds.forEach((docId, i) => {
    const { item, titleKo, vocabulary } = job.vocabByDoc[docId];
    sections.push({ html: _wordVocabHtml(vocabulary, item, titleKo), pageBreakBefore: i > 0, atomic: false });
  });
  const book = job.queue[0] ? job.queue[0].book : '';
  const units = [...new Set(job.queue.map(it => it.unit))].join(', ');
  return buildPdfFromSections(sections, {
    title: `단어 · ${book}`,
    subtitle: units,
    filename: `단어_${String(book).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`,
    columns: 1,
    atomicSections: false
  });
}

function updateWordUI(job) {
  if (!job) return;
  if (wordJobManager && wordJobManager.selectedId !== job.id) { wordJobManager._updateSwitcherLabels(); return; }
  const body = document.getElementById('wordProgressBody');
  if (!body || typeof renderJobChecklist !== 'function') return;

  const done = job.done || 0, failed = job.failed || 0, skipped = job.skipped || 0, total = job.total || 0;
  const items = job.queue.map((it) => {
    const docId = `${it.book}__${it.unit}__${it.num}`;
    let status = job.results[docId] || 'pending';
    return { book: it.book, unit: it.unit, num: it.num, status };
  });
  let headTitle = '단어 정리 중';
  if (job.phase === 'cancelled') headTitle = '단어 정리 — 중단됨';
  else if (job.phase === 'done') headTitle = '단어 정리 — 완료';
  const elapsedMs = job._startedAt ? (Date.now() - job._startedAt) : 0;
  const tokens = job._tokens || { input: 0, output: 0 };
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;
  const costKrw = (typeof computeCostUsd === 'function') ? computeCostUsd(tokens, job.model) * rate : 0;

  renderJobChecklist(body, {
    headTitle,
    subLabel: job.phase === 'done' ? `✅ 완료 — 신규 ${done} · 재사용 ${skipped}${failed ? ` · 실패 ${failed}` : ''}` : `🔄 ${done + skipped + failed}/${total} 지문 처리`,
    elapsedMs,
    tokenUsage: (tokens.input || tokens.output) ? { input: tokens.input, output: tokens.output } : null,
    costKrw,
    stats: { total, done: done, failed, skipped },
    phases: [
      { id: 'prepare', label: '범위 확정' },
      { id: 'generate', label: 'AI 어휘 추출', desc: `${done + skipped + failed}/${total} 처리` },
      { id: 'buildPdf', label: 'PDF 준비' },
      { id: 'done', label: '완료' }
    ],
    phaseStates: job.phaseStates || {},
    items
  });

  if (wordJobManager) {
    const cancelBtn = document.getElementById('wordCancelBtn');
    if (cancelBtn) { cancelBtn.style.visibility = wordJobManager.isJobRunning(job) ? 'visible' : 'hidden'; cancelBtn.style.display = ''; }
    wordJobManager._updateSwitcherLabels();
  }
}
