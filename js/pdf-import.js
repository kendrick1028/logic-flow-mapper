// ══════════════════════════════════════════════════════════════════
//  자료 자동 등록 — PDF 업로드 / 텍스트 직접 입력 → AI 분석 → BOOKS DB 등록
// ══════════════════════════════════════════════════════════════════
//  의존: pdf-lib (CDN, PDF 청크 분할용)
//  - PDF 모드: 50쪽 청크 분할 → /api/claude-pdf 호출 → 결과 머지
//  - 텍스트 모드: 7만 자 청크 분할 → /api/claude (일반 텍스트) 호출 → 결과 머지
//  - 결과를 localStorage('lfm_imported_books') 에 저장 → 부팅 시 BOOKS 머지

const PDF_IMPORT_LS_KEY  = 'lfm_imported_books';
const PDF_CHUNK_PAGES    = 50;
const TEXT_CHUNK_CHARS   = 70000;

let pdfImportState = {
  running: false,
  abort: false,
  mode: 'pdf',   // 'pdf' | 'text'
  expandedUnits: new Set()
};

// ── 진입점 ──────────────────────────────────────────────────────
function initPdfImport() {
  const runBtn = document.getElementById('pdfImportRunBtn');
  if (runBtn && !runBtn._wired) { runBtn.addEventListener('click', runPdfImport); runBtn._wired = true; }
  const cancel = document.getElementById('pdfImportCancelBtn');
  if (cancel && !cancel._wired) { cancel.addEventListener('click', () => { pdfImportState.abort = true; }); cancel._wired = true; }

  // 드래그-드롭 영역
  const drop = document.getElementById('pdfImportDrop');
  const fileInput = document.getElementById('pdfImportFile');
  if (drop && !drop._wired) {
    drop.addEventListener('dragenter', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', e => { e.preventDefault(); drop.classList.remove('dragover'); });
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const f = e.dataTransfer.files?.[0];
      if (f && /\.pdf$/i.test(f.name) && fileInput) {
        const dt = new DataTransfer();
        dt.items.add(f);
        fileInput.files = dt.files;
        updatePdfDropDisplay();
      }
    });
    drop._wired = true;
  }
  if (fileInput && !fileInput._wired) {
    fileInput.addEventListener('change', updatePdfDropDisplay);
    fileInput._wired = true;
  }

  renderImportedBooksList();
  updatePdfImportTextMeta();
}

// ── 모드 전환 ──────────────────────────────────────────────────
function switchPdfImportMode(mode) {
  if (pdfImportState.running) return;
  pdfImportState.mode = mode;
  document.querySelectorAll('.pdfimp-mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  document.getElementById('pdfImportPdfField').style.display  = mode === 'pdf'  ? '' : 'none';
  document.getElementById('pdfImportTextField').style.display = mode === 'text' ? '' : 'none';
  document.getElementById('pdfImportRunBtnLabel').textContent =
    mode === 'pdf' ? 'PDF 분석 & 등록' : '텍스트 분석 & 등록';
  // 입력 변경 시 이전 미리보기/상태 클리어
  hidePreviewAndStatus();
}

function updatePdfDropDisplay() {
  const fileInput = document.getElementById('pdfImportFile');
  const drop = document.getElementById('pdfImportDrop');
  const titleEl = document.getElementById('pdfImportDropTitle');
  if (!fileInput || !drop || !titleEl) return;
  const f = fileInput.files?.[0];
  if (f) {
    drop.classList.add('has-file');
    titleEl.textContent = `📄 ${f.name}  (${(f.size / 1024 / 1024).toFixed(1)}MB)`;
  } else {
    drop.classList.remove('has-file');
    titleEl.textContent = 'PDF 를 드래그하거나 클릭해서 업로드';
  }
}

function updatePdfImportTextMeta() {
  const ta = document.getElementById('pdfImportText');
  const meta = document.getElementById('pdfImportTextMeta');
  if (!ta || !meta) return;
  const text = ta.value || '';
  const chars = text.length;
  const words = (text.trim().match(/\S+/g) || []).length;
  meta.textContent = `${chars.toLocaleString()}자 · ${words.toLocaleString()}단어`;
}

// ── 메인 실행 ──────────────────────────────────────────────────
async function runPdfImport() {
  if (pdfImportState.running) return;
  const bookName = (document.getElementById('pdfImportBookName')?.value || '').trim();
  if (!bookName) { showStatus('교재명을 입력하세요.', 'err'); return; }

  pdfImportState.running = true;
  pdfImportState.abort = false;
  toggleButtons(true);
  showProgress(0, '준비 중…');
  hidePreviewAndStatus();

  try {
    const merged = pdfImportState.mode === 'pdf'
      ? await runPdfMode(bookName)
      : await runTextMode(bookName);

    if (!merged || !Object.keys(merged).length) {
      showStatus('지문을 추출하지 못했습니다. 입력 자료가 영어 교재인지, 페이지가 잘리지 않았는지 확인하세요.', 'err');
      return;
    }
    showStatus('저장 중…', 'info');
    await saveImportedBook(bookName, merged);
    const units = Object.keys(merged).length;
    const passages = countPassages(merged);
    const fsHint = (typeof db !== 'undefined' && currentUser) ? '모든 기기에 동기화됨' : '이 브라우저에만 저장됨 (로그인 시 Firestore 동기화)';
    showStatus(`✅ 등록 완료 — "${bookName}" · 단원 ${units}개 / 지문 ${passages}개. ${fsHint}.`, 'ok');
    renderPreview(merged, true);
    renderImportedBooksList();

  } catch (e) {
    if (e && /취소/.test(e.message || '')) {
      showStatus('사용자가 분석을 중단했습니다.', 'err');
    } else {
      console.error('[pdf-import]', e);
      showStatus('오류: ' + (e.message || String(e)), 'err');
    }
  } finally {
    pdfImportState.running = false;
    toggleButtons(false);
    hideProgress();
  }
}

// ── PDF 모드 ───────────────────────────────────────────────────
async function runPdfMode(bookName) {
  const file = document.getElementById('pdfImportFile')?.files?.[0];
  if (!file) throw new Error('PDF 파일을 선택하세요.');
  if (!/\.pdf$/i.test(file.name)) throw new Error('PDF 파일만 업로드 가능합니다.');

  showProgress(2, 'PDF 로딩…');
  const arrayBuffer = await file.arrayBuffer();
  const PDFLib = window.PDFLib;
  if (!PDFLib) throw new Error('pdf-lib 로딩 실패. 인터넷 연결 확인.');
  const srcDoc = await PDFLib.PDFDocument.load(arrayBuffer);
  const totalPages = srcDoc.getPageCount();

  const chunks = [];
  for (let start = 0; start < totalPages; start += PDF_CHUNK_PAGES) {
    const end = Math.min(start + PDF_CHUNK_PAGES, totalPages);
    chunks.push({ start: start + 1, end, range: [start, end] });
  }
  showStats({ pages: totalPages, chunks: chunks.length, units: 0, passages: 0 });
  showProgress(5, `총 ${totalPages}쪽 → ${chunks.length}개 청크`);

  const merged = {};
  for (let i = 0; i < chunks.length; i++) {
    if (pdfImportState.abort) throw new Error('사용자 취소');
    const c = chunks[i];
    const baseRatio = i / chunks.length;
    const nextRatio = (i + 1) / chunks.length;
    showProgress(5 + Math.round(baseRatio * 90), `청크 ${i + 1}/${chunks.length} 분석 중 (${c.start}~${c.end}쪽)`);

    const newDoc = await PDFLib.PDFDocument.create();
    const idx = []; for (let p = c.range[0]; p < c.range[1]; p++) idx.push(p);
    const copied = await newDoc.copyPages(srcDoc, idx);
    copied.forEach(p => newDoc.addPage(p));
    const bytes = await newDoc.save();
    const base64 = bytesToBase64(bytes);

    const json = await callClaudePdf(base64, i + 1, chunks.length, c.start, c.end);
    mergeUnits(merged, json);
    showStats({ pages: totalPages, chunks: chunks.length, units: Object.keys(merged).length, passages: countPassages(merged) });
    showProgress(5 + Math.round(nextRatio * 90), `청크 ${i + 1}/${chunks.length} 완료`);
    renderPreview(merged, false);
  }
  showProgress(100, '완료');
  return merged;
}

// ── 텍스트 모드 (로컬 파서, AI 호출 없음) ──────────────────────
async function runTextMode(bookName) {
  const text = (document.getElementById('pdfImportText')?.value || '').trim();
  if (!text) throw new Error('텍스트를 입력하세요.');
  if (text.length < 50) throw new Error('텍스트가 너무 짧습니다 (최소 50자).');

  showProgress(20, '텍스트 파싱 중…');
  const merged = parseStructuredText(text);
  const units = Object.keys(merged).length;
  const passages = countPassages(merged);

  if (!passages) {
    throw new Error('지문을 인식하지 못했습니다. 단원/번호 표기를 확인하세요.\n(예: "01회" 헤더, "1." 또는 "1번" 으로 시작하는 줄)');
  }

  showStats({ pages: 0, chunks: 1, units, passages });
  showProgress(100, `완료 — 단원 ${units}개 / 지문 ${passages}개`);
  return merged;
}

// 사용자가 붙여넣은 구조화된 텍스트를 단원/지문 객체로 파싱
//   허용 단원 헤더:    "01회", "1회", "Lesson 1", "Day 3", "Unit 2", "Part 1", "1강", "Chapter 5", "=== 1회 ==="
//   허용 지문 마커:    "1.", "01.", "1)", "1번", "1번.", "[1]", "(1)", "Q1.", "#1"
//   허용 합쳐진 헤더:  "8회 1번", "Lesson 5 3번", "11회 9-10번" (단원+번호 한 줄)
function parseStructuredText(text) {
  // 정규화: 모든 줄바꿈 통일, BOM 제거
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n');

  // 단원 헤더 — 줄 전체가 헤더 패턴이어야 (오탐 방지)
  const unitRe = /^\s*(?:={2,}\s*)?(?:(\d{1,3})\s*회|(?:Lesson|Day|Unit|Part|Chapter|PART|UNIT|LESSON|DAY|CHAPTER)\s+(\d{1,3})|(\d{1,3})\s*강|(\d{1,3})\s*과|(?:제|第)\s*(\d{1,3})\s*(?:회|강|과|장)|(\d{1,3})\s*-?\s*회차)(?:\s*={2,})?\s*$/;

  // 합쳐진 헤더 — "X회 Y번", "X회 Y-Z번", "Lesson X Y번", "X강 Y번" 등 (한 줄에 단원+번호)
  const combinedRe = /^\s*(?:(\d{1,3})\s*회|(?:Lesson|Day|Unit|Part|Chapter)\s+(\d{1,3})|(\d{1,3})\s*강|(\d{1,3})\s*과|(?:제|第)\s*(\d{1,3})\s*(?:회|강|과|장))\s+(\d{1,3}(?:\s*-\s*\d{1,3})?)\s*번\.?\s*$/i;

  // 지문 마커 — 줄 시작에서만, 본문 본격 시작 전 토큰
  const numRe = /^\s*(?:\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3})\s*번\.?|(\d{1,3})\s*[\.\)]|Q\s*(\d{1,3})\s*\.?|#\s*(\d{1,3}))\s+/i;

  const result = {};
  let curUnit = '본문';
  let curNum = null;
  let buffer = [];

  function flush() {
    if (curNum != null && buffer.length) {
      const txt = buffer.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (txt) {
        if (!result[curUnit]) result[curUnit] = {};
        // curNum 이 문자열이면 그대로 (예: "9-10"), 숫자면 zero-pad
        const key = (typeof curNum === 'number') ? String(curNum).padStart(2, '0') : String(curNum);
        // 같은 (단원, 번호) 가 이미 있으면 더 긴 쪽 유지
        if (!result[curUnit][key] || result[curUnit][key].length < txt.length) {
          result[curUnit][key] = txt;
        }
      }
    }
    buffer = [];
  }

  for (let raw of lines) {
    const line = raw.trimEnd();
    // 빈 줄: 현재 지문 본문에 보존 (단락 구분)
    if (!line.trim()) {
      if (curNum) buffer.push('');
      continue;
    }

    // 합쳐진 헤더? "8회 1번" / "Lesson 5 3번" / "11회 9-10번"
    const combinedMatch = line.match(combinedRe);
    if (combinedMatch) {
      flush();
      const unitNum = combinedMatch[1] || combinedMatch[2] || combinedMatch[3] || combinedMatch[4] || combinedMatch[5];
      const passageNum = combinedMatch[6];
      // 단원 라벨 결정 — 한국식 "X회" 와 영문 "Lesson X" 구분
      if (combinedMatch[2]) {
        // 영문 패턴 — 헤더 텍스트에서 형식 추출
        const m = line.match(/^\s*(Lesson|Day|Unit|Part|Chapter)\s+(\d{1,3})/i);
        curUnit = m ? `${m[1]} ${m[2]}` : `${unitNum}`;
      } else if (combinedMatch[3]) {
        curUnit = `${unitNum}강`;
      } else if (combinedMatch[4]) {
        curUnit = `${unitNum}과`;
      } else {
        curUnit = `${unitNum}회`;
      }
      // 번호 — 범위(9-10)면 문자열 그대로, 단일이면 정수
      if (/-/.test(passageNum)) {
        curNum = passageNum.replace(/\s+/g, '');
      } else {
        curNum = parseInt(passageNum, 10);
      }
      continue;
    }

    // 단원 헤더?
    const unitMatch = line.match(unitRe);
    if (unitMatch) {
      flush();
      const numHit = unitMatch[1] || unitMatch[2] || unitMatch[3] || unitMatch[4] || unitMatch[5] || unitMatch[6];
      const cleaned = line.replace(/^=+\s*/, '').replace(/\s*=+$/, '').trim();
      curUnit = cleaned || (numHit ? `${numHit}회` : '본문');
      curNum = null;
      continue;
    }

    // 지문 번호 마커?
    const numMatch = line.match(numRe);
    if (numMatch) {
      flush();
      const n = numMatch[1] || numMatch[2] || numMatch[3] || numMatch[4] || numMatch[5] || numMatch[6];
      curNum = parseInt(n, 10);
      // 마커 뒤 같은 줄에 본문이 있으면 첫 줄로 사용
      const rest = line.replace(numRe, '').trim();
      if (rest) buffer.push(rest);
      continue;
    }

    // 일반 본문 라인 — 현재 지문이 시작된 상태일 때만 누적
    if (curNum) buffer.push(line);
    // 마커 없는 첫 본문 — 단원 직후 첫 줄을 1번으로 자동 시작
    else if (curUnit && !buffer.length) {
      curNum = 1;
      buffer.push(line);
    }
  }
  flush();
  return result;
}

// ── Claude 호출 (PDF) ──────────────────────────────────────────
async function callClaudePdf(pdfBase64, chunkIdx, chunkTotal, startPage, endPage) {
  const r = await fetch('/api/claude-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pdfBase64,
      system: buildExtractionSystemPrompt(),
      userMessage: buildExtractionUserPrompt({ chunkIdx, chunkTotal, startPage, endPage, kind: 'pdf' }),
      model: 'claude-sonnet-4-5'
    })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`API ${r.status}: ${err.error || r.statusText}`);
  }
  const { text } = await r.json();
  return parseJsonResponse(text);
}

function buildExtractionSystemPrompt() {
  return `당신은 한국 영어 교재에서 영어 지문을 추출하는 전문가입니다.
정답이 파란 글씨로 표시된 교사용 본책일 수 있습니다. 정답을 본문에 반영하여 완결된 영어 지문으로 복원하세요.
출력은 반드시 JSON 객체 하나뿐이며, 그 외 어떤 설명/주석/코드펜스도 포함하지 마세요.`;
}

function buildExtractionUserPrompt({ chunkIdx, chunkTotal, startPage, endPage, kind }) {
  const range = kind === 'pdf' ? `${chunkIdx}/${chunkTotal} 청크 (${startPage}~${endPage}쪽)` : `${chunkIdx}/${chunkTotal} 청크`;
  return `이 ${kind === 'pdf' ? 'PDF' : '텍스트'} (${range}) 안의 영어 지문을 모두 추출하세요.

[추출 규칙]
1. 단원/회차 구조를 식별 (예: "01회", "Lesson 1", "Day 3", "Unit 2").
2. 각 지문 번호와 본문을 그대로 추출.
3. 정답을 반영하여 완결된 영어 본문으로 복원:
   - 빈칸 추론: 정답 단어/구를 빈칸에 채워 원문 복원
   - 글의 순서 (A)(B)(C): 정답 순서대로 단락 재배열
   - 문장삽입: 보기로 주어진 문장을 정답 위치에 삽입
   - 어법/어휘: ① ② ③ 마커 제거, 정답이 있으면 정답 표현으로 교체
   - 흐름상 어색한 문장 삭제: 정답(=어색한 문장)을 본문에서 제거
   - 그 외 (제목/주제/요지/내용일치/심경 등): 본문 그대로
4. 한국어 해설/문제 발문/선지/주제문 마커/저작권 표시는 제외.
5. 같은 지문이 두 번 추출되지 않도록 주의.

[출력 형식 — JSON 객체만, 다른 텍스트 절대 없이]
{
  "단원명1": {
    "01": "passage text...",
    "02": "..."
  },
  "단원명2": { ... }
}

* 단원명: 자료 표기 그대로 ("01회", "Lesson 1" 등). 단원 표기가 없으면 "본문" 한 단원으로 묶을 것.
* 지문 번호: 두 자리 문자열 ("01", "02", ...).
* 지문 텍스트: 영어 원문만, 줄바꿈은 \\n.
* 추출할 지문이 없으면 {} 만 반환.`;
}

function parseJsonResponse(text) {
  if (!text) return {};
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const i = s.indexOf('{'); const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return {};
  try { return JSON.parse(s.slice(i, j + 1)); }
  catch (e) { console.warn('[pdf-import] JSON parse failed:', e, s.slice(0, 300)); return {}; }
}

function mergeUnits(target, src) {
  if (!src || typeof src !== 'object') return;
  for (const [unit, items] of Object.entries(src)) {
    if (!items || typeof items !== 'object') continue;
    if (!target[unit]) target[unit] = {};
    for (const [num, passage] of Object.entries(items)) {
      if (typeof passage !== 'string' || !passage.trim()) continue;
      if (target[unit][num] && target[unit][num].length > passage.length) continue;
      target[unit][num] = passage.trim();
    }
  }
}

function countPassages(merged) {
  let n = 0;
  for (const u of Object.values(merged || {})) n += Object.keys(u).length;
  return n;
}

// ── 저장 / BOOKS 머지 ─────────────────────────────────────────
//   Firestore (collection: 'imported_books') = 영구 저장 (모든 기기 공유)
//   localStorage = 오프라인 캐시 + 부팅 즉시 머지용
//   BOOKS 객체 = 런타임 메모리 (변형문제·꼼꼼분석 등이 참조)
async function saveImportedBook(bookName, units) {
  // 1) 메모리 + localStorage 즉시 반영 (Firestore 실패해도 현재 세션은 동작)
  const all = loadImportedBooks();
  all[bookName] = units;
  localStorage.setItem(PDF_IMPORT_LS_KEY, JSON.stringify(all));
  if (typeof BOOKS !== 'undefined') {
    BOOKS[bookName] = units;
    refreshBookSelectorsAfterImport(bookName);
  }
  // 2) Firestore 영구 저장 (로그인 + Firestore SDK 사용 가능 시)
  try {
    if (typeof db !== 'undefined' && currentUser) {
      const docId = sanitizeDocId(bookName);
      await db.collection('imported_books').doc(docId).set({
        name: bookName,
        units,
        ownerUid: currentUser.uid,
        ownerEmail: currentUser.email || null,
        unitCount: Object.keys(units).length,
        passageCount: countPassages(units),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log('[pdf-import] Firestore 저장 완료:', bookName);
    } else {
      console.warn('[pdf-import] Firestore 미사용 (로그인 안 됨 또는 SDK 없음) — localStorage 만 사용');
    }
  } catch (e) {
    console.error('[pdf-import] Firestore 저장 실패 (localStorage 는 정상):', e);
    // 사용자에겐 부분 성공 알림
    showStatus(`✅ 로컬 저장 완료, 단 Firestore 동기화 실패 (${e.message}). 다른 기기에선 보이지 않을 수 있음.`, 'err');
  }
}

function sanitizeDocId(name) {
  // Firestore 문서 ID 제약 회피 — / 와 일부 특수문자 제외
  return String(name).replace(/[\/\.\#\$\[\]]/g, '_').slice(0, 1500);
}

function refreshBookSelectorsAfterImport(newBookName) {
  const sel = document.getElementById('selBook');
  if (sel && typeof BOOKS !== 'undefined') {
    const exists = Array.from(sel.options).some(o => o.value === newBookName);
    if (!exists) {
      const o = document.createElement('option');
      o.value = newBookName;
      o.textContent = newBookName;
      sel.appendChild(o);
    }
  }
  if (typeof initVariant === 'function') initVariant();
  if (typeof initWorkbook === 'function') initWorkbook();
  if (typeof initBatch === 'function') initBatch();
}

function loadImportedBooks() {
  try { return JSON.parse(localStorage.getItem(PDF_IMPORT_LS_KEY) || '{}'); }
  catch { return {}; }
}

async function deleteImportedBook(bookName) {
  if (!confirm(`"${bookName}" 을(를) 삭제할까요? (모든 기기에서 등록된 모든 지문 삭제)`)) return;
  // localStorage / BOOKS / select 즉시 정리
  const all = loadImportedBooks();
  delete all[bookName];
  localStorage.setItem(PDF_IMPORT_LS_KEY, JSON.stringify(all));
  if (typeof BOOKS !== 'undefined') delete BOOKS[bookName];
  const sel = document.getElementById('selBook');
  if (sel) Array.from(sel.options).forEach(o => { if (o.value === bookName) o.remove(); });
  renderImportedBooksList();
  // Firestore 삭제
  try {
    if (typeof db !== 'undefined' && currentUser) {
      await db.collection('imported_books').doc(sanitizeDocId(bookName)).delete();
      console.log('[pdf-import] Firestore 삭제 완료:', bookName);
    }
  } catch (e) {
    console.error('[pdf-import] Firestore 삭제 실패:', e);
    alert('Firestore 삭제 실패: ' + e.message + '\n로컬에선 삭제됐지만 다른 기기에선 다시 나타날 수 있음.');
  }
}

function exportImportedBookJs(bookName) {
  const all = loadImportedBooks();
  const data = all[bookName];
  if (!data) return;
  const slug = bookName.replace(/[^a-zA-Z0-9가-힣]/g, '-').replace(/-+/g, '-').toLowerCase();
  const varName = 'DB_IMPORTED_' + slug.replace(/-/g, '_').toUpperCase();
  const js = `// 자동 생성 — "${bookName}"\nconst ${varName} = ${JSON.stringify(data, null, 2)};\n\n// js/app.js 의 BOOKS 에 추가:\n//   '${bookName}': ${varName}\n`;
  const blob = new Blob([js], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `db-${slug}.js`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function mergeImportedBooksIntoRegistry() {
  if (typeof BOOKS === 'undefined') return;
  const imported = loadImportedBooks();
  for (const [name, units] of Object.entries(imported)) {
    BOOKS[name] = units;
  }
}

// 로그인 후 Firestore 에서 최신본 불러와 BOOKS 갱신
async function syncImportedBooksFromFirestore() {
  if (typeof db === 'undefined' || !currentUser) return;
  try {
    const snap = await db.collection('imported_books').get();
    const fresh = {};
    snap.forEach(doc => {
      const d = doc.data();
      if (d && d.name && d.units) fresh[d.name] = d.units;
    });
    if (!Object.keys(fresh).length) return;
    // localStorage / BOOKS 모두 갱신
    localStorage.setItem(PDF_IMPORT_LS_KEY, JSON.stringify(fresh));
    if (typeof BOOKS !== 'undefined') {
      // 기존 imported book 들 (localStorage 기반) 삭제 후 fresh 로 교체
      const oldLocal = loadImportedBooks();
      Object.keys(oldLocal).forEach(name => {
        if (BOOKS[name] && !fresh[name]) delete BOOKS[name];
      });
      Object.assign(BOOKS, fresh);
    }
    // selBook 옵션 동기화 + 패널 재초기화
    const sel = document.getElementById('selBook');
    if (sel) {
      Object.keys(fresh).forEach(name => {
        if (!Array.from(sel.options).some(o => o.value === name)) {
          const o = document.createElement('option');
          o.value = name; o.textContent = name; sel.appendChild(o);
        }
      });
    }
    if (typeof initVariant === 'function') initVariant();
    if (typeof initWorkbook === 'function') initWorkbook();
    if (typeof initBatch === 'function') initBatch();
    // 만약 PDF 등록 패널이 열려있다면 리스트 새로고침
    renderImportedBooksList();
    console.log('[pdf-import] Firestore 에서', Object.keys(fresh).length, '권 동기화 완료');
  } catch (e) {
    console.error('[pdf-import] Firestore 동기화 실패:', e);
  }
}

// authready 이벤트 → Firestore 동기화
if (typeof window !== 'undefined') {
  window.addEventListener('authready', () => {
    syncImportedBooksFromFirestore();
  });
}

// ── UI: 진행 / 상태 / 통계 ────────────────────────────────────
function showProgress(percent, label) {
  const p = document.getElementById('pdfImportProgress');
  const fill = document.getElementById('pdfImportProgressFill');
  const lbl = document.getElementById('pdfImportProgressLabel');
  const cnt = document.getElementById('pdfImportProgressCount');
  if (!p) return;
  p.classList.add('show');
  if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  if (lbl) lbl.textContent = label || '';
  if (cnt) cnt.textContent = Math.round(percent) + '%';
}

function hideProgress() {
  const p = document.getElementById('pdfImportProgress');
  if (p) p.classList.remove('show');
}

function showStatus(msg, kind) {
  const s = document.getElementById('pdfImportStatus');
  const t = document.getElementById('pdfImportStatusText');
  if (!s || !t) return;
  s.classList.remove('info', 'ok', 'err');
  s.classList.add('show', kind || 'info');
  t.textContent = msg;
  // 아이콘 변경
  const iconEl = s.querySelector('.pdfimp-status-icon');
  if (iconEl) {
    if (kind === 'ok')      iconEl.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
    else if (kind === 'err') iconEl.innerHTML = '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';
    else                     iconEl.innerHTML = '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>';
  }
}

function hidePreviewAndStatus() {
  document.getElementById('pdfImportStatus')?.classList.remove('show');
  document.getElementById('pdfImportStats').style.display = 'none';
  document.getElementById('pdfImportPreviewWrap').style.display = 'none';
}

function showStats({ pages, chunks, units, passages }) {
  document.getElementById('pdfImportStats').style.display = '';
  if (typeof pages === 'number')    document.getElementById('statPages').textContent    = pages.toLocaleString();
  if (typeof chunks === 'number')   document.getElementById('statChunks').textContent   = chunks.toLocaleString();
  if (typeof units === 'number')    document.getElementById('statUnits').textContent    = units.toLocaleString();
  if (typeof passages === 'number') document.getElementById('statPassages').textContent = passages.toLocaleString();
}

function toggleButtons(running) {
  const run = document.getElementById('pdfImportRunBtn');
  const cancel = document.getElementById('pdfImportCancelBtn');
  if (run) run.disabled = running;
  if (cancel) cancel.style.display = running ? '' : 'none';
}

// ── UI: 미리보기 ───────────────────────────────────────────────
function renderPreview(merged, autoExpandAll) {
  const wrap = document.getElementById('pdfImportPreviewWrap');
  const body = document.getElementById('pdfImportPreview');
  if (!wrap || !body) return;
  const units = Object.keys(merged || {});
  if (!units.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  body.innerHTML = units.map(unit => {
    const items = merged[unit] || {};
    const nums = Object.keys(items);
    const expanded = autoExpandAll || pdfImportState.expandedUnits.has(unit);
    const passages = nums.map(num => {
      const passage = items[num] || '';
      const head = passage.replace(/\s+/g, ' ').slice(0, 140);
      return `<div class="pdfimp-passage" title="${escHtml(passage.slice(0, 500))}"><span class="num">${escHtml(num)}.</span> ${escHtml(head)}${passage.length > 140 ? '…' : ''}</div>`;
    }).join('');
    return `<div class="pdfimp-unit ${expanded ? 'open' : ''}" data-unit="${escHtml(unit)}">
      <div class="pdfimp-unit-head" onclick="togglePdfImportUnit(this)">
        <span>📖 ${escHtml(unit)}</span>
        <span class="count">지문 ${nums.length}개</span>
      </div>
      <div class="pdfimp-unit-body">${passages}</div>
    </div>`;
  }).join('');
}

function togglePdfImportUnit(headEl) {
  const unitEl = headEl.parentElement;
  const unitName = unitEl.dataset.unit;
  unitEl.classList.toggle('open');
  if (unitEl.classList.contains('open')) pdfImportState.expandedUnits.add(unitName);
  else pdfImportState.expandedUnits.delete(unitName);
}

// ── UI: 등록된 자료 리스트 ────────────────────────────────────
function renderImportedBooksList() {
  const el = document.getElementById('pdfImportBooksList');
  if (!el) return;
  const all = loadImportedBooks();
  const names = Object.keys(all);
  if (!names.length) {
    el.innerHTML = '<div class="pdfimp-book-empty">아직 등록된 자료가 없습니다. PDF 를 업로드하거나 텍스트를 붙여넣어 시작하세요.</div>';
    return;
  }
  el.innerHTML = '<div class="pdfimp-books-list">' + names.map(name => {
    const cnt = countPassages(all[name]);
    const units = Object.keys(all[name]).length;
    const safeName = JSON.stringify(name).replace(/"/g, '&quot;');
    return `<div class="pdfimp-book-row">
      <div class="pdfimp-book-info">
        <div class="pdfimp-book-name">📚 ${escHtml(name)}</div>
        <div class="pdfimp-book-meta">단원 ${units}개 · 지문 ${cnt}개</div>
      </div>
      <div class="pdfimp-book-actions">
        <button class="pdfimp-btn-ghost" style="height:36px;padding:0 12px;font-size:12px" onclick="exportImportedBookJs(${safeName})">JS 내보내기</button>
        <button class="pdfimp-btn-ghost" style="height:36px;padding:0 12px;font-size:12px" onclick="deleteImportedBook(${safeName})">삭제</button>
      </div>
    </div>`;
  }).join('') + '</div>';
}

// ── 유틸 ──────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// 부팅 시 자동 머지
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    mergeImportedBooksIntoRegistry();
  });
}
