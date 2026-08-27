#!/bin/bash
set -e
echo "Building Olvra Boost project structure..."

mkdir -p public scripts functions

# ---- .gitignore ----
cat > .gitignore << 'EOF_GITIGNORE'
node_modules/
functions/node_modules/
public/config.js
.netlify/
.env
.firebase/
*.log
EOF_GITIGNORE

# ---- netlify.toml ----
cat > netlify.toml << 'EOF_NETLIFY'
[build]
  command = "node scripts/generate-config.js"
  publish = "public"

[build.environment]
  NODE_VERSION = "20"
EOF_NETLIFY

# ---- firebase.json ----
cat > firebase.json << 'EOF_FBJSON'
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "functions": [
    {
      "source": "functions",
      "codebase": "default",
      "ignore": ["node_modules", ".git", "firebase-debug.log", "firebase-debug.*.log"]
    }
  ]
}
EOF_FBJSON

# ---- firestore.rules ----
cat > firestore.rules << 'EOF_FRULES'
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // Services: everyone (signed-in users) can read the catalog & prices.
    // NOBODY writes from the client — only the syncServices Cloud Function
    // (using the Admin SDK, which bypasses these rules) can write here.
    match /services/{serviceId} {
      allow read: if request.auth != null;
      allow write: if false;
    }

    // Users: a user can read/update their own profile, but CANNOT touch
    // wallet_balance directly — that field is only ever changed by the
    // placeOrder Cloud Function (Admin SDK bypasses rules).
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow create: if request.auth != null && request.auth.uid == userId;
      allow update: if request.auth != null
                    && request.auth.uid == userId
                    && !("wallet_balance" in request.resource.data.diff(resource.data).affectedKeys());
    }

    // Orders: a user can read their own orders. Orders are only ever
    // created by the placeOrder Cloud Function, never directly by the client.
    match /orders/{orderId} {
      allow read: if request.auth != null && request.auth.uid == resource.data.uid;
      allow write: if false;
    }
  }
}
EOF_FRULES

# ---- setup-secrets.sh ----
cat > setup-secrets.sh << 'EOF_SETUPSECRETS'
#!/bin/bash
# setup-secrets.sh
# Run this once, locally, in your project folder (after `firebase use --add`).
# It prompts for each secret and sends it straight to Firebase's secret manager.
# Nothing gets written to disk or committed to git.

set -e

SECRETS=(
  "BIGISUB_TOKEN"
  "BIGISUB_PIN"
  "BIGISUB_ACCOUNT_NUMBER"
  "FLW_SECRET_KEY"
  "FLW_CLIENT_SECRET"
  "FLW_ENCRYPTION_KEY"
  "FLW_WEBHOOK_SECRET_HASH"
  "BREVO_API_KEY"
  "VAPID_PRIVATE_KEY"
)

echo "This will set ${#SECRETS[@]} secrets on your Firebase project."
echo "You'll be prompted for each value — paste it and press Enter."
echo ""

for SECRET in "${SECRETS[@]}"; do
  echo "→ Setting $SECRET"
  firebase functions:secrets:set "$SECRET"
  echo ""
done

echo "All secrets set. Verify with: firebase functions:secrets:access BIGISUB_TOKEN"
echo "Remember: any function that reads a secret must list it in its 'secrets' array (see index.js)."
EOF_SETUPSECRETS

# ---- functions/package.json ----
cat > functions/package.json << 'EOF_FNPKG'
{
  "name": "smm-functions",
  "description": "Cloud Functions for SMM boosting platform (BigiSub-backed)",
  "engines": {
    "node": "20"
  },
  "main": "index.js",
  "scripts": {
    "deploy": "firebase deploy --only functions",
    "logs": "firebase functions:log"
  },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^5.0.0",
    "axios": "^1.6.0"
  }
}
EOF_FNPKG

# ---- functions/config.js ----
cat > functions/config.js << 'EOF_FNCONFIG'
// config.js
// Central place for all platform settings. Edit these, don't scatter magic numbers.

module.exports = {
  BIGISUB_BASE_URL: "https://api.bigisub.ng",

  // Flat markup applied to every service price during sync.
  // 0.05 = 5%. sell_price = cost_price * (1 + MARKUP)
  MARKUP: 0.05,

  // Platforms to sync. Start with all 5; comment any out to launch narrower.
  PLATFORMS: ["instagram", "facebook", "tiktok", "twitter", "youtube"],

  // How many services to fetch per page from BigiSub (their API is paginated).
  PAGE_SIZE: 100,
};
EOF_FNCONFIG

# ---- functions/bigisub.js ----
cat > functions/bigisub.js << 'EOF_FNBIGISUB'
// bigisub.js
// Thin wrapper around the BigiSub Marketing Hub API.
// The API token is read from Firebase Functions config / secrets — never hardcode it.

const axios = require("axios");
const { BIGISUB_BASE_URL } = require("./config");

function client(token) {
  return axios.create({
    baseURL: BIGISUB_BASE_URL,
    headers: { Authorization: `Token ${token}` },
    timeout: 15000,
  });
}

/**
 * Fetch one page of services from BigiSub, optionally filtered by platform.
 */
async function fetchServicesPage(token, { platform, page = 1, pageSize = 100 } = {}) {
  const api = client(token);
  const params = { page, page_size: pageSize };
  if (platform) params.platform = platform;

  const res = await api.get("/api/v2/marketinghub/services/", { params });
  if (!res.data?.success) {
    throw new Error(`BigiSub services fetch failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.data; // { count, next, previous, results }
}

/**
 * Fetch ALL services for a platform, paging through until `next` is null.
 */
async function fetchAllServicesForPlatform(token, platform, pageSize = 100) {
  let page = 1;
  let all = [];
  // Bigisub pages via `next` URL, but we can also just page by number until results run dry.
  while (true) {
    const data = await fetchServicesPage(token, { platform, page, pageSize });
    all = all.concat(data.results || []);
    if (!data.next || (data.results || []).length === 0) break;
    page += 1;
  }
  return all;
}

/**
 * Place an order with BigiSub. `body` shape depends on service variant —
 * caller is responsible for building the right payload (see order variants in the API doc).
 */
async function createOrder(token, body) {
  const api = client(token);
  const res = await api.post("/api/v2/marketinghub/order/create/", body);
  if (!res.data?.success) {
    throw new Error(`BigiSub order create failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.data.order;
}

async function getOrderStatus(token, orderId) {
  const api = client(token);
  const res = await api.get("/api/v2/marketinghub/order/status/", {
    params: { order_id: orderId },
  });
  if (!res.data?.success) {
    throw new Error(`BigiSub order status fetch failed: ${JSON.stringify(res.data)}`);
  }
  return res.data.data.order;
}

module.exports = {
  fetchServicesPage,
  fetchAllServicesForPlatform,
  createOrder,
  getOrderStatus,
};
EOF_FNBIGISUB

# ---- functions/index.js ----
cat > functions/index.js << 'EOF_FNINDEX'
// index.js
// Entry point for all Cloud Functions.

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const { PLATFORMS, MARKUP, PAGE_SIZE } = require("./config");
const bigisub = require("./bigisub");

initializeApp();
const db = getFirestore();

// Store your BigiSub token as a Firebase secret, never in code:
//   firebase functions:secrets:set BIGISUB_TOKEN
const BIGISUB_TOKEN = defineSecret("BIGISUB_TOKEN");

// ---------------------------------------------------------------------------
// 1. SCHEDULED SYNC — pulls live services from BigiSub, applies markup, writes
//    to Firestore. Runs every 6 hours. Your app reads from Firestore, never
//    hits BigiSub directly from the client.
// ---------------------------------------------------------------------------
exports.syncServices = onSchedule(
  {
    schedule: "every 6 hours",
    secrets: [BIGISUB_TOKEN],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const token = BIGISUB_TOKEN.value();
    let totalSynced = 0;

    for (const platform of PLATFORMS) {
      console.log(`Syncing platform: ${platform}`);
      const services = await bigisub.fetchAllServicesForPlatform(token, platform, PAGE_SIZE);

      // Batch writes — Firestore caps batches at 500 ops, so chunk it.
      const chunks = chunk(services, 400);
      for (const group of chunks) {
        const batch = db.batch();
        for (const svc of group) {
          const costPrice = parseFloat(svc.price);
          const sellPrice = round2(costPrice * (1 + MARKUP));

          const ref = db.collection("services").doc(String(svc.service_id));
          batch.set(
            ref,
            {
              service_id: svc.service_id,
              name: svc.name,
              platform: svc.platform,
              country: svc.country,
              category: svc.category,
              description: svc.description || "",
              cost_price: costPrice,
              sell_price: sellPrice,
              pricing_model: svc.pricing_model,
              min_quantity: svc.min_quantity,
              max_quantity: svc.max_quantity,
              is_active: svc.is_active,
              service_type: svc.service_type,
              has_dripfeed: !!svc.has_dripfeed,
              has_refill: !!svc.has_refill,
              has_cancel: !!svc.has_cancel,
              synced_at: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        await batch.commit();
        totalSynced += group.length;
      }
    }

    console.log(`Sync complete. Total services synced: ${totalSynced}`);
    return null;
  }
);

// ---------------------------------------------------------------------------
// 2. PLACE ORDER — callable from the app. Re-validates price server-side
//    (never trusts a client-sent amount), deducts wallet atomically, then
//    calls BigiSub to place the order.
// ---------------------------------------------------------------------------
exports.placeOrder = onCall({ secrets: [BIGISUB_TOKEN] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in to place an order.");
  }

  const { serviceId, link, quantity, username } = request.data || {};
  if (!serviceId || !quantity) {
    throw new HttpsError("invalid-argument", "serviceId and quantity are required.");
  }

  const serviceRef = db.collection("services").doc(String(serviceId));
  const userRef = db.collection("users").doc(uid);

  // Read service + user, validate, deduct wallet — all inside one transaction
  // so two simultaneous orders can't double-spend the same balance.
  const { totalCost, service } = await db.runTransaction(async (tx) => {
    const serviceSnap = await tx.get(serviceRef);
    if (!serviceSnap.exists) {
      throw new HttpsError("not-found", "Service not found.");
    }
    const svc = serviceSnap.data();

    if (!svc.is_active) {
      throw new HttpsError("failed-precondition", "This service is currently unavailable.");
    }
    if (quantity < svc.min_quantity || quantity > svc.max_quantity) {
      throw new HttpsError(
        "invalid-argument",
        `Quantity must be between ${svc.min_quantity} and ${svc.max_quantity}.`
      );
    }

    // sell_price is per-unit (matches BigiSub's per_1000/per_unit model already
    // stored during sync) — adjust this math if you store price per 1000 instead.
    const totalCost = round2(svc.sell_price * quantity);

    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User wallet not found.");
    }
    const wallet = userSnap.data().wallet_balance || 0;

    if (wallet < totalCost) {
      throw new HttpsError("failed-precondition", "Insufficient wallet balance.");
    }

    tx.update(userRef, { wallet_balance: FieldValue.increment(-totalCost) });

    return { totalCost, service: svc };
  });

  // Wallet already deducted at this point. Now call BigiSub.
  let bigisubOrder;
  try {
    const orderBody = { service_id: service.service_id, quantity };
    if (link) orderBody.link = link;
    if (username) orderBody.username = username;

    bigisubOrder = await bigisub.createOrder(BIGISUB_TOKEN.value(), orderBody);
  } catch (err) {
    // BigiSub call failed AFTER wallet was deducted — refund immediately.
    await userRef.update({ wallet_balance: FieldValue.increment(totalCost) });
    console.error("BigiSub order failed, wallet refunded:", err.message);
    throw new HttpsError("internal", "Order failed with provider. Your wallet has been refunded.");
  }

  // Record the order in Firestore for the user's order history.
  const orderRef = await db.collection("orders").add({
    uid,
    service_id: service.service_id,
    service_name: service.name,
    platform: service.platform,
    link: link || null,
    username: username || null,
    quantity,
    unit_price: service.sell_price,
    total_amount: totalCost,
    status: bigisubOrder.status || "processing",
    bigisub_order_id: bigisubOrder.id,
    bigisub_tran_id: bigisubOrder.tran_id,
    created_at: FieldValue.serverTimestamp(),
  });

  return {
    orderId: orderRef.id,
    trackingId: bigisubOrder.tran_id,
    status: bigisubOrder.status,
    totalCharged: totalCost,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
EOF_FNINDEX

# ---- scripts/generate-config.js ----
cat > scripts/generate-config.js << 'EOF_GENCONFIG'
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
  "FLW_PUBLIC_KEY",
  "VAPID_PUBLIC_KEY",
  "FUNCTIONS_BASE_URL", // e.g. https://us-central1-yourproject.cloudfunctions.net
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
EOF_GENCONFIG

# ---- public/config.example.js ----
cat > public/config.example.js << 'EOF_PUBCONFIGEX'
// This file is a placeholder for local dev only.
// On Netlify, scripts/generate-config.js OVERWRITES this with real values
// pulled from Netlify env vars at build time. This placeholder version
// (with empty strings) is the only one that ever gets committed to git.
window.APP_CONFIG = {
  "FIREBASE_WEB_API_KEY": "",
  "FIREBASE_PROJECT_ID": "",
  "FIREBASE_AUTH_DOMAIN": "",
  "FIREBASE_STORAGE_BUCKET": "",
  "FIREBASE_MESSAGING_SENDER_ID": "",
  "FIREBASE_APP_ID": "",
  "FLW_PUBLIC_KEY": "",
  "VAPID_PUBLIC_KEY": "",
  "FUNCTIONS_BASE_URL": ""
};
EOF_PUBCONFIGEX

# ---- public/index.html ----
cat > public/index.html << 'EOF_PUBINDEX'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Olvra Boost</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg: #F4F7FE;
    --surface: #FFFFFF;
    --surface-2: #EEF3FF;
    --surface-3: #E1EAFF;
    --blue: #2C5CF6;
    --blue-deep: #1339B0;
    --sky: #16B8E0;
    --amber: #FF9F43;
    --red: #E5484D;
    --green: #12B76A;
    --text: #10162B;
    --muted: #6B7590;
    --muted-2: #9AA3C0;
    --line: rgba(16,22,54,0.08);
    --radius: 20px;
    --shadow: 0 6px 22px rgba(23,43,133,0.08);
  }
  *{ box-sizing: border-box; margin:0; padding:0; -webkit-tap-highlight-color: transparent; }
  html, body{ background: var(--bg); color: var(--text); font-family:'Inter',sans-serif; min-height:100vh; }
  body{
    max-width:460px; margin:0 auto; padding-bottom:96px;
    background:
      radial-gradient(600px 300px at 20% -5%, rgba(44,92,246,0.08), transparent 60%),
      radial-gradient(500px 260px at 100% 0%, rgba(22,184,224,0.07), transparent 55%),
      var(--bg);
    position:relative;
  }

  /* Header */
  .header{ display:flex; align-items:center; justify-content:space-between; padding:22px 20px 6px; }
  .header-left{ display:flex; align-items:center; gap:12px; }
  .avatar{
    width:42px; height:42px; border-radius:50%;
    background: linear-gradient(145deg, var(--blue), var(--blue-deep));
    display:flex; align-items:center; justify-content:center;
    font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:15px; color:#fff;
    box-shadow: 0 6px 16px rgba(44,92,246,0.28);
  }
  .header-text .greet{ font-size:12.5px; color:var(--muted); letter-spacing:0.02em; }
  .header-text .name{ font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:15.5px; margin-top:1px; }
  .bell-btn{
    width:40px; height:40px; border-radius:12px; background:var(--surface);
    border:1px solid var(--line); box-shadow:var(--shadow);
    display:flex; align-items:center; justify-content:center; position:relative;
  }

  /* Wallet */
  .wallet-wrap{ padding:18px 16px 4px; }
  .wallet-card{
    position:relative; overflow:hidden;
    background: linear-gradient(160deg,#EAF0FF 0%,#FFFFFF 60%);
    border:1px solid rgba(44,92,246,0.16); border-radius:var(--radius);
    padding:24px 22px 22px; box-shadow:0 14px 34px rgba(23,43,133,0.10);
  }
  .wallet-label{ font-size:11.5px; letter-spacing:0.14em; color:var(--muted); font-weight:600; text-transform:uppercase; }
  .wallet-row{ display:flex; align-items:baseline; gap:12px; margin-top:10px; }
  .wallet-balance{ font-family:'JetBrains Mono',monospace; font-weight:700; font-size:34px; letter-spacing:-0.01em; font-variant-numeric:tabular-nums; }
  .wallet-actions{ display:flex; gap:10px; margin-top:18px; }
  .btn{
    flex:1; padding:12px; border-radius:14px; border:none; font-weight:600; font-size:14px;
    font-family:'Inter',sans-serif; cursor:pointer;
  }
  .btn-primary{ background:linear-gradient(145deg,var(--blue),var(--blue-deep)); color:#fff; box-shadow:0 8px 20px rgba(44,92,246,0.3); }
  .btn-ghost{ background:var(--surface); border:1px solid var(--line); color:var(--text); }

  /* Platform grid */
  .section-title{ font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:15px; padding:22px 20px 10px; }
  .platform-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; padding:0 16px; }
  .platform-tile{
    background:var(--surface); border:1px solid var(--line); border-radius:16px;
    padding:14px 8px; display:flex; flex-direction:column; align-items:center; gap:6px;
    box-shadow:var(--shadow); cursor:pointer;
  }
  .platform-tile .dot{ width:34px; height:34px; border-radius:50%; }
  .platform-tile span{ font-size:11px; color:var(--muted); font-weight:600; }

  /* Orders */
  .order-list{ padding:0 16px; display:flex; flex-direction:column; gap:10px; }
  .order-row{
    background:var(--surface); border:1px solid var(--line); border-radius:14px;
    padding:14px; display:flex; justify-content:space-between; align-items:center;
    box-shadow:var(--shadow); font-size:13px;
  }
  .order-status{ font-size:11px; font-weight:700; padding:4px 8px; border-radius:8px; }
  .status-processing{ background:#FFF4E5; color:var(--amber); }
  .status-completed{ background:#E7F9F1; color:var(--green); }
  .status-failed{ background:#FDECEC; color:var(--red); }

  .empty-state{ text-align:center; padding:30px 20px; color:var(--muted-2); font-size:13px; }
  .hidden{ display:none !important; }

  /* Auth screen */
  .auth-wrap{ padding:40px 24px; }
  .auth-title{ font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:22px; margin-bottom:6px; }
  .auth-sub{ color:var(--muted); font-size:13.5px; margin-bottom:24px; }
  .input{
    width:100%; padding:14px 16px; border-radius:14px; border:1px solid var(--line);
    background:var(--surface); font-size:14px; margin-bottom:12px; font-family:'Inter',sans-serif;
  }
  #toast{
    position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
    background:var(--text); color:#fff; padding:12px 20px; border-radius:12px;
    font-size:13px; opacity:0; transition:opacity 0.25s; pointer-events:none; z-index:999;
  }
  #toast.show{ opacity:1; }
</style>
</head>
<body>

  <!-- AUTH SCREEN -->
  <div id="auth-screen" class="auth-wrap">
    <div class="auth-title">Welcome to Olvra Boost</div>
    <div class="auth-sub">Sign in to manage your orders and wallet</div>
    <input class="input" id="auth-email" type="email" placeholder="Email">
    <input class="input" id="auth-password" type="password" placeholder="Password">
    <button class="btn btn-primary" style="width:100%" id="auth-submit">Sign In</button>
    <p style="text-align:center;margin-top:14px;font-size:13px;color:var(--muted)">
      No account? <a href="#" id="auth-toggle" style="color:var(--blue);font-weight:600;">Sign up</a>
    </p>
  </div>

  <!-- APP SHELL -->
  <div id="app-screen" class="hidden">
    <div class="header">
      <div class="header-left">
        <div class="avatar" id="avatar-initials">U</div>
        <div class="header-text">
          <div class="greet">Welcome back</div>
          <div class="name" id="user-name">—</div>
        </div>
      </div>
      <div class="bell-btn">🔔</div>
    </div>

    <div class="wallet-wrap">
      <div class="wallet-card">
        <div class="wallet-label">Wallet Balance</div>
        <div class="wallet-row">
          <div class="wallet-balance">₦<span id="wallet-balance">0.00</span></div>
        </div>
        <div class="wallet-actions">
          <button class="btn btn-primary" id="fund-wallet-btn">Fund Wallet</button>
          <button class="btn btn-ghost" id="history-btn">History</button>
        </div>
      </div>
    </div>

    <div class="section-title">Select Platform</div>
    <div class="platform-grid" id="platform-grid"></div>

    <div class="section-title">Recent Orders</div>
    <div class="order-list" id="order-list">
      <div class="empty-state">No orders yet — pick a platform above to get started.</div>
    </div>
  </div>

  <div id="toast"></div>

  <!-- Config generated at Netlify build time — see scripts/generate-config.js -->
  <script src="config.js"></script>

  <!-- Firebase SDKs -->
  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
    import {
      getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword
    } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
    import {
      getFirestore, doc, getDoc, collection, query, where, orderBy, limit, getDocs, onSnapshot
    } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
    import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

    const cfg = window.APP_CONFIG || {};
    const firebaseConfig = {
      apiKey: cfg.FIREBASE_WEB_API_KEY,
      authDomain: cfg.FIREBASE_AUTH_DOMAIN,
      projectId: cfg.FIREBASE_PROJECT_ID,
      storageBucket: cfg.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: cfg.FIREBASE_MESSAGING_SENDER_ID,
      appId: cfg.FIREBASE_APP_ID,
    };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const functions = getFunctions(app);

    window.__olvra = { app, auth, db, functions, httpsCallable };

    const authScreen = document.getElementById("auth-screen");
    const appScreen = document.getElementById("app-screen");
    const toast = document.getElementById("toast");

    function showToast(msg) {
      toast.textContent = msg;
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 2500);
    }

    let isSignup = false;
    document.getElementById("auth-toggle").onclick = (e) => {
      e.preventDefault();
      isSignup = !isSignup;
      document.getElementById("auth-submit").textContent = isSignup ? "Create Account" : "Sign In";
      e.target.textContent = isSignup ? "Sign in instead" : "Sign up";
    };

    document.getElementById("auth-submit").onclick = async () => {
      const email = document.getElementById("auth-email").value.trim();
      const password = document.getElementById("auth-password").value;
      if (!email || !password) return showToast("Enter email and password");
      try {
        if (isSignup) {
          await createUserWithEmailAndPassword(auth, email, password);
        } else {
          await signInWithEmailAndPassword(auth, email, password);
        }
      } catch (err) {
        showToast(err.message.replace("Firebase: ", ""));
      }
    };

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        authScreen.classList.add("hidden");
        appScreen.classList.remove("hidden");
        document.getElementById("user-name").textContent = user.email.split("@")[0];
        document.getElementById("avatar-initials").textContent = user.email[0].toUpperCase();
        loadWallet(user.uid);
        loadOrders(user.uid);
      } else {
        authScreen.classList.remove("hidden");
        appScreen.classList.add("hidden");
      }
    });

    function loadWallet(uid) {
      const ref = doc(db, "users", uid);
      onSnapshot(ref, (snap) => {
        const bal = snap.exists() ? (snap.data().wallet_balance || 0) : 0;
        document.getElementById("wallet-balance").textContent = bal.toLocaleString(undefined, { minimumFractionDigits: 2 });
      });
    }

    async function loadOrders(uid) {
      const q = query(collection(db, "orders"), where("uid", "==", uid), orderBy("created_at", "desc"), limit(10));
      const snap = await getDocs(q);
      const list = document.getElementById("order-list");
      if (snap.empty) return;
      list.innerHTML = "";
      snap.forEach((d) => {
        const o = d.data();
        const statusClass = o.status === "completed" ? "status-completed" : o.status === "failed" ? "status-failed" : "status-processing";
        list.innerHTML += `
          <div class="order-row">
            <div>
              <div style="font-weight:600">${o.service_name || "Order"}</div>
              <div style="color:var(--muted);font-size:11.5px">${o.quantity} units · ₦${o.total_amount}</div>
            </div>
            <div class="order-status ${statusClass}">${o.status}</div>
          </div>`;
      });
    }

    // Platform tiles — wire these to your service-selection page/route
    const platforms = [
      { name: "Instagram", color: "#E1306C" },
      { name: "Facebook", color: "#1877F2" },
      { name: "TikTok", color: "#000000" },
      { name: "Twitter", color: "#1DA1F2" },
      { name: "YouTube", color: "#FF0000" },
    ];
    const grid = document.getElementById("platform-grid");
    platforms.forEach((p) => {
      const tile = document.createElement("div");
      tile.className = "platform-tile";
      tile.innerHTML = `<div class="dot" style="background:${p.color}"></div><span>${p.name}</span>`;
      tile.onclick = () => { window.location.href = `/services.html?platform=${p.name.toLowerCase()}`; };
      grid.appendChild(tile);
    });

    document.getElementById("fund-wallet-btn").onclick = () => {
      window.location.href = "/fund.html";
    };
    document.getElementById("history-btn").onclick = () => {
      window.location.href = "/orders.html";
    };
  </script>
</body>
</html>
EOF_PUBINDEX

chmod +x setup-secrets.sh
echo "Done. Files created:"
find . -type f -not -path "./.git/*" | sort