// public/js/onboarding.js
// A short, mandatory "how this works + terms" flow shown once per user
// before their FIRST order. Gated at order time (not page load) so
// browsing stays frictionless — the interruption only happens right
// before money moves.
//
// Acceptance is stored in two places:
//   - localStorage (instant, no network round-trip on repeat visits)
//   - users/{uid}.onboarding_accepted_version (Firestore — so acceptance
//     is remembered across devices/reinstalls, and so we have a record)
//
// Bump ONBOARDING_VERSION any time the terms change meaningfully; that
// invalidates prior acceptance and shows the flow again.

import { doc, getDoc, setDoc, serverTimestamp } from "./firebase-sdk.bundle.js";

const ONBOARDING_VERSION = "v1";
const LOCAL_KEY = `olvra_onboarding_accepted_${ONBOARDING_VERSION}`;

const NUMBERS_ONBOARDING_VERSION = "numbers_v1";
const NUMBERS_LOCAL_KEY = `olvra_numbers_onboarding_accepted_${NUMBERS_ONBOARDING_VERSION}`;

const STEPS = [
  {
    icon: "🛒",
    title: "How ordering works",
    body: `
      <ol class="ob-list">
        <li>Pick a service and enter the link or username it applies to.</li>
        <li>Choose a quantity — cost updates live as you type.</li>
        <li>Confirm. The amount is deducted from your wallet immediately.</li>
        <li>Your order is sent to our delivery network and starts processing.</li>
      </ol>
    `,
  },
  {
    icon: "⏱️",
    title: "Delivery expectations",
    body: `
      <ul class="ob-list">
        <li><b>Speed varies.</b> Some orders complete in minutes, others take hours — check the estimate shown on each service before ordering.</li>
        <li><b>Delivery can be partial.</b> If a service can't fully deliver, whatever's missing is refunded to your wallet automatically.</li>
        <li><b>Track anytime.</b> Every order's live status is on your Orders page — pending, processing, completed, or refunded.</li>
      </ul>
    `,
  },
  {
    icon: "🔁",
    title: "Refill & cancel",
    body: `
      <ul class="ob-list">
        <li>Where a service supports <b>Refill</b>, you can request it if numbers drop later.</li>
        <li>Where a service supports <b>Cancel</b>, you can stop an in-progress order — you're refunded for whatever wasn't delivered yet.</li>
        <li>These options only appear on services that support them, and aren't guaranteed on every order.</li>
      </ul>
    `,
  },
  {
    icon: "📄",
    title: "Before you place your first order",
    isTerms: true,
    body: `
      <ul class="ob-list">
        <li>Orders are fulfilled by third-party delivery providers, not by Olvra Boost directly.</li>
        <li>Only order for accounts, pages, or links you own or have permission to promote.</li>
        <li>Failed or cancelled orders are refunded to your wallet automatically — no need to contact support unless it's been over 48 hours.</li>
        <li>Results (follower/engagement quality) can vary by service and are not guaranteed to be permanent.</li>
      </ul>
    `,
  },
];

const NUMBERS_STEPS = [
  {
    icon: "📱",
    title: "How Rent Number works",
    body: `
      <ol class="ob-list">
        <li>Pick a service (WhatsApp, Telegram, Google, etc.) and a country.</li>
        <li>Pick a price — you're shown a live list of numbers actually available right now.</li>
        <li>The price is deducted from your wallet and you get a real phone number instantly.</li>
        <li>Use that number to sign up or verify on the service you picked, then wait for the code here.</li>
      </ol>
    `,
  },
  {
    icon: "⏳",
    title: "Time limit — read this",
    body: `
      <ul class="ob-list">
        <li>Every number has a countdown. If <b>no code arrives before it expires</b>, the order closes automatically and you're refunded in full — you don't need to contact support.</li>
        <li>Once a code <b>does</b> arrive, the number can no longer be cancelled for a refund — you're expected to actually use it at that point.</li>
        <li>A number can occasionally come back <b>"banned"</b> (already flagged by the service you're verifying on) — this also refunds automatically, same as a timeout.</li>
      </ul>
    `,
  },
  {
    icon: "📄",
    title: "Before you rent your first number",
    isTerms: true,
    body: `
      <ul class="ob-list">
        <li>Numbers are provided by a third-party SMS-verification provider, not by Olvra Boost directly — availability and delivery speed can vary by country and service.</li>
        <li>Only use rented numbers for lawful sign-ups and verifications. Olvra Boost does not support sending outgoing messages or calls from rented numbers.</li>
        <li>A number is single-use for the service you picked it for — it is not a personal phone line and shouldn't be shared publicly as one.</li>
        <li>Refunds are automatic for timed-out, cancelled, or banned orders with no code received. Once a code has been delivered, the order is considered fulfilled.</li>
      </ul>
    `,
  },
];

function injectStylesOnce() {
  if (document.getElementById("ob-styles")) return;
  const style = document.createElement("style");
  style.id = "ob-styles";
  style.textContent = `
    .ob-overlay {
      position:fixed; inset:0; background:rgba(16,22,54,0.55); z-index:60;
      display:flex; align-items:flex-end; justify-content:center;
    }
    .ob-modal {
      background:#fff; border-radius:22px 22px 0 0; width:100%; max-width:460px;
      padding:24px 22px 20px; max-height:90vh; overflow-y:auto; font-family:'Inter',-apple-system,sans-serif;
    }
    .ob-dots { display:flex; gap:6px; justify-content:center; margin-bottom:16px; }
    .ob-dot { width:22px; height:4px; border-radius:3px; background:#E3E8FA; }
    .ob-dot.active { background:#2C5CF6; }
    .ob-icon { font-size:34px; text-align:center; margin-bottom:10px; }
    .ob-title { font-size:17px; font-weight:700; text-align:center; margin:0 0 14px; color:#10162B; }
    .ob-list { margin:0; padding-left:18px; font-size:13.5px; line-height:1.6; color:#3A4160; }
    .ob-list li { margin-bottom:8px; }
    .ob-check-row {
      display:flex; align-items:flex-start; gap:10px; background:#EEF3FF; border-radius:12px;
      padding:12px 14px; margin-top:16px; font-size:12.5px; color:#1339B0; line-height:1.5;
    }
    .ob-check-row input { margin-top:2px; width:16px; height:16px; flex-shrink:0; }
    .ob-btn-row { display:flex; gap:10px; margin-top:20px; }
    .ob-btn {
      flex:1; padding:14px; border-radius:12px; border:none; font-weight:700; font-size:14px;
      cursor:pointer; font-family:inherit;
    }
    .ob-btn-primary { background:linear-gradient(135deg,#2C5CF6,#1339B0); color:#fff; }
    .ob-btn-primary:disabled { opacity:0.5; cursor:not-allowed; }
    .ob-btn-ghost { background:#EEF3FF; color:#1339B0; flex:0 0 auto; padding:14px 18px; }
  `;
  document.head.appendChild(style);
}

function renderStep(modal, steps, checkboxLabel, index, onDone) {
  const step = steps[index];
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  modal.innerHTML = `
    <div class="ob-dots">
      ${steps.map((_, i) => `<div class="ob-dot ${i === index ? "active" : ""}"></div>`).join("")}
    </div>
    <div class="ob-icon">${step.icon}</div>
    <h2 class="ob-title">${step.title}</h2>
    ${step.body}
    ${
      step.isTerms
        ? `<label class="ob-check-row">
             <input type="checkbox" id="ob-accept-checkbox">
             <span>${checkboxLabel}</span>
           </label>`
        : ""
    }
    <div class="ob-btn-row">
      ${!isFirst ? `<button class="ob-btn ob-btn-ghost" id="ob-back">Back</button>` : ""}
      <button class="ob-btn ob-btn-primary" id="ob-next" ${step.isTerms ? "disabled" : ""}>
        ${isLast ? "Accept & Continue" : "Next"}
      </button>
    </div>
  `;

  if (step.isTerms) {
    const checkbox = modal.querySelector("#ob-accept-checkbox");
    const nextBtn = modal.querySelector("#ob-next");
    checkbox.onchange = () => { nextBtn.disabled = !checkbox.checked; };
  }

  const backBtn = modal.querySelector("#ob-back");
  if (backBtn) backBtn.onclick = () => renderStep(modal, steps, checkboxLabel, index - 1, onDone);

  modal.querySelector("#ob-next").onclick = () => {
    if (isLast) onDone();
    else renderStep(modal, steps, checkboxLabel, index + 1, onDone);
  };
}

function showOnboardingModal(steps, checkboxLabel) {
  injectStylesOnce();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ob-overlay";
    const modal = document.createElement("div");
    modal.className = "ob-modal";
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    renderStep(modal, steps, checkboxLabel, 0, () => {
      document.body.removeChild(overlay);
      resolve();
    });
  });
}

/**
 * Resolves once the signed-in user has accepted the current onboarding
 * terms — either because they already had, or because they just did.
 * Call this right before placing a user's first order.
 */
export async function ensureOnboardingAccepted(db, user) {
  if (localStorage.getItem(LOCAL_KEY) === "1") return true;

  const userRef = doc(db, "users", user.uid);
  try {
    const snap = await getDoc(userRef);
    if (snap.exists() && snap.data().onboarding_accepted_version === ONBOARDING_VERSION) {
      localStorage.setItem(LOCAL_KEY, "1");
      return true;
    }
  } catch (err) {
    console.error("Onboarding check failed, will show flow to be safe:", err);
  }

  await showOnboardingModal(STEPS, "I've read this and understand how ordering, delivery, and refunds work on Olvra Boost.");

  localStorage.setItem(LOCAL_KEY, "1");
  try {
    await setDoc(
      userRef,
      { onboarding_accepted_version: ONBOARDING_VERSION, onboarding_accepted_at: serverTimestamp() },
      { merge: true }
    );
  } catch (err) {
    // Non-fatal — localStorage already has the flag for this device/browser.
    console.error("Failed to persist onboarding acceptance to Firestore:", err);
  }
  return true;
}

/**
 * Same gate as ensureOnboardingAccepted, but for the Rent Number flow —
 * separate content (numbers/timeouts/refunds instead of boost
 * ordering/delivery), separate acceptance flag, so accepting one never
 * silently counts as accepting the other.
 */
export async function ensureNumbersOnboardingAccepted(db, user) {
  if (localStorage.getItem(NUMBERS_LOCAL_KEY) === "1") return true;

  const userRef = doc(db, "users", user.uid);
  try {
    const snap = await getDoc(userRef);
    if (snap.exists() && snap.data().numbers_onboarding_accepted_version === NUMBERS_ONBOARDING_VERSION) {
      localStorage.setItem(NUMBERS_LOCAL_KEY, "1");
      return true;
    }
  } catch (err) {
    console.error("Numbers onboarding check failed, will show flow to be safe:", err);
  }

  await showOnboardingModal(NUMBERS_STEPS, "I've read this and understand how Rent Number's timeouts and refunds work.");

  localStorage.setItem(NUMBERS_LOCAL_KEY, "1");
  try {
    await setDoc(
      userRef,
      { numbers_onboarding_accepted_version: NUMBERS_ONBOARDING_VERSION, numbers_onboarding_accepted_at: serverTimestamp() },
      { merge: true }
    );
  } catch (err) {
    console.error("Failed to persist numbers onboarding acceptance to Firestore:", err);
  }
  return true;
}
