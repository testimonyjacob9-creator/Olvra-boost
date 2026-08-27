// _lib/require-auth.js
// Netlify Functions get no automatic auth context (unlike Firebase's onCall).
// The client must send: Authorization: Bearer <Firebase ID token>
// This verifies it with the Admin SDK and returns the decoded token (uid etc).

const { auth } = require("./firebase-admin");

async function requireAuth(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    const err = new Error("Missing Authorization: Bearer <idToken> header.");
    err.statusCode = 401;
    throw err;
  }

  try {
    return await auth.verifyIdToken(match[1]);
  } catch (e) {
    const err = new Error("Invalid or expired ID token.");
    err.statusCode = 401;
    throw err;
  }
}

module.exports = { requireAuth };
