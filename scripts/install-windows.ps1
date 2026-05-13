# Logic Flow Mapper — Windows 자동 설치 스크립트
# 사용: 이 파일 우클릭 → "PowerShell 로 실행"
#
# 실행 흐름:
#   1. Node.js 설치 (winget, 없으면 직접 다운로드)
#   2. Git 설치 (필요 시)
#   3. Claude Code CLI 전역 설치
#   4. GitHub 에서 프로젝트 다운로드
#   5. npm install
#   6. 바탕화면 단축 아이콘 생성
#   7. dev 서버 시작 + 브라우저 열기

$ErrorActionPreference = 'Continue'   # 일부 단계 실패해도 계속 진행
$ProgressPreference = 'SilentlyContinue'

# 어떤 에러가 나든 창이 자동으로 닫히지 않도록 마지막에 항상 키 입력 대기
trap {
  Write-Host ""
  Write-Host "❌ 오류 발생:" -ForegroundColor Red
  Write-Host $_ -ForegroundColor Yellow
  Write-Host ""
  Write-Host "이 창은 자동으로 닫히지 않습니다. 위 에러를 캡처해서 보내주세요."
  Read-Host "Enter 를 누르면 창이 닫힙니다"
  break
}

# ── 설정 (필요 시 사용자 수정) ─────────────────────────────────
$RepoUrl    = "https://github.com/kendrick1028/logic-flow-mapper.git"   # GitHub 레포 URL
$InstallDir = "$env:USERPROFILE\logic-flow-mapper"
$AppName    = "Logic Flow Mapper"
# ────────────────────────────────────────────────────────────

function Write-Step($num, $msg) {
  Write-Host ""
  Write-Host "═══════════════════════════════════════════════"
  Write-Host "  [$num] $msg" -ForegroundColor Cyan
  Write-Host "═══════════════════════════════════════════════"
}
function Write-OK($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red }

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path","Machine")
  $userPath    = [Environment]::GetEnvironmentVariable("Path","User")
  $env:Path = "$machinePath;$userPath"
  # npm global prefix 도 명시적으로 추가 (npm install -g 직후 PATH 미반영 대응)
  try {
    $npmPrefix = (npm config get prefix 2>$null).Trim()
    if ($npmPrefix -and ($env:Path -notlike "*$npmPrefix*")) {
      $env:Path = "$env:Path;$npmPrefix"
    }
  } catch {}
  # 표준 npm global 경로 fallback 추가
  $defaultNpm = "$env:APPDATA\npm"
  if ((Test-Path $defaultNpm) -and ($env:Path -notlike "*$defaultNpm*")) {
    $env:Path = "$env:Path;$defaultNpm"
  }
}

function Has-Cmd($name) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { return $true }
  # .cmd 확장자로도 검사 (Windows npm shim)
  if (Get-Command "$name.cmd" -ErrorAction SilentlyContinue) { return $true }
  # 직접 경로 확인
  $cmdPath = "$env:APPDATA\npm\$name.cmd"
  if (Test-Path $cmdPath) { return $true }
  return $false
}

# ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔═══════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║                                               ║" -ForegroundColor Magenta
Write-Host "║   Logic Flow Mapper — Windows 자동 설치       ║" -ForegroundColor Magenta
Write-Host "║                                               ║" -ForegroundColor Magenta
Write-Host "╚═══════════════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""

# ── Step 1: Node.js ──────────────────────────────────────────
Write-Step "1/7" "Node.js 확인 / 설치"
if (Has-Cmd "node") {
  $nodeVer = (node --version).Trim()
  Write-OK "Node.js 이미 설치됨 ($nodeVer)"
} else {
  Write-Host "  Node.js 설치 중 (winget)..." -ForegroundColor Gray
  if (Has-Cmd "winget") {
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    Refresh-Path
    if (Has-Cmd "node") { Write-OK "Node.js 설치 완료" }
    else {
      Write-Err "winget 설치 실패. 직접 https://nodejs.org/ko 에서 LTS 버전을 받아 설치하세요."
      Read-Host "Enter 를 누르면 창이 닫힙니다"
      return
    }
  } else {
    Write-Err "winget 이 없습니다. Windows 10 1809+ 또는 Windows 11 필요."
    Write-Host "  수동 설치: https://nodejs.org/ko 에서 LTS 다운로드 후 설치 → 이 스크립트 재실행"
    Read-Host "Enter 를 누르면 창이 닫힙니다"
    return
  }
}

# ── Step 2: Git ──────────────────────────────────────────────
Write-Step "2/7" "Git 확인 / 설치"
if (Has-Cmd "git") {
  Write-OK "Git 이미 설치됨"
} else {
  Write-Host "  Git 설치 중 (winget)..." -ForegroundColor Gray
  winget install -e --id Git.Git --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (Has-Cmd "git") { Write-OK "Git 설치 완료" }
  else {
    Write-Err "Git 설치 실패. https://git-scm.com 에서 직접 설치 후 재시도."
    Read-Host "Enter 를 누르면 창이 닫힙니다"
    return
  }
}

# ── Step 3: Claude CLI ──────────────────────────────────────
Write-Step "3/7" "Claude Code CLI 설치"
if (Has-Cmd "claude") {
  Write-OK "Claude CLI 이미 설치됨"
} else {
  Write-Host "  npm install -g @anthropic-ai/claude-code 실행 중..." -ForegroundColor Gray
  # npm install — 출력 캡처해서 에러 보이게
  $npmOutput = npm install -g "@anthropic-ai/claude-code" 2>&1
  $npmExit = $LASTEXITCODE
  Refresh-Path
  if (Has-Cmd "claude") {
    Write-OK "Claude CLI 설치 완료"
  } else {
    Write-Warn "Claude CLI 자동 감지 실패. PATH 새로고침 시도..."
    Write-Host "  npm exit code: $npmExit" -ForegroundColor Gray
    Write-Host "  npm output (마지막 10줄):" -ForegroundColor Gray
    $npmOutput | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

    # 직접 경로 확인
    $directPath = "$env:APPDATA\npm\claude.cmd"
    if (Test-Path $directPath) {
      Write-OK "Claude CLI 발견됨 ($directPath) — PATH 추가"
      $env:Path = "$env:Path;$env:APPDATA\npm"
    } else {
      Write-Err "Claude CLI 설치 실패. 다음 중 하나 시도:"
      Write-Host "    1. PowerShell 을 '관리자 권한으로 실행' 으로 다시 열고 스크립트 재실행"
      Write-Host "    2. 수동 설치: npm install -g @anthropic-ai/claude-code"
      Write-Host "    3. Node.js 가 제대로 설치됐는지 확인: node --version"
      Read-Host "Enter 를 누르면 창이 닫힙니다"
      return
    }
  }
}

# ── Step 4: 프로젝트 다운로드 ────────────────────────────────
Write-Step "4/7" "프로젝트 다운로드"
if (Test-Path $InstallDir) {
  Write-Host "  기존 폴더 발견 → 업데이트 (git pull)..." -ForegroundColor Gray
  Set-Location $InstallDir
  git pull --rebase 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-OK "업데이트 완료" }
  else { Write-Warn "git pull 실패 — 기존 코드로 계속 진행" }
} else {
  Write-Host "  $RepoUrl → $InstallDir" -ForegroundColor Gray
  git clone $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) {
    Write-Err "git clone 실패. 레포 URL 확인: $RepoUrl"
    Read-Host "Enter 를 누르면 창이 닫힙니다"
    return
  }
  Set-Location $InstallDir
  Write-OK "다운로드 완료"
}

# ── Step 5: 의존성 설치 ─────────────────────────────────────
Write-Step "5/7" "의존성 설치 (npm install)"
Write-Host "  (몇 분 걸릴 수 있습니다)" -ForegroundColor Gray
npm install --no-audit --no-fund 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Write-OK "의존성 설치 완료" }
else { Write-Warn "일부 패키지 설치 경고 — 계속 진행" }

# ── Step 6: 바탕화면 단축 아이콘 ────────────────────────────
Write-Step "6/7" "바탕화면 단축 아이콘 생성"
$startBat = Join-Path $InstallDir "start-windows.bat"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "$AppName.lnk"
try {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($shortcutPath)
  $sc.TargetPath = $startBat
  $sc.WorkingDirectory = $InstallDir
  $sc.WindowStyle = 1
  $sc.Description = "Logic Flow Mapper — 영어 분석 도구"
  $iconFile = Join-Path $InstallDir "favicon.ico"
  if (Test-Path $iconFile) { $sc.IconLocation = $iconFile }
  $sc.Save()
  Write-OK "단축 아이콘 생성: $shortcutPath"
} catch {
  Write-Warn "단축 아이콘 생성 실패: $_"
}

# ── Step 7: 서버 시작 + 브라우저 ────────────────────────────
Write-Step "7/7" "앱 시작"

# 기존 3000 포트 점유 프로세스 종료
$busy = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
if ($busy) {
  foreach ($p in $busy.OwningProcess) {
    try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
  }
}

# 새 PowerShell 창에서 서버 실행 (이 스크립트가 끝나도 살아있도록)
$serverCmd = "Set-Location '$InstallDir'; Write-Host 'Logic Flow Mapper 서버 실행 중...'; Write-Host '창 닫으면 서버 종료됩니다.'; node server.js"
Start-Process powershell -ArgumentList "-NoExit","-Command",$serverCmd -WindowStyle Normal

# 서버가 뜰 때까지 대기 (최대 30초)
Write-Host "  서버 시작 대기 중..." -ForegroundColor Gray
$ready = $false
for ($i=0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $resp = Invoke-WebRequest -Uri "http://localhost:3000/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
}
if ($ready) { Write-OK "서버 준비됨" } else { Write-Warn "서버 응답 확인 실패 — 그래도 브라우저 엽니다" }

Start-Process "http://localhost:3000"

# ── 완료 메시지 ─────────────────────────────────────────────
Write-Host ""
Write-Host "╔═══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                                               ║" -ForegroundColor Green
Write-Host "║   설치 완료!                                  ║" -ForegroundColor Green
Write-Host "║                                               ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  ▸ 브라우저가 자동으로 열렸습니다 (http://localhost:3000)"
Write-Host "  ▸ 처음이면 헤더 우상단의 '🔌 Claude 연결' 버튼을 클릭하세요."
Write-Host "  ▸ 브라우저에서 자기 Claude (Max) 계정으로 Authorize 누르면 끝."
Write-Host ""
Write-Host "  다음부터는 바탕화면의 '$AppName' 단축 아이콘을 더블클릭하세요."
Write-Host ""
Write-Host "  이 창은 닫아도 됩니다. (서버는 별도 창에서 실행 중)"
Write-Host ""
Read-Host "Enter 를 누르면 이 창 닫힙니다"
