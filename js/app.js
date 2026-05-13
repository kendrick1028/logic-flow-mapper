// ── DB Registry ──
const BOOKS = {
  '수능특강 영어': DB_ENGLISH,
  '수능특강 영어독해연습': DB_READING,
  'N기출 영어 고난도 독해': DB_NGICHUL,
  '2603H3': DB_2603H3,
  '목동고1 추가지문': DB_MOKDONG1,
  '영어독해와작문 비상(김진완)': DB_BISANG_RW,
  '수능 빌드업 영어독해': DB_BUILDUP,
  '리딩마스터 수능 고난도': DB_READINGMASTER,
  '해커스 미니모의고사': DB_HACKERS
};

// ── State ──
let currentBook = localStorage.getItem('lfm_book') || '수능특강 영어';
let currentProvider = 'gemini';
let currentModel = 'gemini-3.1-pro-preview';
let currentOption = null;
let manualMode = false;
let currentPanel = localStorage.getItem('lfm_panel') || 'home';

// ── 진행 중 요청 제어 ──
let activeAbortController = null;

// ── 꼼꼼분석 결과 캐시 (저장용) ──
let lastDetailResult = null; // { meta, vocab, grammar }

function startLoadingUI() {
  document.getElementById('loading').classList.add('show');
  activeAbortController = new AbortController();
}

function stopLoadingUI() {
  document.getElementById('loading').classList.remove('show');
  activeAbortController = null;
}

function cancelAnalysis() {
  if (activeAbortController) activeAbortController.abort();
}

// ── Split Layout ──
function activateSplitLayout() {
  const wrap = document.getElementById('splitWrap');
  if (!wrap || wrap.classList.contains('split')) return;
  wrap.classList.add('split');
}

function initSplitHandle() {
  const handle = document.getElementById('splitHandle');
  const left = document.getElementById('splitLeft');
  const wrap = document.getElementById('splitWrap');
  if (!handle || !left || !wrap) return;
  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = left.offsetWidth;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const nw = Math.max(280, Math.min(startW + (e.clientX - startX), wrap.offsetWidth - 320));
    left.style.width = nw + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  // PDF 업로드로 등록된 교재를 BOOKS 에 머지 (다른 init 보다 먼저)
  if (typeof mergeImportedBooksIntoRegistry === 'function') mergeImportedBooksIntoRegistry();
  initBookSelector();
  initModelSelector();
  initSettings();
  loadUnitOptions();
  restoreState();
  initSidebar();
  document.getElementById('manualInput').addEventListener('input', updateManualBtnState);
  initAuth();
  if (typeof initBatch === 'function') initBatch();
  if (typeof initWorkbook === 'function') initWorkbook();
  if (typeof initVariant === 'function') initVariant();
  if (typeof initComic === 'function') initComic();
});

function initModelSelector() {
  const provSel = document.getElementById('selProvider');
  const modelSel = document.getElementById('selModel');
  if (!provSel || !modelSel || typeof AI_MODELS === 'undefined') return;
  const provLabels = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI' };
  const providers = [...new Set(AI_MODELS.map(m => m.provider))];
  providers.forEach(p => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = provLabels[p] || p;
    provSel.appendChild(o);
  });
  provSel.value = currentProvider;
  updateModelOptions();
  initSplitHandle();
}

function onProviderChange() {
  currentProvider = document.getElementById('selProvider').value;
  updateModelOptions();
}

function updateModelOptions() {
  const modelSel = document.getElementById('selModel');
  const optRow = document.getElementById('optionRow');
  const optSel = document.getElementById('selOption');
  modelSel.innerHTML = '';
  const models = AI_MODELS.filter(m => m.provider === currentProvider);
  models.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  });
  currentModel = models[0]?.id || '';
  modelSel.value = currentModel;
  updateOptionRow();
}

function updateOptionRow() {
  const optRow = document.getElementById('optionRow');
  const optSel = document.getElementById('selOption');
  const options = (typeof AI_MODEL_OPTIONS !== 'undefined') ? AI_MODEL_OPTIONS[currentModel] : null;
  if (options && options.length) {
    optSel.innerHTML = '';
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      optSel.appendChild(o);
    });
    currentOption = options[0];
    optSel.value = currentOption;
    optRow.style.display = '';
  } else {
    currentOption = null;
    optRow.style.display = 'none';
  }
}

function onModelChange() {
  currentModel = document.getElementById('selModel').value;
  updateOptionRow();
}

function onOptionChange() {
  currentOption = document.getElementById('selOption').value;
}

// ── Book Selector ──
function initBookSelector() {
  const sel = document.getElementById('selBook');
  Object.keys(BOOKS).forEach(name => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  });
  sel.value = currentBook;
  sel.addEventListener('change', () => {
    currentBook = sel.value;
    localStorage.setItem('lfm_book', currentBook);
    loadUnitOptions();
    resetSelection();
  });
}

function loadUnitOptions() {
  const db = BOOKS[currentBook];
  const unitSel = document.getElementById('selUnit');
  unitSel.innerHTML = '<option value="">강 선택</option>';
  if (!db) return;
  // Sort units numerically
  const units = Object.keys(db).sort((a, b) => {
    const na = parseInt(a);
    const nb = parseInt(b);
    return na - nb;
  });
  units.forEach(u => {
    const o = document.createElement('option');
    o.value = u;
    o.textContent = u;
    unitSel.appendChild(o);
  });
}

function onUnitChange() {
  const u = document.getElementById('selUnit').value;
  const ns = document.getElementById('selNum');
  ns.innerHTML = '<option value="">번호 선택</option>';
  ns.disabled = !u;
  document.getElementById('selBtn').disabled = true;
  document.getElementById('btnLoadAnalysis').style.display = 'none';
  document.getElementById('grammarActions').style.display = 'none';
  document.getElementById('preview').classList.remove('show');
  if (!u) return;
  const db = BOOKS[currentBook];
  if (!db || !db[u]) return;
  // 순서 보정: 모든 키가 숫자로 시작하면 숫자 기준으로 자연 정렬
  // (JS Object.keys()는 integer-like 키를 먼저 반환하므로 "10"이 "01"보다 앞에 오는 문제 방지)
  const keys = Object.keys(db[u]);
  if (keys.length && keys.every(k => /^\d/.test(k))) {
    keys.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  }
  keys.forEach(n => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    ns.appendChild(o);
  });
}

function onNumChange() {
  const u = document.getElementById('selUnit').value;
  const n = document.getElementById('selNum').value;
  const btn = document.getElementById('selBtn');
  const prev = document.getElementById('preview');
  if (manualMode) return; // don't interfere with manual mode
  btn.disabled = !n;
  const bk = BOOKS[currentBook];
  if (u && n && bk && bk[u] && bk[u][n]) {
    const text = bk[u][n];
    prev.textContent = text.slice(0, 200) + (text.length > 200 ? '...' : '');
    prev.classList.add('show');
  } else {
    prev.classList.remove('show');
  }
  // 꼼꼼분석 패널이면 저장된 분석 존재 여부 확인
  if (currentPanel === 'grammar' && u && n && !manualMode) {
    checkSavedAnalysis(currentBook, u, n);
  } else {
    document.getElementById('btnLoadAnalysis').style.display = 'none';
  }
}

function toggleManualInput() {
  manualMode = !manualMode;
  const toggleBtn = document.getElementById('btnManualToggle');
  const manualArea = document.getElementById('manualArea');
  const preview = document.getElementById('preview');
  const selUnit = document.getElementById('selUnit');
  const selNum = document.getElementById('selNum');
  const analyzeBtn = document.getElementById('selBtn');

  if (manualMode) {
    toggleBtn.classList.add('active');
    toggleBtn.textContent = '지문 선택';
    manualArea.classList.add('show');
    preview.classList.remove('show');
    selUnit.disabled = true;
    selNum.disabled = true;
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = '분석하기';
    document.getElementById('btnLoadAnalysis').style.display = 'none';
    updateManualBtnState();
  } else {
    toggleBtn.classList.remove('active');
    toggleBtn.textContent = '직접 입력';
    manualArea.classList.remove('show');
    selUnit.disabled = false;
    // Re-enable selNum only if a unit is selected
    selNum.disabled = !selUnit.value;
    // Restore button state based on selection
    analyzeBtn.disabled = !(selUnit.value && selNum.value);
    analyzeBtn.textContent = '분석하기';
    onNumChange();
  }
}

function updateManualBtnState() {
  if (!manualMode) return;
  const text = document.getElementById('manualInput').value.trim();
  document.getElementById('selBtn').disabled = !text;
}

function clearManual() {
  document.getElementById('manualInput').value = '';
  updateManualBtnState();
}

// 결과 패널 하단의 "재분석" 버튼 — 현재 선택(또는 직접입력) 지문을 새로 분석.
// 이미 저장된/표시된 분석이 있어도 무조건 새 분석을 실행한다.
function reanalyzeCurrent() {
  const passage = getSelectedPassage();
  const manualText = manualMode ? (document.getElementById('manualInput').value || '').trim() : '';
  const text = manualMode ? manualText : passage;
  if (!text) {
    alert('재분석할 지문을 찾지 못했습니다. 좌측에서 지문을 선택하거나 직접 입력하세요.');
    return;
  }
  activateSplitLayout();
  if (currentPanel === 'grammar') runDetailAnalysis(text);
  else analyzeCurrentMode();
}

function analyzeCurrentMode() {
  const passage = getSelectedPassage();
  if (!passage && !manualMode) return;
  const text = manualMode ? document.getElementById('manualInput').value.trim() : passage;
  if (!text) return;

  activateSplitLayout();

  if (currentPanel === 'grammar') {
    runDetailAnalysis(text);
  } else if (currentPanel === 'grammar-quiz') {
    runGrammarQuiz(text);
  } else if (currentPanel === 'fill-blank') {
    runFillBlank(text);
  } else {
    if (manualMode) analyzeManual();
    else analyzeSelected();
  }
}

function getSelectedPassage() {
  const u = document.getElementById('selUnit').value;
  const n = document.getElementById('selNum').value;
  if (!u || !n) return null;
  const db = BOOKS[currentBook];
  if (!db || !db[u] || !db[u][n]) return null;
  return db[u][n];
}

function resetSelection() {
  document.getElementById('selNum').innerHTML = '<option value="">번호 선택</option>';
  document.getElementById('selNum').disabled = true;
  document.getElementById('selBtn').disabled = true;
  document.getElementById('preview').classList.remove('show');
  document.getElementById('result').classList.remove('show');
  if (manualMode) {
    toggleManualInput(); // exit manual mode
  }
}

function restoreState() {}

// ── Analysis ──
function analyzeSelected() {
  const u = document.getElementById('selUnit').value;
  const n = document.getElementById('selNum').value;
  if (!u || !n) return;
  const db = BOOKS[currentBook];
  if (!db || !db[u] || !db[u][n]) return;
  runAnalysis(db[u][n], document.getElementById('selBtn'));
}

function analyzeManual() {
  const t = document.getElementById('manualInput').value.trim();
  if (!t) return;
  runAnalysis(t, document.getElementById('manualBtn'));
}

async function runAnalysis(passage, btn) {
  btn.disabled = true;
  const result = document.getElementById('result');
  result.classList.remove('show');
  startLoadingUI();
  try {
    const { parsed } = await callAI(currentProvider, currentModel, passage, null, activeAbortController.signal, currentOption);
    renderResult(parsed, passage);
    result.classList.add('show');
  } catch (e) {
    document.getElementById('r0').innerHTML = '';
    document.getElementById('r1').innerHTML = '';
    document.getElementById('r2').innerHTML = '';
    document.getElementById('r3').innerHTML = `<div class="err">${esc(e.message)}</div>`;
    result.classList.add('show');
  } finally {
    btn.disabled = false;
    stopLoadingUI();
  }
}

// ── Role colors for sentence numbers ──
const ROLE_COLORS = {
  '주장': '#4f6ef7', '근거': '#2da05a', '예시': '#3a8fd6', '반박': '#e04a4a',
  '전환': '#e08a2a', '결론': '#7c5cbf', '배경': '#888', '부연': '#999'
};

// ── Render ──
function renderResult(d, passage) {
  // Render original text with sentence analysis
  document.getElementById('r0').innerHTML = renderOriginalText(d.sentences || [], passage, d.highlightGroups || []);
  // First sentence with English original
  const firstEn = d.firstSentenceEn || (d.sentences && d.sentences[0] ? d.sentences[0].text : '');
  document.getElementById('r1').innerHTML =
    (firstEn ? `<p style="font-size:13px;color:#888;line-height:1.7;margin-bottom:8px">${esc(firstEn)}</p>` : '') +
    `<p>${esc(d.firstSentence)}</p>`;
  const fl = document.getElementById('r2');
  if (d.logicFlowType === 'arrow') fl.innerHTML = renderArrow(d.logicFlow);
  else if (d.logicFlowType === 'tree') fl.innerHTML = renderTree(d.logicFlow);
  else if (d.logicFlowType === 'table') fl.innerHTML = renderTable(d.logicFlow);
  else fl.innerHTML = `<pre>${esc(d.logicFlow)}</pre>`;
  const rows = d.structureRows || [];
  let th = `<p style="font-size:12px;color:#888;margin-bottom:10px;font-weight:600;">전개 방식: <span style="color:#e08a2a">${esc(d.structureType)}</span></p><table><thead><tr>`;
  if (rows.length) Object.keys(rows[0]).forEach(k => { th += `<th>${esc(k)}</th>`; });
  th += '</tr></thead><tbody>';
  rows.forEach(r => { th += '<tr>'; Object.values(r).forEach(v => { th += `<td>${esc(String(v))}</td>`; }); th += '</tr>'; });
  document.getElementById('r3').innerHTML = th + '</tbody></table>';
}

const HL_COLORS = [
  { bg: '#fff3b0', border: '#e8d88a' },
  { bg: '#d4edfc', border: '#a8d4f0' },
  { bg: '#fdd', border: '#f0b8b8' },
  { bg: '#d9f0d4', border: '#a8d8a0' }
];

function renderOriginalText(sentences, passage, highlightGroups) {
  if (!sentences || !sentences.length) {
    return `<p style="font-size:13.5px;line-height:1.85;color:#333">${esc(passage)}</p>`;
  }
  // Build phrase→color map from highlightGroups
  // 가드: 너무 긴 phrase (50자+) 는 강조 안 함 — 본문 전체를 덮으면 가독성 망가짐
  const PHRASE_MAX_LEN = 50;
  const phraseMap = [];
  (highlightGroups || []).forEach(g => {
    const ci = Math.min((g.color || 1) - 1, HL_COLORS.length - 1);
    (g.phrases || []).forEach(p => {
      const phrase = String(p || '').trim();
      if (!phrase || phrase.length > PHRASE_MAX_LEN) return;
      phraseMap.push({ phrase, colorIdx: ci, label: g.label });
    });
  });
  // Sort by phrase length descending (match longer phrases first)
  phraseMap.sort((a, b) => b.phrase.length - a.phrase.length);

  // Build legend
  const usedRoles = [...new Set(sentences.map(s => s.role || '배경'))];
  let h = '<div class="role-legend">';
  usedRoles.forEach(role => {
    const color = ROLE_COLORS[role] || '#888';
    h += `<span class="role-legend-item"><span class="role-legend-dot" style="background:${color}"></span>${esc(role)}</span>`;
  });
  if (highlightGroups && highlightGroups.length) {
    h += `<span class="role-legend-sep"></span>`;
    highlightGroups.forEach(g => {
      const ci = Math.min((g.color || 1) - 1, HL_COLORS.length - 1);
      const c = HL_COLORS[ci];
      h += `<span class="role-legend-item"><span class="role-legend-dot" style="background:${c.bg};border:1px solid ${c.border}"></span>${esc(g.label)}</span>`;
    });
  }
  h += '</div>';

  sentences.forEach(s => {
    const role = s.role || '배경';
    const color = ROLE_COLORS[role] || '#888';
    const connectors = s.connectors || [];

    // ── 단일-pass 마킹 (nested mark 방지)
    // 1) 모든 phrase 매치 위치를 원문에서 찾아 [start,end,colorIdx] 리스트 생성
    // 2) 가장 긴 매치 우선, 겹치는 영역은 한 번만 적용
    // 3) 결과: [{start,end,kind,info}] 비-겹침 영역 → 한 번에 HTML 빌드
    const original = String(s.text || '');
    const ranges = [];
    phraseMap.forEach(pm => {
      const phrase = String(pm.phrase || '');
      if (!phrase) return;
      const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let m;
      while ((m = re.exec(original)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length, kind: 'phrase', colorIdx: pm.colorIdx });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    });
    connectors.forEach(c => {
      const word = String(c || '');
      if (!word) return;
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      let m;
      while ((m = re.exec(original)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length, kind: 'connector' });
      }
    });
    // 우선순위: 더 긴 범위가 먼저 → 겹치는 짧은 범위 제거
    ranges.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const accepted = [];
    for (const r of ranges) {
      const overlaps = accepted.some(a => !(r.end <= a.start || r.start >= a.end));
      if (!overlaps) accepted.push(r);
    }
    accepted.sort((a, b) => a.start - b.start);

    // HTML 빌드
    let text = '';
    let cur = 0;
    for (const r of accepted) {
      if (r.start > cur) text += esc(original.slice(cur, r.start));
      const span = original.slice(r.start, r.end);
      if (r.kind === 'phrase') {
        const c = HL_COLORS[r.colorIdx] || HL_COLORS[0];
        text += `<mark class="sent-keyword" style="background:${c.bg}">${esc(span)}</mark>`;
      } else {
        text += `<span class="sent-connector">${esc(span)}</span>`;
      }
      cur = r.end;
    }
    if (cur < original.length) text += esc(original.slice(cur));

    h += `<div class="sent-block">`;
    h += `<span class="sent-num" style="background:${color}">${s.id}</span>`;
    h += `<span class="sent-text">${text}</span>`;
    h += `<span class="sent-role role-${esc(role)}">${esc(role)}</span>`;
    h += `</div>`;
  });
  return h;
}

// Convert circled numbers to plain digits
const CIRC_NUMS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
function circToDigit(c) {
  const idx = CIRC_NUMS.indexOf(c);
  return idx >= 0 ? String(idx + 1) : c;
}

function formatFlowNum(raw) {
  // Split range like ①~③ or ②-⑤ into separate tags
  const parts = raw.split(/([~～\-])/);
  if (parts.length >= 3) {
    const nums = parts.filter((_, i) => i % 2 === 0).map(p => p.split('').map(circToDigit));
    return `<span class="arrow-nums">${nums.map(arr => arr.map(n => `<span class="arrow-num">${esc(n)}</span>`).join('')).join('<span class="arrow-num-sep">~</span>')}</span>`;
  }
  // 각 원문자를 개별 arrow-num으로 표시 (①② → "1" "2")
  const digits = raw.split('').map(circToDigit).filter(d => d.trim());
  return `<span class="arrow-nums">${digits.map(d => `<span class="arrow-num">${esc(d)}</span>`).join('')}</span>`;
}

function renderArrow(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  // Parse lines into steps: merge ↓ and standalone connectors into next block
  const steps = [];
  let pendingConns = [];
  lines.forEach(line => {
    const trimmed = line.trim();
    if (/^[↓↑→←]+$/.test(trimmed)) return; // skip arrow-only lines
    // Standalone connector line like [But]
    const connOnly = trimmed.match(/^\[(.+?)\]\s*$/);
    if (connOnly) {
      pendingConns.push(connOnly[1]);
      return;
    }
    steps.push({ line: trimmed, conns: [...pendingConns] });
    pendingConns = [];
  });

  let h = '<div class="arrow-wrap">';
  steps.forEach(step => {
    let line = step.line;
    let conns = [...step.conns];
    // Extract inline connector
    const inlineCm = line.match(/^\[(.+?)\]\s*(.*)/);
    if (inlineCm) {
      conns.push(inlineCm[1]);
      line = inlineCm[2] || '';
    }
    // Extract sentence number
    const nm = line.match(/^([①-⑳]+(?:[~～\-][①-⑳]+)?)\s*/);
    let numHtml = '';
    let bodyText = line;
    if (nm) {
      numHtml = formatFlowNum(nm[1]);
      bodyText = line.slice(nm[0].length);
    }
    // Build connector tags
    let connHtml = conns.map(c => {
      const isRev = /but|however|yet|although|despite/i.test(c);
      return isRev ? `<span class="tag-rev">${esc(c)}</span>` : `<span class="tag-conn">${esc(c)}</span>`;
    }).join(' ');
    if (connHtml) connHtml += ' ';

    // Add text arrow between steps
    if (h.includes('arrow-block')) {
      h += `<div class="arrow-down">↓</div>`;
    }
    h += `<div class="arrow-block">`;
    h += numHtml;
    h += `<span class="arrow-body">${connHtml}${fmt(bodyText)}</span>`;
    h += `</div>`;
  });
  return h + '</div>';
}

function renderTree(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const nodes = lines.map(line => {
    const stripped = line.replace(/[├└│─┌┐┘┤┬┴┼\|]/g, ' ');
    const leadingSpaces = (stripped.match(/^\s*/) || [''])[0].length;
    const depth = Math.round(leadingSpaces / 2);
    const content = line.replace(/^[\s├└│─┌┐┘┤┬┴┼\|]+/, '').trim();
    return { depth, content };
  }).filter(n => n.content);

  // Build a nested tree structure
  function buildTree(nodes, start, parentDepth) {
    const children = [];
    let i = start;
    while (i < nodes.length) {
      if (nodes[i].depth <= parentDepth && i > start) break;
      if (nodes[i].depth === parentDepth + 1) {
        const sub = buildTree(nodes, i + 1, nodes[i].depth);
        children.push({ content: nodes[i].content, children: sub.children });
        i = sub.nextIndex;
      } else if (nodes[i].depth === parentDepth) {
        // root node
        const sub = buildTree(nodes, i + 1, nodes[i].depth);
        children.push({ content: nodes[i].content, children: sub.children, isRoot: true });
        i = sub.nextIndex;
      } else {
        i++;
      }
    }
    return { children, nextIndex: i };
  }

  const tree = buildTree(nodes, 0, -1);

  function renderNode(node, isLast) {
    let h = '';
    if (node.isRoot) {
      h += `<div class="tree-node tree-root"><div class="tree-node-content">${fmt(esc(node.content))}</div></div>`;
      if (node.children.length) {
        h += `<div class="tree-children">`;
        node.children.forEach((c, i) => { h += renderNode(c, i === node.children.length - 1); });
        h += `</div>`;
      }
    } else {
      h += `<div class="tree-item ${isLast ? 'tree-item-last' : ''}">`;
      h += `<div class="tree-node"><div class="tree-node-content">${fmt(esc(node.content))}</div></div>`;
      if (node.children.length) {
        h += `<div class="tree-children">`;
        node.children.forEach((c, i) => { h += renderNode(c, i === node.children.length - 1); });
        h += `</div>`;
      }
      h += `</div>`;
    }
    return h;
  }

  let h = '<div class="tree-wrap">';
  tree.children.forEach((c, i) => { h += renderNode(c, i === tree.children.length - 1); });
  return h + '</div>';
}

function renderTable(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  let h = '<table>';
  lines.forEach((line, i) => {
    const cells = line.split('|').map(c => c.trim());
    if (i === 0) h += '<thead><tr>' + cells.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
    else if (line.replace(/[\|\-\s]/g, '').length === 0) return;
    else h += '<tr>' + cells.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>';
  });
  return h + '</tbody></table>';
}

function fmt(t) {
  return t.replace(/\[([^\]]+)\]/g, (_, c) => {
    const isRev = /but|however|yet|although|despite/i.test(c);
    return isRev ? `<span class="tag-rev">${c}</span>` : `<span class="tag-conn">${c}</span>`;
  })
    .replace(/→/g, '<span style="color:#4f6ef7;font-weight:700;margin:0 4px;">→</span>')
    .replace(/≠/g, '<span style="color:#e04a4a;">≠</span>')
    .replace(/×/g, '<span style="color:#e04a4a;">×</span>');
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Settings Modal ──
function initSettings() {}

function openSettings() {
  document.getElementById('settingsModal').classList.add('show');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('show');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// ── Clear ──
function clearAll() {
  document.getElementById('manualInput').value = '';
  document.getElementById('result').classList.remove('show');
  document.getElementById('loading').classList.remove('show');
  document.getElementById('selUnit').value = '';
  document.getElementById('selNum').innerHTML = '<option value="">번호 선택</option>';
  document.getElementById('selNum').disabled = true;
  document.getElementById('selBtn').disabled = true;
  document.getElementById('preview').classList.remove('show');
  if (manualMode) toggleManualInput();
}

function copyFlow() {
  const el = document.getElementById('r2');
  navigator.clipboard.writeText(el.innerText).then(() => {
    const b = document.querySelector('.copy-btn');
    b.textContent = '복사됨!';
    setTimeout(() => { b.textContent = '복사'; }, 1500);
  });
}

// ── Keyboard shortcut ──
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) {
    if (manualMode) analyzeManual();
  }
  if (e.key === 'Escape') closeSettings();
});

// Close modal on overlay click
document.addEventListener('click', e => {
  if (e.target.id === 'settingsModal') closeSettings();
});

// ══════════════════════════════════
// ── Sidebar ──
// ══════════════════════════════════
function initSidebar() {
  // 기본 상태: 접힘(64px). 저장된 상태가 'expanded' 이면 확장.
  const state = localStorage.getItem('lfm_sidebar');
  const sb = document.getElementById('sidebar');
  // 기존 collapsed/shifted 잔재 제거
  sb.classList.remove('collapsed');
  const mc = document.getElementById('mainContent');
  if (mc) mc.classList.remove('shifted');
  if (state === 'expanded') {
    sb.classList.add('expanded');
  }
  switchPanel(currentPanel);
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  sb.classList.toggle('expanded');
  localStorage.setItem('lfm_sidebar', sb.classList.contains('expanded') ? 'expanded' : 'collapsed');
}

function switchPanel(panel) {
  if (!canAccessPanel(panel)) return;
  currentPanel = panel;
  localStorage.setItem('lfm_panel', panel);
  // Update sidebar active state
  document.querySelectorAll('.sidebar-item[data-panel]').forEach(el => {
    el.classList.toggle('active', el.dataset.panel === panel);
  });
  // Show/hide panels
  const panels = ['home','workbook','variant','batch-analyze','comic','pdf-import','logic','grammar','grammar-quiz','fill-blank'];
  panels.forEach(p => {
    const el = document.getElementById('panel-' + p);
    if (el) el.style.display = p === panel ? '' : 'none';
  });
  // Full-width panels (no split): home / workbook / variant / batch-analyze / comic / pdf-import
  const fullWidthPanels = ['home','workbook','variant','batch-analyze','comic','pdf-import'];
  const splitLeft = document.getElementById('splitLeft');
  const splitHandle = document.getElementById('splitHandle');
  const splitRight = document.getElementById('splitRight');
  if (fullWidthPanels.includes(panel)) {
    document.getElementById('splitWrap').classList.remove('split');
    splitLeft.style.display = 'none';
    splitHandle.style.display = 'none';
    splitRight.style.display = 'block';
  } else {
    splitLeft.style.display = '';
    splitHandle.style.display = '';
    splitRight.style.display = '';
  }
  // Show/hide quiz options
  document.getElementById('quizOptions').style.display =
    (panel === 'grammar-quiz' || panel === 'fill-blank') ? '' : 'none';
  document.getElementById('blankTypeOptions').style.display =
    panel === 'fill-blank' ? '' : 'none';
  // Update button text
  const btn = document.getElementById('selBtn');
  const labels = {
    'home': ['', ''],
    'workbook': ['', ''],
    'variant': ['', ''],
    'batch-analyze': ['', ''],
    'comic': ['', ''],
    'pdf-import': ['', ''],
    'logic': ['분석하기', '논리 구조 분석 중...'],
    'grammar': ['새로 분석하기', '꼼꼼분석 중...'],
    'grammar-quiz': ['문제 생성하기', '문제 생성 중...'],
    'fill-blank': ['문제 생성하기', '문제 생성 중...']
  };
  btn.textContent = labels[panel]?.[0] || '분석하기';
  btn.style.display = fullWidthPanels.includes(panel) ? 'none' : '';
  document.getElementById('loadingText').textContent = labels[panel]?.[1] || '분석 중...';
  // 꼼꼼분석 전용 UI 토글
  document.getElementById('modelSelector').style.display = panel === 'grammar' ? '' : 'none';
  if (panel !== 'grammar') {
    document.getElementById('btnLoadAnalysis').style.display = 'none';
    document.getElementById('grammarActions').style.display = 'none';
  }
  // Update title
  const titles = {
    'home': '홈 <span>대시보드</span>',
    'workbook': '워크북 <span>문제집 생성</span>',
    'variant': '변형문제 <span>시험지 출제</span>',
    'batch-analyze': '일괄 <span>꼼꼼분석</span>',
    'comic': '만화 <span>생성</span>',
    'pdf-import': 'PDF <span>자동 등록</span>',
    'logic': 'Logic Flow <span>Mapper</span>',
    'grammar': '꼼꼼분석 <span>Mapper</span>',
    'grammar-quiz': '어법 선택 <span>테스트</span>',
    'fill-blank': '빈칸 <span>테스트</span>'
  };
  document.querySelector('.hdr h1').innerHTML = titles[panel] || titles['logic'];

  // 대시보드/배치 분석 lazy 초기화 + 폴링 제어
  if (panel === 'home') {
    if (typeof initDashboard === 'function') initDashboard();
  } else {
    if (typeof stopJobPolling === 'function') stopJobPolling();
  }
  if (panel === 'batch-analyze') {
    if (typeof initBatch === 'function') initBatch();
  }
  if (panel === 'pdf-import') {
    if (typeof initPdfImport === 'function') initPdfImport();
  }
}

// ══════════════════════════════════
// ── 꼼꼼분석 (Detail Analysis) ──
// ══════════════════════════════════
async function runDetailAnalysis(passage) {
  const btn = document.getElementById('selBtn');
  const loadBtn = document.getElementById('btnLoadAnalysis');
  btn.disabled = true;
  loadBtn.style.display = 'none';
  lastDetailResult = null;
  document.getElementById('grammarActions').style.display = 'none';

  const result = document.getElementById('grammarResult');
  result.classList.remove('show');
  // 3개 카드 모두 초기화 및 숨김 (메타·지문구조 카드 제거됨)
  ['logicFlowCard','vocabCard','grammarCard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  // 구 카드(metaCard/structureCard) 가 DOM 에 남아있으면 무조건 숨김
  ['metaCard','structureCard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const lfEl = document.getElementById('logicFlowContent'); if (lfEl) lfEl.innerHTML = '';
  const vcEl = document.getElementById('vocabContent');     if (vcEl) vcEl.innerHTML = '';
  const grEl = document.getElementById('g0');               if (grEl) grEl.innerHTML = '';

  startLoadingUI();
  document.getElementById('loadingText').textContent = '3개 영역 동시 분석 중...';

  const sig = activeAbortController.signal;
  const partial = {};

  // 3개 API를 병렬 실행 — 각각 도착하는 대로 즉시 렌더링
  const logicPromise = callAI(currentProvider, currentModel, passage, null, sig, currentOption)
    .then(r => { const logic = r.parsed;
      partial.logic = logic;
      renderLogicFlowInDetail(logic, passage);
      result.classList.add('show');
      document.getElementById('logicFlowCard').style.display = '';
    });

  const vocabPromise = callAI(currentProvider, currentModel, passage, VOCABULARY_PROMPT, sig, currentOption)
    .then(r => { const vocab = r.parsed;
      partial.vocab = vocab;
      renderVocabulary(vocab.vocabulary || []);
      result.classList.add('show');
      document.getElementById('vocabCard').style.display = '';
    });

  // 어법: 문장 단위 병렬 호출 (timeout 회피)
  const grammarPromise = callGrammarChunked(currentProvider, currentModel, passage, sig, currentOption)
    .then(r => { const grammar = r.parsed;
      partial.grammar = grammar;
      renderGrammar(grammar);
      result.classList.add('show');
      document.getElementById('grammarCard').style.display = '';
    });

  // 모두 완료될 때까지 대기 (개별 실패는 다른 섹션에 영향 없음)
  const results = await Promise.allSettled([logicPromise, vocabPromise, grammarPromise]);

  // 실패한 섹션에 에러 메시지 표시
  const cardMap = [
    [{ card: 'logicFlowCard', content: 'logicFlowContent' }],
    [{ card: 'vocabCard', content: 'vocabContent' }],
    [{ card: 'grammarCard', content: 'g0' }]
  ];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      cardMap[i].forEach(({ card, content }) => {
        document.getElementById(content).innerHTML = `<div class="err">${esc(r.reason?.message || '분석 실패')}</div>`;
        document.getElementById(card).style.display = '';
      });
      result.classList.add('show');
    }
  });

  // 결과 캐싱 + 액션바 표시 (하나라도 성공했으면)
  if (partial.logic || partial.vocab || partial.grammar) {
    lastDetailResult = partial;
    const actions = document.getElementById('grammarActions');
    const saveBtn = document.getElementById('btnSaveAnalysis');
    // PDF 버튼은 항상 표시
    actions.style.display = 'flex';
    // 저장 버튼은 DB 지문만
    if (!manualMode && document.getElementById('selUnit').value && document.getElementById('selNum').value) {
      saveBtn.style.display = '';
      saveBtn.textContent = '서버에 저장';
      saveBtn.disabled = false;
    } else {
      saveBtn.style.display = 'none';
    }
  }

  btn.disabled = false;
  stopLoadingUI();
}

// ── Firestore 저장/조회/불러오기 ──
function analysisDocId(book, unit, num) {
  return `${book}__${unit}__${num}`;
}

async function checkSavedAnalysis(book, unit, num) {
  const loadBtn = document.getElementById('btnLoadAnalysis');
  loadBtn.style.display = 'none';
  try {
    const docId = analysisDocId(book, unit, num);
    const doc = await db.collection('analyses').doc(docId).get();
    // 선택이 바뀌었으면 무시
    if (document.getElementById('selUnit').value !== unit ||
        document.getElementById('selNum').value !== num) return;
    if (doc.exists) {
      loadBtn.style.display = '';
      loadBtn.disabled = false;
      loadBtn.textContent = '기존 분석 가져오기';
    }
  } catch (e) {
    console.error('checkSavedAnalysis:', e);
  }
}

async function loadSavedAnalysis() {
  const u = document.getElementById('selUnit').value;
  const n = document.getElementById('selNum').value;
  if (!u || !n) return;

  const loadBtn = document.getElementById('btnLoadAnalysis');
  loadBtn.disabled = true;
  loadBtn.textContent = '불러오는 중...';

  try {
    activateSplitLayout();
    const docId = analysisDocId(currentBook, u, n);
    const doc = await db.collection('analyses').doc(docId).get();
    if (!doc.exists) { alert('저장된 분석이 없습니다.'); return; }
    const data = doc.data();
    const result = document.getElementById('grammarResult');

    // 초기화 — 새 양식은 3개 카드만 (구 metaCard/structureCard 는 DOM 에 없을 수 있음)
    ['metaCard','structureCard','logicFlowCard','vocabCard','grammarCard'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    ['metaContent','structureContent','logicFlowContent','vocabContent','g0'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });

    // 렌더링 — 메타·지문구조는 더 이상 표시 안 함
    const loadedPassage = getSelectedPassage() || '';
    if (data.logic) {
      renderLogicFlowInDetail(data.logic, loadedPassage);
      document.getElementById('logicFlowCard').style.display = '';
    }
    if (data.vocab) {
      renderVocabulary(data.vocab.vocabulary || []);
      document.getElementById('vocabCard').style.display = '';
    }
    if (data.grammar) {
      // 저장된 sentence 수 < 원본 문장 수 → 빠진 ID 자리에 _error 스텁 채워 재시도 가능하게
      const grammarWithGaps = reconstructMissingSentences(data.grammar, loadedPassage);
      renderGrammar(grammarWithGaps);
      document.getElementById('grammarCard').style.display = '';
      // lastDetailResult 도 보강된 버전으로
      lastDetailResult = { logic: data.logic, vocab: data.vocab, grammar: grammarWithGaps };
    } else {
      lastDetailResult = { logic: data.logic, vocab: data.vocab, grammar: null };
    }
    result.classList.add('show');
    // 이미 저장된 결과 → PDF만 표시, 저장 버튼 숨김
    const actions = document.getElementById('grammarActions');
    actions.style.display = 'flex';
    document.getElementById('btnSaveAnalysis').style.display = 'none';
  } catch (e) {
    alert('불러오기 실패: ' + e.message);
  } finally {
    loadBtn.textContent = '기존 분석 가져오기';
    loadBtn.disabled = false;
  }
}

// 로드 시 빠진 문장 ID 재구성 — 저장된 sentences 와 원문 비교
// passage 원문을 splitIntoSentences 로 쪼개서 빠진 ID 자리에 _error 스텁 삽입.
// → 재시도 버튼이 작동할 수 있게 text 필드 확보.
function reconstructMissingSentences(grammarObj, originalPassage) {
  if (!grammarObj || !Array.isArray(grammarObj.sentences)) {
    return grammarObj || { sentences: [] };
  }
  const saved = grammarObj.sentences.slice();
  const expected = (typeof splitIntoSentences === 'function' && originalPassage)
    ? splitIntoSentences(originalPassage)
    : [];
  if (!expected.length) return grammarObj;
  const expectedCount = grammarObj.totalSentenceCount || expected.length;
  if (saved.length >= expectedCount) return grammarObj;

  const present = new Set(saved.map(s => s && s.id));
  const stubs = [];
  for (let i = 1; i <= expectedCount; i++) {
    if (!present.has(i)) {
      stubs.push({
        id: i,
        text: expected[i - 1] || '',
        translation: '',
        annotations: [],
        specialPatterns: [],
        _error: 'not_analyzed'   // 마커 — UI 에서 재시도 버튼 표시. PDF 에선 스킵.
      });
    }
  }
  const merged = saved.concat(stubs).sort((a, b) => (a.id || 0) - (b.id || 0));
  return { ...grammarObj, sentences: merged };
}

// 저장용 grammar 정제 — _error 문장 제외 + totalSentenceCount 메타데이터 추가
// 로드 시 빠진 문장 ID 를 감지해서 재시도 UI 제공 가능
function sanitizeGrammarForSave(grammarObj) {
  if (!grammarObj || !Array.isArray(grammarObj.sentences)) return grammarObj || null;
  const total = grammarObj.sentences.length;
  const clean = grammarObj.sentences
    .filter(s => s && !s._error && Array.isArray(s.annotations))
    .map(s => {
      // _error / 임시 필드 제거
      const { _error, ...rest } = s;
      return rest;
    });
  return {
    ...grammarObj,
    sentences: clean,
    totalSentenceCount: total   // 원본 기대 문장 수 (로드 시 누락 감지용)
  };
}

async function saveDetailAnalysis() {
  if (!lastDetailResult) { alert('저장할 분석 결과가 없습니다.'); return; }
  const u = document.getElementById('selUnit').value;
  const n = document.getElementById('selNum').value;
  if (!u || !n || manualMode) { alert('직접 입력한 지문은 저장할 수 없습니다.'); return; }

  const saveBtn = document.getElementById('btnSaveAnalysis');
  saveBtn.disabled = true;
  saveBtn.textContent = '저장 중...';

  try {
    const docId = analysisDocId(currentBook, u, n);
    await db.collection('analyses').doc(docId).set({
      book: currentBook,
      unit: u,
      number: n,
      // meta 필드 제거됨 (메타·지문구조 카드 단순화로 미사용)
      logic: lastDetailResult.logic || null,
      vocab: lastDetailResult.vocab || null,
      grammar: sanitizeGrammarForSave(lastDetailResult.grammar),
      schemaVersion: 2,
      savedAt: firebase.firestore.FieldValue.serverTimestamp(),
      savedBy: currentUser ? currentUser.uid : null
    });
    saveBtn.textContent = '저장 완료!';
    setTimeout(() => {
      document.getElementById('grammarActions').style.display = 'none';
    }, 1500);
  } catch (e) {
    alert('저장 실패: ' + e.message);
    saveBtn.textContent = '서버에 저장';
    saveBtn.disabled = false;
  }
}

// (renderMetadata 제거 — 메타 카드는 단순화로 삭제됨. 호환을 위해 빈 함수 유지)
function renderMetadata(_d) { /* deprecated */ }

function renderLogicFlowInDetail(data, passage) {
  const el = document.getElementById('logicFlowContent');
  let h = '';

  // (원문 분석 섹션 제거됨 — 사용자 요청)

  // 첫 문장 해석
  const firstEn = data.firstSentenceEn || (data.sentences && data.sentences[0] ? data.sentences[0].text : '');
  if (firstEn || data.firstSentence) {
    h += `<div class="lf-sub"><div class="lf-sub-label">첫 문장 해석</div>`;
    if (firstEn) h += `<p style="font-size:13px;color:#888;line-height:1.7;margin-bottom:6px">${esc(firstEn)}</p>`;
    if (data.firstSentence) h += `<p style="font-size:13.5px;line-height:1.7">${esc(data.firstSentence)}</p>`;
    h += `</div>`;
  }

  // Logic Flow
  h += `<div class="lf-sub"><div class="lf-sub-label">Logic Flow</div>`;
  if (data.logicFlowType === 'arrow') h += renderArrow(data.logicFlow || '');
  else if (data.logicFlowType === 'tree') h += renderTree(data.logicFlow || '');
  else if (data.logicFlowType === 'table') h += renderTable(data.logicFlow || '');
  else h += `<pre>${esc(data.logicFlow || '')}</pre>`;
  h += `</div>`;

  // 구조 요약
  const rows = data.structureRows || [];
  if (rows.length) {
    h += `<div class="lf-sub"><div class="lf-sub-label">구조 요약</div>`;
    h += `<p style="font-size:12px;color:#888;margin-bottom:8px;font-weight:600;">전개 방식: <span style="color:#e08a2a">${esc(data.structureType || '')}</span></p>`;
    h += `<table><thead><tr>`;
    Object.keys(rows[0]).forEach(k => { h += `<th>${esc(k)}</th>`; });
    h += `</tr></thead><tbody>`;
    rows.forEach(r => { h += '<tr>'; Object.values(r).forEach(v => { h += `<td>${esc(String(v))}</td>`; }); h += '</tr>'; });
    h += `</tbody></table></div>`;
  }

  el.innerHTML = h;
}

// (renderStructure 제거 — 지문구조 카드는 단순화로 삭제됨. 호환을 위해 빈 함수 유지)
function renderStructure(_stages) { /* deprecated */ }

// 첨부 이미지 양식 — 2열 셀 그리드, 별표(빈출), 동의어/반의어 색상 구분
function renderVocabulary(items) {
  const el = document.getElementById('vocabContent');
  if (!el) return;
  if (!items || !items.length) { el.innerHTML = ''; return; }

  // 한 글자 한국어 품사 → 라벨 매핑 (이미지처럼 원형 안에 글자)
  const posChip = (p) => {
    const ch = String(p || '').trim().charAt(0) || '';
    return ch ? `<span class="vp-chip">${esc(ch)}</span>` : '';
  };

  const renderCell = (v) => {
    if (!v) return '<div class="vcell vcell-empty"></div>';
    const star = v.isStarred ? '<sup class="vstar" title="시험 빈출">★</sup>' : '';
    const syn = Array.isArray(v.synonyms) && v.synonyms.length
      ? `<div class="vsyn"><span class="vsign vsign-syn">≡</span>${esc(v.synonyms.join(', '))}</div>` : '';
    const ant = Array.isArray(v.antonyms) && v.antonyms.length
      ? `<div class="vant"><span class="vsign vsign-ant">↔</span>${esc(v.antonyms.join(', '))}</div>` : '';
    return `<div class="vcell">
      <div class="vleft">
        <input type="checkbox" class="vchk" tabindex="-1" aria-label="학습 표시">
        <span class="vword">${esc(v.word || '')}${star}</span>
      </div>
      <div class="vright">
        <div class="vmeaning">${posChip(v.pos)}<span class="vmean-text">${esc(v.meaningKo || '')}</span></div>
        ${syn}${ant}
      </div>
    </div>`;
  };

  // 2열 그리드 — 1행 좌측 + 우측
  let h = `<div class="vocab-section-title"><h3>핵심 단어</h3><span class="vocab-section-sub">시험에 자주 출제되는 단어를 학습해 보세요.</span></div>`;
  h += `<div class="vocab-grid">`;
  for (let i = 0; i < items.length; i += 2) {
    h += renderCell(items[i]);
    h += renderCell(items[i + 1]);
  }
  h += `</div>`;
  el.innerHTML = h;
}

function gichulTag(code) {
  const name = (typeof GICHULCODE_MAP !== 'undefined') ? GICHULCODE_MAP[code] : null;
  if (!name) return '';
  return `<span class="gichul-tag">${code}. ${esc(name)}</span>`;
}

function injectOmitted(html, others) {
  if (!others || !others.length) return html;
  others.forEach(o => {
    if (!o.range || !o.detail) return;
    const isOmission = (o.gichulCode === 28) ||
      /생략/.test(o.type || '') || /생략/.test(o.detail || '');
    if (!isOmission) return;
    // detail에서 생략된 단어 추출: "관계대명사 that 생략" → "that"
    const wordMatch = (o.detail || '').match(/\b(that|which|who|whom|whose|where|when|should|had|were|being)\b/i);
    if (!wordMatch) return;
    const omitted = wordMatch[1];
    // range의 첫 단어 앞에 생략된 단어를 회색 괄호로 삽입
    const firstWord = o.range.trim().split(/\s+/)[0];
    if (!firstWord || firstWord.length < 2) return;
    const escaped = esc(firstWord).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const gray = `<span class="gm-omitted">(${esc(omitted)})</span> `;
    const regex = new RegExp(`(>|^|\\s)(${escaped})`, 'i');
    html = html.replace(regex, `$1${gray}$2`);
  });
  return html;
}

function injectGichulSuperscripts(html, others) {
  if (!others || !others.length) return html;
  const done = new Set();
  others.forEach(o => {
    if (!o.gichulCode || !o.range || done.has(o.gichulCode)) return;
    done.add(o.gichulCode);
    // buildGrammarAnnotations에서 이미 위첨자가 삽입된 경우 스킵
    if (html.includes(`gc-sup">${o.gichulCode}</sup>`)) return;
    const firstWord = o.range.trim().split(/\s+/)[0];
    if (!firstWord || firstWord.length < 2) return;
    const escaped = esc(firstWord).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sup = `<sup class="gc-sup">${o.gichulCode}</sup>`;
    // 태그 밖의 텍스트에서 첫 번째 매칭에만 삽입
    const regex = new RegExp(`(>|^|\\s)(${escaped})`, 'i');
    html = html.replace(regex, `$1${sup}$2`);
  });
  return html;
}

// ── 어법 렌더러 ──────────────────────────────────────────────
// 주: 신 스키마 sentences[].annotations (start/end 인덱스) 우선,
//     구 스키마 sentences[].tokens (배열) 폴백,
//     레거시 mainVerbs/clauseVerbs/... 도 마지막 폴백.

// (1) annotations 기반 렌더러 — 이벤트 기반 (중첩 wrapper 지원)
//   prep-phrase / clause-bracket 같은 wrapper 가 sub-conj·main-verb 등을 포함할 수 있음.
//   slash 는 zero-length annotation, 해당 위치에 파란 슬래시 삽입.
//   omitted (zero-length sub-conj) 도 별도 처리.
function renderAnnotatedText(text, annotations) {
  const t = String(text || '');
  if (!t) return '';

  const anns = (Array.isArray(annotations) ? annotations : [])
    .filter(a => a && a.type)
    .map(a => ({
      ...a,
      start: Math.max(0, Math.min(t.length, a.start | 0)),
      end:   Math.max(0, Math.min(t.length, a.end | 0))
    }));

  // 분류: 0-length (slash, omitted), 일반 span
  const zeroLength = anns.filter(a => a.start === a.end);
  const spans      = anns.filter(a => a.start < a.end);

  // 이벤트 리스트: open/close
  const events = [];
  spans.forEach((a, idx) => {
    events.push({ pos: a.start, kind: 'open',  ann: a, idx });
    events.push({ pos: a.end,   kind: 'close', ann: a, idx });
  });
  // zero-length 는 'point' 이벤트
  zeroLength.forEach((a, idx) => {
    events.push({ pos: a.start, kind: 'point', ann: a, idx });
  });

  events.sort((e1, e2) => {
    if (e1.pos !== e2.pos) return e1.pos - e2.pos;
    // 같은 위치: close → point → open 순서
    const order = { close: 0, point: 1, open: 2 };
    if (e1.kind !== e2.kind) return order[e1.kind] - order[e2.kind];
    if (e1.kind === 'open')  return e2.ann.end - e1.ann.end;        // outer 먼저
    if (e1.kind === 'close') return e2.ann.start - e1.ann.start;    // outer 나중
    return 0;
  });

  let html = '';
  let cur = 0;
  for (const ev of events) {
    if (ev.pos > cur) {
      html += esc(t.slice(cur, ev.pos));
      cur = ev.pos;
    }
    if (ev.kind === 'open')  html += renderAnnOpenTag(ev.ann);
    else if (ev.kind === 'close') html += renderAnnCloseTag(ev.ann, t);
    else                          html += renderAnnPoint(ev.ann);
  }
  if (cur < t.length) html += esc(t.slice(cur));
  return html;
}

// open 태그 렌더 — 클래스/data-* 만, 텍스트는 사이에 들어감
function renderAnnOpenTag(a) {
  const type = a.type;
  const dataAttrs = [];
  if (a.subtype)  dataAttrs.push(`data-subtype="${esc(a.subtype)}"`);
  if (a.usage)    dataAttrs.push(`data-usage="${esc(a.usage)}"`);
  if (a.modifies) dataAttrs.push(`data-modifies="${esc(a.modifies)}"`);
  const dAttr = dataAttrs.length ? ' ' + dataAttrs.join(' ') : '';

  switch (type) {
    case 'main-verb':      return `<span class="gr-main-verb"${dAttr}>`;
    case 'clause-verb':    return `<span class="gr-clause-verb"${dAttr}>`;
    case 'sub-conj':       return `<span class="gr-sub-conj"${dAttr}>`;
    case 'coord-conj':     return `<span class="gr-coord-conj"${dAttr}>`;
    case 'to-inf':         return `<span class="gr-to-inf"${dAttr}>`;
    case 'gerund':         return `<span class="gr-gerund-ing"${dAttr}>`;
    case 'participle':     return `<span class="gr-participle"${dAttr}>`;
    case 'special':        return `<span class="gr-special"${dAttr}>`;
    case 'prep-phrase':    return `<span class="gr-prep-phrase">`;
    case 'clause-bracket': return `<span class="gr-clause-bracket">`;
    default: return `<span>`;
  }
}

function renderAnnCloseTag(a, fullText) {
  // role superscript (V1, V2 등)
  if (a.role && (a.type === 'main-verb' || a.type === 'clause-verb')) {
    const cls = a.type === 'main-verb' ? 'gr-role-main' : 'gr-role-clause';
    return `</span><sup class="${cls}">${esc(a.role)}</sup>`;
  }
  return `</span>`;
}

// zero-length annotation: slash, 생략 sub-conj, 핵심 포인트 미주번호
function renderAnnPoint(a) {
  if (a.type === 'slash') {
    return `<span class="gr-slash">/</span>`;
  }
  if (a.type === 'sub-conj' && a.omitted) {
    const insertText = a.insertText || '(that)';
    return `<span class="gr-sub-conj gr-omitted" data-subtype="${esc(a.subtype || '명사절')}">${esc(insertText)}</span><sup class="gr-omit-tag">생략</sup>`;
  }
  if (a.type === 'special-marker') {
    return `<sup class="gm-special-marker">${esc(a.number)}</sup>`;
  }
  return '';
}

// (2) 구 tokens 스키마 → annotations 로 변환 (폴백)
function tokensToAnnotations(text, tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return null;
  const anns = [];
  let cursor = 0;
  for (const tok of tokens) {
    const tt = String(tok.text == null ? '' : tok.text);
    if (!tt) continue;
    // 원문에서 토큰 위치 찾기 (cursor 부터 검색)
    const idx = text.indexOf(tt, cursor);
    if (idx < 0) continue;
    if (tok.type && tok.type !== 'text') {
      anns.push({
        start: idx,
        end: idx + tt.length,
        type: tok.type,
        subtype: tok.subtype,
        usage: tok.usage,
        modifies: tok.modifies,
        role: tok.role,
        omitted: tok.omitted,
        optional: tok.optional
      });
    }
    cursor = idx + tt.length;
  }
  return anns;
}

// (3) 구 호환을 위한 토큰 라인 렌더러 (레거시 — 사용 안 함, 제거 예정)
function renderTokenLine(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return '';
  let h = '';
  tokens.forEach((t, i) => {
    if (i > 0) h += ' ';
    const text = String(t.text == null ? '' : t.text);
    const safe = esc(text);
    const type = t.type || 'text';

    if (type === 'text') {
      h += safe;
      return;
    }
    // 공통 data 속성
    const dataAttrs = [];
    if (t.subtype)  dataAttrs.push(`data-subtype="${esc(t.subtype)}"`);
    if (t.usage)    dataAttrs.push(`data-usage="${esc(t.usage)}"`);
    if (t.modifies) dataAttrs.push(`data-modifies="${esc(t.modifies)}"`);
    const dAttr = dataAttrs.length ? ' ' + dataAttrs.join(' ') : '';

    if (type === 'main-verb' || type === 'clause-verb') {
      const roleSup = t.role ? `<sup class="gr-role-${type === 'main-verb' ? 'main' : 'clause'}">${esc(t.role)}</sup>` : '';
      h += `<span class="gr-${type}"${dAttr}>${safe}</span>${roleSup}`;
    } else if (type === 'sub-conj') {
      const cls = t.omitted ? 'gr-sub-conj gr-omitted' : 'gr-sub-conj';
      const wrappedText = t.optional ? `(${safe})` : (t.omitted ? `(${safe})` : safe);
      const omittedSup = t.omitted ? `<sup class="gr-omit-tag">생략</sup>` : '';
      h += `<span class="${cls}"${dAttr}>${wrappedText}</span>${omittedSup}`;
    } else if (type === 'coord-conj') {
      h += `<span class="gr-coord-conj"${dAttr}>${safe}</span>`;
    } else if (type === 'to-inf') {
      // text 형식: "to study" — 'to' 와 verb 분리해서 마킹
      const m = text.match(/^(to)\s+(.+)$/i);
      if (m) {
        h += `<span class="gr-to-inf-to">${esc(m[1])}</span> <span class="gr-to-inf-verb"${dAttr}>${esc(m[2])}</span>`;
      } else {
        h += `<span class="gr-to-inf-verb"${dAttr}>${safe}</span>`;
      }
    } else if (type === 'gerund') {
      // -ing 부분만 동그라미. text 가 'studying' 같은 경우 → study + ing 분리
      const m = text.match(/^(.+?)(ing)$/i);
      if (m) {
        h += `${esc(m[1])}<span class="gr-gerund-ing"${dAttr}>${esc(m[2])}</span>`;
      } else {
        h += `<span class="gr-gerund-ing"${dAttr}>${safe}</span>`;
      }
    } else if (type === 'participle') {
      h += `<span class="gr-participle"${dAttr}>${safe}</span>`;
    } else if (type === 'special') {
      h += `<span class="gr-special"${dAttr}>${safe}</span>`;
    } else {
      // 알 수 없는 타입 → 텍스트로
      h += safe;
    }
  });
  return h;
}

// 구 스키마 (mainVerbs/clauseVerbs/...) → 토큰으로 변환 (폴백)
function legacyToTokens(s) {
  if (!s || !s.text) return [];
  // 단순 fallback: 원문 그대로 한 토큰 (마킹 없이)
  return [{ text: s.text, type: 'text' }];
}

function renderGrammar(data) {
  const sentences = data.sentences || [];
  const g0 = document.getElementById('g0');
  if (!g0) return;
  let h = '';

  // 미분석 문장 개수 — 상단 배너 (조용한 안내)
  const failedCount = sentences.filter(s => s && s._error).length;
  if (failedCount > 0) {
    h += `<div class="gm-retry-banner">
      <span>미분석 문장 <b>${failedCount}개</b></span>
      <button class="gm-retry-all-btn" onclick="retryAllFailedGrammar()">분석 실행</button>
    </div>`;
  }

  sentences.forEach(s => {
    if (!s) return;
    const errMode = !!s._error;
    h += `<div class="gm-sentence${errMode ? ' gm-sentence-error' : ''}" data-sid="${s.id}" data-text="${esc(s.text || '')}">`;
    // 문장 헤더: 번호 + (미분석시) 분석 버튼
    const sp = Array.isArray(s.specialPatterns) ? s.specialPatterns : [];
    h += `<div class="gm-sent-header">
      <span class="gm-sent-num">${s.id}</span>
      ${errMode ? `<button class="gm-retry-btn" onclick="retryGrammarSentence(${s.id})" title="이 문장 분석하기">분석</button>` : ''}
    </div>`;
    // 미분석 문장 — 원문만 회색으로 표시 (실패 메시지 X)
    if (errMode) {
      h += `<div class="gm-sent-text gm-token-line" style="color:#999">${esc(s.text || '')}</div>`;
      h += `</div>`;
      return;
    }

    // 어법 라인 — annotations 우선, 구 tokens 폴백, 그 외엔 원문 그대로
    // 핵심 포인트 anchor 위치에 미주번호 마커 삽입
    let baseAnns = Array.isArray(s.annotations) ? s.annotations.slice() : null;
    if (!baseAnns && Array.isArray(s.tokens) && s.tokens.length) {
      baseAnns = tokensToAnnotations(s.text || '', s.tokens);
    }
    // specialPatterns → 미주번호 마커로 변환
    const markerAnns = sp
      .map((p, i) => ({ ...p, _index: i + 1 }))
      .filter(p => Number.isFinite(p.anchor))
      .map(p => ({
        start: p.anchor,
        end: p.anchor,
        type: 'special-marker',
        number: p._index
      }));
    const allAnns = baseAnns ? baseAnns.concat(markerAnns) : markerAnns;

    let line = '';
    if (allAnns.length) {
      line = renderAnnotatedText(s.text || '', allAnns);
    } else {
      line = esc(s.text || '');
    }
    h += `<div class="gm-sent-text gm-token-line">${line}</div>`;

    // 번역
    h += `<div class="gm-translation">${esc(s.translation || '')}</div>`;

    // 핵심 포인트 — 미주번호와 함께 표시
    if (sp.length) {
      h += `<div class="gm-special-box">`;
      h += `<div class="gm-special-title">핵심 포인트</div>`;
      sp.forEach((p, i) => {
        const num = i + 1;
        let exp = esc(p.explanation || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        h += `<div class="gm-special-item">
          <div class="gm-special-label"><span class="gm-special-num">${num}</span>${esc(p.label || '특수구문')}</div>
          <div class="gm-special-exp">${exp}</div>
        </div>`;
      });
      h += `</div>`;
    }

    // 구 스키마 호환: tokens 가 없고 others 가 있으면 기존 방식으로 표시
    if (!Array.isArray(s.tokens) && Array.isArray(s.others) && s.others.length) {
      h += `<div class="gm-special-box">`;
      h += `<div class="gm-special-title">핵심 포인트 (구 형식)</div>`;
      s.others.forEach(o => {
        let detailHtml = esc(o.detail || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        h += `<div class="gm-special-item">
          <span class="gm-special-label">${esc(o.type || '')}</span>
          <span class="gm-special-exp">${detailHtml}</span>
        </div>`;
      });
      h += `</div>`;
    }

    h += `</div>`;
  });
  g0.innerHTML = h;
}

// ── 실패한 문장 단일 재시도 ──────────────────────────────────
// 호출 후: lastDetailResult 갱신 → renderGrammar 전체 재실행 + Firestore 동기화
async function retryGrammarSentence(id) {
  const cardEl = document.querySelector(`#g0 .gm-sentence[data-sid="${id}"]`);
  if (!cardEl) return false;
  const sentText = cardEl.getAttribute('data-text');
  if (!sentText) return false;

  const btn = cardEl.querySelector('.gm-retry-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 재분석 중...'; }
  cardEl.classList.add('gm-retrying');

  try {
    const r = await callAI(currentProvider, currentModel, sentText, GRAMMAR_PER_SENTENCE_PROMPT, null, currentOption);
    let newS = null;
    if (r.parsed && Array.isArray(r.parsed.sentences) && r.parsed.sentences.length) newS = r.parsed.sentences[0];
    else if (r.parsed && r.parsed.id != null) newS = r.parsed;
    if (!newS || !Array.isArray(newS.annotations)) throw new Error('invalid response format');
    newS.id = id;
    if (!newS.text) newS.text = sentText;

    // 메모리 결과 — lastDetailResult 우선, 없으면 DOM 으로부터 재구성
    if (!lastDetailResult) lastDetailResult = {};
    if (!lastDetailResult.grammar) {
      // DOM 에서 현재 sentences 재구성 (단순화: 빈 sentences 배열로 시작)
      lastDetailResult.grammar = { sentences: [] };
    }
    const list = lastDetailResult.grammar.sentences;
    const idx = list.findIndex(s => s && s.id === id);
    if (idx >= 0) list[idx] = newS;
    else list.push(newS);
    list.sort((a, b) => (a.id || 0) - (b.id || 0));

    renderGrammar(lastDetailResult.grammar);
    await persistGrammarUpdate(id, newS);
    return true;
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 다시 분석'; }
    cardEl.classList.remove('gm-retrying');
    console.error('[retryGrammarSentence]', e);
    alert(`재분석 실패: ${e.message || e}`);
    return false;
  }
}

// ── 모든 실패 문장 일괄 재시도 (병렬) ────────────────────────
async function retryAllFailedGrammar() {
  const failedCards = Array.from(document.querySelectorAll('#g0 .gm-sentence-error'));
  if (!failedCards.length) return;
  const banner = document.querySelector('#g0 .gm-retry-banner');
  const allBtn = banner ? banner.querySelector('.gm-retry-all-btn') : null;
  if (allBtn) { allBtn.disabled = true; allBtn.textContent = '⏳ 재분석 중...'; }

  const ids = failedCards.map(el => parseInt(el.getAttribute('data-sid'), 10)).filter(Number.isFinite);
  const results = await Promise.allSettled(ids.map(id => retryGrammarSentence(id)));
  const success = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  const fail = results.length - success;

  if (allBtn) {
    allBtn.disabled = false;
    allBtn.textContent = '🔄 모두 다시 분석';
  }
  // alert 으로 결과 알림
  if (fail === 0) alert(`✅ ${success}개 문장 재분석 완료`);
  else alert(`재분석 — 성공 ${success} · 실패 ${fail}`);
}

// Firestore 의 grammar.sentences 배열 안 특정 문장만 업데이트 (성공한 경우만 저장)
async function persistGrammarUpdate(sentenceId, newSentence) {
  // 새 문장도 _error 면 저장 건너뛰기
  if (newSentence && newSentence._error) return;
  try {
    const u = document.getElementById('selUnit')?.value;
    const n = document.getElementById('selNum')?.value;
    if (!u || !n || manualMode) return;
    if (typeof db === 'undefined' || !currentUser) return;
    const docId = analysisDocId(currentBook, u, n);
    const ref = db.collection('analyses').doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return;
    const data = snap.data();
    const sentences = (data.grammar && data.grammar.sentences) || [];
    const idx = sentences.findIndex(s => s && s.id === sentenceId);
    // _error 제거된 문장만 저장
    const { _error, ...cleanSent } = newSentence;
    if (idx >= 0) sentences[idx] = cleanSent;
    else sentences.push(cleanSent);
    await ref.update({
      'grammar.sentences': sentences,
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.warn('Firestore grammar update failed:', e);
  }
}

if (typeof window !== 'undefined') {
  window.retryGrammarSentence = retryGrammarSentence;
  window.retryAllFailedGrammar = retryAllFailedGrammar;
}

async function downloadDetailPDF(ev) {
  const result = document.getElementById('grammarResult');
  const lfCard = document.getElementById('logicFlowCard');
  const vcCard = document.getElementById('vocabCard');
  const hasAnyContent =
    (lfCard && lfCard.style.display !== 'none') ||
    (vcCard && vcCard.style.display !== 'none') ||
    document.querySelectorAll('#g0 .gm-sentence').length > 0;
  if (!result.classList.contains('show') || !hasAnyContent) {
    alert('먼저 꼼꼼분석을 실행해주세요.');
    return;
  }
  if (typeof html2canvas === 'undefined' || !window.jspdf) {
    alert('PDF 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해주세요.');
    return;
  }

  const btn = (ev && ev.target) || document.querySelector('.action-btn-pdf');
  const originalText = btn.textContent;
  btn.textContent = '생성 중...';
  btn.disabled = true;

  let container = null;
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    // A4: 210mm × 297mm
    const pageWidth = 210;
    const pageHeight = 297;
    const marginX = 12;
    const marginY = 15;
    const subHdrReserve = 9;   // 2페이지+ 머릿말 높이
    const footerReserve = 8;   // 꼬릿말 높이
    const contentWidth = pageWidth - (marginX * 2);   // 186mm
    const bottomLimit = pageHeight - marginY - footerReserve; // 콘텐츠 하단 한계
    const newPageStartY = marginY + subHdrReserve;  // 2페이지+ 콘텐츠 시작 Y

    // off-screen container with fixed capture width
    const captureWidth = 750; // px
    container = document.createElement('div');
    container.style.cssText = `position:absolute;left:-9999px;top:0;width:${captureWidth}px;background:#fff`;
    document.body.appendChild(container);

    const canvasOpts = { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true };

    // 캡처 헬퍼: HTMLElement → {dataUrl, heightMm} (contentWidth 기준)
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

    // .sec-card 통째로 캡처 (tag + content)
    const captureCard = async (cardId) => {
      const card = document.getElementById(cardId);
      if (!card || card.style.display === 'none') return null;
      const clone = card.cloneNode(true);
      clone.style.maxWidth = captureWidth + 'px';
      clone.style.overflow = 'hidden';
      clone.style.wordBreak = 'break-word';
      return captureNode(clone);
    };

    // 로고 이미지 로드 (우측 상단)
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
    } catch (e) {
      console.warn('로고 이미지 로드 실패:', e);
    }

    // 교재/단원/지문 메타정보 수집
    const selUnitVal = document.getElementById('selUnit')?.value || '';
    const selNumVal = document.getElementById('selNum')?.value || '';
    const bookLabel = currentBook || '';
    const isManual = manualMode || (!selUnitVal && !selNumVal);

    // (메타 헤더 큰 블록은 제거 — 모든 페이지의 머릿말이 동일하게 책·단원·지문번호 표시)
    // 1페이지에도 동일 머릿말이 적용되어 빈 공간 없이 어휘부터 시작.

    // ── 섹션 이미지 캡처 — 새 양식 ──
    // 부제목 div 만드는 헬퍼 (핵심단어 / 어법분석 / 구조분석)
    const makeSubtitle = (text) => {
      const el = document.createElement('div');
      el.style.cssText = `font-size:18px;font-weight:800;color:#1a1a1a;letter-spacing:-.4px;padding:4px 0 12px;font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic','나눔고딕',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
      el.textContent = text;
      return el;
    };

    // 지문 번호 + 제목 큰 헤더 (첫 페이지 vocab 위)
    // 색상: 번호=파란색 큰 글씨, 제목=검정 일반
    const PASSAGE_HEADER_BLUE = '#4f6ef7';
    const makePassageHeader = (numText, titleKo) => {
      const el = document.createElement('div');
      el.style.cssText = `display:flex;align-items:baseline;gap:14px;padding:6px 0 16px;border-bottom:1px solid #ebebeb;margin-bottom:16px;font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic','나눔고딕',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
      el.innerHTML =
        `<span style="font-size:26px;font-weight:800;color:${PASSAGE_HEADER_BLUE};letter-spacing:-.5px;flex-shrink:0">${esc(numText)}</span>` +
        (titleKo ? `<span style="font-size:17px;font-weight:700;color:#1a1a1a;letter-spacing:-.3px;line-height:1.3">${esc(titleKo)}</span>` : '');
      return el;
    };

    // 지문 번호 / 제목 결정
    const passageNumText = isManual
      ? '직접 입력'
      : (selNumVal ? (String(selNumVal).match(/\d+/) ? String(selNumVal).match(/\d+/)[0] + '번' : selNumVal) : '');
    const passageTitleKo = (lastDetailResult && lastDetailResult.logic && lastDetailResult.logic.titleKo) || '';

    // 어휘: 지문 번호/제목 헤더 + "핵심단어" 부제목 + 행 단위 셀
    let passageHeaderImg = null;
    let vocabHeaderImg = null;
    const vocabRowImgs = [];
    if (document.getElementById('vocabCard').style.display !== 'none') {
      // (1) 지문 번호 + 제목 (이 PDF 의 첫 페이지 vocab 위에만 표시)
      if (passageNumText || passageTitleKo) {
        passageHeaderImg = await captureNode(makePassageHeader(passageNumText, passageTitleKo));
      }
      // (2) 핵심단어 부제목
      vocabHeaderImg = await captureNode(makeSubtitle('핵심단어'));

      // (3) 셀 2개씩 행 단위 캡처
      const cells = Array.from(document.querySelectorAll('#vocabContent .vocab-grid .vcell'));
      for (let i = 0; i < cells.length; i += 2) {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;background:transparent';
        row.appendChild(cells[i].cloneNode(true));
        if (i + 1 < cells.length) row.appendChild(cells[i + 1].cloneNode(true));
        vocabRowImgs.push(await captureNode(row));
      }
    }

    // 어법: "어법분석" 부제목 + 범례 + 문장들
    let grammarHeaderImg = null;
    const sentenceImgs = [];
    if (document.getElementById('grammarCard').style.display !== 'none' &&
        document.querySelectorAll('#g0 .gm-sentence').length) {
      const gHeader = document.createElement('div');
      gHeader.style.cssText = 'padding:0';
      gHeader.appendChild(makeSubtitle('어법분석'));
      const origLegend = document.querySelector('#panel-grammar .gr-legend')
        || document.querySelector('#panel-grammar .gm-legend');
      if (origLegend) gHeader.appendChild(origLegend.cloneNode(true));
      grammarHeaderImg = await captureNode(gHeader);

      // PDF 는 분석 실패/미분석 문장 제외 — 에러 표시 절대 X
      const sentences = Array.from(document.querySelectorAll('#g0 .gm-sentence:not(.gm-sentence-error)'));
      for (const sent of sentences) {
        sentenceImgs.push(await captureNode(sent.cloneNode(true)));
      }
    }

    // Logic Flow → 구조분석: 부제목 + 서브섹션
    let logicFlowHeaderImg = null;
    const logicSubImgs = [];
    if (document.getElementById('logicFlowCard').style.display !== 'none') {
      logicFlowHeaderImg = await captureNode(makeSubtitle('구조분석'));
      const subs = Array.from(document.querySelectorAll('#logicFlowContent .lf-sub'));
      for (let si = 0; si < subs.length; si++) {
        const img = await captureNode(subs[si].cloneNode(true));
        // group: 첫문장해석(0)과 Logic Flow(1)를 같은 그룹으로 묶음
        img._group = (si === 0 || si === 1) ? 'flow' : null;
        logicSubImgs.push(img);
      }
    }

    // ── PDF 조립 ──
    // 모든 페이지의 머릿말이 동일하게 책·단원·지문번호 표시 (post-pass 에서 그려짐).
    // 1페이지도 newPageStartY 부터 시작하므로 머릿말 자리 확보 + 어휘가 즉시 시작.
    let y = newPageStartY;

    // 섹션 배치 헬퍼: 현재 페이지에 들어가면 이어서, 안 들어가면 새 페이지
    const usableH = bottomLimit - newPageStartY; // 2페이지+ 사용 가능 높이
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

    // 1) 첫 페이지 — 지문 번호/제목 헤더 + "핵심단어" 부제목 + 행 단위 분할
    if (passageHeaderImg) placeInFlow(passageHeaderImg);
    if (vocabHeaderImg)   placeInFlow(vocabHeaderImg);
    for (const rowImg of vocabRowImgs) {
      if (rowImg.heightMm <= usableH && y + rowImg.heightMm > bottomLimit) {
        pdf.addPage();
        y = newPageStartY;
      }
      placeInFlow(rowImg);
    }

    // 2) 어법 분석: 항상 새 페이지에서 시작 + 문장 카드는 페이지 중간에 잘리지 않음
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

    // ── 머릿말 + 꼬릿말 (모든 페이지) ──
    // 머릿말 — 좌측 "상세분석" + 우측 "교재명 | 단원명", 하단 파란 구분선
    const HEADER_BLUE = '#4f6ef7';
    const subHdrEl = document.createElement('div');
    subHdrEl.style.cssText = `width:${captureWidth}px;padding:4px 0 8px;border-bottom:2.5px solid ${HEADER_BLUE};display:flex;justify-content:space-between;align-items:baseline;font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic','나눔고딕',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
    let rightParts = [];
    if (!isManual) {
      if (bookLabel) rightParts.push(bookLabel);
      const unitParts = [];
      if (selUnitVal) unitParts.push(selUnitVal);
      if (selNumVal) unitParts.push(selNumVal);
      if (unitParts.length) rightParts.push(unitParts.join(' '));
    }
    const rightStr = rightParts.join('  |  ');
    subHdrEl.innerHTML =
      `<span style="font-size:15px;color:${HEADER_BLUE};font-weight:800;letter-spacing:-.3px">상세분석</span>` +
      `<span style="font-size:12.5px;color:#444;font-weight:600;letter-spacing:-.1px">${rightStr || '직접 입력 지문'}</span>`;
    const subHdrImg = await captureNode(subHdrEl);

    // 꼬릿말 — 상단 파란 구분선
    const ftrEl = document.createElement('div');
    ftrEl.style.cssText = `width:${captureWidth}px;padding:8px 0 0;border-top:2.5px solid ${HEADER_BLUE};display:flex;justify-content:space-between;align-items:center;font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic','나눔고딕',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
    ftrEl.innerHTML = `<span style="font-size:12.5px;color:#444;font-weight:700;letter-spacing:-.1px">송유근 영어</span><span style="font-size:12.5px;color:#444;font-weight:600;letter-spacing:-.1px">최고의 강의 &amp; 철저한 관리</span>`;
    const ftrImg = await captureNode(ftrEl);

    const totalPages = pdf.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      pdf.setPage(p);

      // 머릿말: 모든 페이지 (1페이지 포함) — 통일된 양식
      pdf.addImage(subHdrImg.dataUrl, 'JPEG', marginX, marginY - 2, contentWidth, subHdrImg.heightMm);

      // 꼬릿말: 모든 페이지 하단
      const ftrY = pageHeight - marginY + 2;
      pdf.addImage(ftrImg.dataUrl, 'JPEG', marginX, ftrY, contentWidth, ftrImg.heightMm);

      // 페이지 번호 (중앙, ASCII만 사용)
      pdf.setFontSize(9);
      pdf.setTextColor(100, 100, 100);
      pdf.text(`- ${p} / ${totalPages} -`, pageWidth / 2, ftrY + ftrImg.heightMm + 3, { align: 'center' });
    }

    // filename: date + book + unit + passage
    const date = new Date().toISOString().slice(0, 10);
    const safe = s => String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
    const parts = ['꼼꼼분석', safe(currentBook) || 'detail'];
    if (!isManual) {
      if (selUnitVal) parts.push(safe(selUnitVal));
      if (selNumVal) parts.push(safe(selNumVal));
    } else {
      parts.push('직접입력');
    }
    parts.push(date);
    pdf.save(parts.join('_') + '.pdf');

    btn.textContent = '다운로드 완료!';
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
  } catch (e) {
    console.error(e);
    alert('PDF 생성 실패: ' + e.message);
    btn.textContent = originalText;
    btn.disabled = false;
  } finally {
    if (container && container.parentNode) container.parentNode.removeChild(container);
  }
}

// 하위 호환 alias (이전 이름으로 호출되는 곳 대비)
const downloadGrammarPDF = downloadDetailPDF;

function parseBold(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }

function formatGmLabel(detail, extra) {
  let cls = 'gm-label';
  const full = (detail || '') + (extra ? ' ' + extra : '');
  if (/toV|부정사/i.test(full)) cls += ' gm-label-purple';
  else if (/분사/i.test(full)) cls += ' gm-label-green';
  else if (/동명사/i.test(full)) cls += ' gm-label-orange';
  let html = parseBold(detail || '');
  if (extra) html += `<br>${parseBold(extra)}`;
  return `<span class="${cls}">${html}</span>`;
}

function buildGrammarAnnotations(s) {
  let text = s.text || '';
  // Collect all annotations with positions (we'll match by word)
  const annos = [];

  // Main verbs
  (s.mainVerbs || []).forEach(v => {
    annos.push({ word: v.original || v.word, cls: 'gm-main-verb', label: null });
  });
  // Clause verbs
  (s.clauseVerbs || []).forEach(v => {
    annos.push({ word: v.original || v.word, cls: 'gm-clause-verb', label: v.clause || '절동사' });
  });
  // Infinitives
  (s.infinitives || []).forEach(v => {
    const full = v.original || ('to ' + v.word);
    // Split: "to" gets circle, rest gets underline
    annos.push({ word: full, type: 'infinitive', detail: `toV-${v.type || ''}`, extra: v.detail || '' });
  });
  // Participles
  (s.participles || []).forEach(v => {
    annos.push({ word: v.original || v.word, type: 'participle', detail: v.type || '분사', extra: v.detail || '' });
  });
  // Gerunds
  (s.gerunds || []).forEach(v => {
    annos.push({ word: v.original || v.word, type: 'gerund', detail: `동명사(${v.function || ''})` });
  });
  // Conjunctions (subordinating)
  (s.conjunctions || []).forEach(v => {
    let detail = v.type || '종속접속사';
    if (detail && !detail.includes('절')) {
      const adverbialTypes = ['시간','이유','조건','양보','결과','목적','장소','방법','비교','대조'];
      if (adverbialTypes.some(t => detail.includes(t))) detail += '부사절';
      else if (detail.includes('명사')) detail += '절';
      else if (detail.includes('형용사') || detail.includes('관계')) detail += '절';
      else detail += '부사절';
    }
    let clauseType = 'adv';
    if (detail.includes('명사')) clauseType = 'noun';
    else if (detail.includes('형용사') || detail.includes('관계')) clauseType = 'adj';
    annos.push({ word: v.word, type: 'conjunction', detail, clauseType, clauseRange: v.clauseRange || '' });
  });
  // Coordinating conjunctions
  (s.coordinatingConjs || []).forEach(v => {
    annos.push({ word: v.word, type: 'coordinating' });
  });
  // Others (관계대명사, 도치, 가정법 등 — 위 카테고리에서 이미 처리되지 않은 항목)
  (s.others || []).forEach(o => {
    if (!o.range) return;
    annos.push({ word: o.range, type: 'others', detail: o.type || '', gichulCode: o.gichulCode });
  });

  // Sort: 동사/준동사/접속사 등 구체적 어노테이션 우선, others는 항상 마지막
  // 같은 우선순위 내에서는 단어 길이 내림차순 (긴 것 먼저 매칭)
  const _annoPri = (a) => a.type === 'others' ? 1 : 0;
  annos.sort((a, b) => {
    const pa = _annoPri(a), pb = _annoPri(b);
    if (pa !== pb) return pa - pb;
    return (b.word || '').length - (a.word || '').length;
  });

  // Pre-pass: insert closing bracket markers for clauseRange
  let result = esc(text);
  const closingBrackets = [];
  annos.forEach(a => {
    if (a.type === 'conjunction' && a.clauseRange) {
      const brackets = { noun: ['[', ']'], adj: ['{', '}'], adv: ['(', ')'] };
      const br = brackets[a.clauseType] || brackets.adv;
      const escapedRange = esc(a.clauseRange).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rangeRe = new RegExp(escapedRange, 'i');
      const cbMarker = `\x01${closingBrackets.length}\x01`;
      result = result.replace(rangeRe, match => {
        closingBrackets.push(br[1]);
        return match + cbMarker;
      });
    }
  });

  // Replace words with markers
  const markers = [];
  annos.forEach((a, idx) => {
    const escaped = esc(a.word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const marker = `\x00${idx}\x00`;
    result = result.replace(regex, (match) => {
      markers[idx] = { match, anno: a };
      return marker;
    });
  });

  // Now replace markers with actual HTML
  markers.forEach((m, idx) => {
    if (!m) return;
    const marker = `\x00${idx}\x00`;
    let html = '';
    const a = m.anno;
    const word = m.match;

    if (a.type === 'infinitive') {
      const toMatch = word.match(/^(to)\s+(.+)$/i);
      const detailParts = formatGmLabel(a.detail, a.extra);
      if (toMatch) {
        html = `<span class="gm-anno"><span class="gm-anno-text"><span class="gm-to-circle">${toMatch[1]}</span> <span class="gm-to-underline">${toMatch[2]}</span></span>${detailParts}</span>`;
      } else {
        html = `<span class="gm-anno"><span class="gm-anno-text gm-to-underline">${word}</span>${detailParts}</span>`;
      }
    } else if (a.type === 'participle') {
      const detailParts = formatGmLabel(a.detail, a.extra);
      html = `<span class="gm-anno"><span class="gm-anno-text"><span class="gm-participle-box">${word}</span></span>${detailParts}</span>`;
    } else if (a.type === 'gerund') {
      // Only circle the -ing part
      const ingMatch = word.match(/^(.+?)(ing)$/i);
      if (ingMatch) {
        html = `<span class="gm-anno"><span class="gm-anno-text">${ingMatch[1]}<span class="gm-gerund-circle">${ingMatch[2]}</span></span><span class="gm-label gm-label-orange">${esc(a.detail)}</span></span>`;
      } else {
        html = `<span class="gm-anno"><span class="gm-anno-text"><span class="gm-gerund-circle">${word}</span></span><span class="gm-label gm-label-orange">${esc(a.detail)}</span></span>`;
      }
    } else if (a.type === 'conjunction') {
      const brackets = { noun: ['[', ']'], adj: ['{', '}'], adv: ['(', ')'] };
      const br = brackets[a.clauseType] || brackets.adv;
      html = `<span class="gm-clause-bracket">${br[0]}</span><span class="gm-anno"><span class="gm-anno-text"><span class="gm-conj">${word}</span></span><span class="gm-label gm-label-red">${esc(a.detail)}</span></span>`;
    } else if (a.type === 'coordinating') {
      html = `<span class="gm-coord-box">${word}</span>`;
    } else if (a.type === 'others') {
      const sup = a.gichulCode ? `<sup class="gc-sup">${a.gichulCode}</sup>` : '';
      html = `${sup}<span class="gm-anno"><span class="gm-anno-text"><span class="gm-others-range">${word}</span></span><span class="gm-label gm-label-red">${esc(a.detail)}</span></span>`;
    } else if (a.cls) {
      html = `<span class="${a.cls}">${word}</span>`;
      if (a.label) {
        html = `<span class="gm-anno"><span class="gm-anno-text"><span class="${a.cls}">${word}</span></span><span class="gm-label">${esc(a.label)}</span></span>`;
      }
    } else {
      html = word;
    }

    result = result.replace(marker, html);
  });

  // Replace closing bracket markers with HTML
  closingBrackets.forEach((br, i) => {
    result = result.replace(`\x01${i}\x01`, `<span class="gm-clause-bracket">${br}</span>`);
  });

  // Clean up any remaining markers
  result = result.replace(/\x00\d+\x00/g, '');
  result = result.replace(/\x01\d+\x01/g, '');
  return result;
}

// ══════════════════════════════════
// ── Grammar Quiz ──
// ══════════════════════════════════
let quizData = null;

function getDifficulty() {
  const el = document.querySelector('input[name="difficulty"]:checked');
  return el ? el.value : 'mid';
}
function getBlankType() {
  const el = document.querySelector('input[name="blankType"]:checked');
  return el ? el.value : 'both';
}
function buildQuizPrompt() {
  const diff = getDifficulty();
  const diffText = {
    high: '난이도 상: 15~20문제를 출제하세요. 모든 어법 영역에서 최대한 많이 출제.',
    mid: '난이도 중: 10~12문제를 출제하세요. 다양한 어법 포인트에서 고르게 출제.',
    low: '난이도 하: 6~8문제를 출제하세요. 중요한 핵심 어법 중심으로 출제.'
  };
  return GRAMMAR_QUIZ_PROMPT.replace('DIFFICULTY_PLACEHOLDER', diffText[diff] || diffText.mid);
}
function buildBlankPrompt() {
  const diff = getDifficulty();
  const type = getBlankType();
  const diffText = {
    high: '난이도 상: 25~35개 빈칸을 만드세요. 가능한 모든 중요 단어에 빈칸.',
    mid: '난이도 중: 15~20개 빈칸을 만드세요. 다양한 유형에서 고르게.',
    low: '난이도 하: 8~12개 빈칸을 만드세요. 핵심 단어 중심.'
  };
  const typeText = {
    grammar: '어법 유형만 출제: 동사 형태, 준동사, 접속사 등 어법적으로 중요한 단어만 빈칸으로 만드세요.',
    content: '내용 유형만 출제: 지문의 핵심 주제어, 논리 전개에 중요한 키워드만 빈칸으로 만드세요.',
    both: '종합 출제: 어법적으로 중요한 단어와 내용적으로 핵심인 키워드를 고르게 빈칸으로 만드세요.'
  };
  return FILL_BLANK_PROMPT
    .replace('DIFFICULTY_PLACEHOLDER', diffText[diff] || diffText.mid)
    .replace('TYPE_PLACEHOLDER', typeText[type] || typeText.both);
}

async function runGrammarQuiz(passage) {
  const btn = document.getElementById('selBtn');
  btn.disabled = true;
  const result = document.getElementById('quizResult');
  result.classList.remove('show');
  startLoadingUI();
  try {
    const prompt = buildQuizPrompt();
    const { parsed } = await callAI(currentProvider, currentModel, passage, prompt, activeAbortController.signal, currentOption);
    quizData = parsed;
    renderGrammarQuiz(parsed);
    result.classList.add('show');
  } catch (e) {
    document.getElementById('q0').innerHTML = `<div class="err">${esc(e.message)}</div>`;
    result.classList.add('show');
  } finally {
    btn.disabled = false;
    stopLoadingUI();
  }
}

function renderGrammarQuiz(data) {
  const qs = data.questions || [];
  const orig = data.originalText || '';
  let h = '';

  // Build passage with inline selection dropdowns
  let passageHtml = esc(orig);
  qs.forEach(q => {
    const escaped = esc(q.original).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    const inlineWidget = `<span class="quiz-inline" data-qid="${q.id}" data-answer="${esc(q.answer)}"><span class="quiz-inline-num">${q.id}</span><span class="quiz-inline-btn quiz-inline-a" data-val="A" onclick="selectQuizOption(this)">${esc(q.optionA)}</span><span class="quiz-inline-sep">/</span><span class="quiz-inline-btn quiz-inline-b" data-val="B" onclick="selectQuizOption(this)">${esc(q.optionB)}</span></span>`;
    passageHtml = passageHtml.replace(re, inlineWidget);
  });
  h += `<div class="quiz-passage">${passageHtml}</div>`;

  // Explanation cards (hidden until grading)
  qs.forEach(q => {
    h += `<div class="quiz-explanation" id="expl-${q.id}"><span class="quiz-q-num" style="margin-right:6px">${q.id}</span><span class="quiz-q-cat" style="margin-right:6px">${esc(q.category || '')}</span>${esc(q.explanation || '')}</div>`;
  });

  h += `<button class="btn-grade" onclick="gradeGrammarQuiz()">채점하기</button>`;
  document.getElementById('q0').innerHTML = h;
}

function selectQuizOption(el) {
  const parent = el.closest('.quiz-inline');
  if (parent.classList.contains('graded')) return;
  // Deselect siblings
  parent.querySelectorAll('.quiz-inline-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}

function gradeGrammarQuiz() {
  if (!quizData) return;
  const qs = quizData.questions || [];
  let correct = 0;
  const total = qs.length;

  qs.forEach(q => {
    const inlineEl = document.querySelector(`.quiz-inline[data-qid="${q.id}"]`);
    if (!inlineEl) return;
    inlineEl.classList.add('graded');
    const selected = inlineEl.querySelector('.quiz-inline-btn.selected');
    const userAnswer = selected ? selected.dataset.val : '';
    const isCorrect = userAnswer === q.answer;
    if (isCorrect) correct++;

    // Mark correct/wrong
    inlineEl.querySelectorAll('.quiz-inline-btn').forEach(btn => {
      if (btn.dataset.val === q.answer) btn.classList.add('correct');
      else if (btn === selected && !isCorrect) btn.classList.add('wrong');
    });
    // Show explanation
    const expl = document.getElementById(`expl-${q.id}`);
    if (expl) expl.classList.add('show');
  });

  // Show score
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  const scoreHtml = `<div class="score-card"><div class="score-big">${correct}/${total}</div><div class="score-sub">${pct}점</div><div class="score-bar"><div class="score-fill" style="width:${pct}%"></div></div></div>`;
  const q0 = document.getElementById('q0');
  q0.insertAdjacentHTML('afterbegin', scoreHtml);

  const btn = q0.querySelector('.btn-grade');
  if (btn) { btn.disabled = true; btn.textContent = '채점 완료'; btn.classList.add('graded'); }
}

// ══════════════════════════════════
// ── Fill-in-the-Blank ──
// ══════════════════════════════════
let blankData = null;

async function runFillBlank(passage) {
  const btn = document.getElementById('selBtn');
  btn.disabled = true;
  const result = document.getElementById('blankResult');
  result.classList.remove('show');
  startLoadingUI();
  try {
    const prompt = buildBlankPrompt();
    const { parsed } = await callAI(currentProvider, currentModel, passage, prompt, activeAbortController.signal, currentOption);
    blankData = parsed;
    renderFillBlank(parsed);
    result.classList.add('show');
  } catch (e) {
    document.getElementById('b0').innerHTML = `<div class="err">${esc(e.message)}</div>`;
    result.classList.add('show');
  } finally {
    btn.disabled = false;
    stopLoadingUI();
  }
}

function renderFillBlank(data) {
  const blanks = data.blanks || [];
  let textWB = data.textWithBlanks || '';
  const showHint = document.getElementById('hintToggle')?.checked ?? false;
  let h = '';

  // Replace __[N]__ with input fields
  let passageHtml = esc(textWB);
  blanks.forEach(b => {
    const pat = `__[${b.id}]__`;
    const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    const firstLetter = showHint && b.answer ? b.answer.charAt(0) : '';
    const placeholder = showHint ? firstLetter + '...' : b.id;
    const val = showHint ? firstLetter : '';
    const inputHtml = `<input class="blank-input" data-bid="${b.id}" data-answer="${esc(b.answer)}" placeholder="${esc(placeholder)}" value="${esc(val)}" autocomplete="off"><span class="blank-answer" id="ba-${b.id}"> ${esc(b.answer)}</span>`;
    passageHtml = passageHtml.replace(re, inputHtml);
  });

  h += `<div class="blank-passage">${passageHtml}</div>`;
  h += `<button class="btn-grade" onclick="gradeFillBlank()">채점하기</button>`;
  document.getElementById('b0').innerHTML = h;
}

function gradeFillBlank() {
  if (!blankData) return;
  const blanks = blankData.blanks || [];
  let correct = 0;
  const total = blanks.length;

  blanks.forEach(b => {
    const input = document.querySelector(`.blank-input[data-bid="${b.id}"]`);
    if (!input) return;
    const userVal = input.value.trim().toLowerCase();
    const ans = (b.answer || '').toLowerCase();
    const isCorrect = userVal === ans;
    if (isCorrect) correct++;

    input.readOnly = true;
    input.classList.add(isCorrect ? 'correct' : 'wrong');
    // Show correct answer if wrong
    if (!isCorrect) {
      const ba = document.getElementById(`ba-${b.id}`);
      if (ba) ba.classList.add('show');
    }
  });

  // Show score
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  const scoreHtml = `<div class="score-card"><div class="score-big">${correct}/${total}</div><div class="score-sub">${pct}점</div><div class="score-bar"><div class="score-fill" style="width:${pct}%"></div></div></div>`;
  const b0 = document.getElementById('b0');
  b0.insertAdjacentHTML('afterbegin', scoreHtml);

  const btn = b0.querySelector('.btn-grade');
  if (btn) { btn.disabled = true; btn.textContent = '채점 완료'; btn.classList.add('graded'); }
}
