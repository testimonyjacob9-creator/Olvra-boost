// netlify/functions/reengage-users.js
//
// Scheduled job (see netlify.toml) — runs automatically, no admin action
// needed. Finds users who haven't been active in 2+ days and sends them
// a low-key "come back" email from Olives, reminding them of their
// wallet/Olive balance.
//
// PATTERN ADAPTED FROM WoodPayVTU's reengage-inactive-users.js (2026-09-07)
// — same app family, same problem, already solved there. Key idea reused:
//
// WHY DAILY CRON + PER-USER GATING INSTEAD OF A "RUN EVERY 2 DAYS" CRON:
// Standard cron can't express "every 2 days starting from whenever each
// user went inactive" — a `*/2` day-of-month field just means odd
// calendar days, drifting out of sync with each user's own inactivity
// clock. Instead this runs once a day, and gates who actually gets
// messaged with last_reengagement_sent_at, so any single user is still
// only ever messaged about once every 2 days, measured from their own
// activity.
//
// Activity tracking: users.last_activity_at is stamped by place-order.js
// (any order attempt) and flutterwave-webhook.js (wallet funding).
// Users who've never done either use created_at as the baseline.
//
// Tone is deliberately understated (no discount codes, no "LIMITED TIME",
// no exclamation-heavy copy) — reads like a normal account email, which
// keeps it out of Gmail's Promotions tab and spam filters far more
// reliably than a marketing-styled blast would. Testimony's ask was to
// "lure them... without going to spam" — this is exactly the lever that
// actually achieves that; overly salesy copy is what triggers spam
// filters and Promotions-tab sorting, not frequency.
//
// Respects marketing_opt_out (unsubscribe.js) — same as the admin
// broadcast email.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { sendEmail } = require("./_lib/brevo");
const { renderEmail } = require("./_lib/email-template");

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 15;

function naira(n) {
  return Number(n || 0).toLocaleString("en-NG");
}

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts._seconds != null) return ts._seconds * 1000;
  return null;
}

// A few rotating openers so 28 emails every 2 days don't all read as an
// identical templated blast — varies the copy without varying the
// substance (still just "here's your balance, come place an order").
// Picked by a stable hash of the uid so the SAME user doesn't just see
// a random one each time either — deliberate, not jarring.
const OPENERS = [
  "It's been a couple of days since your last order, so here's a quick reminder of where your account stands.",
  "Just checking in — your Olvra Boost account has been quiet for a bit.",
  "A quick nudge from Olives: your wallet and Olives are just sitting here, ready when you are.",
];
function pickOpener(uid) {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  return OPENERS[hash % OPENERS.length];
}

async function sendReengagementEmail(uid, user) {
  const opener = pickOpener(uid);
  const olives = user.olive_balance || 0;
  const oliveLine = olives > 0
    ? `<p style="margin:0 0 14px;">You've also got <b>🫒 ${olives} Olive${olives === 1 ? "" : "s"}</b> (worth ₦${olives * 2}) waiting to be spent on any order.</p>`
    : "";

  const bodyHtml = `
    <p style="margin:0 0 14px;">${opener}</p>
    <div style="background:#EEF3FF;border-radius:12px;padding:16px 18px;margin:16px 0;">
      <div style="font-size:11px;color:#2C5CF6;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Wallet balance</div>
      <div style="font-size:24px;color:#10162B;font-weight:800;margin-top:4px;">₦${naira(user.wallet_balance)}</div>
    </div>
    ${oliveLine}
    <p style="margin:0;">Instagram, TikTok, Facebook and more — real growth, fast delivery, whenever you're ready.</p>`;

  const html = renderEmail({
    title: "🫒 Olives here — just checking in",
    bodyHtml,
    ctaText: "Open Olvra Boost",
    ctaUrl: "https://olvraboost.netlify.app",
    unsubscribeUrl: `https://olvraboost.netlify.app/.netlify/functions/unsubscribe?uid=${uid}`,
  });

  return sendEmail({
    to: user.email,
    toName: user.name,
    subject: `Your Olvra Boost balance: ₦${naira(user.wallet_balance)}`,
    html,
  });
}

exports.handler = async () => {
  const now = Date.now();
  const cutoff = now - TWO_DAYS_MS;

  let usersSnap;
  try {
    usersSnap = await db.collection("users").get();
  } catch (err) {
    console.error("reengage-users: could not load users:", err.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
  }

  const candidates = [];
  usersSnap.forEach((doc) => {
    const u = doc.data();
    if (u.suspended) return;
    if (!u.email) return;
    if (u.marketing_opt_out) return;

    const createdAtMs = toMillis(u.created_at);
    // Account itself must be at least 2 days old — brand-new signups
    // don't need a "come back" nudge yet.
    if (createdAtMs && createdAtMs > cutoff) return;

    const lastActivityMs = toMillis(u.last_activity_at) || createdAtMs;
    if (lastActivityMs && lastActivityMs > cutoff) return; // active recently — skip

    const lastSentMs = toMillis(u.last_reengagement_sent_at);
    if (lastSentMs && lastSentMs > cutoff) return; // already nudged within 2 days

    candidates.push({ uid: doc.id, ...u });
  });

  console.log(`reengage-users: ${candidates.length} inactive user(s) out of ${usersSnap.size} total`);

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (user) => {
      try {
        await sendReengagementEmail(user.uid, user);
        sent += 1;
      } catch (err) {
        console.error(`reengage-users: email failed for ${user.email}:`, err.message);
        failed += 1;
      }
      // Stamped regardless of email success — a user whose email keeps
      // failing shouldn't get retried every single day; that's a
      // separate deliverability problem, not something more attempts fixes.
      try {
        await db.collection("users").doc(user.uid).update({
          last_reengagement_sent_at: FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.error(`reengage-users: could not stamp last_reengagement_sent_at for ${user.uid}:`, err.message);
      }
    }));
  }

  console.log(`reengage-users: done — ${sent} sent, ${failed} failed, ${candidates.length} candidates`);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, checked: usersSnap.size, matched: candidates.length, sent, failed }),
  };
};
