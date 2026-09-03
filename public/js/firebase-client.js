// public/js/firebase-client.js
// Shared Firebase Web SDK init, imported independently by every page
// (index.html, fund.html, services.html, orders.html). Each page does a
// full browser navigation to the next (not a single-page app), so a page
// can NEVER rely on a `window` global set by another page's script — that
// global simply doesn't exist after a fresh page load. This module fixes
// that by giving every page its own working init.

// Bundled locally from the `firebase` npm package (see
// scripts/bundle-firebase.js) and served from our own domain — NOT loaded
// from gstatic.com. This was changed on 2026-08-29 after gstatic.com
// became unreachable/broken for many users, taking down all sign-in and
// sign-up. See git history / NETLIFY_ENV_SETUP.md for the full story.
import { initializeApp, getAuth, getFirestore } from "./firebase-sdk.bundle.js";

// Hardcoded directly (same approach as WoodPayVTU) — no build-time
// injection, no config.js, nothing that depends on Netlify env vars or the
// build step running correctly. These values are safe to expose publicly;
// see NETLIFY_ENV_SETUP.md for why.
const firebaseConfig = {
  apiKey: "AIzaSyBNmwzcR15pTd2XpTzvp9S-O0V6ABzcoqE",
  authDomain: "olvra-boost.firebaseapp.com",
  projectId: "olvra-boost",
  storageBucket: "olvra-boost.firebasestorage.app",
  messagingSenderId: "527708700840",
  appId: "1:527708700840:web:fe696622ad93e42536429d",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/**
 * Calls a Netlify Function with the signed-in user's Firebase ID token
 * attached, and throws with a readable message on any non-2xx response.
 */
export async function callFunction(name, body) {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in.");
  const idToken = await user.getIdToken();
  const res = await fetch(`/.netlify/functions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request to ${name} failed.`);
  return data;
}

/**
 * Firebase's SDK doesn't retry network failures on its own — a short
 * automatic retry helps meaningfully on weak mobile connections (this app
 * has real users on very slow/flaky Nigerian mobile data, seen as low as
 * a few hundred bytes/sec — a single failed attempt there is normal, not
 * exceptional).
 *
 * Covers BOTH Firebase Auth's error code ("auth/network-request-failed")
 * AND Firestore's own connectivity codes ("unavailable",
 * "deadline-exceeded", "resource-exhausted") — a bare getDoc() failing on
 * a flaky connection was previously falling straight through to a raw,
 * confusing error message with no retry at all (2026-09-02: this is what
 * was actually causing "network error" on admin login — the sign-in
 * itself retried fine, but the very next Firestore read right after it
 * didn't).
 *
 * `onRetry(attempt, attempts)` is optional — pass it to show the user
 * "still trying..." instead of letting the button sit there looking frozen.
 */
const RETRYABLE_CODES = new Set([
  "auth/network-request-failed",
  "unavailable",
  "deadline-exceeded",
  "resource-exhausted",
]);

export async function withNetworkRetry(fn, attempts = 4, onRetry) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = (err.code || "").replace(/^firestore\//, "");
      if (!RETRYABLE_CODES.has(code) || i === attempts - 1) throw err;
      if (onRetry) onRetry(i + 1, attempts);
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Every non-index page should call this first. Redirects to "/" if the
 * user isn't signed in; otherwise resolves with the Firebase user object.
 */
export function requireSignedInUser() {
  return new Promise((resolve) => {
    let unsub;
    unsub = auth.onAuthStateChanged((user) => {
      if (unsub) unsub();
      if (!user) {
        window.location.href = "/";
        return;
      }
      resolve(user);
    });
  });
}
