# Logic Flow Mapper

영어 지문 분석 · 변형 문제 생성 · 워크북 제작 도구. 로컬에서 실행하는 정적 웹앱이며,
Claude Code CLI 와 Gemini / OpenAI API 를 사용합니다.

---

## 1. 사전 준비

각 컴퓨터에 한 번만 설치하면 됩니다.

### 1-1. Node.js (필수)
- https://nodejs.org/ko 에서 **LTS** 버전 설치 (Windows 는 .msi 다운로드 → 다음·다음·완료).

### 1-2. Claude Code CLI (필수)
PowerShell 또는 명령 프롬프트(CMD) 에서:
```
npm install -g @anthropic-ai/claude-code
```
설치 후 한 번만 로그인:
```
claude
```
대화 창이 뜨면 `/login` 입력 → 브라우저에서 Anthropic 계정으로 로그인 (Max 정액제 계정 권장).
로그인이 끝나면 `/exit` 또는 Ctrl+C 로 빠져나옵니다.

### 1-3. Gemini / OpenAI API 키 발급 (필수)
- Gemini: https://aistudio.google.com/app/apikey  → 키 생성 (무료 등급 가능)
- OpenAI: https://platform.openai.com/api-keys   → 키 생성 (유료, 결제수단 등록 필요)

키는 **앱을 실행한 뒤** 우측 상단 **「API 키 설정」** 버튼에 입력합니다. 브라우저 localStorage 에만 저장되며 외부로 전송되지 않습니다.

---

## 2. 다운로드 & 실행

### 2-1. 다운로드
GitHub 페이지에서 **Code → Download ZIP** 으로 받아 압축 해제.
(또는 `git clone <저장소 URL>`)

### 2-2. 실행

**Windows**
- 폴더 안의 `start.bat` 더블클릭.

**macOS / Linux**
- 터미널에서 폴더로 이동 후 `./start.sh` 실행 (또는 `npm start`).

서버가 켜지면 자동으로 안내가 뜹니다. 브라우저에서 **http://localhost:3000** 접속.

종료는 실행 중인 검은 창에서 **Ctrl+C**.

---

## 3. 첫 실행 시 할 일

1. 회원가입 / 로그인 (Firebase Auth — 학생 / 선생님 구분)
   - 선생님 계정은 관리자 코드가 필요합니다. 관리자에게 문의하세요.
2. 우측 상단 **「API 키 설정」** 클릭 → Gemini / OpenAI 키 입력 후 저장.
3. 좌측 사이드바에서 원하는 기능 선택.

---

## 4. 자주 묻는 문제

**Q. 실행하면 "claude 명령어를 찾을 수 없습니다" 오류가 뜹니다.**
- Claude Code CLI 가 설치되지 않았거나, PATH 에 등록되지 않은 경우입니다.
- `npm install -g @anthropic-ai/claude-code` 재실행 → 검은 창(터미널)을 새로 열어 다시 시도.
- 그래도 안 되면 `.env` 파일을 만들어 `CLAUDE_BIN=절대경로` 로 지정 (예시는 `.env.example` 참고).

**Q. PDF 가져오기 기능이 안 됩니다.**
- 이 기능은 Anthropic API 키가 따로 필요합니다. `.env` 에 `CLAUDE_API_KEY=...` 추가 후 서버 재시작.

**Q. 다른 포트로 띄우고 싶어요.**
- `.env` 에 `PORT=8080` 같은 식으로 지정.

**Q. Gemini 키가 자주 한도 초과돼요.**
- 「API 키 설정」 의 Gemini 입력란에 여러 키를 줄바꿈으로 넣으면 자동 로테이션됩니다.

---

## 5. 폴더 구조

```
Logic Flow Mapper/
├── index.html          ← 메인 화면
├── css/                ← 스타일
├── js/                 ← 프론트엔드 모듈 (api, app, batch, …)
├── server.js           ← 로컬 Node 서버 (정적 파일 + /api/claude /api/claude-pdf)
├── package.json
├── start.bat           ← Windows 실행
├── start.sh            ← macOS/Linux 실행
└── .env.example        ← 환경변수 템플릿 (복사해서 .env 로 사용)
```
