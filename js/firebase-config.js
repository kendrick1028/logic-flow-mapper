// ── Firebase Configuration ──
// 아래에 Firebase 프로젝트 SDK 설정값을 입력하세요.
const firebaseConfig = {
  apiKey: "AIzaSyAiuqhdVNaaU7BCG8BpnSitP3qhBr_CHaA",
  authDomain: "logic-flow-97922.firebaseapp.com",
  projectId: "logic-flow-97922",
  storageBucket: "logic-flow-97922.firebasestorage.app",
  messagingSenderId: "428000440867",
  appId: "1:428000440867:web:4da6648636d882a7283796"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();