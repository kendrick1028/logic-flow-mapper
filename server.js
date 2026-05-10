// Logic Flow Mapper — 로컬 개발 서버 (Windows / macOS / Linux 공용)
// `vercel dev` 대신 Node 내장 모듈만으로 정적 파일 + /api/* 핸들러를 처리한다.
//
// 실행:  node server.js   (또는  npm start)
// 환경:
//   PORT                포트 (기본 3000)
//   CLAUDE_API_KEY      Anthropic API 키 (선택). 없으면 /api/claude 는 Claude CLI 로 폴백,
//                       /api/claude-pdf 는 사용 불가.
//   USE_CLAUDE_CODE=1   API 키가 있어도 Claude CLI 강제 사용
//   CLAUDE_BIN          claude 실행 파일 경로 (기본 'claude' / Windows 는 자동 'claude.cmd' 시도)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_WINDOWS = process.platform === 'win32';

// ── .env 자동 로드 (별도 의존성 없이) ──
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    if (m[1].startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadDotEnv();

// ── 정적 파일 서빙 ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // 디렉토리 트래버설 차단
  const normalized = path.normalize(urlPath).replace(/^[\\/]+/, '');
  const filePath = path.join(__dirname, normalized);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404); return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ── 요청 본문 JSON 파싱 ──
function readJson(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

// ── /api/claude — Claude CLI spawn (또는 Anthropic API) ──
const CLI_TIMEOUT_MS = 300_000;

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  return IS_WINDOWS ? 'claude.cmd' : 'claude';
}

async function callClaudeViaApi({ model, system, userMessage }) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('CLAUDE_API_KEY not configured');
  const body = {
    model: model || 'claude-sonnet-4-5',
    max_tokens: 8192,
    system: system || '',
    messages: [{ role: 'user', content: userMessage }]
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Claude API error');
  return { text: data.content?.[0]?.text || '', usage: data.usage || null, source: 'api-key' };
}

function callClaudeViaCli({ model, system, userMessage }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--max-turns', '1'
  ];
  if (system && String(system).trim()) args.push('--system-prompt', String(system));
  if (model) args.push('--model', model);
  args.push(userMessage);

  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '32000'
    };
    // Windows 의 .cmd shim 은 shell:true 가 필요. 그 외엔 직접 spawn.
    const proc = spawn(resolveClaudeBin(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      shell: IS_WINDOWS
    });
    let stdoutBuf = '', stderrBuf = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`claude CLI timeout (${CLI_TIMEOUT_MS}ms)`));
    }, CLI_TIMEOUT_MS);
    proc.stdout.on('data', d => { stdoutBuf += d.toString(); });
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });
    proc.on('error', err => {
      clearTimeout(timer);
      const e = new Error(`claude CLI 실행 실패: ${err.message}`);
      e.hint = `'claude' 명령어를 찾을 수 없습니다. Claude Code 가 설치되어 있는지(\`npm i -g @anthropic-ai/claude-code\`) PATH 에 있는지 확인하세요. 또는 .env 의 CLAUDE_BIN 에 절대경로 지정.`;
      reject(e);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      let text = '', usage = null, stopReason = null, initInfo = null, lastError = null;
      for (const line of stdoutBuf.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let msg; try { msg = JSON.parse(t); } catch { continue; }
        if (msg.type === 'system' && msg.subtype === 'init') initInfo = msg;
        else if (msg.type === 'assistant' && msg.message?.content) {
          for (const b of msg.message.content) if (b.type === 'text' && b.text) text += b.text;
          if (msg.message.usage) usage = msg.message.usage;
          if (msg.message.stop_reason) stopReason = msg.message.stop_reason;
        } else if (msg.type === 'result') {
          if (msg.usage) usage = msg.usage;
          if (msg.subtype === 'error' || msg.is_error) lastError = msg;
        }
      }
      if (code !== 0 || (!text && lastError)) {
        const errMsg = lastError?.error || stderrBuf || `claude CLI 종료 코드 ${code}`;
        const e = new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
        if (/Not logged in|Invalid authentication|401/i.test(stdoutBuf + stderrBuf)) {
          e.hint = '터미널에서 `claude` 실행 → `/login` 으로 OAuth 로그인 후 다시 시도하세요.';
        }
        return reject(e);
      }
      resolve({
        text, usage, stop_reason: stopReason, source: 'claude-cli',
        apiKeySource: initInfo?.apiKeySource || null,
        sessionId: initInfo?.session_id || null
      });
    });
  });
}

async function handleClaude(req, res) {
  let body;
  try { body = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: 'invalid JSON: ' + e.message }); }

  const { model, system, userMessage } = body || {};
  if (!userMessage) return sendJson(res, 400, { error: 'userMessage required' });

  const forceCli  = process.env.USE_CLAUDE_CODE === '1';
  const hasApiKey = !!process.env.CLAUDE_API_KEY;
  const useApiKey = !forceCli && hasApiKey;

  try {
    const result = useApiKey
      ? await callClaudeViaApi({ model, system, userMessage })
      : await callClaudeViaCli({ model, system, userMessage });
    sendJson(res, 200, result);
  } catch (e) {
    console.error('[api/claude] error:', e.message);
    sendJson(res, 500, { error: e.message, hint: e.hint, source: useApiKey ? 'api-key' : 'claude-cli' });
  }
}

// ── /api/claude-pdf — Anthropic API (CLAUDE_API_KEY 필요) ──
async function handleClaudePdf(req, res) {
  let body;
  try { body = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: 'invalid JSON: ' + e.message }); }

  const { pdfBase64, system, userMessage, model } = body || {};
  if (!pdfBase64)   return sendJson(res, 400, { error: 'pdfBase64 required' });
  if (!userMessage) return sendJson(res, 400, { error: 'userMessage required' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, {
      error: 'CLAUDE_API_KEY 가 설정되지 않았습니다. PDF 가져오기 기능은 Anthropic API 키가 필요합니다.',
      hint: '프로젝트 루트의 .env 파일에 CLAUDE_API_KEY=... 를 추가하고 서버를 재시작하세요. (.env.example 참고)'
    });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-5',
        max_tokens: 16000,
        system: system || '',
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: userMessage }
          ]
        }]
      })
    });
    const data = await r.json();
    if (!r.ok) return sendJson(res, r.status, { error: data.error?.message || 'Claude PDF API error' });
    sendJson(res, 200, { text: data.content?.[0]?.text || '', usage: data.usage || null });
  } catch (e) {
    console.error('[api/claude-pdf] error:', e.message);
    sendJson(res, 500, { error: e.message });
  }
}

// ── 라우터 ──
const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/api/claude'      && req.method === 'POST') return handleClaude(req, res);
  if (urlPath === '/api/claude-pdf'  && req.method === 'POST') return handleClaudePdf(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  console.log(`\n  Logic Flow Mapper`);
  console.log(`  ──────────────────────────────────────`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ Claude: ${process.env.CLAUDE_API_KEY ? 'Anthropic API key' : 'Claude Code CLI'}`);
  console.log(`  ▸ 종료: Ctrl+C\n`);
});
