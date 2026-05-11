@echo off
REM Logic Flow Mapper - 일상 런처 (Windows)
REM 바탕화면 단축아이콘이 이 파일을 가리킴.

cd /d "%~dp0"

REM 3000 포트 점유 프로세스 종료 (간단 처리)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

REM 브라우저 백그라운드로 열기 (서버 시작 후 3초 뒤)
start "" /B cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"

REM 서버 실행 (이 창 닫으면 서버 종료)
echo.
echo  ==========================================
echo   Logic Flow Mapper
echo   - http://localhost:3000
echo   - 이 창 닫으면 서버 종료됩니다
echo  ==========================================
echo.

node server.js

REM 서버가 죽으면 일시 정지 (에러 메시지 확인용)
echo.
echo  서버가 종료되었습니다.
pause
