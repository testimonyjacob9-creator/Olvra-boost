// ===== VERSION MARKER: v3-base64-2026-08-28 =====
// If you can see this exact line when viewing this file on GitHub, the
// upload worked. If you see anything else at the top, it did not.
//
// _lib/firebase-admin.js
// Initializes the Firebase Admin SDK exactly once per warm Netlify Function
// container.
//
// MOST RELIABLE ON MOBILE — one env var, base64-encoded service account JSON:
//   FIREBASE_SERVICE_ACCOUNT_BASE64 = <the whole service account JSON,
//   base64-encoded>
// Base64 only ever contains letters, digits, +, /, = — nothing a phone
// keyboard's autocorrect or "smart quotes" feature can silently corrupt.
// Plain JSON/PEM values contain quote characters that very commonly get
// swapped for curly quotes during mobile copy-paste, which breaks the key
// without any visible sign anything is wrong.
//
// FALLBACK — one env var, the full downloaded service account JSON as-is:
//   FIREBASE_SERVICE_ACCOUNT_JSON = { "type": "service_account", ... }
//
// FALLBACK — three separate env vars (kept for backwards compatibility):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (with literal \n newlines)

const admin = require("firebase-admin");

function buildServiceAccount() {
  const base64Blob = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64Blob) {
    let parsed;
    try {
      const jsonStr = Buffer.from(base64Blob.trim(), "base64").toString("utf8");
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_BASE64 could not be decoded — make sure you pasted the entire base64 string, unmodified."
      );
    }
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error("Decoded FIREBASE_SERVICE_ACCOUNT_BASE64 is missing project_id, client_email, or private_key.");
    }
    return {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }

  const jsonBlob = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (jsonBlob) {
    let parsed;
    try {
      parsed = JSON.parse(jsonBlob);
    } catch (e) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON — make sure you pasted the entire downloaded file, unmodified."
      );
    }
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email, or private_key.");
    }
    return {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Netlify's env var UI stores newlines as the two characters "\" + "n".
  // We flip those back into real newlines, or the PEM key won't parse.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase service account env vars — set FIREBASE_SERVICE_ACCOUNT_BASE64 (recommended), FIREBASE_SERVICE_ACCOUNT_JSON, or all three of FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY."
    );
  }

  return { projectId, clientEmail, privateKey };
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(buildServiceAccount()),
  });
}

const db = admin.firestore();
const auth = admin.auth();
const FieldValue = admin.firestore.FieldValue;

module.exports = { admin, db, auth, FieldValue };
