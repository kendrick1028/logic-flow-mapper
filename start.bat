@echo off
REM Logic Flow Mapper - Windows 실행 스크립트
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [오류] Node.js 가 설치되어 있지 않습니다.
  echo https://nodejs.org/ko 에서 LTS 버전을 설치한 후 다시 시도하세요.
  echo.
  pause
  exit /b 1
)

where claude >nul 2>nul
if errorlevel 1 (
  echo.
  echo [경고] Claude Code CLI 가 설치되어 있지 않습니다.
  echo Claude 분석 기능을 쓰려면 아래 명령으로 설치하세요:
  echo     npm install -g @anthropic-ai/claude-code
  echo 그 다음 한 번  claude  를 실행해서 /login 으로 로그인하세요.
  echo.
)

echo.
echo Logic Flow Mapper 서버를 시작합니다...
echo 브라우저에서 http://localhost:3000 으로 접속하세요.
echo 종료하려면 이 창에서 Ctrl+C 를 누르세요.
echo.

node server.js

pause
