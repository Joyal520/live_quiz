// livequiz/firebase.js
// Firebase Web SDK (Modular) - loaded directly from Google CDN
// Works on GitHub Pages (no backend needed)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  serverTimestamp,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  deleteDoc,
  getDocs,
  writeBatch,
  increment,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ✅ Your Firebase config (you already got this from Firebase Console)
const firebaseConfig = {
  apiKey: "AIzaSyC6d2ihQZBinYOh5NjYmC4CqlvH9Dh6Yo8",
  authDomain: "electratechlivequiz.firebaseapp.com",
  projectId: "electratechlivequiz",
  storageBucket: "electratechlivequiz.firebasestorage.app",
  messagingSenderId: "268767149449",
  appId: "1:268767149449:web:5b93fcf35bc86fd5513558",
  measurementId: "G-X5E0B5G6NH"
};

const requiredConfigKeys = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId"
];

const missingConfigKeys = requiredConfigKeys.filter((key) => !firebaseConfig[key]);
if (missingConfigKeys.length) {
  console.error("[LiveQuiz] Missing Firebase config:", missingConfigKeys.join(", "));
}

// 1) Init app + services
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export { firebaseConfig };

console.info("[LiveQuiz] Firebase initialized", firebaseConfig.projectId);

// 2) Ensure every visitor is a Firebase user (anonymous)
// This gives each student a unique uid automatically.
let anonAuthPromise = null;
const AUTH_RETRY_CODES = new Set(["auth/network-request-failed"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function signInAnonymouslyWithRetry(maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const cred = await signInAnonymously(auth);
      return cred.user;
    } catch (error) {
      lastError = error;
      if (!AUTH_RETRY_CODES.has(error?.code) || attempt === maxAttempts) {
        throw error;
      }

      console.warn("[LiveQuiz] Anonymous auth retry", { attempt, code: error.code });
      await delay(500 * attempt);
    }
  }

  throw lastError;
}

export async function ensureAnonAuth() {
  if (auth.currentUser) return auth.currentUser;
  if (!anonAuthPromise) {
    anonAuthPromise = signInAnonymouslyWithRetry()
      .catch((error) => {
        anonAuthPromise = null;
        throw error;
      });
  }
  return anonAuthPromise;
}

// 3) Export helpers we will use in other files
export const TS = serverTimestamp;
export const Fire = {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  deleteDoc,
  getDocs,
  writeBatch,
  increment,
  limit
};

// Game Status Constants
export const GameStatus = {
  LOBBY: "lobby",
  QUESTION: "question",
  REVEAL: "reveal",
  FINISHED: "finished"
};

// Centralized Scoring Formula
export function calculatePoints(clientSubmitMs, questionStartMs, durationSec) {
  const durationMs = durationSec * 1000;
  const elapsed = clientSubmitMs - questionStartMs;
  const remaining = Math.max(0, durationMs - elapsed);
  const speedBonus = Math.round(500 * remaining / durationMs);
  return 500 + speedBonus;
}
