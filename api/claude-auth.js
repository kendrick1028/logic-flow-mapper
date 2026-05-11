// Claude CLI 인증 헬퍼 — UI 의 "Claude 연결" 버튼 백엔드
//   GET  ?action=status  → CLI 인증 상태 확인 (ok / not_logged_in / not_installed)
//   POST { action: 'login' } → claude setup-token 또는 /login 트리거 (OS 기본 브라우저 자동으로 열림)

import { spawn, exec } from 'child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.body && req.body.action) || req.query.action || 'status';

  try {
    if (action === 'status') {
      const result = await checkAuth();
      return res.status(200).json(result);
    }
    if (action === 'login') {
      const result = await startLogin();
      return res.status(200).json(result);
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[api/claude-auth] error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

// ── 인증 상태 확인 ──
//   claude -p 'ok' 한 번 호출 → 응답 "ok" 면 정상, "Not logged in" 또는 401 면 미인증
async function checkAuth() {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '1',
      'ok'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ status: 'timeout', message: 'claude CLI 응답 없음 (10초)' });
    }, 10_000);

    proc.stdout.on('data', d => { stdoutBuf += d.toString(); });
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });
    proc.on('error', err => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        resolve({ status: 'not_installed', message: 'claude CLI 가 설치되지 않았습니다.' });
      } else {
        resolve({ status: 'error', message: err.message });
      }
    });
    proc.on('close', code => {
      clearTimeout(timer);
      const combined = stdoutBuf + stderrBuf;
      if (/Not logged in|Invalid authentication|Please run \/login|401/i.test(combined)) {
        return resolve({ status: 'not_logged_in', message: '로그인 필요' });
      }
      if (code === 0 && stdoutBuf.length > 0) {
        return resolve({ status: 'ok', message: '인증됨' });
      }
      resolve({ status: 'error', message: `claude CLI 에러 (code ${code})`, detail: combined.slice(0, 200) });
    });
  });
}

// ── 로그인 트리거 ──
//   `claude setup-token` 을 백그라운드로 실행. CLI 가 브라우저 자동 열음.
//   서버는 즉시 응답하고, 클라이언트가 status 폴링으로 완료 감지.
async function startLogin() {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ['setup-token'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let urlCaptured = null;
    let resolved = false;
    const finishOnce = (data) => { if (!resolved) { resolved = true; resolve(data); } };

    proc.stdout.on('data', d => {
      const text = d.toString();
      stdoutBuf += text;
      // setup-token 이 인증 URL 출력하면 캡처해서 클라이언트로 반환 (브라우저 자동 열기용)
      const urlMatch = text.match(/(https?:\/\/[^\s]+(?:claude\.ai|anthropic\.com)[^\s]*)/i);
      if (urlMatch && !urlCaptured) {
        urlCaptured = urlMatch[1];
        finishOnce({ status: 'login_started', authUrl: urlCaptured, message: '브라우저에서 인증 진행 중...' });
      }
    });
    proc.stderr.on('data', d => {
      const text = d.toString();
      stderrBuf += text;
      const urlMatch = text.match(/(https?:\/\/[^\s]+(?:claude\.ai|anthropic\.com)[^\s]*)/i);
      if (urlMatch && !urlCaptured) {
        urlCaptured = urlMatch[1];
        finishOnce({ status: 'login_started', authUrl: urlCaptured, message: '브라우저에서 인증 진행 중...' });
      }
    });

    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        finishOnce({ status: 'not_installed', message: 'claude CLI 가 설치되지 않았습니다. npm i -g @anthropic-ai/claude-code 실행 필요.' });
      } else {
        finishOnce({ status: 'error', message: err.message });
      }
    });

    proc.on('close', code => {
      // URL 캡처 못 하고 즉시 종료된 경우
      const combined = stdoutBuf + stderrBuf;
      if (!urlCaptured) {
        if (code === 0) {
          finishOnce({ status: 'login_complete', message: '인증 완료' });
        } else {
          finishOnce({ status: 'error', message: `setup-token 실패 (code ${code})`, detail: combined.slice(0, 300) });
        }
      }
    });

    // 5초 후에도 URL 못 잡으면 그냥 응답 (CLI 가 브라우저 자체 열었을 수도)
    setTimeout(() => {
      finishOnce({ status: 'login_started', message: 'claude CLI 가 시작되었습니다. 브라우저에서 인증 진행하세요.' });
    }, 5000);
  });
}
