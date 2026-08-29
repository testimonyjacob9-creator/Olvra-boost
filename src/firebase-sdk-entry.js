// src/firebase-sdk-entry.js
// Single entry point re-exporting every Firebase Web SDK function this app
// uses anywhere (across firebase-client.js, index.html, admin.html,
// fund.html, orders.html, notifications.html, all-services.html,
// admin-login.html, onboarding.js). Bundled by scripts/bundle-firebase.js
// into public/js/firebase-sdk.bundle.js — served from our own domain
// instead of gstatic.com. Add new exports here if a page starts using a
// Firebase function not already listed.

export { initializeApp } from "firebase/app";

export {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";

export {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  writeBatch,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getCountFromServer,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
