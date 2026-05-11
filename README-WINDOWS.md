# Logic Flow Mapper — 윈도우 설치 가이드

## 🚀 빠른 설치 (5분)

### 1단계 — 설치 스크립트 다운로드

[install-windows.ps1](https://raw.githubusercontent.com/kendrick1028/logic-flow-mapper/main/scripts/install-windows.ps1) 우클릭 → **다른 이름으로 링크 저장** → 바탕화면에 저장.

### 2단계 — 실행

저장한 `install-windows.ps1` 우클릭 → **"PowerShell 로 실행"**

> ⚠️ 처음 실행 시 "이 게시자의 스크립트를 실행하시겠습니까?" 보안 경고 → **"한 번 실행"** 클릭.
>
> 또는 실행 정책 오류 발생 시 PowerShell 관리자 권한으로 열고:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```

스크립트가 자동으로:
- ✅ Node.js 설치 (없으면)
- ✅ Git 설치 (없으면)
- ✅ Claude Code CLI 전역 설치
- ✅ GitHub 에서 프로젝트 다운로드 (`%USERPROFILE%\logic-flow-mapper`)
- ✅ 의존성 설치 (`npm install`)
- ✅ 바탕화면에 단축 아이콘 생성
- ✅ 서버 시작 + 브라우저 자동 열기

### 3단계 — Claude 연결 (한 번만)

브라우저가 열리면 헤더 우상단의 **🔌 Claude 연결** 버튼 클릭.

→ 새 탭으로 Anthropic 인증 페이지 열림.
→ 자기 Max 구독 계정으로 **Authorize**.
→ 앱에서 자동으로 ✅ 연결 완료 감지 → **Claude CLI · Max 정액제** 배지로 바뀜.

이후엔 다시 누를 일 없음 (Windows credential store 에 영구 저장).

---

## 📅 매일 사용

바탕화면의 **Logic Flow Mapper** 아이콘 더블클릭.

- 서버 자동 시작 (검정 창에 로그 표시 — 닫지 말 것)
- 3초 후 브라우저에 `http://localhost:3000` 자동 열림

사용 끝나면 서버 창 닫으면 됨.

---

## 🛠 수동 설치 (스크립트 안 쓰는 경우)

```powershell
# 1. Node.js 설치
winget install -e --id OpenJS.NodeJS.LTS

# 2. Git 설치
winget install -e --id Git.Git

# 3. Claude CLI 설치
npm install -g @anthropic-ai/claude-code

# 4. 프로젝트 클론
cd %USERPROFILE%
git clone https://github.com/kendrick1028/logic-flow-mapper.git
cd logic-flow-mapper
npm install

# 5. 서버 실행
node server.js

# 6. 브라우저로 http://localhost:3000 접속
```

---

## 🐛 문제 해결

### "claude CLI 가 설치되지 않았습니다"

```powershell
npm install -g @anthropic-ai/claude-code
```

설치 후 PowerShell 재시작.

### "Claude 연결" 버튼 눌렀는데 브라우저 안 열림

수동으로 PowerShell 열어서:
```powershell
claude setup-token
```
→ 출력된 URL 을 브라우저로 복사 → Authorize → 토큰 자동 저장.

### 포트 3000 이 이미 사용 중

```powershell
# 점유 프로세스 찾기
netstat -ano | findstr ":3000"

# PID 로 종료
taskkill /F /PID <PID번호>
```

또는 다른 포트로:
```powershell
$env:PORT = 3001
node server.js
```

### 분석이 너무 느려요

기본은 동시 8개. 더 빠르게 하려면 브라우저 URL 에:
```
http://localhost:3000/?claudeConcurrency=12
```

(단, Anthropic rate limit 초과 시 429 에러 가능. 8 권장)

### 업데이트 받기

```powershell
cd %USERPROFILE%\logic-flow-mapper
git pull
```

또는 `install-windows.ps1` 재실행하면 자동 업데이트됨.

---

## 📁 폴더 구조

```
%USERPROFILE%\logic-flow-mapper\
├── server.js              # 로컬 dev 서버 (Node 내장)
├── start-windows.bat      # 일상 런처 (더블클릭)
├── scripts\
│   └── install-windows.ps1  # 자동 설치 스크립트
├── api\                   # /api/* 서버리스 함수
├── js\                    # 프론트엔드 JS
├── css\                   # 스타일
└── index.html             # 진입점
```

---

## ❓ FAQ

**Q. macOS / Linux 에서도 되나요?**
Yes. macOS 는 다음 명령어로 동일하게:
```bash
brew install node git
npm install -g @anthropic-ai/claude-code
git clone https://github.com/kendrick1028/logic-flow-mapper.git
cd logic-flow-mapper
npm install
node server.js
```

**Q. 다른 사람 Anthropic 계정으로도 쓸 수 있나요?**
네, 각 PC 의 사용자가 본인 Claude 계정으로 로그인 (🔌 Claude 연결 버튼). 분석 비용은 본인 Max 구독에서 차감.

**Q. API 키로도 쓸 수 있나요?**
프로젝트 루트에 `.env` 파일 만들고:
```
CLAUDE_API_KEY=sk-ant-...
```
저장 후 서버 재시작. CLI 로그인 안 했어도 API 키로 호출됨 (Pay-per-use).

**Q. 인터넷 안 되는 곳에서도 되나요?**
아니요. Claude API 호출이 필요해서 인터넷 필수.
