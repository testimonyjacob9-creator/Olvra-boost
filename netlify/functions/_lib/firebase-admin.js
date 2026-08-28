// _lib/firebase-admin.js
// Initializes the Firebase Admin SDK exactly once per warm Netlify Function
// container.
//
// PREFERRED — one env var, the full downloaded service account JSON:
//   FIREBASE_SERVICE_ACCOUNT_JSON = { "type": "service_account", ... }
// Paste the *entire* contents of the JSON file Firebase gives you
// (Project Settings → Service Accounts → Generate new private key) as-is,
// on one line, into this single env var. JSON.parse() decodes the
// private_key's escaped newlines correctly and automatically — this is
// far less error-prone on mobile than manually splitting a multi-line PEM
// key into a separate env var, which is very easy to corrupt via
// autocorrect / smart punctuation / stripped line breaks when copy-pasting
// on a phone keyboard.
//
// FALLBACK — three separate env vars (kept for backwards compatibility):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (with literal \n newlines)

const admin = require("firebase-admin");

function buildServiceAccount() {
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
      "Missing Firebase service account env vars — set FIREBASE_SERVICE_ACCOUNT_JSON (recommended), or all three of FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY."
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
