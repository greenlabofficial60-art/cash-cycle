// ─────────────────────────────────────────────────────────────────────────────
// Firebase configuration for Cash Cycle
//
// To enable Google Sign-in + cloud sync:
//  1. Go to https://console.firebase.google.com → create a project
//  2. Add a web app → copy the config values below
//  3. Authentication → Sign-in method → enable Google
//  4. Firestore Database → Create database → start in test mode
//  5. Authentication → Settings → Authorized domains → add your GitHub Pages domain
//     e.g.  greenlabofficial60-art.github.io
//  6. Paste your values, save this file, and redeploy
// ─────────────────────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCqLqK3HDSJQroc_Grp2QTLNEJT8HiofR0",
  authDomain:        "cashaycle.firebaseapp.com",
  projectId:         "cashaycle",
  storageBucket:     "cashaycle.firebasestorage.app",
  messagingSenderId: "1038405752515",
  appId:             "1:1038405752515:web:deeab912e5ebcdc293b476",
};

export const FIREBASE_READY = !!(FIREBASE_CONFIG.apiKey);

// ── Firebase SDK (only initialised when configured) ───────────────────────────
import { initializeApp }                                                  from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc }                              from "firebase/firestore";

let _auth = null;
let _db   = null;

if (FIREBASE_READY) {
  const app = initializeApp(FIREBASE_CONFIG);
  _auth = getAuth(app);
  _db   = getFirestore(app);
}

export const fbAuth = _auth;
export const fbDb   = _db;
export { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, doc, setDoc, getDoc };
