// _lib/firebase-admin.js
// Initializes the Firebase Admin SDK exactly once per warm Netlify Function
// container, using a service-account built from individual Netlify env vars
// (never a committed JSON file).
//
// Required Netlify env vars:
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   (with literal \n newlines — see note below)

const admin = require("firebase-admin");

function buildServiceAccount() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Netlify's env var UI stores newlines as the two characters "\" + "n".
  // We flip those back into real newlines, or the PEM key won't parse.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase service account env vars (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)."
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
