// scripts/generate-config.js
// Runs during `netlify build`. Reads PUBLIC-SAFE env vars from Netlify's
// dashboard and writes public/config.js — this file is git-ignored, so real
// values only ever exist inside Netlify's build environment, never in git.

const fs = require("fs");
const path = require("path");

const required = [
  "FIREBASE_WEB_API_KEY",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_STORAGE_BUCKET",
  "FIREBASE_MESSAGING_SENDER_ID",
  "FIREBASE_APP_ID",
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn(`[generate-config] Missing env vars (set these in Netlify): ${missing.join(", ")}`);
}

const config = {};
for (const key of required) {
  config[key] = process.env[key] || "";
}

const output = `// AUTO-GENERATED at build time. Do not edit directly, do not commit real values.
window.APP_CONFIG = ${JSON.stringify(config, null, 2)};
`;

fs.writeFileSync(path.join(__dirname, "..", "public", "config.js"), output);
console.log("[generate-config] public/config.js written.");
