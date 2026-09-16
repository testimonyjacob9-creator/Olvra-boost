// scripts/bump-sw-version.js
// Runs during `netlify build`, right after generate-config.js. Rewrites
// public/sw.js's CACHE_VERSION to something unique per deploy — Netlify's
// own COMMIT_REF (the git SHA being deployed) when available, a timestamp
// otherwise (e.g. a local build).
//
// Why this exists: CACHE_VERSION used to be a hand-typed string that had
// to be manually bumped for the service worker to ever discard its old
// cached files. It went unbumped across an entire session's worth of
// deploys — Netlify kept building and deploying successfully the whole
// time, but every browser kept serving pre-session JS from cache, making
// it look like nothing had deployed at all. This makes that class of bug
// impossible: every real deploy gets a genuinely new cache version, no
// human has to remember to change anything.

const fs = require("fs");
const path = require("path");

const swPath = path.join(__dirname, "..", "public", "sw.js");
const version = `olvra-boost-${process.env.COMMIT_REF ? process.env.COMMIT_REF.slice(0, 10) : Date.now()}`;

let content = fs.readFileSync(swPath, "utf8");
const updated = content.replace(
  /const CACHE_VERSION = ".*?";/,
  `const CACHE_VERSION = "${version}";`
);

if (updated === content) {
  console.warn("[bump-sw-version] CACHE_VERSION line not found/changed — check public/sw.js's format.");
} else {
  fs.writeFileSync(swPath, updated);
  console.log(`[bump-sw-version] public/sw.js CACHE_VERSION set to "${version}".`);
}
