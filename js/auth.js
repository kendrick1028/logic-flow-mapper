// ── Authentication Module ──
let currentUser = null;
let userRole = null;
let selectedSignupRole = 'student';

const TEACHER_PANELS = ['home', 'workbook', 'variant', 'logic', 'grammar', 'grammar-quiz', 'fill-blank'];
const STUDENT_PANELS = ['home', 'logic'];

// 관리자 코드: 선생님(관리자) 계정 생성 시 이 코드가 일치해야 teacher 권한 부여
// ⚠️ 보안 참고: 클라이언트 코드이므로 완전히 숨겨지진 않음. 반드시 바꿔서 쓰고, 공개 배포 시에는
//    Firestore Security Rules 또는 Cloud Functions 기반 검증으로 교체 권장.
const ADMIN_CODE = '8266';

function selectSignupRole(role) {
  selectedSignupRole = role;
  document.getElementById('roleStudent').classList.toggle('active', role === 'student');
  document.getElementById('roleTeacher').classList.toggle('active', role === 'teacher');
  const codeInput = document.getElementById('signupAdminCode');
  if (role === 'teacher') {
    codeInput.style.display = '';
    codeInput.focus();
  } else {
    codeInput.style.display = 'none';
    codeInput.value = '';
  }
  document.getElementById('authError').textContent = '';
}

function canAccessPanel(panel) {
  if (userRole === 'teacher') return true;
  return STUDENT_PANELS.includes(panel);
}

async function getUserRole(uid) {
  const doc = await db.collection('users').doc(uid).get();
  if (doc.exists) return doc.data().role;
  return 'student';
}

async function handleSignIn(email, password) {
  const errEl = document.getElementById('authError');
  errEl.textContent = '';
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (e) {
    errEl.textContent = getAuthErrorMessage(e.code);
  }
}

async function handleSignUp(email, password, passwordConfirm) {
  const errEl = document.getElementById('authError');
  errEl.textContent = '';
  if (password !== passwordConfirm) {
    errEl.textContent = '비밀번호가 일치하지 않습니다.';
    return;
  }
  if (password.length < 6) {
    errEl.textContent = '비밀번호는 6자 이상이어야 합니다.';
    return;
  }
  // 관리자(선생님) 계정일 경우 관리자 코드 검증
  let finalRole = 'student';
  if (selectedSignupRole === 'teacher') {
    const enteredCode = (document.getElementById('signupAdminCode').value || '').trim();
    if (enteredCode !== ADMIN_CODE) {
      errEl.textContent = '관리자 코드가 올바르지 않습니다.';
      return;
    }
    finalRole = 'teacher';
  }
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await db.collection('users').doc(cred.user.uid).set({
      email: email,
      role: finalRole,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    errEl.textContent = getAuthErrorMessage(e.code);
  }
}

async function handleSignOut() {
  await auth.signOut();
}

function getAuthErrorMessage(code) {
  const messages = {
    'auth/user-not-found': '등록되지 않은 이메일입니다.',
    'auth/wrong-password': '비밀번호가 올바르지 않습니다.',
    'auth/invalid-email': '올바른 이메일 형식이 아닙니다.',
    'auth/email-already-in-use': '이미 사용 중인 이메일입니다.',
    'auth/weak-password': '비밀번호는 6자 이상이어야 합니다.',
    'auth/too-many-requests': '잠시 후 다시 시도해주세요.',
    'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않습니다.'
  };
  return messages[code] || '오류가 발생했습니다. 다시 시도해주세요.';
}

function showAuthScreen() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('mainContent').style.display = 'none';
}

function showApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('sidebar').style.display = '';
  document.getElementById('mainContent').style.display = '';
}

function switchAuthTab(tab) {
  const loginTab = document.getElementById('tabLogin');
  const signupTab = document.getElementById('tabSignup');
  const loginForm = document.getElementById('formLogin');
  const signupForm = document.getElementById('formSignup');
  document.getElementById('authError').textContent = '';

  if (tab === 'login') {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    loginForm.style.display = '';
    signupForm.style.display = 'none';
  } else {
    loginTab.classList.remove('active');
    signupTab.classList.add('active');
    loginForm.style.display = 'none';
    signupForm.style.display = '';
    // 회원가입 폼 초기화: 기본값 '학생'으로
    selectSignupRole('student');
  }
}

function updateSidebarForRole() {
  document.querySelectorAll('.sidebar-item[data-panel]').forEach(el => {
    const panel = el.dataset.panel;
    const lock = el.querySelector('.lock-icon');
    if (!canAccessPanel(panel)) {
      el.classList.add('locked');
      if (!lock) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'lock-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.innerHTML = '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>';
        el.appendChild(svg);
      }
    } else {
      el.classList.remove('locked');
      if (lock) lock.remove();
    }
  });

  // Update user info in sidebar
  const userInfo = document.getElementById('sidebarUserInfo');
  if (userInfo && currentUser) {
    const roleLabel = userRole === 'teacher' ? '선생님' : '학생';
    userInfo.innerHTML = `<span class="user-email">${currentUser.email}</span><span class="user-role">${roleLabel}</span>`;
  }
}

function initAuth() {
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      currentUser = user;
      try {
        userRole = await getUserRole(user.uid);
      } catch (e) {
        console.warn('[auth] getUserRole failed:', e && e.message);
        userRole = 'student';
      }
      showApp();
      updateSidebarForRole();
      // auth-ready 브로드캐스트: 대시보드 등 후속 Firestore get() 호출이
      // currentUser 가 세팅된 이후에 실행되도록 한다.
      window.__authReady = true;
      try {
        window.dispatchEvent(new CustomEvent('authready', {
          detail: { user: currentUser, role: userRole }
        }));
      } catch (e) { /* older browsers */ }
      // 로그인 후 role이 확정된 시점에 DOM/패널 상태 동기화
      // (initSidebar()가 auth 전에 호출되면 userRole=null이라 switchPanel이 no-op으로 끝남)
      const targetPanel = canAccessPanel(currentPanel) ? currentPanel : 'logic';
      switchPanel(targetPanel);
    } else {
      currentUser = null;
      userRole = null;
      window.__authReady = false;
      showAuthScreen();
    }
  });
}
