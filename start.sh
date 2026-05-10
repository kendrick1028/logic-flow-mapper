#!/usr/bin/env bash
# Logic Flow Mapper — macOS / Linux 실행 스크립트
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[오류] Node.js 가 설치되어 있지 않습니다. https://nodejs.org/ko 에서 LTS 설치 후 다시 시도하세요."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "[경고] Claude Code CLI 가 설치되어 있지 않습니다."
  echo "       npm install -g @anthropic-ai/claude-code"
  echo "       설치 후 'claude' 실행 → /login 으로 로그인하세요."
  echo
fi

echo "Logic Flow Mapper 서버 시작 — http://localhost:3000"
echo "종료: Ctrl+C"
echo

exec node server.js
