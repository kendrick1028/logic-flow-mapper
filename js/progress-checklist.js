// ── Progress Checklist 공용 렌더러 (Round 9 확장) ──
// 배치/변형/워크북 생성 작업의 진행 상황 통일 렌더.
//
// 사용법:
//   renderJobChecklist(containerEl, {
//     headTitle: '변형문제 생성 중',
//     subLabel: '현재 상황 문구',
//     overallPct: 45,                         // 전체 진행도 0~100 (라운드 9: 상위에서 직접 계산해서 전달)
//     elapsedMs: 12340,                       // 총 경과 시간 (ms)
//     tokenUsage: { input: 1234, output: 5678 }, // (옵션) 실시간 토큰 합계
//     costKrw: 120,                           // (옵션) 예상 비용 (KRW)
//     finalCostLine: '...',                   // (옵션) 완료 시 표시할 비용 문구
//     phases: [
//       {
//         id, label, desc?,
//         weight: 15,                          // 전체 진행도 계산 기여 비중
//         progress: 0~1,                       // 해당 phase 내부 진행률
//         detailItems: [                       // 드롭다운 안 항목 (실시간)
//           { status, label, desc?, extra? }
//         ],
//         detailLabel?: '세부 진행'            // (옵션) details summary 텍스트
//       }
//     ],
//     phaseStates: { phaseId: 'pending'|'active'|'done'|'failed' },
//     stats: { done, failed, skipped, total }, // (옵션) 통계 pill
//     currentItem: { book, unit, num } | null
//   });

function renderJobChecklist(containerEl, job) {
  if (!containerEl || !job) return;
  const phases = job.phases || [];
  const phaseStates = job.phaseStates || {};
  const stats = job.stats || {};
  const pct = Math.max(0, Math.min(100, Math.round(job.overallPct != null ? job.overallPct : 0)));
  const subLabel = job.subLabel || '';
  const elapsed = _pcFormatElapsed(job.elapsedMs || 0);
  const tokenUsage = job.tokenUsage || null;
  const costKrw = job.costKrw;
  const finalCostLine = job.finalCostLine || '';

  const openSet = _pcReadOpenSet(containerEl);   // 사용자가 펼친 phase 기억

  // 재렌더 전 각 phase 의 detail scroll 위치 캡처 (tail-log 동작 유지)
  const _scrollPositions = {};
  const _userAtBottom = {};
  containerEl.querySelectorAll('.progress-phase').forEach(el => {
    const id = el.dataset.phase;
    const sc = el.querySelector('.phase-detail-scroll');
    if (id && sc) {
      _scrollPositions[id] = sc.scrollTop;
      _userAtBottom[id] = (sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 8;
    }
  });

  containerEl.innerHTML = `
    <div class="progress-sticky-top">
      <div class="progress-card-head">
        <div class="progress-pct-ring" style="--pct:${pct}">
          <span>${pct}%</span>
        </div>
        <div class="progress-head-info">
          <div class="progress-head-title">${_pcEscape(job.headTitle || '진행 중')}</div>
          <div class="progress-head-sub">${_pcEscape(subLabel)}</div>
          <div class="progress-head-stats">
            ${stats.done != null ? `<span class="stat-pill stat-done">${stats.done} 완료</span>` : ''}
            ${stats.failed ? `<span class="stat-pill stat-failed">${stats.failed} 실패</span>` : ''}
            ${stats.skipped ? `<span class="stat-pill stat-skipped">${stats.skipped} 스킵</span>` : ''}
            ${stats.total != null ? `<span class="stat-pill stat-total">${stats.total} 전체</span>` : ''}
          </div>
        </div>
      </div>

      <div class="progress-bar-lg"><div class="progress-bar-fill-lg" style="width:${pct}%"></div></div>

      <div class="progress-meta-row">
        <div class="progress-timer">
          <span class="progress-timer-label">⏱ 경과</span>
          <span class="progress-timer-value">${elapsed}</span>
        </div>
        ${tokenUsage ? `
          <div class="progress-token">
            <span class="progress-token-label">토큰</span>
            <span class="progress-token-value">입력 ${_pcNum(tokenUsage.input)} / 출력 ${_pcNum(tokenUsage.output)}</span>
          </div>
        ` : ''}
        ${typeof costKrw === 'number' && costKrw >= 0 ? `
          <div class="progress-cost">
            <span class="progress-cost-label">비용</span>
            <span class="progress-cost-value">₩ ${_pcNum(Math.round(costKrw))}</span>
          </div>
        ` : ''}
      </div>
      ${finalCostLine ? `
        <div class="progress-final-line">${_pcEscape(finalCostLine)}</div>
      ` : ''}
    </div>

    ${phases.length ? `
      <div class="progress-phase-list">
        ${phases.map(p => _pcRenderPhase(p, phaseStates[p.id] || 'pending', openSet.has(p.id))).join('')}
      </div>
    ` : ''}
  `;

  // 스크롤 위치 복원 — 사용자가 맨 아래에 있었으면 맨 아래 유지 (새 항목 자동 추적),
  // 아니면 기존 scrollTop 유지 (위로 스크롤 중 튕김 방지)
  containerEl.querySelectorAll('.progress-phase').forEach(el => {
    const id = el.dataset.phase;
    const sc = el.querySelector('.phase-detail-scroll');
    if (!id || !sc) return;
    if (_userAtBottom[id]) {
      sc.scrollTop = sc.scrollHeight;
    } else if (_scrollPositions[id] != null) {
      sc.scrollTop = _scrollPositions[id];
    }
  });

  // 드롭다운 토글 바인딩 (이벤트 delegation)
  _pcBindPhaseToggles(containerEl);
}

function _pcRenderPhase(p, state, isOpen) {
  const icon = state === 'done' ? '✓' : state === 'failed' ? '✕' : '';
  const checkInner = state === 'active' ? '<div class="phase-spinner"></div>' : icon;
  const phaseProgress = Math.max(0, Math.min(1, p.progress || 0));
  const hasDetail = Array.isArray(p.detailItems) && p.detailItems.length > 0;

  const phasePctHtml = state === 'active' && phaseProgress > 0 && phaseProgress < 1
    ? `<span class="phase-pct">${Math.round(phaseProgress * 100)}%</span>` : '';

  const chevron = hasDetail
    ? `<span class="phase-chevron">${isOpen ? '▾' : '▸'}</span>`
    : '';

  const detailHtml = hasDetail ? `
    <div class="phase-detail-wrap ${isOpen ? 'open' : ''}">
      <div class="phase-detail-scroll">
        ${p.detailItems.slice(-200).map(it => _pcRenderDetailItem(it)).join('')}
      </div>
    </div>
  ` : '';

  return `
    <div class="progress-phase progress-phase-${state} ${hasDetail ? 'has-detail' : ''}" data-phase="${_pcEscape(p.id)}">
      <div class="phase-row" data-phase-row="${_pcEscape(p.id)}">
        <div class="phase-check">${checkInner}</div>
        <div class="phase-body">
          <div class="phase-label-row">
            <div class="phase-label">${_pcEscape(p.label)}</div>
            ${phasePctHtml}
            ${chevron}
          </div>
          ${p.desc ? `<div class="phase-desc">${_pcEscape(p.desc)}</div>` : ''}
          ${state === 'active' && phaseProgress > 0 ? `
            <div class="phase-progress-bar"><div class="phase-progress-fill" style="width:${phaseProgress * 100}%"></div></div>
          ` : ''}
        </div>
      </div>
      ${detailHtml}
    </div>
  `;
}

function _pcRenderDetailItem(it) {
  const st = it.status || 'pending';
  const mark = st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'skipped' ? '–' : st === 'running' ? '●' : '○';
  const label = it.label || '';
  const desc = it.desc || '';
  const extra = it.extra || '';
  return `
    <div class="phase-detail-item phase-detail-${st}">
      <span class="pdi-mark">${mark}</span>
      <div class="pdi-body">
        <div class="pdi-label">${_pcEscape(label)}</div>
        ${desc ? `<div class="pdi-desc">${_pcEscape(desc)}</div>` : ''}
        ${extra ? `<div class="pdi-extra">${_pcEscape(extra)}</div>` : ''}
      </div>
    </div>
  `;
}

function _pcReadOpenSet(containerEl) {
  // 컨테이너에 저장된 open phase id 읽기
  const open = containerEl._pcOpenPhases;
  return open instanceof Set ? open : new Set();
}

function _pcBindPhaseToggles(containerEl) {
  if (containerEl._pcBound) return;
  containerEl._pcBound = true;
  if (!(containerEl._pcOpenPhases instanceof Set)) containerEl._pcOpenPhases = new Set();
  containerEl.addEventListener('click', (e) => {
    const row = e.target.closest('.phase-row');
    if (!row) return;
    const phaseEl = row.closest('.progress-phase');
    if (!phaseEl || !phaseEl.classList.contains('has-detail')) return;
    const id = row.dataset.phaseRow;
    if (!id) return;
    const set = containerEl._pcOpenPhases;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    // 즉시 DOM 에 반영 (rerender 없이)
    const wrap = phaseEl.querySelector('.phase-detail-wrap');
    const chev = phaseEl.querySelector('.phase-chevron');
    if (wrap) wrap.classList.toggle('open');
    if (chev) chev.textContent = set.has(id) ? '▾' : '▸';
  });
}

function _pcFormatElapsed(ms) {
  if (!ms || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function _pcNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('ko-KR');
}

function _pcEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 패널 영역 2↔3 열 전환 헬퍼 (panel-split 에 .running 토글)
function setPanelRunning(panelId, running) {
  const split = document.querySelector(`#panel-${panelId} .panel-split`);
  if (split) split.classList.toggle('running', !!running);
}
