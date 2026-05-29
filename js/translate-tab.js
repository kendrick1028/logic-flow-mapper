// ══════════════════════════════════════
// 해석 탭 — 문단별 문장 번역 일괄 생성
// ──────────────────────────────────────
// 일괄 상세분석과 동일한 범위선택 UI. 선택 지문을 TRANSLATION_PROMPT 로 문단별
// 문장 번역(영문+한글)으로 정리하고, A4 단일컬럼 PDF 로 문단 단위 page-break,
// 문장 잘림 없이 출력한다. Claude CLI 연결.
// ══════════════════════════════════════

let translateJobManager = null;

function initTranslateTab() {
  const tree = document.getElementById('transRangeTree');
  if (!tree || typeof BOOKS === 'undefined') return;

  if (!translateJobManager && typeof JobManager !== 'undefined') {
    translateJobManager = new JobManager({
      featureKey: 'translate',
      switcherId: 'transJobSwitcher',
      progressBodyId: 'transProgressBody',
      downloadCardId: 'transDownloadsCard',
      downloadAreaId: 'transDownloadArea',
      cancelBtnId: 'transCancelBtn',
      emptyStateId: 'transEmptyState',
      labelFn: (job) => {
        const pct = job.total ? Math.round((job.done + job.failed) / job.total * 100) : 0;
        const status = job.phase === 'cancelled' ? '중단' : job.phase === 'done' ? '완료' : `${pct}%`;
        return `해석 (${status})`;
      },
      renderFn: (job) => updateTranslateUI(job),
      onRemove: (job) => { if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; } }
    });
    if (typeof window !== 'undefined') {
      window._jobManagers = window._jobManagers || {};
      window._jobManagers.translate = translateJobManager;
    }
    translateJobManager.renderSelected();
  }

  initRangeTree(tree, updateTransRangeSummary);
  updateTransRangeSummary();

  if (typeof AI_MODELS !== 'undefined') {
    const provSel = document.getElementById('transProvider');
    const modelSel = document.getElementById('transModel');
    if (provSel && modelSel) {
      const provLabels = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI' };
      [...new Set(AI_MODELS.map(m => m.provider))].forEach(p => {
        const o = document.createElement('option'); o.value = p; o.textContent = provLabels[p] || p; provSel.appendChild(o);
      });
      provSel.addEventListener('change', updateTransModelOptions);
      if (typeof selectClaudeDefault === 'function') selectClaudeDefault('transProvider', updateTransModelOptions);
      else updateTransModelOptions();
    }
  }
  if (typeof populateEffortSelect === 'function') populateEffortSelect('transEffort');
  if (typeof wireFastToggle === 'function') wireFastToggle('transFast', 'transEffort');
}

function updateTransModelOptions() {
  const provider = document.getElementById('transProvider').value;
  const modelSel = document.getElementById('transModel');
  modelSel.innerHTML = '';
  AI_MODELS.filter(m => m.provider === provider).forEach(m => {
    const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; modelSel.appendChild(o);
  });
}

function updateTransRangeSummary() {
  const el = document.getElementById('transRangeSummary');
  const tree = document.getElementById('transRangeTree');
  if (!el || !tree) return;
  const n = (typeof getRangeSelectionCount === 'function') ? getRangeSelectionCount(tree) : 0;
  el.textContent = `선택된 지문: ${n}개`;
}

function startTranslateJob() {
  const tree = document.getElementById('transRangeTree');
  const items = (typeof getRangeSelection === 'function') ? getRangeSelection(tree) : [];
  if (!items.length) { alert('지문을 한 개 이상 선택해주세요.'); return; }

  const provider = document.getElementById('transProvider').value;
  const model = document.getElementById('transModel').value;
  const fast = !!document.getElementById('transFast')?.checked;
  const effort = (document.getElementById('transEffort') || {}).value || DEFAULT_EFFORT;

  const job = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `trans_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'translate',
    queue: items, total: items.length, done: 0, failed: 0,
    provider, model, effort, fast,
    results: {},        // docId → status
    transByDoc: {},     // docId → { item, titleKo, paragraphs }
    abortController: new AbortController(),
    phase: 'prepare',
    phaseStates: { prepare: 'active', generate: 'pending', buildPdf: 'pending', done: 'pending' },
    _tokens: { input: 0, output: 0, calls: 0 },
    _startedAt: Date.now(), _timerInterval: null,
    _downloadsHtml: '', _bindDownloads: null
  };

  if (translateJobManager) translateJobManager.addJob(job);
  if (typeof setPanelRunning === 'function') setPanelRunning('translate', true);
  job._timerInterval = setInterval(() => updateTranslateUI(job), 1000);
  runTranslatePipeline(job).finally(() => { if (typeof updateSidebarIndicators === 'function') updateSidebarIndicators(); });
}

function cancelTranslateJob(jobId) {
  if (!translateJobManager) return;
  const targetId = jobId || translateJobManager.selectedId;
  const job = translateJobManager.getJob(targetId);
  if (job && job.abortController) job.abortController.abort();
}

// 응답이 paragraphs 스키마가 아니면 splitIntoSentences 폴백으로라도 문단 1개 구성
function _normalizeTranslation(parsed, passage) {
  if (parsed && Array.isArray(parsed.paragraphs) && parsed.paragraphs.length) {
    return parsed.paragraphs.filter(p => p && Array.isArray(p.sentences) && p.sentences.length);
  }
  if (parsed && Array.isArray(parsed.sentences) && parsed.sentences.length) {
    return [{ sentences: parsed.sentences }];
  }
  return null;
}

async function runTranslatePipeline(job) {
  job.phase = 'running';
  job.phaseStates.prepare = 'done';
  job.phaseStates.generate = 'active';
  updateTranslateUI(job);

  const sig = job.abortController.signal;
  const tasks = job.queue.map((item) => async () => {
    if (sig.aborted) return;
    const docId = `${item.book}__${item.unit}__${item.num}`;
    job.results[docId] = 'running';
    updateTranslateUI(job);
    try {
      let titleKo = '';
      try { const snap = await db.collection('analyses').doc(docId).get(); if (snap.exists) { const d = snap.data(); if (d.logic && d.logic.titleKo) titleKo = d.logic.titleKo; } } catch (e) {}

      let paragraphs = null, lastErr = null;
      for (let attempt = 0; attempt < 3 && !paragraphs; attempt++) {
        if (sig.aborted) throw new Error('aborted');
        try {
          const r = await callAI(job.provider, job.model, item.passage, TRANSLATION_PROMPT, sig, null, job.effort, job.fast);
          if (r && r.usage) { job._tokens.input += r.usage.input_tokens || 0; job._tokens.output += r.usage.output_tokens || 0; job._tokens.calls++; }
          paragraphs = _normalizeTranslation(r && r.parsed, item.passage);
        } catch (e) { lastErr = e; if (attempt < 2) await new Promise(rs => setTimeout(rs, attempt === 0 ? 2000 : 5000)); }
      }
      if (!paragraphs) throw lastErr || new Error('해석 생성 실패');
      job.transByDoc[docId] = { item, titleKo, paragraphs };
      job.results[docId] = 'done';
      job.done++;
    } catch (e) {
      if (e && e.message === 'aborted') return;
      job.results[docId] = 'failed';
      job.failed++;
    }
    setPhaseProgress(job, 'generate', (job.done + job.failed) / Math.max(1, job.total));
    updateTranslateUI(job);
  });

  await Promise.all(tasks.map(t => t()));
  job.phaseStates.generate = 'done';
  await finishTranslateJob(job);
}

async function finishTranslateJob(job) {
  const aborted = job.abortController.signal.aborted;
  const okDocs = Object.keys(job.transByDoc).length;
  if (!aborted && okDocs > 0) {
    job.phase = 'buildPdf'; job.phaseStates.buildPdf = 'active';
    updateTranslateUI(job);
    job._downloadsHtml = `<button class="wb-download-btn" data-role="trans-dl-pdf">해석 PDF 다운로드 (${okDocs}개 지문)</button>`;
    job._bindDownloads = (area) => {
      const btn = area.querySelector('[data-role="trans-dl-pdf"]');
      if (btn) btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'PDF 생성 중...';
        try { const pdf = await buildTranslatePdf(job); pdf.save(); }
        catch (e) { alert('PDF 생성 실패: ' + e.message); }
        btn.disabled = false; btn.textContent = `해석 PDF 다운로드 (${okDocs}개 지문)`;
      });
    };
    job.phaseStates.buildPdf = 'done';
  }
  job.phase = aborted ? 'cancelled' : 'done';
  job.phaseStates.done = aborted ? 'pending' : 'done';
  if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; }
  updateTranslateUI(job);
  if (translateJobManager) translateJobManager.notifyPhaseChanged(job.id);
}

const _SUP = ['⁰','¹','²','³','⁴','⁵','⁶','⁷','⁸','⁹'];
function _supNum(n) { return String(n).split('').map(d => _SUP[+d] || d).join(''); }

// 한 지문 = 헤더 섹션 + 문단별 섹션(atomic). 문단 = 영문 단락(번호 위첨자) + 한글 해석.
function _translateSections(entry, isFirst) {
  const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { item, titleKo, paragraphs } = entry;
  const numText = (String(item.num).match(/\d+/) ? String(item.num).match(/\d+/)[0] + '번' : item.num);
  const out = [];
  // 헤더
  out.push({
    pageBreakBefore: !isFirst,
    atomic: true,
    html: `<div style="display:flex;align-items:baseline;gap:12px;padding:2px 0 14px;border-bottom:1px solid #ebebeb;margin-bottom:14px">` +
      `<span style="font-size:22px;font-weight:800;color:#4f6ef7">${e(numText)}</span>` +
      (titleKo ? `<span style="font-size:15px;font-weight:700;color:#1a1a1a">${e(titleKo)}</span>` : '') + `</div>`
  });
  // 문단별 섹션 (atomic → 문단 단위로 페이지 넘김, 문장 잘림 방지)
  paragraphs.forEach((p, pi) => {
    const sents = (p.sentences || []);
    const enLine = sents.map(s => `<sup style="color:#4f6ef7;font-weight:800">${_supNum(s.id)}</sup>${e(s.en || '')}`).join(' ');
    const koLines = sents.map(s => `<div style="margin:3px 0"><sup style="color:#4f6ef7;font-weight:800">${_supNum(s.id)}</sup>${e(s.ko || '')}</div>`).join('');
    out.push({
      atomic: true,
      html: `<div style="margin-bottom:16px;break-inside:avoid">` +
        `<div style="font-size:14px;line-height:1.75;color:#1a1a1a;margin-bottom:7px">${enLine}</div>` +
        `<div style="font-size:13.5px;line-height:1.7;color:#555;background:#f7f8fb;border-left:3px solid #cdd6f5;border-radius:4px;padding:8px 11px">${koLines}</div>` +
        `</div>`
    });
  });
  return out;
}

async function buildTranslatePdf(job) {
  const sections = [];
  const docIds = job.queue.map(it => `${it.book}__${it.unit}__${it.num}`).filter(d => job.transByDoc[d]);
  docIds.forEach((docId, i) => {
    _translateSections(job.transByDoc[docId], i === 0).forEach(s => sections.push(s));
  });
  const book = job.queue[0] ? job.queue[0].book : '';
  const units = [...new Set(job.queue.map(it => it.unit))].join(', ');
  return buildPdfFromSections(sections, {
    title: `해석 · ${book}`,
    subtitle: units,
    filename: `해석_${String(book).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`,
    columns: 1,
    atomicSections: true
  });
}

function updateTranslateUI(job) {
  if (!job) return;
  if (translateJobManager && translateJobManager.selectedId !== job.id) { translateJobManager._updateSwitcherLabels(); return; }
  const body = document.getElementById('transProgressBody');
  if (!body || typeof renderJobChecklist !== 'function') return;

  const done = job.done || 0, failed = job.failed || 0, total = job.total || 0;
  const items = job.queue.map((it) => {
    const docId = `${it.book}__${it.unit}__${it.num}`;
    return { book: it.book, unit: it.unit, num: it.num, status: job.results[docId] || 'pending' };
  });
  let headTitle = '해석 생성 중';
  if (job.phase === 'cancelled') headTitle = '해석 — 중단됨';
  else if (job.phase === 'done') headTitle = '해석 — 완료';
  const elapsedMs = job._startedAt ? (Date.now() - job._startedAt) : 0;
  const tokens = job._tokens || { input: 0, output: 0 };
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;
  const costKrw = (typeof computeCostUsd === 'function') ? computeCostUsd(tokens, job.model) * rate : 0;

  renderJobChecklist(body, {
    headTitle,
    subLabel: job.phase === 'done' ? `✅ 완료 — ${done}개 지문${failed ? ` · 실패 ${failed}` : ''}` : `🔄 ${done + failed}/${total} 지문 처리`,
    elapsedMs,
    tokenUsage: (tokens.input || tokens.output) ? { input: tokens.input, output: tokens.output } : null,
    costKrw,
    stats: { total, done, failed },
    phases: [
      { id: 'prepare', label: '범위 확정' },
      { id: 'generate', label: 'AI 해석 생성', desc: `${done + failed}/${total} 처리` },
      { id: 'buildPdf', label: 'PDF 준비' },
      { id: 'done', label: '완료' }
    ],
    phaseStates: job.phaseStates || {},
    items
  });

  if (translateJobManager) {
    const cancelBtn = document.getElementById('transCancelBtn');
    if (cancelBtn) { cancelBtn.style.visibility = translateJobManager.isJobRunning(job) ? 'visible' : 'hidden'; cancelBtn.style.display = ''; }
    translateJobManager._updateSwitcherLabels();
  }
}
