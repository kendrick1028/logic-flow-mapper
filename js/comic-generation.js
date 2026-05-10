// ── Comic Generation Engine ──
// 영어 지문 → 4~8컷 만화 생성. gpt-image-1 으로 이미지 병렬 생성, 한국어 텍스트 오버레이.
// 다중 작업 지원: JobManager 기반.

let comicJobManager = null;
let _comicInitialized = false;

// ── 스타일 옵션 ──
const COMIC_STYLES = [
  { id: 'marvel', label: '마블 코믹스',
    bubbleStyle: 'bold action burst speech bubbles with thick black outlines, jagged shout balloons for emphasis',
    prompt: 'Marvel comics style, dynamic heroic poses, dramatic chiaroscuro lighting, bold ink linework, saturated primary colors, halftone shading dots, action-packed cinematic compositions, classic American superhero comic aesthetic' },
  { id: 'disney', label: '디즈니 애니메이션',
    bubbleStyle: 'soft rounded speech bubbles with friendly hand-drawn outlines',
    prompt: 'Classic Disney animation style, expressive cute characters with large round eyes, soft warm color palette, smooth clean linework, charming friendly facial expressions, painterly storybook backgrounds, family-friendly wholesome aesthetic' },
  { id: 'pixar', label: '픽사 3D',
    bubbleStyle: 'clean modern speech bubbles with subtle drop shadows',
    prompt: 'Pixar 3D animated film style, cinematic three-dimensional rendering, soft global illumination, expressive stylized characters, rich color grading, depth of field blur, polished CG storybook aesthetic' },
  { id: 'ghibli', label: '지브리 감성',
    bubbleStyle: 'soft hand-painted speech bubbles with gentle outlines',
    prompt: 'Studio Ghibli animation style, hand-painted watercolor backgrounds, warm natural lighting, gentle expressive characters, lush detailed nature scenery, nostalgic dreamy atmosphere, soft cel-shaded animation aesthetic' },
  { id: 'imalnyeon', label: '이말년 병맛 만화',
    bubbleStyle: 'crude exaggerated speech bubbles with messy outlines, large impact text balloons',
    prompt: 'Korean internet humor comic style (이말년 풍), deliberately crude simple linework, exaggerated absurd facial expressions, flat saturated colors, comedic chaotic compositions, meme-like aesthetic, intentionally rough but charming' },
  { id: 'webtoon', label: '한국 웹툰',
    bubbleStyle: 'modern clean digital speech bubbles with subtle gradients',
    prompt: 'Korean webtoon illustration style (manhwa), expressive detailed characters with large eyes, dynamic vertical scroll composition, clean digital linework with soft cel shading, vibrant modern colors, K-drama emotional aesthetic' },
  { id: 'yonkoma', label: '일본 4컷 만화',
    bubbleStyle: 'classic manga oval speech bubbles with sharp pointed tails',
    prompt: 'Japanese yonkoma 4-panel manga style, simple cute character design, clean black and white linework with screen tone shading, expressive chibi-like faces, gag manga aesthetic' },
  { id: 'educational', label: '심플 교육용',
    bubbleStyle: 'simple round friendly speech bubbles',
    prompt: 'Simple clean educational illustration style, bright cheerful colors, clear bold outlines, minimal flat shading, friendly cartoon characters, suitable for language learning textbook, approachable and clear' },
  { id: 'watercolor', label: '수채화 스토리북',
    bubbleStyle: 'soft watercolor speech bubbles with hand-drawn feel',
    prompt: 'Soft watercolor illustration style, gentle pastel colors, flowing brushstrokes, dreamy atmospheric quality, classic storybook illustration aesthetic' },
  { id: 'popart', label: '팝아트',
    bubbleStyle: 'bold POW BAM style burst bubbles with thick black outlines',
    prompt: 'Bold pop art comic style, vivid saturated primary colors, strong black outlines, Lichtenstein-inspired halftone dots, high contrast dramatic compositions, retro graphic novel aesthetic' }
];

// ── Phase 가중치 ──
const COMIC_PHASE_WEIGHTS = {
  prepare: 2,
  analyze: 15,
  generatePrompts: 8,
  generateImages: 55,
  qualityCheck: 10,
  compose: 5,
  buildPdf: 5,
  done: 0
};

const COMIC_IMAGE_CONCURRENCY = 8;       // 기본값 (runtime 엔 job.panelCount 사용)
const COMIC_IMAGE_MAX_RETRIES = 2;
const COMIC_IMAGE_TIMEOUT_MS = 180000;   // 3분 (이미지 생성은 느림)

// 이미지 생성 모델 목록 (드롭다운 렌더용)
const IMAGE_MODELS = [
  { id: 'gpt-image-1.5-low',               label: 'GPT Image 1.5 Low',    emoji: '🎨', usdPerImage: 0.009,  note: '최저가 · OpenAI' },
  { id: 'gpt-image-1.5-medium',            label: 'GPT Image 1.5 Medium', emoji: '🎨', usdPerImage: 0.034,  note: '균형 · OpenAI' },
  { id: 'gpt-image-1.5-high',              label: 'GPT Image 1.5 High',   emoji: '🎨', usdPerImage: 0.133,  note: '최고품질 · OpenAI' },
  { id: 'gemini-3.1-flash-image-preview',  label: '나노바나나 2',          emoji: '🍌', usdPerImage: 0.0672, note: 'Gemini 3.1 Flash · 4K, 한글 강함' },
  { id: 'gemini-3-pro-image-preview',      label: '나노바나나 Pro',        emoji: '🍌', usdPerImage: 0.134,  note: 'Gemini 3 Pro · 최고품질' },
  { id: 'gemini-2.5-flash-image',          label: '나노바나나 1',          emoji: '🍌', usdPerImage: 0.039,  note: 'Gemini 2.5 · 기본' }
];

// ── 초기화 ──
function initComic() {
  if (_comicInitialized) return;
  const tree = document.getElementById('comicRangeTree');
  if (!tree || typeof BOOKS === 'undefined') return;
  _comicInitialized = true;

  // JobManager
  if (!comicJobManager && typeof JobManager !== 'undefined') {
    comicJobManager = new JobManager({
      featureKey: 'comic',
      switcherId: 'comicJobSwitcher',
      progressBodyId: 'comicProgressBody',
      downloadCardId: 'comicDownloadsCard',
      downloadAreaId: 'comicDownloadArea',
      cancelBtnId: 'comicCancelBtn',
      emptyStateId: 'comicEmptyState',
      labelFn: (job) => {
        const title = job.comicTitle || '만화';
        const pct = computeComicOverallPct(job);
        const status = job.phase === 'cancelled' ? '중단' :
                       job.phase === 'done' ? '완료' :
                       job.phase === 'failed' ? '실패' :
                       `${pct}%`;
        return `${title} (${status})`;
      },
      renderFn: (job) => updateComicUI(job),
      onRemove: (job) => {
        if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; }
      }
    });
    if (typeof window !== 'undefined') {
      window._jobManagers = window._jobManagers || {};
      window._jobManagers.comic = comicJobManager;
    }
    comicJobManager.renderSelected();
  }

  // Range tree
  if (typeof initRangeTree === 'function') {
    initRangeTree(tree, updateComicRangeSummary);
    updateComicRangeSummary();
  }

  // Provider/Model selectors
  if (typeof AI_MODELS !== 'undefined') {
    const provSel = document.getElementById('comicProvider');
    const modelSel = document.getElementById('comicModel');
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
      provSel.addEventListener('change', updateComicModelOptions);
      updateComicModelOptions();
    }
  }

  // Style dropdown
  const styleSel = document.getElementById('comicStyle');
  if (styleSel) {
    styleSel.innerHTML = '';
    COMIC_STYLES.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.label;
      styleSel.appendChild(o);
    });
  }

  // Image model dropdown — 동적으로 품질/원화 비용 표시
  populateImageModelDropdown();
  // 환율이 뒤늦게 로드되는 경우 대비 — 1초 후 재렌더
  setTimeout(populateImageModelDropdown, 1500);
}

// 만화 1건 평균 6컷 기준 원화 표시 (실시간 환율 적용)
function populateImageModelDropdown() {
  const sel = document.getElementById('comicImageModel');
  if (!sel) return;
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;
  const currentVal = sel.value;
  const panelsRef = 6;  // 기준 문항 수 (안내용)

  const openaiModels = IMAGE_MODELS.filter(m => m.id.startsWith('gpt'));
  const geminiModels = IMAGE_MODELS.filter(m => m.id.startsWith('gemini'));

  let html = '';
  const fmtKrw = (usd) => `₩${Math.round(usd * rate).toLocaleString()}`;
  const renderOption = (m) => {
    const perImageKrw = fmtKrw(m.usdPerImage);
    const comicKrw = fmtKrw(m.usdPerImage * panelsRef);
    return `<option value="${m.id}">${m.emoji} ${m.label} — 장당 ${perImageKrw} · 6컷 ${comicKrw}</option>`;
  };
  if (openaiModels.length) {
    html += '<optgroup label="OpenAI">';
    openaiModels.forEach(m => { html += renderOption(m); });
    html += '</optgroup>';
  }
  if (geminiModels.length) {
    html += '<optgroup label="Google Gemini">';
    geminiModels.forEach(m => { html += renderOption(m); });
    html += '</optgroup>';
  }
  sel.innerHTML = html;
  // 선택값 복원
  if (currentVal && IMAGE_MODELS.find(m => m.id === currentVal)) {
    sel.value = currentVal;
  } else {
    sel.value = 'gpt-image-1.5-medium';  // 기본: GPT Image 1.5 Medium
  }
}

function updateComicRangeSummary() {
  const el = document.getElementById('comicRangeSummary');
  const tree = document.getElementById('comicRangeTree');
  if (!el || !tree) return;
  const count = typeof getRangeSelectionCount === 'function' ? getRangeSelectionCount(tree) : 0;
  el.textContent = `선택된 지문: ${count}개`;
}

function updateComicModelOptions() {
  const provider = document.getElementById('comicProvider').value;
  const modelSel = document.getElementById('comicModel');
  if (!modelSel) return;
  modelSel.innerHTML = '';
  AI_MODELS.filter(m => m.provider === provider).forEach(m => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  });
}

function computeComicOverallPct(job) {
  if (!job) return 0;
  const states = job.phaseStates || {};
  const progress = job._phaseProgress || {};
  let total = 0, done = 0;
  Object.entries(COMIC_PHASE_WEIGHTS).forEach(([id, w]) => {
    const st = states[id];
    if (st == null) return;
    total += w;
    if (st === 'done') done += w;
    else if (st === 'active') done += w * (progress[id] || 0);
  });
  return total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
}

function setComicPhaseProgress(job, phaseId, val) {
  if (!job) return;
  job._phaseProgress = job._phaseProgress || {};
  job._phaseProgress[phaseId] = Math.max(0, Math.min(1, val));
}

function pushComicDetail(job, phaseId, item) {
  if (!job) return;
  job._phaseDetails = job._phaseDetails || {};
  const arr = job._phaseDetails[phaseId] || [];
  if (item && item.id) {
    const existing = arr.findIndex(x => x && x.id === item.id);
    if (existing !== -1) { arr[existing] = Object.assign({}, arr[existing], item); job._phaseDetails[phaseId] = arr; return; }
  }
  arr.push(item);
  if (arr.length > 100) arr.splice(0, arr.length - 100);
  job._phaseDetails[phaseId] = arr;
}

// ── 시작 ──
function startComicJob() {
  const tree = document.getElementById('comicRangeTree');
  const items = typeof getRangeSelection === 'function' ? getRangeSelection(tree) : [];
  if (!items.length) { alert('지문을 한 개 이상 선택해주세요.'); return; }

  const provider = document.getElementById('comicProvider').value;
  const model = document.getElementById('comicModel').value;
  const imageModelEl = document.getElementById('comicImageModel');
  const imageModel = (imageModelEl && imageModelEl.value) || 'gemini-3.1-flash-image-preview';
  const styleId = document.getElementById('comicStyle').value;
  const style = COMIC_STYLES.find(s => s.id === styleId) || COMIC_STYLES[0];
  const titleEl = document.getElementById('comicTitle');
  const comicTitle = (titleEl && titleEl.value || '').trim() || '만화';

  // 첫 번째 지문만 사용 (만화는 지문 1개 단위)
  const item = items[0];

  const phaseStates = {
    prepare: 'active',
    analyze: 'pending',
    generatePrompts: 'pending',
    generateImages: 'pending',
    qualityCheck: 'pending',
    compose: 'pending',
    buildPdf: 'pending',
    done: 'pending'
  };

  const job = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `comic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'comic',
    item, provider, model, imageModel, style, comicTitle,
    panelCount: 0,
    panels: [],
    _tokens: { input: 0, output: 0, calls: 0 },
    _imagesGenerated: 0,
    _phaseProgress: {},
    _phaseDetails: {},
    _startedAt: Date.now(),
    _timerInterval: null,
    _finalCostLine: '',
    _downloadsHtml: '',
    _bindDownloads: null,
    _composedHtml: '',
    abortController: new AbortController(),
    phase: 'prepare',
    phaseStates,
    subLabel: '준비 중...'
  };

  if (comicJobManager) comicJobManager.addJob(job);
  if (typeof setPanelRunning === 'function') setPanelRunning('comic', true);

  job._timerInterval = setInterval(() => updateComicUI(job), 1000);
  updateComicUI(job, '준비 중...');

  runComicPipeline(job).finally(() => {
    if (typeof updateSidebarIndicators === 'function') updateSidebarIndicators();
  });
}

// ── 파이프라인 ──
async function runComicPipeline(job) {
  const { item, provider, model, style } = job;
  const sig = job.abortController.signal;

  try {
    // ── Phase 1: Analyze ──
    job.phase = 'analyze';
    job.phaseStates.prepare = 'done';
    job.phaseStates.analyze = 'active';
    updateComicUI(job, '지문 분석 중...');

    const analysisPrompt = buildAnalysisPrompt(item.passage);
    const analysis = await callAITracked(job, provider, model,
      `다음 영어 지문을 분석하세요:\n\n${item.passage}`,
      analysisPrompt, sig, 'high');

    job.panelCount = analysis.panelCount || 4;
    job.panels = Array.isArray(analysis.panels) ? analysis.panels : [];
    if (job.panels.length === 0) {
      // 스토리보드 AI 가 아무것도 반환 못 함 — 에러로 처리 (빈 패딩으로 그림 생성하지 않음)
      throw new Error('스토리보드 AI 가 패널을 반환하지 못했습니다. 다시 시도하거나 다른 스토리보드 모델을 선택해주세요.');
    }
    if (job.panels.length < job.panelCount) {
      // 일부 부족한 경우만 패딩 — 캡션/대사는 비워서 이미지에 텍스트가 강제되지 않도록
      while (job.panels.length < job.panelCount) {
        job.panels.push({ scene: 'A simple scene related to the passage', speechBubble: '', caption: '', keywordsEn: [] });
      }
    }
    job.panels = job.panels.slice(0, job.panelCount);

    pushComicDetail(job, 'analyze', {
      status: 'done',
      label: `${job.panelCount}컷 만화 구성 완료`,
      desc: `지문 ${item.book} · ${item.unit} · ${item.num}번`
    });
    job.phaseStates.analyze = 'done';
    setComicPhaseProgress(job, 'analyze', 1);

    if (sig.aborted) throw new Error('aborted');

    // ── Phase 2: Generate Prompts ──
    job.phase = 'generatePrompts';
    job.phaseStates.generatePrompts = 'active';
    updateComicUI(job, '이미지 프롬프트 생성 중...');

    // 지문을 압축해서 이미지 모델에 컨텍스트로 전달 (~600자 제한, 토큰 비용 절감)
    const passageContext = (item.passage || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    job.panels.forEach((panel, i) => {
      panel._imagePrompt = buildImagePrompt(panel, style, i, job.panelCount, passageContext);
      pushComicDetail(job, 'generatePrompts', {
        status: 'done',
        label: `${i + 1}/${job.panelCount}컷 프롬프트`,
        desc: (panel.scene || '').slice(0, 80)
      });
    });
    job.phaseStates.generatePrompts = 'done';
    setComicPhaseProgress(job, 'generatePrompts', 1);

    if (sig.aborted) throw new Error('aborted');

    // ── Phase 3: Generate Images (병렬) ──
    job.phase = 'generateImages';
    job.phaseStates.generateImages = 'active';
    updateComicUI(job, `이미지 생성 시작 (${job.panelCount}컷 병렬)...`);

    let imagesDone = 0;
    // 병렬 수 = 패널 수 (한 번에 모두 병렬 실행). Tier 4 기준 RPM 여유.
    const concurrency = Math.max(1, job.panels.length);
    await runComicWithConcurrency(job, job.panels, concurrency, async (panel, idx) => {
      if (sig.aborted) return;
      const rid = `img_${idx}`;
      pushComicDetail(job, 'generateImages', {
        id: rid, status: 'running',
        label: `${idx + 1}컷 이미지 생성 중...`,
        desc: style.label
      });
      updateComicUI(job);

      try {
        const result = await generatePanelImage(panel._imagePrompt, sig, job.imageModel);
        panel.imageBase64 = result.base64;
        panel._imageModelUsed = result.usedFallback || job.imageModel;
        job._imagesGenerated = (job._imagesGenerated || 0) + 1;
        if (result.usedFallback) {
          job._fallbackCount = (job._fallbackCount || 0) + 1;
        }
        pushComicDetail(job, 'generateImages', {
          id: rid, status: 'done',
          label: `${idx + 1}컷 이미지 완료${result.usedFallback ? ' (Nano Banana 폴백)' : ''}`,
          desc: ''
        });
      } catch (e) {
        console.warn(`[comic] image gen failed for panel ${idx}:`, e.message);
        panel.imageBase64 = null;
        pushComicDetail(job, 'generateImages', {
          id: rid, status: 'failed',
          label: `${idx + 1}컷 이미지 실패`,
          desc: e.message
        });
      }
      imagesDone++;
      setComicPhaseProgress(job, 'generateImages', imagesDone / job.panelCount);
      job.subLabel = `이미지 ${imagesDone}/${job.panelCount} (병렬)`;
      updateComicUI(job);
    });

    job.phaseStates.generateImages = 'done';
    setComicPhaseProgress(job, 'generateImages', 1);

    if (sig.aborted) throw new Error('aborted');

    // ── Phase 4: Quality Check (실패 재시도) ──
    job.phase = 'qualityCheck';
    job.phaseStates.qualityCheck = 'active';
    updateComicUI(job, '품질 검증 중...');

    let retryCount = 0;
    for (let i = 0; i < job.panels.length; i++) {
      if (sig.aborted) break;
      const panel = job.panels[i];
      if (panel.imageBase64) {
        pushComicDetail(job, 'qualityCheck', { status: 'done', label: `${i + 1}컷 통과`, desc: '' });
        continue;
      }
      // 재시도
      for (let retry = 0; retry < COMIC_IMAGE_MAX_RETRIES; retry++) {
        if (sig.aborted) break;
        retryCount++;
        pushComicDetail(job, 'qualityCheck', {
          id: `retry_${i}`, status: 'running',
          label: `${i + 1}컷 재생성 (${retry + 1}/${COMIC_IMAGE_MAX_RETRIES})`,
          desc: ''
        });
        updateComicUI(job);
        try {
          const result = await generatePanelImage(panel._imagePrompt, sig, job.imageModel);
          panel.imageBase64 = result.base64;
          panel._imageModelUsed = result.usedFallback || job.imageModel;
          job._imagesGenerated = (job._imagesGenerated || 0) + 1;
          if (result.usedFallback) job._fallbackCount = (job._fallbackCount || 0) + 1;
          pushComicDetail(job, 'qualityCheck', {
            id: `retry_${i}`, status: 'done',
            label: `${i + 1}컷 재생성 성공`,
            desc: ''
          });
          break;
        } catch (e) {
          if (retry === COMIC_IMAGE_MAX_RETRIES - 1) {
            pushComicDetail(job, 'qualityCheck', {
              id: `retry_${i}`, status: 'failed',
              label: `${i + 1}컷 재생성 실패`,
              desc: e.message
            });
          }
        }
      }
      setComicPhaseProgress(job, 'qualityCheck', (i + 1) / job.panels.length);
    }

    job.phaseStates.qualityCheck = 'done';
    setComicPhaseProgress(job, 'qualityCheck', 1);

    if (sig.aborted) throw new Error('aborted');

    // ── Phase 5: Compose ──
    // 말풍선/텍스트가 이미지 안에 이미 포함됨 → HTML 조립 단계 생략 (PDF 를 jsPDF 로 직접 조립)
    job.phase = 'compose';
    job.phaseStates.compose = 'done';
    setComicPhaseProgress(job, 'compose', 1);

  } catch (e) {
    if (e && e.message === 'aborted') {
      job.phase = 'cancelled';
      job.subLabel = '중단됨';
    } else {
      console.error('[comic] pipeline error:', e);
      job.phase = 'failed';
      job._failedError = (e && e.message) || '알 수 없는 오류';
      job.subLabel = `실패: ${job._failedError}`;
    }
  }

  await finishComicJob(job);
}

// ── 이미지 생성 API 호출 (모델별 디스패치) ──
// 반환: { base64, usedFallback?: string } — 폴백 발생 시 fallback 모델 이름 포함
async function generatePanelImage(prompt, externalSignal, imageModel) {
  const full = imageModel || 'gpt-image-1.5-medium';
  if (full.startsWith('gemini')) {
    const b64 = await generatePanelImageGemini(prompt, externalSignal, full);
    return { base64: b64 };
  }
  // gpt-image-1.5-{low|medium|high} 또는 gpt-image-1
  let model = full;
  let quality = 'medium';
  const match = full.match(/^(gpt-image-[\d.]+)-(low|medium|high)$/);
  if (match) {
    model = match[1];
    quality = match[2];
  }
  try {
    const b64 = await generatePanelImageOpenAI(prompt, externalSignal, model, quality);
    return { base64: b64 };
  } catch (e) {
    // OpenAI 안전 거부 → Nano Banana 2 로 자동 폴백
    if (e && e.code === 'SAFETY_REJECTED') {
      console.warn('[comic] OpenAI 안전 거부 → Nano Banana 2 폴백');
      const fallbackModel = 'gemini-3.1-flash-image-preview';
      const b64 = await generatePanelImageGemini(prompt, externalSignal, fallbackModel);
      return { base64: b64, usedFallback: fallbackModel };
    }
    throw e;
  }
}

// ── Gemini Nano Banana (gemini-2.5-flash-image-preview) ──
async function generatePanelImageGemini(prompt, externalSignal, model) {
  if (typeof nextGeminiKey !== 'function') throw new Error('Gemini API 키 관리자가 없습니다.');
  const apiKey = nextGeminiKey();
  if (!apiKey) throw new Error('Gemini API 키가 없습니다.');

  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort('timeout'), COMIC_IMAGE_TIMEOUT_MS);
  const onExternalAbort = () => timeoutCtrl.abort('external');
  if (externalSignal) {
    if (externalSignal.aborted) timeoutCtrl.abort('external');
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: timeoutCtrl.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Nano Banana 계열 모델은 TEXT + IMAGE 모두 명시 필수
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        // 프롬프트 레벨 안전 필터 완전 해제 (이미지 출력 필터는 모델 내부에 남아있음)
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',   threshold: 'BLOCK_NONE' }
        ]
      })
    });

    if (res.status === 429) throw new Error('Gemini 이미지 API 한도 초과. 잠시 후 다시 시도해주세요.');
    if (res.status === 401 || res.status === 403) throw new Error('Gemini API 키 인증 실패.');

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Gemini 이미지 생성 오류 (${res.status})`);

    // Gemini 응답: candidates[0].content.parts[].inlineData.data (base64)
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      // inlineData 또는 inline_data (API 버전에 따라 snake_case 반환 가능)
      const inline = part.inlineData || part.inline_data;
      if (inline && inline.data) {
        return inline.data;
      }
    }
    // 이미지 없음: 안전 필터, 빈 응답, 또는 텍스트만 반환 — 원인 로깅
    const finishReason = candidate?.finishReason || 'UNKNOWN';
    const textOnly = parts.filter(p => p.text).map(p => p.text).join(' ').slice(0, 200);
    const safetyRatings = candidate?.safetyRatings || data?.promptFeedback?.safetyRatings || [];
    const blocked = (data?.promptFeedback?.blockReason) || (safetyRatings.find(r => r.blocked)?.category) || null;
    throw new Error(`Gemini 이미지 응답 없음 (finishReason=${finishReason}${blocked ? ', blocked=' + blocked : ''}${textOnly ? ', text="' + textOnly + '"' : ''})`);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (externalSignal && externalSignal.aborted) throw new Error('만화 생성이 취소되었습니다.');
      throw new Error(`이미지 생성 시간 초과 (${COMIC_IMAGE_TIMEOUT_MS / 1000}초).`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// ── OpenAI gpt-image-1 ──
async function generatePanelImageOpenAI(prompt, externalSignal, model, quality) {
  const apiKey = typeof getOpenAIKey === 'function' ? getOpenAIKey() : '';
  if (!apiKey) throw new Error('OpenAI API 키가 없습니다.');

  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort('timeout'), COMIC_IMAGE_TIMEOUT_MS);
  const onExternalAbort = () => timeoutCtrl.abort('external');
  if (externalSignal) {
    if (externalSignal.aborted) timeoutCtrl.abort('external');
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const body = {
      model: model || 'gpt-image-1.5',
      prompt,
      n: 1,
      size: '1024x1024'
    };
    // gpt-image-1.5 계열만 quality 필드 지원
    if (/gpt-image-1\.5/.test(body.model) && ['low', 'medium', 'high'].includes(quality)) {
      body.quality = quality;
    }
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: timeoutCtrl.signal,
      body: JSON.stringify(body)
    });

    if (res.status === 429) throw new Error('이미지 생성 API 한도 초과. 잠시 후 다시 시도해주세요.');
    if (res.status === 401) throw new Error('OpenAI API 키 인증 실패.');

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || `이미지 생성 오류 (${res.status})`;
      // 안전 시스템 거부 감지
      const isSafety = /safety system|safety filter|content_policy|rejected by/i.test(msg) ||
                       data.error?.code === 'content_policy_violation' ||
                       data.error?.type === 'image_generation_user_error';
      const err = new Error(msg);
      if (isSafety) err.code = 'SAFETY_REJECTED';
      throw err;
    }

    // gpt-image-1 은 b64_json 또는 url 반환
    const imgData = data.data && data.data[0];
    if (!imgData) throw new Error('이미지 데이터 없음');

    // base64 우선, 없으면 URL 에서 fetch
    if (imgData.b64_json) return imgData.b64_json;
    if (imgData.url) {
      const imgRes = await fetch(imgData.url);
      const blob = await imgRes.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
    throw new Error('이미지 응답 형식 인식 불가');
  } catch (e) {
    if (e.name === 'AbortError') {
      if (externalSignal && externalSignal.aborted) throw new Error('만화 생성이 취소되었습니다.');
      throw new Error(`이미지 생성 시간 초과 (${COMIC_IMAGE_TIMEOUT_MS / 1000}초).`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// ── 프롬프트 빌드 ──
function buildAnalysisPrompt(passage) {
  const wordCount = passage.split(/\s+/).length;
  const suggestedPanels = wordCount < 150 ? 4 : wordCount < 250 ? 6 : 8;
  return `당신은 학생들이 키득거리며 읽을 수 있는 영어 교육용 만화 작가입니다. 주어진 영어 지문의 내용을 ${suggestedPanels}컷 만화로 충실하게 각색하세요.
반드시 JSON 형식으로만 응답하세요.

🎯 절대 원칙: 만화는 지문의 실제 내용을 시각적으로 재현해야 합니다. 일반적인 학교/수업 장면이 아니라, 지문에서 실제로 다루는 주제·등장인물·사물·사건·실험·연구 등을 그대로 옮겨야 합니다.

📖 분석 단계 (먼저 머릿속으로 수행):
1. 지문의 핵심 주제는 무엇인가? (예: 청색광이 수면에 미치는 영향, 산호초 백화 현상, 고대 그리스 철학자의 일화 등)
2. 지문에 등장하는 구체적 대상은 무엇인가? (사람·동물·사물·장소·실험기구·자연현상 등)
3. 지문이 전달하는 핵심 사건/논리 흐름은? (원인→결과, 문제→해결, 발견→영향 등)

✏️ 톤 & 스타일 가이드:
- 짧고 임팩트 있는 대사 (한 말풍선당 8~20자, 절대 30자 넘지 말 것)
- 친근한 구어체 — "~지", "~잖아", "~네!", "~거든?"
- 적절한 감탄사 — "헐!", "우와", "엥?", "어머!", "그래서?", "대박"
- 학생이 키득거릴 수 있는 위트 — 너무 진지하지 않게
- 단, 지문의 핵심 사실/개념은 정확히 전달 (지어내거나 일반화하지 말 것)

출력 형식:
{
  "panelCount": ${suggestedPanels},
  "panels": [
    {
      "scene": "Vivid visual description in English of THIS SPECIFIC moment from the passage. Must include: (1) the concrete subject(s) from the passage — actual objects/animals/people/phenomena mentioned (not generic), (2) the specific action or state happening in this panel, (3) the setting/environment from the passage, (4) facial expressions and emotions. Be hyper-specific to the passage content. NEVER write generic scenes like 'a teacher in a classroom' unless the passage is literally about a teacher in a classroom.",
      "speechBubble": "이 컷에서 이 장면이 전달하는 지문의 핵심 정보를 재치있는 한국어 대사로 (8~20자). 지문에 없는 내용 지어내지 말 것. 빈 문자열 가능.",
      "caption": "상단 캡션 (선택). 시간/배경/상황 전환 표시. 예: '실험 시작!', '24시간 후', '연구 결과는?'",
      "keywordsEn": ["passage에 실제로 등장한 핵심 영단어 2~4개"]
    }
  ]
}

📌 규칙:
- ⚠️ scene 은 반드시 지문에 등장한 실제 내용을 묘사. 일반적/추상적 장면 절대 금지.
- ⚠️ speechBubble 과 caption 은 반드시 한국어. 영어 문장 금지.
- speechBubble 과 caption 중 최소 하나는 반드시 채울 것
- 각 컷은 지문의 서로 다른 핵심 포인트를 하나씩 전달 (기승전결 또는 논리 흐름 유지)
- 캐릭터 일관성을 위해 주인공/주요 등장인물의 외형(나이/머리/옷)을 첫 컷의 scene 에서 명시 → 이후 컷에서도 동일하게 유지
- keywordsEn 은 지문에 실제로 나온 단어로만 (지어내지 말 것)
- 한국어 대사 안에 핵심 영단어 괄호 보충 가능: "이거 (experiment) 진짜 신기해!" (문장은 한국어 유지)`;
}

function buildImagePrompt(panel, style, idx, totalPanels, passageContext) {
  // 호환: 기존 dialogueKo / narrationKo 가 있으면 fallback
  const speech = panel.speechBubble || panel.dialogueKo || '';
  const caption = panel.caption || panel.narrationKo || '';
  const keywords = Array.isArray(panel.keywordsEn) ? panel.keywordsEn.filter(Boolean) : [];

  const textParts = [];
  if (caption) {
    textParts.push(`- A rectangular caption box at the top of the panel containing the EXACT Korean text: 「${caption}」`);
  }
  if (speech) {
    textParts.push(`- A speech bubble pointing to the speaking character containing the EXACT Korean text: 「${speech}」`);
  }
  const textBlock = textParts.length
    ? `\n\nTEXT IN PANEL — render these EXACTLY as written, in clean legible KOREAN HANGUL (한글) characters:\n${textParts.join('\n')}\n\n⚠️ IMPORTANT TEXT RULES:\n- ALL text in the image MUST be in Korean Hangul (한글) — never English, never Latin letters, never any other language.\n- The Korean characters MUST be accurate, sharp, and readable.\n- Use ${style.bubbleStyle || 'classic comic speech bubbles'}.\n- Do NOT add any other text, signs, labels, English words, or written content beyond exactly what is specified above.`
    : '\n\nNo text or speech bubbles in this panel — purely visual, no written content of any kind.';

  const keywordBlock = keywords.length
    ? `\n\nVISUAL ELEMENTS TO INCLUDE — these specific concepts MUST be visually represented in the scene: ${keywords.join(', ')}`
    : '';

  const contextBlock = passageContext
    ? `\n\nSOURCE PASSAGE CONTEXT (the comic must visually convey this content): "${passageContext}"`
    : '';

  return `${style.prompt}.

Scene: ${panel.scene || 'A simple educational scene'}${keywordBlock}${contextBlock}

This is panel ${idx + 1} of ${totalPanels} in a comic strip illustrating an English reading passage. The visual MUST faithfully depict the actual subject matter of the source passage — not a generic classroom or school scene unless the passage is literally about that. Square format, single panel composition. Maintain consistent character design (same age, hairstyle, clothing) throughout the entire strip.${textBlock}`;
}

// ── 만화 조합 HTML ──
function buildComicCompositeHtml(job, useSmall) {
  const cols = 2;
  const panels = job.panels;
  const gap = 10;
  const panelWidth = 340;

  let html = `<div style="max-width:720px;margin:0 auto;font-family:'Pretendard','Noto Sans KR',sans-serif">`;

  // 타이틀
  html += `<div style="text-align:center;margin-bottom:16px">
    <div style="font-size:20px;font-weight:800;color:#1a1a1a;margin-bottom:4px">${_comicEsc(job.comicTitle)}</div>
    <div style="font-size:11px;color:#888">${_comicEsc(job.item.book)} · ${_comicEsc(job.item.unit)} · ${_comicEsc(job.item.num)}번 · ${job.style.label}</div>
  </div>`;

  // 격자
  html += `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:${gap}px">`;

  panels.forEach((panel, i) => {
    const b64 = (useSmall && panel._smallBase64) ? panel._smallBase64 : panel.imageBase64;
    const imgFormat = (useSmall && panel._smallBase64) ? 'jpeg' : 'png';
    const imgSrc = b64
      ? `data:image/${imgFormat};base64,${b64}`
      : 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#f0f0f0"/><text x="200" y="200" text-anchor="middle" fill="#999" font-size="16">이미지 생성 실패</text></svg>');

    html += `<div style="border:2px solid #222;border-radius:8px;overflow:hidden;background:#fff;break-inside:avoid;position:relative">`;
    // 컷 번호 (이미지 위 좌상단)
    html += `<div style="position:absolute;top:6px;left:6px;width:24px;height:24px;border-radius:50%;background:#222;color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;z-index:1">${i + 1}</div>`;
    html += `<img src="${imgSrc}" style="width:100%;aspect-ratio:1;object-fit:cover;display:block" />`;
    html += `</div>`;
  });

  html += `</div>`;

  // 어휘 요약
  const allKeywords = [...new Set(panels.flatMap(p => p.keywordsEn || []))];
  if (allKeywords.length) {
    html += `<div style="margin-top:14px;padding:10px 14px;background:#f8f9fc;border:1px solid #e3e8f5;border-radius:8px">
      <div style="font-size:10px;font-weight:700;color:#888;letter-spacing:0.05em;margin-bottom:6px">KEY VOCABULARY</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${allKeywords.map(kw => `<span style="background:#fff;border:1px solid #d6e0f8;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;color:#333">${_comicEsc(kw)}</span>`).join('')}
      </div>
    </div>`;
  }

  html += `</div>`;
  return html;
}

// ── 이미지 축소 헬퍼 (1024→targetPx, canvas GPU 가속) ──
function downsizeBase64Image(base64, targetPx) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(targetPx / img.width, targetPx / img.height, 1);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // JPEG 로 변환 (PNG 보다 훨씬 작음)
      const result = canvas.toDataURL('image/jpeg', 0.85);
      resolve(result.split(',')[1]);  // base64 부분만
    };
    img.onerror = reject;
    img.src = 'data:image/png;base64,' + base64;
  });
}

// ── jsPDF 직접 조립 (html2canvas 우회 → 즉시 완료) ──
function buildComicPdfDirect(job) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = 210, pageH = 297;
  const margin = 12;
  const usableW = pageW - margin * 2;
  const cols = 2;
  const gap = 4;
  const cellW = (usableW - gap * (cols - 1)) / cols;
  const imgH = cellW;   // 정사각형 이미지
  const cellH = imgH;   // 텍스트 영역 제거 (말풍선이 이미지에 포함됨)
  let y = margin;

  // 타이틀
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(job.comicTitle || 'Comic', pageW / 2, y + 6, { align: 'center' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(128);
  doc.text(`${job.item.book} · ${job.item.unit} · ${job.item.num} · ${job.style.label}`, pageW / 2, y + 12, { align: 'center' });
  doc.setTextColor(0);
  y += 18;

  // 패널 격자
  const panels = job.panels || [];
  panels.forEach((panel, i) => {
    const col = i % cols;
    const x = margin + col * (cellW + gap);

    // 새 행 시작 (2컷마다)
    if (col === 0 && i > 0) {
      y += cellH + gap;
    }

    // 페이지 넘김 체크
    if (y + cellH > pageH - margin) {
      doc.addPage();
      y = margin;
    }

    // 패널 테두리
    doc.setDrawColor(34, 34, 34);
    doc.setLineWidth(0.5);
    doc.roundedRect(x, y, cellW, cellH, 2, 2, 'S');

    // 이미지
    if (panel.imageBase64) {
      try {
        doc.addImage('data:image/png;base64,' + panel.imageBase64, 'PNG', x + 0.5, y + 0.5, cellW - 1, imgH - 1);
      } catch (e) {
        doc.setFillColor(240, 240, 240);
        doc.rect(x + 0.5, y + 0.5, cellW - 1, imgH - 1, 'F');
      }
    } else {
      doc.setFillColor(240, 240, 240);
      doc.rect(x + 0.5, y + 0.5, cellW - 1, imgH - 1, 'F');
      doc.setFontSize(8);
      doc.setTextColor(153);
      doc.text('Image failed', x + cellW / 2, y + imgH / 2, { align: 'center' });
      doc.setTextColor(0);
    }

    // 컷 번호 (원형 배지)
    doc.setFillColor(34, 34, 34);
    doc.circle(x + 5, y + 5, 3.5, 'F');
    doc.setTextColor(255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text(String(i + 1), x + 5, y + 6.2, { align: 'center' });
    doc.setTextColor(0);
    doc.setFont('helvetica', 'normal');
  });

  // 어휘 요약 페이지 하단
  const allKeywords = [...new Set(panels.flatMap(p => p.keywordsEn || []))];
  if (allKeywords.length) {
    y += cellH + gap + 6;
    if (y > pageH - 30) { doc.addPage(); y = margin; }
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(128);
    doc.text('KEY VOCABULARY', margin, y);
    doc.setTextColor(0);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const kwText = allKeywords.join('  ·  ');
    const kwLines = doc.splitTextToSize(kwText, usableW);
    doc.text(kwLines, margin, y + 5);
  }

  return doc;
}

function _comicEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Firestore 사용량 기록 (만화: 텍스트 분석 토큰 + 이미지 생성 비용) ──
async function recordComicUsageToFirestore(job) {
  if (typeof db === 'undefined' || !db) return;
  const tokens = job._tokens || { input: 0, output: 0, calls: 0 };
  const imageCount = job._imagesGenerated || 0;
  const textModel = job.model || 'unknown';
  const imageModel = job.imageModel || 'unknown';

  const textCostUsd = (typeof computeCostUsd === 'function') ? computeCostUsd(tokens, textModel) : 0;
  const imageCostUsd = (typeof computeImageCostUsd === 'function') ? computeImageCostUsd(imageCount, imageModel) : 0;
  const totalCostUsd = textCostUsd + imageCostUsd;
  if (!totalCostUsd && !tokens.input && !tokens.output && !imageCount) return;

  const calls = (tokens.calls || 0) + imageCount;
  const inc = firebase.firestore.FieldValue.increment;

  const now = new Date();
  const monthId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dayId = `${monthId}-${String(now.getDate()).padStart(2, '0')}`;

  const monthlyUpdate = {
    totalInputTokens: inc(tokens.input || 0),
    totalOutputTokens: inc(tokens.output || 0),
    totalCostUsd: inc(totalCostUsd),
    calls: inc(calls),
    questionCount: inc(0),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  const dailyUpdate = {
    totalCostUsd: inc(totalCostUsd),
    calls: inc(calls),
    totalInputTokens: inc(tokens.input || 0),
    totalOutputTokens: inc(tokens.output || 0),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  // nested byModel 구조 (모델명에 점이 있어도 평면 key 로 저장되지 않도록)
  const byModelMonthly = {};
  const byModelDaily = {};
  if (textCostUsd > 0) {
    byModelMonthly[textModel] = {
      input: inc(tokens.input || 0),
      output: inc(tokens.output || 0),
      costUsd: inc(textCostUsd),
      calls: inc(tokens.calls || 0)
    };
    byModelDaily[textModel] = {
      costUsd: inc(textCostUsd),
      calls: inc(tokens.calls || 0)
    };
  }
  if (imageCount > 0) {
    byModelMonthly[imageModel] = Object.assign(byModelMonthly[imageModel] || {}, {
      costUsd: inc(imageCostUsd),
      calls: inc(imageCount),
      imageCount: inc(imageCount)
    });
    byModelDaily[imageModel] = Object.assign(byModelDaily[imageModel] || {}, {
      costUsd: inc(imageCostUsd),
      calls: inc(imageCount),
      imageCount: inc(imageCount)
    });
  }
  if (Object.keys(byModelMonthly).length) monthlyUpdate.byModel = byModelMonthly;
  if (Object.keys(byModelDaily).length) dailyUpdate.byModel = byModelDaily;

  try {
    await db.collection('usage_monthly').doc(monthId).set(monthlyUpdate, { merge: true });
    await db.collection('usage_daily').doc(dayId).set(dailyUpdate, { merge: true });
  } catch (e) {
    console.warn('[comic] usage recording failed:', e.message);
  }
}

// ── 완료 ──
async function finishComicJob(job) {
  if (!job) return;
  const aborted = job.abortController.signal.aborted;
  const failed = job.phase === 'failed';

  if (!aborted && !failed && job.panels && job.panels.some(p => p.imageBase64)) {
    job.phase = 'buildPdf';
    job.phaseStates.buildPdf = 'active';
    updateComicUI(job, 'PDF 빌드 중...');

    try {
      // jsPDF 직접 조립 — html2canvas 우회 (이미지에 이미 말풍선이 포함되므로 HTML 렌더 불필요)
      // 1~3초 내 완료, 원본 base64 PNG 를 직접 addImage 로 삽입
      const pdf = buildComicPdfDirect(job);

      const filename = `만화_${job.item.book}_${job.item.unit}_${job.item.num}.pdf`;
      let dlHtml = '<div class="wb-download-row">';
      dlHtml += '<button class="wb-download-btn" data-role="comic-dl-pdf">만화 PDF 다운로드</button>';
      dlHtml += '</div>';
      job._downloadsHtml = dlHtml;
      // jsPDF 직접 반환이므로 저장 래퍼 구성
      job._mainPdf = {
        pdf,
        save(fname) { pdf.save(fname || filename); },
        get blob() { return pdf.output('blob'); }
      };
      job._pdfFilename = filename;
      job._bindDownloads = (area) => {
        const btn = area.querySelector('[data-role="comic-dl-pdf"]');
        if (btn) btn.addEventListener('click', () => pdf.save(filename));
      };
    } catch (e) {
      console.warn('[comic] PDF build failed:', e && e.message);
      job._pdfError = (e && e.message) || 'PDF 빌드 실패';
    }

    job.phaseStates.buildPdf = 'done';
    setComicPhaseProgress(job, 'buildPdf', 1);
  }

  if (aborted) {
    job.phase = 'cancelled';
    job.subLabel = '중단됨';
  } else if (failed) {
    // 파이프라인에서 이미 phase='failed', subLabel 설정됨
    // 활성 단계를 failed 로 표시하여 완료 체크 대신 실패 상태 노출
    const activePhase = Object.keys(job.phaseStates || {}).find(k => job.phaseStates[k] === 'active');
    if (activePhase) job.phaseStates[activePhase] = 'failed';
    // 실패해도 지금까지 쌓인 토큰 비용은 기록
    recordComicUsageToFirestore(job).catch(() => {});
  } else {
    job.phase = 'done';
    job.phaseStates.done = 'done';
    const elapsed = Math.round((Date.now() - (job._startedAt || Date.now())) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    job.subLabel = `완료! ${job.panelCount}컷 만화 · ${mins}분 ${secs}초`;
    // Firestore 사용량 기록 (텍스트 토큰 + 이미지 생성 비용)
    recordComicUsageToFirestore(job).catch(() => {});
  }
  updateComicUI(job);

  if (job._timerInterval) { clearInterval(job._timerInterval); job._timerInterval = null; }
  if (comicJobManager) comicJobManager.notifyPhaseChanged(job.id);

  // 완료 시 다운로드 영역으로 자동 스크롤
  if (!aborted && job._downloadsHtml) {
    setTimeout(() => {
      const dlCard = document.getElementById('comicDownloadsCard');
      if (dlCard) dlCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  }
}

// ── UI ──
function updateComicUI(job, label) {
  if (!job) return;
  if (label) { job.currentLabel = label; job.subLabel = label; }

  if (comicJobManager && comicJobManager.selectedId !== job.id) {
    if (comicJobManager) comicJobManager._updateSwitcherLabels();
    return;
  }

  const body = document.getElementById('comicProgressBody');
  if (!body || typeof renderJobChecklist !== 'function') return;

  const details = job._phaseDetails || {};
  const phaseProgress = job._phaseProgress || {};
  const overallPct = computeComicOverallPct(job);
  const elapsedMs = job._startedAt ? (Date.now() - job._startedAt) : 0;

  let headTitle = '만화 생성 중';
  if (job.phase === 'cancelled') headTitle = '만화 — 중단됨';
  else if (job.phase === 'done') headTitle = '만화 — 완료';
  else if (job.phase === 'failed') headTitle = '만화 — 실패';

  const phases = [
    { id: 'prepare', label: '준비', weight: COMIC_PHASE_WEIGHTS.prepare },
    { id: 'analyze', label: '지문 분석', desc: `${job.panelCount || '?'}컷 구성`, weight: COMIC_PHASE_WEIGHTS.analyze, detailItems: details.analyze },
    { id: 'generatePrompts', label: '프롬프트 생성', weight: COMIC_PHASE_WEIGHTS.generatePrompts, detailItems: details.generatePrompts },
    { id: 'generateImages', label: '이미지 생성', desc: job.style ? job.style.label : '', weight: COMIC_PHASE_WEIGHTS.generateImages, detailItems: details.generateImages },
    { id: 'qualityCheck', label: '품질 검증', weight: COMIC_PHASE_WEIGHTS.qualityCheck, detailItems: details.qualityCheck },
    { id: 'compose', label: '만화 조합', weight: COMIC_PHASE_WEIGHTS.compose },
    { id: 'buildPdf', label: 'PDF 빌드', weight: COMIC_PHASE_WEIGHTS.buildPdf },
    { id: 'done', label: '완료', weight: COMIC_PHASE_WEIGHTS.done }
  ];
  phases.forEach(p => { p.progress = phaseProgress[p.id] || 0; });

  // 비용 계산: 텍스트 토큰(스토리보드) + 이미지 생성 비용 (이미지당)
  const tokens = job._tokens || { input: 0, output: 0 };
  const imageCount = job._imagesGenerated || 0;
  const textCostUsd = (typeof computeCostUsd === 'function') ? computeCostUsd(tokens, job.model) : 0;
  const imageCostUsd = (typeof computeImageCostUsd === 'function') ? computeImageCostUsd(imageCount, job.imageModel) : 0;
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;
  const totalCostKrw = (textCostUsd + imageCostUsd) * rate;

  renderJobChecklist(body, {
    headTitle,
    subLabel: job.subLabel || '',
    overallPct,
    elapsedMs,
    tokenUsage: (tokens.input || tokens.output) ? { input: tokens.input, output: tokens.output } : null,
    costKrw: totalCostKrw,
    phases,
    phaseStates: job.phaseStates || {},
    stats: { total: job.panelCount || 0, done: job.panels ? job.panels.filter(p => p.imageBase64).length : 0 }
  });

  if (comicJobManager) {
    const cancelBtn = document.getElementById('comicCancelBtn');
    if (cancelBtn) {
      cancelBtn.style.visibility = comicJobManager.isJobRunning(job) ? 'visible' : 'hidden';
      cancelBtn.style.display = '';
    }
    comicJobManager._updateSwitcherLabels();
  }
}

function cancelComicJob(jobId) {
  if (!comicJobManager) return;
  const targetId = jobId || comicJobManager.selectedId;
  if (!targetId) return;
  const job = comicJobManager.getJob(targetId);
  if (job && job.abortController) job.abortController.abort();
}

// ── 동시 실행 헬퍼 ──
async function runComicWithConcurrency(job, tasks, limit, worker) {
  let i = 0;
  const next = async () => {
    while (true) {
      if (job && job.abortController && job.abortController.signal.aborted) return;
      const idx = i++;
      if (idx >= tasks.length) return;
      try { await worker(tasks[idx], idx); }
      catch (e) {
        if (e && e.message === 'aborted') return;
        console.warn('[comic] worker failed:', e && e.message);
      }
    }
  };
  const runners = Math.min(Math.max(1, limit), tasks.length || 1);
  await Promise.all(Array.from({ length: runners }, next));
}
