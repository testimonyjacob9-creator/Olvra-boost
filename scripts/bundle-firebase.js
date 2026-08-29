// scripts/bundle-firebase.js
// Runs during `npm run build` (see netlify.toml). Bundles the Firebase Web
// SDK — installed as a normal npm dependency — into a single local file at
// public/js/firebase-sdk.bundle.js.
//
// WHY THIS EXISTS: the app used to load Firebase directly from Google's
// CDN (https://www.gstatic.com/firebasejs/...) via <script type="module">
// imports on every page. On 2026-08-29 this started crashing for real
// users — a TypeError inside firebase-auth.js itself, thrown before any
// sign-in/sign-up request could even be sent, on multiple SDK versions
// (10.12.0 and 11.0.2), on multiple networks. That points at something
// between users and gstatic.com (a network-level filter/proxy affecting
// that specific Google domain), not at this app's code or Firebase
// project config — both were independently verified healthy.
//
// The fix: stop depending on gstatic.com being reachable/unmodified at
// runtime. Bundle Firebase into this app's own deploy, served from our
// own domain, so nothing loads from Google's CDN at all.

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const entry = path.join(__dirname, "..", "src", "firebase-sdk-entry.js");
const outfile = path.join(__dirname, "..", "public", "js", "firebase-sdk.bundle.js");

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    outfile,
    minify: true,
    target: ["es2020"],
  })
  .then(() => {
    const sizeKb = (fs.statSync(outfile).size / 1024).toFixed(1);
    console.log(`[bundle-firebase] Wrote ${outfile} (${sizeKb} KB).`);
  })
  .catch((err) => {
    console.error("[bundle-firebase] Build failed:", err);
    process.exit(1);
  });
