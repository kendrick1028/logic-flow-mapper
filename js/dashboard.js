// ── Home Dashboard ──
// 출제/분석 현황 통계, 교재 지문 통계, 진행중 작업 시각화
// 전역 `batchJob`, `workbookJob`, `variantJob` 을 읽어 실시간 렌더링
// 완료 작업은 window._completedJobs 에 누적 저장 → 사용자가 수동으로 삭제

let _dashboardPollTimer = null;
let _dashboardStatsCache = null;
let _dashboardJobsBound = false;

// 완료 작업 저장소 (다운로드 블롭 포함, 페이지 이동해도 세션 동안 유지)
window._completedJobs = window._completedJobs || [];

async function initDashboard() {
  renderHero();
  renderKpiRow(_dashboardStatsCache ? _dashboardStatsCache.collections : null);
  if (_dashboardStatsCache) {
    renderBooksCard(_dashboardStatsCache.books);
  }
  renderJobsCard();
  startJobPolling();

  if (!window.__authReady) {
    await new Promise(res => {
      let done = false;
      const finish = () => { if (done) return; done = true; window.removeEventListener('authready', onReady); res(); };
      const onReady = () => finish();
      window.addEventListener('authready', onReady, { once: true });
      setTimeout(finish, 5000);
    });
  }

  if (typeof currentUser === 'undefined' || !currentUser) return;

  renderHero();
  if (!_dashboardStatsCache) {
    await refreshDashboardStats();
  }
  loadUsageData().then(() => { renderUsageCard(); renderKpiRow(_dashboardStatsCache ? _dashboardStatsCache.collections : null); }).catch(() => {});
}

function startJobPolling() {
  if (_dashboardPollTimer) clearInterval(_dashboardPollTimer);
  _dashboardPollTimer = setInterval(renderJobsCard, 400);
}

function stopJobPolling() {
  if (_dashboardPollTimer) {
    clearInterval(_dashboardPollTimer);
    _dashboardPollTimer = null;
  }
}

async function safeGet(name) {
  try {
    return await db.collection(name).get();
  } catch (e) {
    console.warn('[dashboard] get', name, 'failed:', e && e.message);
    return null;
  }
}

async function refreshDashboardStats() {
  const booksGrid = document.getElementById('dashBooksGrid');
  if (booksGrid) booksGrid.innerHTML = '<div class="empty-state sm">불러오는 중...</div>';

  try {
    const [anaSnap, wbSnap, varSnap] = await Promise.all([
      safeGet('analyses'),
      safeGet('workbooks'),
      safeGet('variants')
    ]);

    const collections = aggregateCollectionStats(anaSnap, wbSnap, varSnap);
    const books = computeBookStats(typeof BOOKS !== 'undefined' ? BOOKS : {}, anaSnap);
    _dashboardStatsCache = { collections, books };
    renderKpiRow(collections);
    renderBooksCard(books);
  } catch (e) {
    console.warn('[dashboard] refresh failed:', e && e.message);
    if (booksGrid) booksGrid.innerHTML = `<div class="empty-state sm">불러오기 실패</div>`;
  }
}

function aggregateCollectionStats(anaSnap, wbSnap, varSnap) {
  const result = {
    analyses: { total: 0, byBook: {} },
    workbooks: { total: 0, byBook: {}, passageCount: 0 },
    variants: { totalQuestions: 0, byBook: {}, passageCount: 0, byType: {} }
  };

  if (anaSnap) anaSnap.forEach(doc => {
    const d = doc.data() || {};
    result.analyses.total += 1;
    const book = d.book || '(unknown)';
    result.analyses.byBook[book] = (result.analyses.byBook[book] || 0) + 1;
  });

  if (wbSnap) wbSnap.forEach(doc => {
    const d = doc.data() || {};
    result.workbooks.passageCount += 1;
    const book = d.book || '(unknown)';
    result.workbooks.byBook[book] = (result.workbooks.byBook[book] || 0) + 1;
    // 각 유형 필드를 카운트
    ['blank_high','blank_mid','blank_low','choice_2','choice_3','match_en','match_ko','order','insert'].forEach(k => {
      if (d[k]) result.workbooks.total += 1;
    });
  });

  if (varSnap) varSnap.forEach(doc => {
    const d = doc.data() || {};
    const qs = Array.isArray(d.questions) ? d.questions : [];
    if (qs.length) result.variants.passageCount += 1;
    result.variants.totalQuestions += qs.length;
    const book = d.book || '(unknown)';
    result.variants.byBook[book] = (result.variants.byBook[book] || 0) + qs.length;
    qs.forEach(q => {
      const t = q.type || '(기타)';
      result.variants.byType[t] = (result.variants.byType[t] || 0) + 1;
    });
  });

  return result;
}

function computeBookStats(BOOKS, anaSnap) {
  // 교재별 단원 수, 지문 수, 분석 커버리지
  const analyzedSet = new Set();
  if (anaSnap) anaSnap.forEach(doc => {
    const d = doc.data() || {};
    if (d.book && d.unit && (d.number != null)) {
      analyzedSet.add(`${d.book}__${d.unit}__${d.number}`);
    }
  });

  const books = [];
  Object.keys(BOOKS).forEach(bookName => {
    const bookDB = BOOKS[bookName] || {};
    const units = Object.keys(bookDB);
    let totalPassages = 0;
    let analyzedPassages = 0;
    units.forEach(unit => {
      const nums = Object.keys(bookDB[unit] || {});
      totalPassages += nums.length;
      nums.forEach(num => {
        if (analyzedSet.has(`${bookName}__${unit}__${num}`)) analyzedPassages += 1;
      });
    });
    books.push({
      name: bookName,
      unitCount: units.length,
      passageCount: totalPassages,
      analyzedCount: analyzedPassages,
      coverage: totalPassages ? Math.round(analyzedPassages / totalPassages * 100) : 0
    });
  });
  return books;
}

// ── 히어로 (인사말 + 유저) ──
function renderHero() {
  const el = document.getElementById('dashGreeting');
  const sub = document.getElementById('dashGreetingSub');
  if (!el) return;
  const user = (typeof currentUser !== 'undefined') ? currentUser : null;
  const role = (typeof userRole !== 'undefined') ? userRole : null;
  if (!user) { el.textContent = '대시보드'; return; }
  const roleLabel = role === 'teacher' ? '선생님' : (role === 'student' ? '학생' : '님');
  const email = user.email || '';
  const name = email.split('@')[0] || email;
  el.textContent = `${name} ${roleLabel}`;
  if (sub) sub.innerHTML = `${escapeHtmlDash(email)} · <a href="#" onclick="handleSignOut();return false" style="color:var(--c-primary)">로그아웃</a>`;
}

// ── KPI 행 (통합 지표) ──
function renderKpiRow(stats) {
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;

  // 분석
  const k1 = document.getElementById('dashKpiAnalysis');
  if (k1 && stats) {
    k1.querySelector('.dash-kpi-num').textContent = stats.analyses.total;
    k1.querySelector('.dash-kpi-sub').textContent = `${Object.keys(stats.analyses.byBook).length}개 교재`;
  }
  // 워크북
  const k2 = document.getElementById('dashKpiWorkbook');
  if (k2 && stats) {
    k2.querySelector('.dash-kpi-num').textContent = stats.workbooks.total.toLocaleString();
    k2.querySelector('.dash-kpi-sub').textContent = `${stats.workbooks.passageCount}지문`;
  }
  // 변형문제
  const k3 = document.getElementById('dashKpiVariant');
  if (k3 && stats) {
    k3.querySelector('.dash-kpi-num').textContent = stats.variants.totalQuestions.toLocaleString();
    k3.querySelector('.dash-kpi-sub').textContent = `${stats.variants.passageCount}지문`;
  }
  // 비용
  const k4 = document.getElementById('dashKpiCost');
  if (k4 && _usageMonthly) {
    const usd = _usageMonthly.totalCostUsd || 0;
    const krw = Math.round(usd * rate);
    k4.querySelector('.dash-kpi-num').textContent = `₩${krw.toLocaleString()}`;
    k4.querySelector('.dash-kpi-sub').textContent = `$${usd.toFixed(2)} · ₩${rate.toFixed(0)}/\$`;
  }
}

function renderBooksCard(books) {
  const grid = document.getElementById('dashBooksGrid');
  if (!grid) return;
  if (!books.length) {
    grid.innerHTML = '<div class="empty-state sm">등록된 교재가 없습니다.</div>';
    return;
  }
  grid.innerHTML = books.map(b => `
    <div class="book-tile">
      <div class="book-name" title="${escapeHtmlDash(b.name)}">${escapeHtmlDash(b.name)}</div>
      <div class="book-bar-wrap"><div class="book-bar"><div class="book-fill" style="width:${b.coverage}%"></div></div></div>
      <div class="book-pct">${b.coverage}%</div>
    </div>
  `).join('');
}

// ── 완료 작업 관리 API ──
function dashboardRegisterCompleted(payload) {
  const entry = Object.assign({
    id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    finishedAt: Date.now()
  }, payload || {});
  window._completedJobs.unshift(entry);
  if (window._completedJobs.length > 20) window._completedJobs.length = 20;
  renderJobsCard();
}

function clearCompletedJobs() {
  window._completedJobs = [];
  renderJobsCard();
}

function dashboardSaveBlob(blob, name) {
  if (!blob) return;
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'download.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (e) {
    console.warn('[dashboard] saveBlob failed:', e && e.message);
  }
}

function formatRelTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '방금 전';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}

function renderJobsCard() {
  const grid = document.getElementById('dashJobsGrid');
  const countEl = document.getElementById('dashJobsCount');
  if (!grid) return;

  // ── 진행중 작업 수집 ──
  const activeJobs = [];

  if (typeof batchJob !== 'undefined' && batchJob) {
    const total = batchJob.total || 0;
    const done = batchJob.done || 0;
    const cur = batchJob.queue && batchJob.current < batchJob.queue.length ? batchJob.queue[batchJob.current] : null;
    activeJobs.push({
      kind: '일괄 꼼꼼분석',
      total, done,
      pct: total ? Math.round(done / total * 100) : 0,
      label: `${done}/${total}` + (batchJob.failed ? ` · 실패 ${batchJob.failed}` : ''),
      currentItem: cur ? { book: cur.book, unit: cur.unit, num: cur.num } : null
    });
  }

  if (typeof workbookJob !== 'undefined' && workbookJob) {
    const total = workbookJob.total || 0;
    const done = workbookJob.done || 0;
    const cur = workbookJob.items && workbookJob.current < workbookJob.items.length ? workbookJob.items[workbookJob.current] : null;
    activeJobs.push({
      kind: '워크북 생성',
      total, done,
      pct: total ? Math.round(done / total * 100) : 0,
      label: `${done}/${total}` + (workbookJob.failed ? ` · 실패 ${workbookJob.failed}` : ''),
      currentItem: cur ? { book: cur.book, unit: cur.unit, num: cur.num } : null
    });
  }

  if (typeof variantJob !== 'undefined' && variantJob) {
    const total = variantJob.totalSteps || 0;
    const done = variantJob.doneSteps || 0;
    const genCnt = (variantJob.generated || []).length;
    const reuseCnt = (variantJob.reusedFromCache || []).length;
    const cur = variantJob._currentItem || null;
    activeJobs.push({
      kind: '변형문제 생성',
      total, done,
      pct: total ? Math.round(done / total * 100) : 0,
      label: `${done}/${total} · 신규 ${genCnt} · 재사용 ${reuseCnt}`,
      extra: variantJob.currentLabel || '',
      currentItem: cur ? { book: cur.book, unit: cur.unit, num: cur.num } : null
    });
  }

  const completed = window._completedJobs || [];
  if (countEl) countEl.textContent = String(activeJobs.length + completed.length);

  if (!activeJobs.length && !completed.length) {
    grid.innerHTML = '<div class="empty-state">현재 실행중이거나 완료된 작업이 없습니다.</div>';
    return;
  }

  let html = '';

  if (activeJobs.length) {
    html += `<div class="dash-jobs-section-label">진행중</div>`;
    html += `<div class="dash-jobs">` + activeJobs.map(j => {
      const cur = j.currentItem;
      return `
      <div class="job-card">
        <div class="job-head">
          <span class="job-kind">${escapeHtmlDash(j.kind)}</span>
          <span class="job-pct">${j.pct}%</span>
        </div>
        <div class="job-bar"><div class="job-fill" style="width:${j.pct}%"></div></div>
        <div class="job-meta">${escapeHtmlDash(j.label)}</div>
        ${j.extra ? `<div class="job-extra">${escapeHtmlDash(j.extra)}</div>` : ''}
        ${cur ? `
          <div class="job-current">
            <span class="job-current-label">작업 중</span>
            <span class="job-current-body"><span class="cur-book">${escapeHtmlDash(cur.book || '')}</span><span class="cur-sep">·</span>${escapeHtmlDash(cur.unit || '')}<span class="cur-sep">·</span>${escapeHtmlDash(cur.num || '')}번</span>
          </div>
        ` : ''}
      </div>
      `;
    }).join('') + `</div>`;
  }

  if (completed.length) {
    html += `<div class="dash-jobs-section-label">최근 완료</div>`;
    html += `<div class="dash-jobs">` + completed.map((j, idx) => {
      const statusClass = j.status === 'aborted' ? 'aborted' : 'done';
      const statusText = j.status === 'aborted' ? '중단' : '완료';
      const dls = Array.isArray(j.downloads) ? j.downloads : [];
      return `
        <div class="job-card done ${statusClass}">
          <div class="job-head">
            <span class="job-kind">${escapeHtmlDash(j.kind || '작업')}</span>
            <span class="job-status">${statusText}</span>
          </div>
          ${j.title ? `<div class="job-title">${escapeHtmlDash(j.title)}</div>` : ''}
          ${j.summary ? `<div class="job-meta">${escapeHtmlDash(j.summary)}</div>` : ''}
          ${dls.length ? `<div class="job-downloads">${dls.map((d, di) => {
            const cls = /정답|해설|answer/i.test(d.label || '') ? 'answer'
                      : /묶음|전체|bundle/i.test(d.label || '') ? 'bundle' : '';
            return `<button class="btn-dl ${cls}" data-job="${idx}" data-dl="${di}">${escapeHtmlDash(d.label || '다운로드')}</button>`;
          }).join('')}</div>` : ''}
          <div class="job-time">${escapeHtmlDash(formatRelTime(j.finishedAt))}</div>
        </div>
      `;
    }).join('') + `</div>`;
  }

  grid.innerHTML = html;

  // 다운로드 이벤트 위임 (한 번만 바인딩)
  if (!_dashboardJobsBound) {
    _dashboardJobsBound = true;
    grid.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.btn-dl');
      if (!b) return;
      const ji = parseInt(b.dataset.job, 10);
      const di = parseInt(b.dataset.dl, 10);
      const j = window._completedJobs[ji];
      if (!j || !Array.isArray(j.downloads)) return;
      const d = j.downloads[di];
      if (!d || !d.blob) return;
      dashboardSaveBlob(d.blob, d.filename || ((d.label || 'download') + '.pdf'));
    });
  }
}

function escapeHtmlDash(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ══════════════════════════════════════
// AI 사용량 카드
// ══════════════════════════════════════

let _usageMonthly = null;
let _usageDaily = [];

const MODEL_COLORS = {
  'gpt-5.4': '#10a37f', 'gpt-5.4-pro': '#0d8c6d', 'gpt-5.4-mini': '#2da05a', 'gpt-5.4-nano': '#16a34a',
  'gpt-image-1': '#7c3aed', 'gpt-image-1.5-low': '#a855f7', 'gpt-image-1.5-medium': '#9333ea', 'gpt-image-1.5-high': '#6d28d9',
  'claude-opus-4-6': '#d97706', 'claude-sonnet-4-6': '#f59e0b',
  'gemini-3.1-pro-preview': '#4285f4', 'gemini-3-flash-preview': '#3b82f6',
  'gemini-3.1-flash-image-preview': '#facc15', 'gemini-3-pro-image-preview': '#eab308', 'gemini-2.5-flash-image': '#fbbf24'
};

// Firestore v8 SDK 는 점(.)을 필드명에 포함하면 평면 key 로 저장됨.
// "byModel.modelName.input": 123 같은 평면 key 들을 nested byModel[modelName].input 으로 복원.
function _flattenModelKeys(data) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };
  result.byModel = { ...(result.byModel || {}) };
  // 평면 key 패턴 매칭
  const flatKeys = Object.keys(result).filter(k => k.startsWith('byModel.'));
  flatKeys.forEach(k => {
    // "byModel.{modelName}.{field}" 형태 파싱
    // modelName 에 점이 있을 수 있으므로 마지막 점을 기준으로 분리
    const stripped = k.slice('byModel.'.length);
    const lastDot = stripped.lastIndexOf('.');
    if (lastDot === -1) return;
    const modelName = stripped.slice(0, lastDot);
    const field = stripped.slice(lastDot + 1);
    result.byModel[modelName] = result.byModel[modelName] || {};
    result.byModel[modelName][field] = result[k];
    delete result[k];
  });
  return result;
}

async function loadUsageData() {
  if (typeof db === 'undefined' || !db) return;
  const now = new Date();
  const monthId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  try {
    const monthSnap = await db.collection('usage_monthly').doc(monthId).get();
    if (monthSnap.exists && !monthSnap.data()._needsReseed) {
      _usageMonthly = _flattenModelKeys(monthSnap.data());
    } else {
      _usageMonthly = null;
    }

    // 2026-04 초기 시드: 기존 $290 사용분 반영 (4/12 일자, USD 기준)
    if (!_usageMonthly && monthId === '2026-04') {
      const seed = {
        totalInputTokens: 0, totalOutputTokens: 0,
        totalCostUsd: 290,
        calls: 0, questionCount: 2593,
        byModel: { 'gpt-5.4': { input: 0, output: 0, costUsd: 290, calls: 0, questionCount: 2593 } },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        _seeded: true
      };
      const dailySeed = {
        totalCostUsd: 290,
        calls: 0, questionCount: 2593,
        totalInputTokens: 0, totalOutputTokens: 0,
        byModel: { 'gpt-5.4': { costUsd: 290, calls: 0, questionCount: 2593 } },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      try {
        await db.collection('usage_monthly').doc(monthId).set(seed);
        await db.collection('usage_daily').doc('2026-04-12').set(dailySeed);
        _usageMonthly = seed;
      } catch (e) { console.warn('[dashboard] seed failed:', e.message); _usageMonthly = null; }
    }
  } catch (e) { _usageMonthly = null; }

  try {
    // 최근 30일 일별 데이터
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startId = `${thirtyDaysAgo.getFullYear()}-${String(thirtyDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(thirtyDaysAgo.getDate()).padStart(2, '0')}`;
    const snap = await db.collection('usage_daily').where(firebase.firestore.FieldPath.documentId(), '>=', startId).orderBy(firebase.firestore.FieldPath.documentId()).get();
    _usageDaily = [];
    snap.forEach(doc => _usageDaily.push({ id: doc.id, ..._flattenModelKeys(doc.data()) }));
  } catch (e) { _usageDaily = []; }

  // 모델 필터 드롭다운 채우기
  const sel = document.getElementById('dashUsageModelFilter');
  if (sel && _usageMonthly && _usageMonthly.byModel) {
    const models = Object.keys(_usageMonthly.byModel);
    // 프로바이더 그룹핑
    const groups = {};
    models.forEach(m => {
      let prov = 'Other';
      if (m.startsWith('gpt')) prov = 'OpenAI';
      else if (m.startsWith('claude')) prov = 'Anthropic';
      else if (m.startsWith('gemini')) prov = 'Google';
      if (!groups[prov]) groups[prov] = [];
      groups[prov].push(m);
    });
    let optsHtml = '<option value="all">전체 모델</option>';
    Object.entries(groups).forEach(([prov, ms]) => {
      optsHtml += `<optgroup label="${escapeHtmlDash(prov)}">`;
      ms.forEach(m => { optsHtml += `<option value="${escapeHtmlDash(m)}">${escapeHtmlDash(m)}</option>`; });
      optsHtml += '</optgroup>';
    });
    sel.innerHTML = optsHtml;
  }
}

function renderUsageCard() {
  const grid = document.getElementById('dashUsageGrid');
  if (!grid) return;

  if (!_usageMonthly) {
    grid.innerHTML = '<div class="empty-state">이번 달 사용 기록이 없습니다.</div>';
    return;
  }

  const filter = (document.getElementById('dashUsageModelFilter') || {}).value || 'all';
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;
  let totalUsd, totalCalls, totalQ, modelLabel;

  if (filter === 'all') {
    totalUsd = _usageMonthly.totalCostUsd || 0;
    totalCalls = _usageMonthly.calls || 0;
    totalQ = _usageMonthly.questionCount || 0;
    modelLabel = '전체 모델';
  } else {
    const md = (_usageMonthly.byModel || {})[filter] || {};
    totalUsd = md.costUsd || 0;
    totalCalls = md.calls || 0;
    totalQ = md.questionCount || 0;
    modelLabel = filter;
  }
  const totalKrw = Math.round(totalUsd * rate);
  const avgPerQ = totalQ > 0 ? Math.round(totalKrw / totalQ) : 0;
  const accentColor = filter === 'all' ? '#4f6ef7' : (MODEL_COLORS[filter] || '#4f6ef7');

  // 선택된 모델의 이번 달 총 비용 (큰 카드)
  let html = `<div class="usage-selected-summary" style="border-left-color:${accentColor}">
    <div class="usage-sel-left">
      <div class="usage-sel-label">${escapeHtmlDash(modelLabel)} · 이번 달</div>
      <div class="usage-sel-cost" style="color:${accentColor}">₩${totalKrw.toLocaleString()}</div>
      <div class="usage-sel-sub">$${totalUsd.toFixed(4)} @ ₩${rate.toFixed(0)}/$</div>
    </div>
    <div class="usage-sel-right">
      <div class="usage-sel-kpi"><div class="v">${totalCalls.toLocaleString()}</div><div class="l">API 호출</div></div>
      ${totalQ > 0 ? `<div class="usage-sel-kpi"><div class="v">${totalQ.toLocaleString()}</div><div class="l">문항</div></div>` : ''}
      ${avgPerQ > 0 ? `<div class="usage-sel-kpi"><div class="v">₩${avgPerQ.toLocaleString()}</div><div class="l">문항당</div></div>` : ''}
    </div>
  </div>`;

  // 일별 차트
  html += `<div class="usage-chart-wrap"><canvas id="usageDailyChart"></canvas></div>`;

  grid.innerHTML = html;

  // 차트 렌더링
  requestAnimationFrame(() => drawDailyChart(filter, accentColor));
}

const CHART_FONT = '"Pretendard","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic","Nanum Gothic",sans-serif';

function drawDailyChart(filter, accentColor) {
  const canvas = document.getElementById('usageDailyChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  const bar = accentColor || '#4f6ef7';
  const rate = (typeof USD_TO_KRW !== 'undefined') ? USD_TO_KRW : 1380;

  // ── 이번 달 전체 일수 생성 (1일 ~ 말일) ──
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthId = `${year}-${String(month + 1).padStart(2, '0')}`;
  const today = now.getDate();

  // 실 데이터를 날짜별 맵으로
  const dataMap = {};
  _usageDaily.forEach(d => {
    if (!d.id || !d.id.startsWith(monthId)) return;
    const day = parseInt(d.id.slice(8), 10);
    if (filter === 'all') {
      dataMap[day] = { cost: (d.totalCostUsd || 0) * rate, q: d.questionCount || 0 };
    } else {
      const md = (d.byModel || {})[filter] || {};
      dataMap[day] = { cost: (md.costUsd || 0) * rate, q: md.questionCount || 0 };
    }
  });

  // 1일 ~ 말일까지 배열 생성
  const data = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = dataMap[day] || { cost: 0, q: 0 };
    data.push({ day, label: String(day), cost: d.cost, q: d.q, isFuture: day > today });
  }

  const pad = { top: 28, right: 12, bottom: 32, left: 56 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const maxCost = Math.max(...data.map(d => d.cost), 100);
  const slotW = cW / data.length;
  const barW = Math.max(2, Math.min(22, slotW - 3));

  ctx.clearRect(0, 0, W, H);

  // Y축 grid (점선, 은은한 색)
  ctx.strokeStyle = '#eef0f5';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.font = '10px ' + CHART_FONT;
  ctx.fillStyle = '#999';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + cH * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    const val = Math.round(maxCost * i / 4);
    const lbl = val >= 10000 ? (val / 10000).toFixed(val % 10000 === 0 ? 0 : 1) + '만' : val.toLocaleString();
    ctx.fillText(lbl, pad.left - 6, y + 3);
  }
  ctx.setLineDash([]);

  // 축 라인
  ctx.strokeStyle = '#d6dbe8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + cH);
  ctx.lineTo(W - pad.right, pad.top + cH);
  ctx.stroke();

  // ── 막대 + 값 표시 ──
  // 그라데이션
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
  grad.addColorStop(0, bar);
  grad.addColorStop(1, bar + '60');

  data.forEach((d, i) => {
    const x = pad.left + slotW * i + (slotW - barW) / 2;
    const h = d.cost > 0 ? Math.max(2, (d.cost / maxCost) * cH) : 0;
    const y = pad.top + cH - h;

    if (d.cost > 0) {
      // 막대
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, [4, 4, 0, 0]);
      ctx.fill();

      // 막대 위에 값 표시 (1,000원 이상만 명확히 표시)
      if (d.cost >= 100) {
        ctx.fillStyle = bar;
        ctx.font = '9.5px ' + CHART_FONT;
        ctx.textAlign = 'center';
        const valLbl = d.cost >= 10000 ? (d.cost / 10000).toFixed(1) + '만' : Math.round(d.cost).toLocaleString();
        ctx.fillText(valLbl, x + barW / 2, y - 4);
      }
    } else if (d.isFuture) {
      // 미래 날짜: 연한 점
      ctx.fillStyle = '#f0f2f7';
      ctx.beginPath();
      ctx.arc(x + barW / 2, pad.top + cH - 2, 1.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // 과거인데 데이터 없음: 회색 바닥 점선
      ctx.fillStyle = '#e3e6ef';
      ctx.fillRect(x, pad.top + cH - 1.5, barW, 1.5);
    }
  });

  // ── X축 라벨: 1, 5, 10, 15, 20, 25, 말일 중요 날짜만 + 오늘은 강조 ──
  ctx.fillStyle = '#888';
  ctx.textAlign = 'center';
  ctx.font = '9.5px ' + CHART_FONT;
  data.forEach((d, i) => {
    const x = pad.left + slotW * i + slotW / 2;
    const isKeyDay = d.day === 1 || d.day % 5 === 0 || d.day === daysInMonth;
    const isToday = d.day === today;
    if (isKeyDay || isToday) {
      if (isToday) {
        ctx.fillStyle = bar;
        ctx.font = 'bold 10px ' + CHART_FONT;
      } else {
        ctx.fillStyle = '#888';
        ctx.font = '9.5px ' + CHART_FONT;
      }
      ctx.fillText(d.label, x, H - pad.bottom + 14);
    }
  });

  // 오늘 날짜 세로 하이라이트
  if (today <= daysInMonth) {
    const todayX = pad.left + slotW * (today - 1) + slotW / 2;
    ctx.strokeStyle = bar + '30';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(todayX, pad.top);
    ctx.lineTo(todayX, pad.top + cH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 상단 총합 라벨
  const totalMonthCost = data.reduce((sum, d) => sum + d.cost, 0);
  ctx.fillStyle = '#1a1a1a';
  ctx.font = 'bold 11px ' + CHART_FONT;
  ctx.textAlign = 'left';
  ctx.fillText(`일별 비용 추이 · ${year}년 ${month + 1}월`, pad.left, 14);
  ctx.fillStyle = '#888';
  ctx.font = '10px ' + CHART_FONT;
  ctx.textAlign = 'right';
  ctx.fillText(`총 ₩${Math.round(totalMonthCost).toLocaleString()}`, W - pad.right, 14);

}
