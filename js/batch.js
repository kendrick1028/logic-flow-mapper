// ── Batch Analysis Engine ──
// 다중 작업 지원: 각 batch job 은 독립된 state/abortController 를 보유.
// 여러 배치를 동시에 돌릴 수 있음.
let batchJobManager = null;
let _batchInitialized = false;

function initBatch() {
  if (_batchInitialized) return;
  const tree = document.getElementById('batchRangeTree');
  const batchProvider = document.getElementById('batchProvider');
  const batchModel = document.getElementById('batchModel');
  const overviewBook = document.getElementById('overviewBook');
  if (!tree) return;
  _batchInitialized = true;

  // JobManager 초기화
  if (!batchJobManager && typeof JobManager !== 'undefined') {
    batchJobManager = new JobManager({
      featureKey: 'batch',
      switcherId: 'batchJobSwitcher',
      progressBodyId: 'batchProgressBody',
      downloadCardId: 'batchDownloadsCard',
      downloadAreaId: 'batchDownloadArea',
      cancelBtnId: 'batchCancelBtn',
      emptyStateId: 'batchEmptyState',
      labelFn: (job) => {
        const books = job.queue && job.queue.length ? [...new Set(job.queue.map(q => q.book))] : [];
        const title = books.length === 1 ? books[0] : (books.length > 1 ? `${books.length}개 교재` : '일괄분석');
        const progress = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
        const status = job.phase === 'cancelled' ? '중단' :
                       job.phase === 'done' ? '완료' :
                       `${progress}% (${job.done}/${job.total})`;
        return `${title} (${status})`;
      },
      renderFn: (job, body) => {
        updateBatchUI(job);
      },
      onRemove: (job) => {
        if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; }
      }
    });
    if (typeof window !== 'undefined') {
      window._jobManagers = window._jobManagers || {};
      window._jobManagers.batch = batchJobManager;
    }
    batchJobManager.renderSelected();
  }

  // Range tree 초기화 (교재 탭 + 단원/지문 트리)
  if (typeof initRangeTree === 'function') {
    initRangeTree(tree, updateBatchRangeSummary);
    updateBatchRangeSummary();
  }

  // overviewBook 드롭다운 채우기 (저장된 분석 현황 카드)
  const bookNames = Object.keys(BOOKS);
  if (overviewBook) {
    overviewBook.innerHTML = '';
    bookNames.forEach(name => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      overviewBook.appendChild(o);
    });
  }

  // Provider/Model selectors
  if (typeof AI_MODELS !== 'undefined' && batchProvider && batchModel) {
    const provLabels = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI' };
    const providers = [...new Set(AI_MODELS.map(m => m.provider))];
    batchProvider.innerHTML = '';
    providers.forEach(p => {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = provLabels[p] || p;
      batchProvider.appendChild(o);
    });
    batchProvider.addEventListener('change', updateBatchModels);
    updateBatchModels();
  }

  // Load saved overview on init
  loadSavedOverview();
}

function updateBatchRangeSummary() {
  const tree = document.getElementById('batchRangeTree');
  const el = document.getElementById('batchRangeSummary');
  if (!tree || !el) return;
  const count = typeof getRangeSelectionCount === 'function' ? getRangeSelectionCount(tree) : 0;
  el.textContent = `선택된 지문: ${count}개`;
}

function updateBatchModels() {
  const provider = document.getElementById('batchProvider').value;
  const modelSel = document.getElementById('batchModel');
  modelSel.innerHTML = '';
  const models = AI_MODELS.filter(m => m.provider === provider);
  models.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  });
}

function startBatchJob() {
  const tree = document.getElementById('batchRangeTree');
  const selections = tree && typeof getRangeSelection === 'function' ? getRangeSelection(tree) : [];
  if (!selections.length) { alert('분석할 지문을 한 개 이상 선택해주세요.'); return; }

  const provider = document.getElementById('batchProvider').value;
  const model = document.getElementById('batchModel').value;
  const forceReanalyze = !!document.getElementById('batchForceReanalyze')?.checked;

  const queue = selections;  // [{book, unit, num, passage}]

  const job = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'batch',
    queue,
    current: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    total: queue.length,
    abortController: new AbortController(),
    results: {},
    provider,
    model,
    option: null,
    forceReanalyze,
    phase: 'prepare',
    phaseStates: { prepare: 'active', running: 'pending', buildPdf: 'pending', done: 'pending' },
    subLabel: '준비 중...',
    _startedAt: Date.now(),
    _tokens: { input: 0, output: 0, calls: 0 }
  };

  if (batchJobManager) batchJobManager.addJob(job);
  if (typeof setPanelRunning === 'function') setPanelRunning('batch-analyze', true);

  // 경과 시간 실시간 갱신 (1초 간격)
  job._timerInterval = setInterval(() => updateBatchUI(job), 1000);

  // 비동기 파이프라인 실행
  runBatchPipeline(job).finally(() => {
    if (typeof updateSidebarIndicators === 'function') updateSidebarIndicators();
  });
}

async function runBatchPipeline(job) {
  const queue = job.queue;

  job.phase = 'running';
  job.phaseStates.prepare = 'done';
  job.phaseStates.running = 'active';
  updateBatchUI(job);

  // 모든 지문 병렬 처리 (각 지문 내부에서 4개 API 호출도 병렬)
  const tasks = queue.map((item, i) => async () => {
    if (job.abortController.signal.aborted) return;

    const docId = `${item.book}__${item.unit}__${item.num}`;

    // Skip if already saved in Firestore (forceReanalyze 가 켜져 있으면 스킵하지 않음)
    try {
      const existing = job.forceReanalyze ? null : await db.collection('analyses').doc(docId).get();
      if (existing && existing.exists) {
        job.results[docId] = 'skipped';
        job.skipped++;
        job.done++;
        try {
          const d = existing.data();
          job.resultData = job.resultData || {};
          job.resultData[docId] = {
            item,
            result: {
              // meta 필드 폐기 — 구 데이터에 있어도 무시
              logic: d.logic || null,
              vocab: d.vocab || null,
              grammar: d.grammar || null
            }
          };
        } catch (e) { /* ignore */ }
        updateBatchUI(job);
        return;
      }
    } catch (e) { /* check failed, proceed with analysis */ }

    // Analyze with up to 3 retries
    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (job.abortController.signal.aborted) break;
      try {
        const result = await runSinglePassageAnalysis(item, job);
        await saveBatchResult(item, result);
        job.results[docId] = 'done';
        job.resultData = job.resultData || {};
        job.resultData[docId] = { item, result };
        job.done++;
        success = true;
      } catch (e) {
        if (job.abortController.signal.aborted) break;
        console.warn(`Batch retry ${attempt + 1}/3 for ${docId}:`, e.message);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, attempt === 0 ? 2000 : 5000));
        }
      }
    }
    if (!success && !job.abortController.signal.aborted) {
      job.results[docId] = 'failed';
      job.failed++;
    }
    updateBatchUI(job);
  });

  // 전체 병렬 실행
  await Promise.all(tasks.map(fn => fn()));

  finishBatchJob(job);
}

async function runSinglePassageAnalysis(item, job) {
  const sig = job.abortController.signal;
  const provider = job.provider;
  const model = job.model;
  const option = job.option;

  // 3개 영역 (Logic Flow / Vocab / Grammar) 병렬 호출. 메타·지문구조 제거됨.
  // 어법은 문장 단위 분할 병렬 호출 (timeout 회피).
  const [logicR, vocabR, grammarR] = await Promise.allSettled([
    callAI(provider, model, item.passage, null, sig, option),
    callAI(provider, model, item.passage, VOCABULARY_PROMPT, sig, option),
    callGrammarChunked(provider, model, item.passage, sig, option)
  ]);

  // 실제 API 응답의 usage 누적 (없으면 무시)
  job._tokens = job._tokens || { input: 0, output: 0, cached: 0, calls: 0 };
  [logicR, vocabR, grammarR].forEach(r => {
    if (r.status !== 'fulfilled') return;
    job._tokens.calls = (job._tokens.calls || 0) + 1;
    const usage = r.value && r.value.usage;
    if (usage) {
      if (usage.input_tokens) job._tokens.input += usage.input_tokens;
      if (usage.output_tokens) job._tokens.output += usage.output_tokens;
      if (usage.cached_tokens) job._tokens.cached = (job._tokens.cached || 0) + usage.cached_tokens;
    }
  });

  const result = {
    logic: logicR.status === 'fulfilled' ? logicR.value.parsed : null,
    vocab: vocabR.status === 'fulfilled' ? vocabR.value.parsed : null,
    grammar: grammarR.status === 'fulfilled' ? grammarR.value.parsed : null
  };

  if (!result.logic && !result.vocab && !result.grammar) {
    throw new Error('모든 분석 실패');
  }
  return result;
}

// ── 배치 PDF 생성 ──
// 단일 꼼꼼분석 페이지(Mapper)의 downloadDetailPDF 와 동일한 DOM 기반 렌더링 사용.
// 각 지문마다 detail card 에 렌더 함수를 호출해 실제 DOM 을 생성한 뒤 html2canvas 로 캡처.

function _batchSaveDetailState() {
  const ids = ['metaCard', 'structureCard', 'logicFlowCard', 'vocabCard', 'grammarCard'];
  const contentIds = ['metaContent', 'structureContent', 'logicFlowContent', 'vocabContent', 'g0'];
  const state = { cards: {}, contents: {} };
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) state.cards[id] = el.style.display;
  });
  contentIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) state.contents[id] = el.innerHTML;
  });
  return state;
}

function _batchRestoreDetailState(state) {
  if (!state) return;
  Object.entries(state.cards || {}).forEach(([id, disp]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = disp;
  });
  Object.entries(state.contents || {}).forEach(([id, html]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

function _batchPopulateDetailCards(result, passageText) {
  // 기존 내용 초기화 (구 카드 ID 도 안전하게 정리)
  ['metaCard', 'structureCard', 'logicFlowCard', 'vocabCard', 'grammarCard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  ['metaContent', 'structureContent', 'logicFlowContent', 'vocabContent', 'g0'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // 단일 분석 페이지와 동일한 render 함수 사용 — 메타·지문구조는 더 이상 표시 안 함
  if (result.logic && typeof renderLogicFlowInDetail === 'function') {
    renderLogicFlowInDetail(result.logic, passageText || '');
    document.getElementById('logicFlowCard').style.display = '';
  }
  if (result.vocab && typeof renderVocabulary === 'function') {
    renderVocabulary(result.vocab.vocabulary || []);
    document.getElementById('vocabCard').style.display = '';
  }
  if (result.grammar && typeof renderGrammar === 'function') {
    renderGrammar(result.grammar);
    document.getElementById('grammarCard').style.display = '';
  }
}

async function buildBatchPdf(job) {
  if (typeof html2canvas === 'undefined' || !window.jspdf) {
    throw new Error('PDF 라이브러리를 불러오지 못했습니다.');
  }
  const resultData = job.resultData || {};
  const queue = job.queue || [];

  // 분석 결과가 있는 항목만 필터 (순서는 queue 순서 유지)
  const passages = [];
  for (const item of queue) {
    const docId = `${item.book}__${item.unit}__${item.num}`;
    const data = resultData[docId];
    if (data && data.result) passages.push(data);
  }
  if (!passages.length) return null;

  // ── 단일 분석 PDF (downloadDetailPDF) 와 동일한 설정 ──
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

  const pageWidth = 210;
  const pageHeight = 297;
  const marginX = 12;
  const marginY = 15;
  const subHdrReserve = 9;
  const footerReserve = 8;
  const contentWidth = pageWidth - (marginX * 2);
  const bottomLimit = pageHeight - marginY - footerReserve;
  const newPageStartY = marginY + subHdrReserve;

  const captureWidth = 750;
  const container = document.createElement('div');
  container.style.cssText = `position:absolute;left:-9999px;top:0;width:${captureWidth}px;background:#fff`;
  document.body.appendChild(container);

  const canvasOpts = { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true };

  const captureNode = async (node) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = `width:${captureWidth}px;background:#fff;padding:0`;
    wrap.appendChild(node);
    container.appendChild(wrap);
    const c = await html2canvas(wrap, canvasOpts);
    const out = {
      dataUrl: c.toDataURL('image/jpeg', 0.92),
      heightMm: contentWidth * (c.height / c.width)
    };
    container.removeChild(wrap);
    return out;
  };

  const captureCard = async (cardId) => {
    const card = document.getElementById(cardId);
    if (!card || card.style.display === 'none') return null;
    const clone = card.cloneNode(true);
    clone.style.maxWidth = captureWidth + 'px';
    clone.style.overflow = 'hidden';
    clone.style.wordBreak = 'break-word';
    return captureNode(clone);
  };

  // 로고 이미지 로드 (한 번만)
  const logoWidthMm = 34;
  let logoDataUrl = null;
  let logoHeightMm = 0;
  try {
    const logoImg = new Image();
    logoImg.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      logoImg.onload = resolve;
      logoImg.onerror = reject;
      logoImg.src = encodeURIComponent('송유근영어[가로].png');
    });
    logoHeightMm = logoWidthMm * (logoImg.naturalHeight / logoImg.naturalWidth);
    const lc = document.createElement('canvas');
    lc.width = logoImg.naturalWidth;
    lc.height = logoImg.naturalHeight;
    lc.getContext('2d').drawImage(logoImg, 0, 0);
    logoDataUrl = lc.toDataURL('image/png');
  } catch (e) { /* 로고 없이 진행 */ }

  // 원본 DOM 상태 저장
  const originalState = _batchSaveDetailState();

  // 지문별 페이지 범위 추적 (머릿말을 지문별로 다르게 표시)
  const passagePageRanges = [];   // { startPage, endPage, bookLabel, unitVal, numVal }

  try {
    for (let pi = 0; pi < passages.length; pi++) {
      const { item, result } = passages[pi];

      // 1) DOM 에 이 지문의 분석 결과 렌더링
      _batchPopulateDetailCards(result, item.passage || '');
      // DOM 업데이트 대기
      await new Promise(r => requestAnimationFrame(r));

      // (큰 메타 헤더 블록 제거 — 모든 페이지 머릿말이 책·단원·지문번호 동일 표시)

      // 3) 섹션 이미지 캡처 — 어휘는 행 단위 분할 캡처 (단어 단위 page break)
      let vocabHeaderImg = null;
      const vocabRowImgs = [];
      if (document.getElementById('vocabCard').style.display !== 'none') {
        const hdrWrap = document.createElement('div');
        hdrWrap.style.cssText = 'padding:0;background:#fff';
        const tagT3 = document.querySelector('#vocabCard .tag.t3');
        if (tagT3) hdrWrap.appendChild(tagT3.cloneNode(true));
        const secTitle = document.querySelector('#vocabContent .vocab-section-title');
        if (secTitle) {
          const sc = secTitle.cloneNode(true);
          sc.style.marginTop = '8px';
          hdrWrap.appendChild(sc);
        }
        vocabHeaderImg = await captureNode(hdrWrap);

        const cells = Array.from(document.querySelectorAll('#vocabContent .vocab-grid .vcell'));
        for (let i = 0; i < cells.length; i += 2) {
          const row = document.createElement('div');
          row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;background:transparent';
          row.appendChild(cells[i].cloneNode(true));
          if (i + 1 < cells.length) row.appendChild(cells[i + 1].cloneNode(true));
          vocabRowImgs.push(await captureNode(row));
        }
      }

      // Logic Flow 서브섹션 분할 캡처
      let logicFlowHeaderImg = null;
      const logicSubImgs = [];
      if (document.getElementById('logicFlowCard').style.display !== 'none') {
        const lfTag = document.querySelector('#logicFlowCard .tag.t1');
        if (lfTag) logicFlowHeaderImg = await captureNode(lfTag.cloneNode(true));
        const subs = Array.from(document.querySelectorAll('#logicFlowContent .lf-sub'));
        for (let si = 0; si < subs.length; si++) {
          const img = await captureNode(subs[si].cloneNode(true));
          // 원문분석 제거됨 — 인덱스 [0]첫문장해석, [1]Logic Flow, [2]구조요약
          img._group = (si === 0 || si === 1) ? 'flow' : null;
          logicSubImgs.push(img);
        }
      }

      // 어법 헤더 + 문장 개별 캡처
      let grammarHeaderImg = null;
      const sentenceImgs = [];
      if (document.getElementById('grammarCard').style.display !== 'none' &&
          document.querySelectorAll('#g0 .gm-sentence').length) {
        const gHeader = document.createElement('div');
        gHeader.style.cssText = 'padding:0';
        const origTag = document.querySelector('#panel-grammar .tag.t4');
        const origLegend = document.querySelector('#panel-grammar .gr-legend')
          || document.querySelector('#panel-grammar .gm-legend');
        if (origTag) {
          const tagClone = origTag.cloneNode(true);
          tagClone.style.marginBottom = '10px';
          gHeader.appendChild(tagClone);
        }
        if (origLegend) gHeader.appendChild(origLegend.cloneNode(true));
        grammarHeaderImg = await captureNode(gHeader);

        const sentences = Array.from(document.querySelectorAll('#g0 .gm-sentence'));
        for (const sent of sentences) {
          sentenceImgs.push(await captureNode(sent.cloneNode(true)));
        }
      }

      // 4) PDF 에 조립 — 1페이지부터 어휘 즉시 시작 (큰 메타 헤더 제거)
      const passageStartPage = pi === 0 ? 1 : (pdf.internal.getNumberOfPages() + 1);
      if (pi > 0) pdf.addPage();
      let y = newPageStartY;

      const usableH = bottomLimit - newPageStartY;
      const placeInFlow = (img) => {
        if (!img) return;
        const gap = 4;
        if (y + img.heightMm > bottomLimit) {
          pdf.addPage();
          y = newPageStartY;
        }
        if (img.heightMm > usableH) {
          const scaledW = contentWidth * (usableH / img.heightMm);
          const xOffset = marginX + (contentWidth - scaledW) / 2;
          pdf.addImage(img.dataUrl, 'JPEG', xOffset, y, scaledW, usableH);
          y += usableH + gap;
        } else {
          pdf.addImage(img.dataUrl, 'JPEG', marginX, y, contentWidth, img.heightMm);
          y += img.heightMm + gap;
        }
      };

      // 1) 어휘: 헤더 + 행 단위 분할
      if (vocabHeaderImg) placeInFlow(vocabHeaderImg);
      for (const rowImg of vocabRowImgs) {
        if (rowImg.heightMm <= usableH && y + rowImg.heightMm > bottomLimit) {
          pdf.addPage();
          y = newPageStartY;
        }
        placeInFlow(rowImg);
      }

      // 2) 어법 분석: 새 페이지 + 문장 단위 keepTogether
      if (grammarHeaderImg) {
        pdf.addPage();
        y = newPageStartY;
        placeInFlow(grammarHeaderImg);
        for (const img of sentenceImgs) {
          if (img.heightMm <= usableH && y + img.heightMm > bottomLimit) {
            pdf.addPage();
            y = newPageStartY;
          }
          placeInFlow(img);
        }
      }

      // 3) Logic Flow: 마지막, 새 페이지
      if (logicFlowHeaderImg || logicSubImgs.length) {
        pdf.addPage();
        y = newPageStartY;
        placeInFlow(logicFlowHeaderImg);
        for (let si = 0; si < logicSubImgs.length; si++) {
          const img = logicSubImgs[si];
          if (img._group === 'flow' && si + 1 < logicSubImgs.length && logicSubImgs[si + 1]._group === 'flow') {
            const combinedH = img.heightMm + logicSubImgs[si + 1].heightMm + 8;
            if (y + combinedH > bottomLimit) {
              pdf.addPage();
              y = newPageStartY;
            }
          }
          placeInFlow(img);
        }
      }

      const passageEndPage = pdf.internal.getNumberOfPages();
      passagePageRanges.push({
        startPage: passageStartPage,
        endPage: passageEndPage,
        bookLabel: item.book || '',
        unitVal: item.unit || '',
        numVal: item.num ? String(item.num) + '번' : ''
      });
    }

    // ── 머릿말 + 꼬릿말 (지문별 다른 서브헤더 적용) ──
    // 꼬릿말은 모든 페이지에 공통
    const ftrEl = document.createElement('div');
    ftrEl.style.cssText = `width:${captureWidth}px;padding:6px 0 0;border-top:2px solid #bbb;display:flex;justify-content:space-between;align-items:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
    ftrEl.innerHTML = `<span style="font-size:11px;color:#666;font-weight:700">송유근 영어</span><span style="font-size:11px;color:#666;font-weight:600">최고의 강의 &amp; 철저한 관리</span>`;
    const ftrImg = await captureNode(ftrEl);

    // 지문별 서브헤더 캐시
    const subHdrByRange = [];
    for (const range of passagePageRanges) {
      const subHdrEl = document.createElement('div');
      subHdrEl.style.cssText = `width:${captureWidth}px;padding:3px 0 6px;border-bottom:2px solid #bbb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
      const parts = ['꼼꼼분석'];
      if (range.bookLabel) parts.push(range.bookLabel);
      if (range.unitVal) parts.push(range.unitVal);
      if (range.numVal) parts.push(range.numVal);
      subHdrEl.innerHTML = `<span style="font-size:13px;color:#555;font-weight:700;letter-spacing:0.02em">${parts.map(t => `<span>${t}</span>`).join('<span style="color:#aaa;margin:0 8px">·</span>')}</span>`;
      const subHdrImg = await captureNode(subHdrEl);
      subHdrByRange.push({ range, subHdrImg });
    }

    const totalPages = pdf.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      pdf.setPage(p);

      // 지문별 머릿말 — 모든 페이지 (지문 첫 페이지 포함) 동일하게 표시
      const range = passagePageRanges.find(r => p >= r.startPage && p <= r.endPage);
      if (range) {
        const subHdrEntry = subHdrByRange.find(s => s.range === range);
        if (subHdrEntry) {
          pdf.addImage(subHdrEntry.subHdrImg.dataUrl, 'JPEG', marginX, marginY - 2, contentWidth, subHdrEntry.subHdrImg.heightMm);
        }
      }

      // 꼬릿말
      const ftrY = pageHeight - marginY + 2;
      pdf.addImage(ftrImg.dataUrl, 'JPEG', marginX, ftrY, contentWidth, ftrImg.heightMm);

      pdf.setFontSize(9);
      pdf.setTextColor(100, 100, 100);
      pdf.text(`- ${p} / ${totalPages} -`, pageWidth / 2, ftrY + ftrImg.heightMm + 3, { align: 'center' });
    }
  } finally {
    // DOM 원본 상태 복원
    _batchRestoreDetailState(originalState);
    // 오프스크린 컨테이너 제거
    if (container.parentNode) container.parentNode.removeChild(container);
  }

  // 반환 객체 (변형문제/만화와 호환)
  return {
    pdf,
    save(fname) { pdf.save(fname || 'batch_detail.pdf'); },
    get blob() { return pdf.output('blob'); }
  };
}

async function saveBatchResult(item, result) {
  const docId = `${item.book}__${item.unit}__${item.num}`;
  await db.collection('analyses').doc(docId).set({
    book: item.book,
    unit: item.unit,
    number: item.num,
    // meta 필드 폐기 (메타·지문구조 카드 단순화로 미사용)
    logic: result.logic || null,
    vocab: result.vocab || null,
    grammar: result.grammar || null,
    schemaVersion: 2,
    savedAt: firebase.firestore.FieldValue.serverTimestamp(),
    savedBy: typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : null
  });
}

function updateBatchUI(job) {
  if (!job) return;

  // 선택되지 않은 job 은 state 만 갱신, DOM 렌더 스킵
  if (batchJobManager && batchJobManager.selectedId !== job.id) {
    if (batchJobManager) batchJobManager._updateSwitcherLabels();
    return;
  }

  const body = document.getElementById('batchProgressBody');
  if (!body || typeof renderJobChecklist !== 'function') return;
  const done = job.done || 0;
  const failed = job.failed || 0;
  const skipped = job.skipped || 0;
  const total = job.total || 0;
  const current = job.current || 0;
  const queue = job.queue || [];
  const results = job.results || {};

  const cur = current < queue.length ? queue[current] : null;
  const items = queue.map((it, i) => {
    const docId = `${it.book}__${it.unit}__${it.num}`;
    const st = results[docId];
    let status = 'pending';
    if (st === 'done') status = 'done';
    else if (st === 'skipped') status = 'skipped';
    else if (st === 'failed') status = 'failed';
    else if (i === current) status = 'running';
    return { book: it.book, unit: it.unit, num: it.num, status };
  });

  let headTitle = '일괄 꼼꼼분석 중';
  if (job.phase === 'cancelled') headTitle = '일괄 꼼꼼분석 — 중단됨';
  else if (job.phase === 'done') headTitle = '일괄 꼼꼼분석 — 완료';
  else if (job.phase === 'failed') headTitle = '일괄 꼼꼼분석 — 실패';

  // 경과 시간 + 토큰 사용량 + 원화 비용
  const elapsedMs = job._startedAt ? (Date.now() - job._startedAt) : 0;
  const tokens = job._tokens || { input: 0, output: 0 };
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;
  const costUsd = (typeof computeCostUsd === 'function') ? computeCostUsd(tokens, job.model) : 0;
  const costKrw = costUsd * rate;

  // 동적 상태 라벨 — 단순 'subLabel' 보다 정확한 진행 상황 우선
  let dynamicSub = '';
  const inProgressCount = Math.max(0, total - (done + failed));
  // CLI 동시 호출 큐 상태
  const queueStats = (typeof window.__claudeQueueStats === 'function') ? window.__claudeQueueStats() : null;
  const queueInfo = queueStats ? ` · API ${queueStats.active}/${queueStats.limit} 동시 (${queueStats.queued}개 대기)` : '';

  if (job.phase === 'prepare') {
    dynamicSub = '⏳ 분석 준비 중...';
  } else if (job.phase === 'running') {
    const calls = (job._tokens && job._tokens.calls) || 0;
    if (done + failed === 0 && calls === 0) {
      dynamicSub = `🚀 분석 실행 중 — Claude CLI 호출 시작 (${total}개 지문)${queueInfo}`;
    } else if (inProgressCount > 0) {
      dynamicSub = `🔄 분석 실행 중 — ${done + failed}/${total} 지문 처리${queueInfo}`;
    } else {
      dynamicSub = `🔄 마무리 중 — ${done + failed}/${total} 지문 처리${queueInfo}`;
    }
  } else if (job.phase === 'buildPdf') {
    dynamicSub = `📄 PDF 빌드 중... (${done}/${total} 완료)`;
  } else if (job.phase === 'done') {
    dynamicSub = job.subLabel || `✅ 완료 — 성공 ${done - skipped} · 실패 ${failed}${skipped ? ' · 스킵 ' + skipped : ''}`;
  } else if (job.phase === 'cancelled') {
    dynamicSub = job.subLabel || `⏸ 중단됨 — ${done + failed} / ${total} 처리`;
  } else if (job.phase === 'failed') {
    dynamicSub = job.subLabel || '❌ 분석 실패';
  }

  renderJobChecklist(body, {
    headTitle,
    subLabel: dynamicSub,
    elapsedMs,
    tokenUsage: (tokens.input || tokens.output) ? { input: tokens.input, output: tokens.output } : null,
    costKrw: costKrw,
    stats: { total, done: done - skipped, failed, skipped },
    phases: [
      { id: 'prepare', label: '범위 확정 및 큐 구성' },
      { id: 'running', label: 'AI 꼼꼼분석 실행', desc: `${done + failed} / ${total} 처리 · Firestore 자동 저장` },
      { id: 'buildPdf', label: 'PDF 빌드', desc: job._pdfBuildDesc || '' },
      { id: 'done', label: '완료' }
    ],
    phaseStates: job.phaseStates || {},
    currentItem: cur ? { book: cur.book, unit: cur.unit, num: cur.num } : null,
    items
  });

  // 취소 버튼 — 레이아웃 시프트 방지 (visibility)
  if (batchJobManager) {
    const cancelBtn = document.getElementById('batchCancelBtn');
    if (cancelBtn) {
      cancelBtn.style.visibility = batchJobManager.isJobRunning(job) ? 'visible' : 'hidden';
      cancelBtn.style.display = '';
    }
    batchJobManager._updateSwitcherLabels();
  }
}

function cancelBatchJob(jobId) {
  if (!batchJobManager) return;
  const targetId = jobId || batchJobManager.selectedId;
  if (!targetId) return;
  const job = batchJobManager.getJob(targetId);
  if (job && job.abortController) {
    job.abortController.abort();
  }
}

async function finishBatchJob(job) {
  if (!job) return;
  const wasAborted = job.abortController.signal.aborted;

  // 경과 시간 타이머 정지
  if (job._timerInterval) {
    clearInterval(job._timerInterval);
    job._timerInterval = null;
  }

  let title = '일괄 꼼꼼분석';
  let summary = '';

  const { done, failed, skipped, total, queue } = job;
  const successCount = done - skipped;

  const summaryParts = [`총 ${total}개`];
  summaryParts.push(`성공 ${successCount}`);
  if (skipped > 0) summaryParts.push(`스킵 ${skipped}`);
  if (failed > 0) summaryParts.push(`실패 ${failed}`);
  summary = summaryParts.join(' · ');

  try {
    const books = [...new Set(queue.map(q => q.book))];
    if (books.length === 1) title = books[0];
    else if (books.length > 1) title = `${books.length}개 교재`;
  } catch (e) { /* ignore */ }

  job.phaseStates.running = wasAborted ? 'failed' : 'done';
  job.current = job.queue.length;

  if (wasAborted) {
    job.phaseStates.done = 'pending';
    job.phase = 'cancelled';
    job.subLabel = `중단됨 — ${summary}`;
    updateBatchUI(job);
  } else {
    job.subLabel = `분석 완료 · ${summary}`;
    updateBatchUI(job);

    // Firestore 사용량 기록
    try {
      const tokens = job._tokens || { input: 0, output: 0, calls: 0 };
      if ((tokens.input || tokens.output) && typeof db !== 'undefined' && db) {
        const model = job.model || 'unknown';
        const costUsd = (typeof computeCostUsd === 'function') ? computeCostUsd(tokens, model) : 0;
        const calls = tokens.calls || 0;
        const inc = firebase.firestore.FieldValue.increment;
        const now = new Date();
        const monthId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const dayId = `${monthId}-${String(now.getDate()).padStart(2, '0')}`;
        // nested byModel 구조 (모델명에 점이 있어도 평면 key 로 저장되지 않도록)
        const byModelMonthly = { [model]: {
          input: inc(tokens.input), output: inc(tokens.output),
          costUsd: inc(costUsd), calls: inc(calls)
        }};
        const byModelDaily = { [model]: {
          costUsd: inc(costUsd), calls: inc(calls)
        }};
        await db.collection('usage_monthly').doc(monthId).set({
          totalInputTokens: inc(tokens.input), totalOutputTokens: inc(tokens.output),
          totalCostUsd: inc(costUsd), calls: inc(calls),
          byModel: byModelMonthly,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await db.collection('usage_daily').doc(dayId).set({
          totalCostUsd: inc(costUsd), calls: inc(calls),
          totalInputTokens: inc(tokens.input), totalOutputTokens: inc(tokens.output),
          byModel: byModelDaily,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    } catch (e) { console.warn('[batch] usage recording failed:', e.message); }

    // ── PDF 다운로드 버튼 (클릭 시 빌드) ──
    const passageCount = Object.keys(job.resultData || {}).length;
    if (passageCount > 0) {
      job.phaseStates.buildPdf = 'done';
      job._pdfBuildDesc = `${passageCount}개 지문 · 다운로드 시 생성`;

      const filenameBase = (() => {
        const books = [...new Set(Object.values(job.resultData || {}).map(d => d.item.book))];
        const prefix = books.length === 1 ? books[0] : `${books.length}개교재`;
        return `꼼꼼분석_${prefix.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
      })();
      let dlHtml = '<div class="wb-download-row">';
      dlHtml += `<button class="wb-download-btn" data-role="batch-dl-pdf">꼼꼼분석 PDF 다운로드 (${passageCount}개 지문)</button>`;
      dlHtml += '</div>';
      job._downloadsHtml = dlHtml;
      job._pdfFilename = filenameBase;
      // 클릭 시 PDF 빌드 → 저장 (on-demand)
      job._bindDownloads = (area) => {
        const btn = area.querySelector('[data-role="batch-dl-pdf"]');
        if (btn) btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = `PDF 생성 중... (${passageCount}개 지문, 잠시 기다려주세요)`;
          try {
            const pdf = await buildBatchPdf(job);
            if (pdf) {
              pdf.save(filenameBase);
              btn.textContent = `다운로드 완료!`;
              setTimeout(() => {
                btn.textContent = `꼼꼼분석 PDF 다운로드 (${passageCount}개 지문)`;
                btn.disabled = false;
              }, 2000);
            } else {
              btn.textContent = 'PDF 생성 실패';
              btn.disabled = false;
            }
          } catch (e) {
            console.warn('[batch] PDF build failed:', e.message);
            btn.textContent = `PDF 생성 실패: ${e.message}`;
            setTimeout(() => {
              btn.textContent = `꼼꼼분석 PDF 다운로드 (${passageCount}개 지문)`;
              btn.disabled = false;
            }, 3000);
          }
        });
      };
    } else {
      job.phaseStates.buildPdf = 'done';
      job._pdfBuildDesc = '분석 결과 없음';
    }

    // ── 완료 ──
    job.phaseStates.done = 'done';
    job.phase = 'done';
    job.subLabel = `✅ 완료! ${summary}`;
    updateBatchUI(job);
  }

  // Manager 업데이트 → running count 변화
  if (batchJobManager) {
    batchJobManager.notifyPhaseChanged(job.id);
  }

  // 대시보드 완료 작업 등록
  if (typeof dashboardRegisterCompleted === 'function') {
    try {
      dashboardRegisterCompleted({
        kind: '일괄 꼼꼼분석',
        title,
        summary,
        status: wasAborted ? 'aborted' : 'done',
        downloads: []
      });
    } catch (e) { /* ignore */ }
  }

  // Refresh saved overview
  loadSavedOverview();
}

async function loadSavedOverview() {
  const overviewBook = document.getElementById('overviewBook');
  const grid = document.getElementById('savedOverviewGrid');
  if (!overviewBook || !grid) return;

  const bookName = overviewBook.value;
  const bookDB = BOOKS[bookName];
  if (!bookDB) { grid.innerHTML = ''; return; }

  // Build full passage list
  const allPassages = [];
  Object.keys(bookDB).forEach(unit => {
    const keys = Object.keys(bookDB[unit]);
    if (keys.length && keys.every(k => /^\d/.test(k))) {
      keys.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    }
    keys.forEach(num => {
      allPassages.push({ unit, num, docId: `${bookName}__${unit}__${num}` });
    });
  });

  grid.innerHTML = '<div style="font-size:12px;color:#999;padding:8px 0">불러오는 중...</div>';

  try {
    const snapshot = await db.collection('analyses')
      .where('book', '==', bookName)
      .get();
    const savedIds = new Set(snapshot.docs.map(d => d.id));

    const units = [...new Set(allPassages.map(p => p.unit))];
    let html = '';
    let totalAll = 0, totalSaved = 0;

    units.forEach(unit => {
      const passages = allPassages.filter(p => p.unit === unit);
      const doneCount = passages.filter(p => savedIds.has(p.docId)).length;
      totalAll += passages.length;
      totalSaved += doneCount;

      html += `<div class="overview-unit">
        <div class="overview-unit-header">
          <span>${unit}</span>
          <span class="overview-count">${doneCount}/${passages.length}</span>
        </div>
        <div class="overview-items">
          ${passages.map(p => {
            const saved = savedIds.has(p.docId);
            return `<div class="overview-item ${saved ? 'saved' : ''}" title="${p.unit} ${p.num}">${p.num}</div>`;
          }).join('')}
        </div>
      </div>`;
    });

    // Summary header
    const summaryPct = totalAll > 0 ? Math.round((totalSaved / totalAll) * 100) : 0;
    const summary = `<div style="font-size:13px;color:#333;font-weight:600;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #f0f0f0">전체 ${totalSaved}/${totalAll} 완료 (${summaryPct}%)</div>`;

    grid.innerHTML = summary + html;
  } catch (e) {
    console.error('loadSavedOverview:', e);
    grid.innerHTML = '<div style="font-size:12px;color:#e04a4a;padding:8px 0">분석 현황을 불러올 수 없습니다.</div>';
  }
}
