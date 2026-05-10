// ══════════════════════════════════════
// JobManager — 동시 다중 작업 실행 지원
// ──────────────────────────────────────
// 각 기능(변형문제/배치/워크북)이 독립된 JobManager 인스턴스를 보유.
// jobs Map 으로 여러 job 을 동시에 관리하고, 사용자는 드롭다운으로 전환.
// UI 렌더는 selectedId 에 해당하는 job 만 DOM 에 반영. 다른 job 은 백그라운드에서
// state 만 갱신됨 (JavaScript single-thread 라 동시성 안전).
// ══════════════════════════════════════

class JobManager {
  /**
   * @param {object} opts
   * @param {string} opts.featureKey      - 'variant' | 'batch' | 'workbook'
   * @param {string} opts.switcherId      - 드롭다운 컨테이너 element id
   * @param {string} opts.progressBodyId  - 진행 카드 body id (렌더 타깃)
   * @param {string} [opts.downloadCardId]- 다운로드 카드 id (optional)
   * @param {string} [opts.downloadAreaId]- 다운로드 버튼 영역 id (optional)
   * @param {string} opts.cancelBtnId     - "중단" 버튼 id
   * @param {string} opts.emptyStateId    - "진행 중 작업 없음" 빈 상태 element id
   * @param {function} opts.renderFn      - (job, progressBodyEl) => void — 선택된 job 렌더
   * @param {function} opts.labelFn       - (job) => string — 드롭다운 항목 라벨
   * @param {function} [opts.onRemove]    - (job) => void — 수동 닫기 시 정리(timer 등)
   * @param {function} [opts.onCancel]    - (job) => void — 중단 버튼 클릭 시
   */
  constructor(opts) {
    this.featureKey = opts.featureKey;
    this.switcherId = opts.switcherId;
    this.progressBodyId = opts.progressBodyId;
    this.downloadCardId = opts.downloadCardId || null;
    this.downloadAreaId = opts.downloadAreaId || null;
    this.cancelBtnId = opts.cancelBtnId;
    this.emptyStateId = opts.emptyStateId || null;
    this.renderFn = opts.renderFn;
    this.labelFn = opts.labelFn;
    this.onRemove = opts.onRemove || null;
    this.onCancel = opts.onCancel || null;

    this.jobs = new Map();   // jobId → job object
    this.selectedId = null;
  }

  // ── 기본 조회 ──
  listJobs() { return [...this.jobs.values()]; }
  getJob(jobId) { return this.jobs.get(jobId); }
  getSelectedJob() { return this.selectedId ? this.jobs.get(this.selectedId) : null; }

  isJobRunning(job) {
    if (!job) return false;
    if (job._cancelled || job._failed || job._completed) return false;
    // phase 가 'done' / 'cancelled' / 'failed' 가 아니면 실행 중
    const p = job.phase;
    return p !== 'done' && p !== 'cancelled' && p !== 'failed';
  }

  runningCount() {
    return this.listJobs().filter(j => this.isJobRunning(j)).length;
  }

  // ── 변경 오퍼레이션 ──
  addJob(job) {
    if (!job || !job.id) throw new Error('JobManager.addJob: job.id required');
    this.jobs.set(job.id, job);
    // 자동 선택 — 새로 추가된 것을 항상 선택
    this.selectedId = job.id;
    this.renderSwitcher();               // 구조 변경 → 전체 재렌더
    this.renderSelected();
    updateSidebarIndicators();
    // 새 작업 추가 애니메이션 + 토스트 피드백
    this._flashSwitcher();
    this._showJobAddedToast(job);
  }

  removeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    // 실행 중이면 먼저 취소
    if (this.isJobRunning(job)) {
      try { job.abortController && job.abortController.abort(); } catch (e) {}
    }
    // cleanup (timer 등)
    if (typeof this.onRemove === 'function') {
      try { this.onRemove(job); } catch (e) { console.warn('[JobManager.onRemove]', e); }
    }
    this.jobs.delete(jobId);
    // 선택된 job 이 제거되면 다른 것 자동 선택
    if (this.selectedId === jobId) {
      const remaining = this.listJobs();
      this.selectedId = remaining.length ? remaining[remaining.length - 1].id : null;
    }
    this.renderSwitcher();               // 구조 변경 → 전체 재렌더
    this.renderSelected();
    updateSidebarIndicators();
  }

  selectJob(jobId) {
    if (!this.jobs.has(jobId)) return;
    this.selectedId = jobId;
    // 선택만 변경 — DOM select 의 value 만 업데이트 (전체 재렌더 안 함)
    this._updateSelectValue();
    this.renderSelected();
  }

  // job state 가 변경됐을 때 호출 (워커에서). 선택된 job 이면 DOM 재렌더.
  // **중요**: 드롭다운 <select> 는 절대 innerHTML 교체하지 않음 (open state 초기화 방지)
  updateJob(jobId) {
    // 옵션 라벨만 in-place 업데이트 (열려있어도 안 닫힘)
    this._updateSwitcherLabels();
    if (jobId === this.selectedId) {
      this.renderSelected();
    }
  }

  // 작업 완료/취소/실패 등 phase 전환 시 호출 — 사이드바 인디케이터도 갱신
  notifyPhaseChanged(jobId) {
    this.updateJob(jobId);
    updateSidebarIndicators();
  }

  // ── 렌더링 ──
  // 전체 재렌더: 구조 변경(addJob/removeJob)에만 사용. 드롭다운이 열려있으면 닫힘.
  renderSwitcher() {
    const el = document.getElementById(this.switcherId);
    if (!el) return;
    const jobs = this.listJobs();
    if (jobs.length === 0) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    const running = this.runningCount();
    const countBadge = `<span class="job-switcher-count" data-role="job-switcher-count">${jobs.length}개${running > 0 ? ` · 실행 ${running}` : ''}</span>`;

    const options = jobs.map(j => {
      const label = this._safeLabel(j);
      const statusIcon = this.isJobRunning(j) ? '●' : (j._cancelled || j.phase === 'cancelled' ? '⊗' : (j._failed || j.phase === 'failed' ? '✕' : '✓'));
      const selected = j.id === this.selectedId ? 'selected' : '';
      return `<option value="${this._esc(j.id)}" ${selected}>${statusIcon} ${this._esc(label)}</option>`;
    }).join('');

    el.innerHTML = `
      ${countBadge}
      <select class="job-switcher-select" data-role="job-switcher-select">${options}</select>
      <button type="button" class="job-switcher-close" data-role="job-switcher-close" title="선택된 작업 닫기">×</button>
    `;

    // bind
    const select = el.querySelector('[data-role="job-switcher-select"]');
    const closeBtn = el.querySelector('[data-role="job-switcher-close"]');
    if (select) {
      select.addEventListener('change', (e) => {
        this.selectJob(e.target.value);
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (!this.selectedId) return;
        const job = this.getSelectedJob();
        // 실행 중이면 확인
        if (job && this.isJobRunning(job)) {
          if (!confirm('실행 중인 작업입니다. 중단하고 닫을까요?')) return;
        }
        this.removeJob(this.selectedId);
      });
    }
  }

  // In-place update: <option> 의 text 와 count badge 만 갱신 (innerHTML 교체 안 함)
  // 이래야 사용자가 드롭다운 열어둔 상태에서도 안 닫힘
  _updateSwitcherLabels() {
    const el = document.getElementById(this.switcherId);
    if (!el) return;
    const select = el.querySelector('[data-role="job-switcher-select"]');
    if (!select) {
      // 드롭다운이 아직 없으면 전체 렌더로 폴백
      this.renderSwitcher();
      return;
    }
    const jobs = this.listJobs();
    const jobIds = jobs.map(j => j.id);
    const existingIds = Array.from(select.options).map(o => o.value);

    // 구조 변경 감지: 옵션 개수 또는 id 순서가 다르면 전체 재렌더
    const structureChanged = jobIds.length !== existingIds.length ||
      jobIds.some((id, i) => id !== existingIds[i]);
    if (structureChanged) {
      this.renderSwitcher();
      return;
    }

    // 옵션 text 만 in-place 업데이트
    jobs.forEach((j, i) => {
      const opt = select.options[i];
      if (!opt) return;
      const label = this._safeLabel(j);
      const statusIcon = this.isJobRunning(j) ? '●' : (j._cancelled || j.phase === 'cancelled' ? '⊗' : (j._failed || j.phase === 'failed' ? '✕' : '✓'));
      const newText = `${statusIcon} ${label}`;
      if (opt.textContent !== newText) opt.textContent = newText;
    });

    // count badge 갱신
    const badge = el.querySelector('[data-role="job-switcher-count"]');
    if (badge) {
      const running = this.runningCount();
      const newBadge = `${jobs.length}개${running > 0 ? ` · 실행 ${running}` : ''}`;
      if (badge.textContent !== newBadge) badge.textContent = newBadge;
    }
  }

  // selectJob 시 select 의 value 만 변경 (전체 재렌더 안 함)
  _updateSelectValue() {
    const el = document.getElementById(this.switcherId);
    if (!el) return;
    const select = el.querySelector('[data-role="job-switcher-select"]');
    if (!select) {
      this.renderSwitcher();
      return;
    }
    if (this.selectedId && select.value !== this.selectedId) {
      select.value = this.selectedId;
    }
  }

  // 새 작업 추가 애니메이션 — 드롭다운 바운스
  _flashSwitcher() {
    const el = document.getElementById(this.switcherId);
    if (!el) return;
    el.classList.remove('job-switcher-flash');
    // 강제 reflow 로 애니메이션 재트리거
    void el.offsetWidth;
    el.classList.add('job-switcher-flash');
    setTimeout(() => el.classList.remove('job-switcher-flash'), 1400);
  }

  // 토스트 피드백
  _showJobAddedToast(job) {
    const label = this._safeLabel(job);
    const featureLabels = { variant: '변형문제', batch: '일괄분석', workbook: '워크북' };
    const kindLabel = featureLabels[this.featureKey] || this.featureKey;

    // 기존 토스트 있으면 제거
    const existing = document.getElementById('_jobToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = '_jobToast';
    toast.className = 'job-toast';
    toast.innerHTML = `
      <div class="job-toast-icon">+</div>
      <div class="job-toast-body">
        <div class="job-toast-title">새 ${this._esc(kindLabel)} 작업 추가됨</div>
        <div class="job-toast-desc">${this._esc(label)}</div>
      </div>
    `;
    document.body.appendChild(toast);
    // 다음 프레임에 show 클래스 추가 → transition
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 2400);
  }

  renderSelected() {
    const body = document.getElementById(this.progressBodyId);
    if (!body) return;
    const job = this.getSelectedJob();

    // Empty state
    const emptyEl = this.emptyStateId ? document.getElementById(this.emptyStateId) : null;
    if (!job) {
      body.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
      // 다운로드 영역 숨김
      this._hideDownloads();
      // 취소 버튼 숨김
      this._hideCancelBtn();
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    // 렌더
    try {
      this.renderFn(job, body);
    } catch (e) {
      console.error('[JobManager.renderFn]', e);
    }

    // 취소 버튼 — visibility 로 레이아웃 시프트 방지
    const cancelBtn = document.getElementById(this.cancelBtnId);
    if (cancelBtn) {
      cancelBtn.style.visibility = this.isJobRunning(job) ? 'visible' : 'hidden';
      cancelBtn.style.display = '';
    }

    // 다운로드 영역: 완료 + 해당 job 에 downloadsHtml 있으면 표시
    this._renderDownloads(job);
  }

  _renderDownloads(job) {
    if (!this.downloadCardId) return;
    const card = document.getElementById(this.downloadCardId);
    const area = this.downloadAreaId ? document.getElementById(this.downloadAreaId) : null;
    if (!card) return;
    if (job && job._downloadsHtml) {
      card.style.display = '';
      if (area) {
        area.innerHTML = job._downloadsHtml;
        // 다운로드 버튼 바인딩을 job 이 직접 처리하도록 _bindDownloads(area) 호출 지원
        if (typeof job._bindDownloads === 'function') {
          try { job._bindDownloads(area); } catch (e) { console.warn(e); }
        }
      }
    } else {
      card.style.display = 'none';
      if (area) area.innerHTML = '';
    }
  }

  _hideDownloads() {
    if (!this.downloadCardId) return;
    const card = document.getElementById(this.downloadCardId);
    if (card) card.style.display = 'none';
    const area = this.downloadAreaId ? document.getElementById(this.downloadAreaId) : null;
    if (area) area.innerHTML = '';
  }

  _hideCancelBtn() {
    const cancelBtn = document.getElementById(this.cancelBtnId);
    if (cancelBtn) {
      cancelBtn.style.visibility = 'hidden';
      cancelBtn.style.display = '';
    }
  }

  _safeLabel(job) {
    try { return this.labelFn(job) || '(작업)'; }
    catch (e) { return '(라벨 오류)'; }
  }

  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}

// ── 전역 사이드바 인디케이터 ──
// 각 기능에서 JobManager 생성 시 window._jobManagers[featureKey] 에 등록
if (typeof window !== 'undefined') {
  window._jobManagers = window._jobManagers || {};
  window._sidebarIndicators = window._sidebarIndicators || { variant: 0, batch: 0, workbook: 0, comic: 0 };
}

function updateSidebarIndicators() {
  if (typeof window === 'undefined') return;
  const managers = window._jobManagers || {};
  const map = { variant: 0, batch: 0, workbook: 0, comic: 0 };
  for (const key of Object.keys(map)) {
    const mgr = managers[key];
    if (mgr && typeof mgr.runningCount === 'function') {
      map[key] = mgr.runningCount();
    }
  }
  window._sidebarIndicators = map;
  for (const key of Object.keys(map)) {
    const dot = document.getElementById(`sidebar-dot-${key}`);
    if (dot) {
      dot.style.display = map[key] > 0 ? '' : 'none';
    }
  }
}

// beforeunload 경고 — 실행 중 job 있으면 확인창
if (typeof window !== 'undefined' && !window._jobManagerBeforeUnloadBound) {
  window._jobManagerBeforeUnloadBound = true;
  window.addEventListener('beforeunload', (e) => {
    const managers = window._jobManagers || {};
    let totalRunning = 0;
    for (const key of Object.keys(managers)) {
      const mgr = managers[key];
      if (mgr && typeof mgr.runningCount === 'function') {
        totalRunning += mgr.runningCount();
      }
    }
    if (totalRunning > 0) {
      e.preventDefault();
      e.returnValue = '진행 중인 작업이 있습니다. 정말 나가시겠습니까?';
      return e.returnValue;
    }
  });
}
