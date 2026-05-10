// ── 공용 PDF 빌더 (워크북/변형문제/해설지 공용) ──
// html2canvas + jsPDF 기반. A4 세로, 헤더/푸터/페이지번호 포함.
//
// 사용법:
//   const pdf = await buildPdfFromSections([
//     { html: '<h1>...</h1>' },
//     { html: '<div>...</div>', pageBreakBefore: true }
//   ], {
//     title: '워크북 · 수능특강 영어',
//     subtitle: 'Unit 1 · 빈칸(상)',
//     filename: 'workbook.pdf',
//     headerText: '송유근 영어',
//     footerText: '최고의 강의 & 철저한 관리',
//     answerKey: [ { html: '<div>해설지 내용</div>' } ]  // 선택
//   });
//   pdf.save();                  // 다운로드
//   // 또는 pdf.blob 로 Blob 접근 가능

async function buildPdfFromSections(sections, options = {}) {
  if (typeof html2canvas === 'undefined' || !window.jspdf) {
    throw new Error('PDF 라이브러리를 불러오지 못했습니다.');
  }
  const opts = Object.assign({
    title: '',
    subtitle: '',
    filename: 'document.pdf',
    headerText: '송유근 영어',
    footerText: '최고의 강의 & 철저한 관리',
    answerKey: null,
    answerKeyTitle: '정답 및 해설',
    columns: 1,           // 1단 또는 2단 (변형문제는 2단)
    columnGutter: 6,      // 단 사이 간격 (mm)
    atomicSections: false, // true 이면 섹션을 단/페이지 경계로 슬라이스하지 않고 통째로 옮김
    logoSrc: ''            // 로고 이미지 경로 (첫 페이지 제목 옆에 삽입)
  }, options);

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

  // A4 상수
  const pageWidth = 210;
  const pageHeight = 297;
  const marginX = 12;
  const marginY = 15;
  const subHdrReserve = 9;
  const footerReserve = 10;
  const contentWidth = pageWidth - (marginX * 2); // 186mm
  const bottomLimit = pageHeight - marginY - footerReserve;
  const newPageStartY = marginY + subHdrReserve;

  // 다단 구성
  const colCount = Math.max(1, parseInt(opts.columns, 10) || 1);
  const gutter = colCount > 1 ? opts.columnGutter : 0;
  const colWidth = (contentWidth - gutter * (colCount - 1)) / colCount; // mm per column
  // 단 폭에 비례하는 캡처 폭 (px). 1단=750px 기준으로 스케일
  const baseCaptureWidth = 750;
  const captureWidth = colCount === 1 ? baseCaptureWidth : Math.round(baseCaptureWidth * (colWidth / contentWidth));

  // 오프스크린 컨테이너
  const container = document.createElement('div');
  container.style.cssText = `position:absolute;left:-9999px;top:0;width:${baseCaptureWidth}px;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
  document.body.appendChild(container);

  const canvasOpts = { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true };

  // width = 캡처할 폭(px). 섹션 html을 폭에 맞춰 캡처
  const captureHtml = async (html, widthPx = captureWidth) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = `width:${widthPx}px;background:#fff;padding:0;box-sizing:border-box`;
    wrap.innerHTML = html;
    container.appendChild(wrap);
    const c = await html2canvas(wrap, canvasOpts);
    // 실제 배치되는 mm 폭 기준으로 heightMm 계산
    const targetWmm = widthPx === captureWidth ? colWidth : contentWidth;
    const out = {
      dataUrl: c.toDataURL('image/jpeg', 0.92),
      heightMm: targetWmm * (c.height / c.width),
      widthMm: targetWmm
    };
    container.removeChild(wrap);
    return out;
  };

  // 단별 Y 추적
  // colYs[i] : i번 단의 다음 배치 Y (mm). 페이지 전체에 걸친 fullWidth 밴드 위에는 모두 동일 Y.
  // topY : 현재 페이지에서 본문이 시작되는 Y (fullWidth 밴드가 추가되면 올라감)
  let topY = marginY;                                    // 1페이지는 marginY부터 (헤더 없음)
  let colYs = Array.from({ length: colCount }, () => topY);
  let currentCol = 0;
  let onFirstPage = true;

  const colX = (col) => marginX + col * (colWidth + gutter);

  const startNewPage = () => {
    pdf.addPage();
    onFirstPage = false;
    topY = newPageStartY;
    colYs = Array.from({ length: colCount }, () => topY);
    currentCol = 0;
  };

  const advanceColumnOrPage = () => {
    if (colCount > 1 && currentCol < colCount - 1) {
      currentCol += 1;
    } else {
      startNewPage();
    }
  };

  // 한 단에 사용 가능한 최대 높이 (newPage 이후 기준)
  const usableColumnHeight = bottomLimit - newPageStartY;

  // 큰 섹션은 세로로 슬라이스해서 여러 단/페이지로 흘려보낸다
  // placeOpts.atomic === true 이면 슬라이스를 피하고 단/페이지만 이동.
  // 섹션이 한 단보다도 큰 경우에만 폴백 슬라이스.
  const placeImage = async (img, gap = 3, placeOpts = {}) => {
    const atomic = placeOpts.atomic === true;
    // 현재 단에 완전히 들어갈 때
    const yNow = colYs[currentCol];
    const xMm = colX(currentCol);

    if (yNow + img.heightMm <= bottomLimit) {
      pdf.addImage(img.dataUrl, 'JPEG', xMm, yNow, img.widthMm, img.heightMm);
      colYs[currentCol] = yNow + img.heightMm + gap;
      return;
    }

    // atomic 모드: 한 단 전체에 들어갈 수 있으면 슬라이스 없이 단/페이지 이동
    if (atomic && img.heightMm <= usableColumnHeight) {
      advanceColumnOrPage();
      return placeImage(img, gap, placeOpts);
    }

    // 남은 공간이 거의 없으면 단/페이지 이동 후 재시도
    const remaining = bottomLimit - yNow;
    if (remaining < 20) {
      advanceColumnOrPage();
      return placeImage(img, gap, placeOpts);
    }

    // 섹션 자체가 한 단 높이보다 큰 경우: 이미지 슬라이스 (폴백)
    const sliceHmm = remaining;
    const fullImg = new Image();
    fullImg.src = img.dataUrl;
    await new Promise((res, rej) => { fullImg.onload = res; fullImg.onerror = rej; });
    const sliceRatio1 = sliceHmm / img.heightMm;
    const slice1Hpx = Math.floor(fullImg.naturalHeight * sliceRatio1);
    const slice2Hpx = fullImg.naturalHeight - slice1Hpx;

    const cv1 = document.createElement('canvas');
    cv1.width = fullImg.naturalWidth;
    cv1.height = slice1Hpx;
    cv1.getContext('2d').drawImage(fullImg, 0, 0);
    pdf.addImage(cv1.toDataURL('image/jpeg', 0.92), 'JPEG', xMm, yNow, img.widthMm, sliceHmm);
    colYs[currentCol] = yNow + sliceHmm + gap;

    if (slice2Hpx <= 0) return;
    advanceColumnOrPage();

    const cv2 = document.createElement('canvas');
    cv2.width = fullImg.naturalWidth;
    cv2.height = slice2Hpx;
    cv2.getContext('2d').drawImage(fullImg, 0, -slice1Hpx);
    const slice2Hmm = img.widthMm * (slice2Hpx / fullImg.naturalWidth);
    const remaining2 = { dataUrl: cv2.toDataURL('image/jpeg', 0.92), heightMm: slice2Hmm, widthMm: img.widthMm };
    await placeImage(remaining2, gap, placeOpts);
  };

  // fullWidth 섹션 — 모든 단에 걸쳐 배치. 현재 단이 과도하게 찼으면 새 페이지.
  const placeFullWidth = async (html, gap = 4) => {
    const img = await captureHtml(html, baseCaptureWidth);
    // 모든 단 중 가장 낮게 내려간 위치를 기준선으로 삼아 밴드 배치
    const bandY = Math.max(...colYs);
    if (bandY + img.heightMm > bottomLimit) {
      startNewPage();
      return placeFullWidth(html, gap);
    }
    pdf.addImage(img.dataUrl, 'JPEG', marginX, bandY, contentWidth, img.heightMm);
    // 모든 단의 Y를 밴드 아래로 동기화
    const newY = bandY + img.heightMm + gap;
    colYs = colYs.map(() => newY);
    currentCol = 0;
  };

  // ── 로고 이미지 로드 (옵션) ──
  let logoDataUrl = null;
  let logoWidthMm = 34;
  let logoHeightMm = 0;
  if (opts.logoSrc) {
    try {
      const logoImg = new Image();
      logoImg.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        logoImg.onload = resolve;
        logoImg.onerror = reject;
        logoImg.src = opts.logoSrc;
      });
      logoHeightMm = logoWidthMm * (logoImg.naturalHeight / logoImg.naturalWidth);
      const lc = document.createElement('canvas');
      lc.width = logoImg.naturalWidth;
      lc.height = logoImg.naturalHeight;
      lc.getContext('2d').drawImage(logoImg, 0, 0);
      logoDataUrl = lc.toDataURL('image/png');
    } catch (e) {
      console.warn('[pdf-export] 로고 로드 실패:', e);
    }
  }

  // ── 1페이지: 제목 헤더 (전폭) ──
  if (opts.title || opts.subtitle) {
    const titleHtml = `
      <div style="padding:4px 0 10px 0;border-bottom:2px solid #1a1a1a;margin-bottom:8px">
        ${opts.title ? `<div style="font-size:22px;font-weight:800;color:#1a1a1a;letter-spacing:-0.3px">${escapeHtmlPdf(opts.title)}</div>` : ''}
        ${opts.subtitle ? `<div style="font-size:13px;color:#555;font-weight:600;margin-top:4px">${escapeHtmlPdf(opts.subtitle)}</div>` : ''}
      </div>
    `;
    await placeFullWidth(titleHtml, 4);

    // 로고를 제목 헤더가 있는 페이지(문제 첫 페이지) 우측 상단에 삽입
    if (logoDataUrl) {
      const titlePage = pdf.internal.getNumberOfPages();
      pdf.setPage(titlePage);
      pdf.addImage(logoDataUrl, 'PNG', pageWidth - marginX - logoWidthMm, marginY, logoWidthMm, logoHeightMm);
    }
  }

  // ── 본문 섹션들 ──
  const bodyAtomic = { atomic: !!opts.atomicSections };
  for (const sec of sections) {
    if (!sec || !sec.html) continue;
    if (sec.pageBreakBefore) {
      // 이미 새 페이지 최상단이면 스킵
      const atTop = colYs.every(y => y <= topY + 2);
      if (!atTop) startNewPage();
    }
    if (sec.fullWidth) {
      await placeFullWidth(sec.html);
    } else {
      const img = await captureHtml(sec.html);
      const secAtomic = (sec.atomic === false) ? { atomic: false } : (sec.atomic === true ? { atomic: true } : bodyAtomic);
      await placeImage(img, 3, secAtomic);
    }
    // Round 8: pageBreakAfter — 섹션 렌더 직후 새 페이지
    if (sec.pageBreakAfter) {
      const atTop = colYs.every(y => y <= topY + 2);
      if (!atTop) startNewPage();
    }
  }

  // ── 해설지 ──
  if (opts.answerKey && Array.isArray(opts.answerKey) && opts.answerKey.length) {
    startNewPage();
    const sepHtml = `
      <div style="padding:30px 0 20px 0;text-align:center">
        <div style="display:inline-block;padding:10px 30px;border:2px solid #1a1a1a;border-radius:8px">
          <div style="font-size:20px;font-weight:800;color:#1a1a1a;letter-spacing:2px">${escapeHtmlPdf(opts.answerKeyTitle)}</div>
        </div>
      </div>
    `;
    await placeFullWidth(sepHtml, 6);

    for (const sec of opts.answerKey) {
      if (!sec || !sec.html) continue;
      if (sec.pageBreakBefore) {
        const atTop = colYs.every(y => y <= topY + 2);
        if (!atTop) startNewPage();
      }
      if (sec.fullWidth) {
        await placeFullWidth(sec.html);
      } else {
        const img = await captureHtml(sec.html);
        const secAtomic = (sec.atomic === false) ? { atomic: false } : (sec.atomic === true ? { atomic: true } : bodyAtomic);
        await placeImage(img, 3, secAtomic);
      }
      if (sec.pageBreakAfter) {
        const atTop = colYs.every(y => y <= topY + 2);
        if (!atTop) startNewPage();
      }
    }
  }

  // ── 헤더/푸터 캡처 (한 번만, 전폭) ──
  const subHdrHtml = `
    <div style="width:${baseCaptureWidth}px;padding:3px 0 6px;border-bottom:1.5px solid #bbb">
      <span style="font-size:12px;color:#555;font-weight:700;letter-spacing:0.02em">
        ${opts.subtitle ? `${escapeHtmlPdf(opts.title)} <span style="color:#aaa;margin:0 8px">·</span> ${escapeHtmlPdf(opts.subtitle)}` : escapeHtmlPdf(opts.title)}
      </span>
    </div>
  `;
  const subHdrImg = await captureHtml(subHdrHtml, baseCaptureWidth);

  const ftrHtml = `
    <div style="width:${baseCaptureWidth}px;padding:6px 0 0;border-top:1.5px solid #bbb;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:11px;color:#666;font-weight:700">${escapeHtmlPdf(opts.headerText)}</span>
      <span style="font-size:11px;color:#666;font-weight:600">${escapeHtmlPdf(opts.footerText)}</span>
    </div>
  `;
  const ftrImg = await captureHtml(ftrHtml, baseCaptureWidth);

  const totalPages = pdf.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p);

    // 머릿말: 2페이지부터 (단, 해설지 첫 페이지는 별도 표시 생략)
    if (p > 1) {
      pdf.addImage(subHdrImg.dataUrl, 'JPEG', marginX, marginY - 2, contentWidth, subHdrImg.heightMm);
    }
    // 꼬릿말: 모든 페이지
    const ftrY = pageHeight - marginY + 2;
    pdf.addImage(ftrImg.dataUrl, 'JPEG', marginX, ftrY, contentWidth, ftrImg.heightMm);
    // 페이지 번호
    pdf.setFontSize(9);
    pdf.setTextColor(100, 100, 100);
    pdf.text(`- ${p} / ${totalPages} -`, pageWidth / 2, ftrY + ftrImg.heightMm + 3, { align: 'center' });
  }

  // 컨테이너 제거
  document.body.removeChild(container);

  // 반환 객체
  const out = {
    pdf,
    save(fname) {
      pdf.save(fname || opts.filename);
    },
    get blob() {
      return pdf.output('blob');
    }
  };
  return out;
}

function escapeHtmlPdf(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 파일명 안전화 (공용)
function safePdfFilename(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
}
