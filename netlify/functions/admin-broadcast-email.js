// netlify/functions/admin-broadcast-email.js
//
// POST /.netlify/functions/admin-broadcast-email
// Headers: Authorization: Bearer <Firebase ID token>  (must be an admin)
// Body:    { subject, message }
//
// Admin types a subject + plain message; this wraps it in the same
// branded template every other email uses and sends it to every user
// (except anyone who's unsubscribed — see unsubscribe.js). Admin never
// touches HTML — that's the whole point of the "already well designed,
// I just need to type" ask.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const { sendEmail } = require("./_lib/brevo");
const { renderEmail } = require("./_lib/email-template");

const CONCURRENCY = 15; // matches the same safe batch size WoodPayVTU's reengage job uses

async function assertAdmin(uid) {
  const snap = await db.collection("admins").doc(uid).get();
  if (!snap.exists) {
    throw Object.assign(new Error("Admin access required."), { statusCode: 403 });
  }
}

function escapeHtml(str) {
  const div = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  return String(str || "").replace(/[&<>]/g, (c) => div[c]);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    await assertAdmin(decoded.uid);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
    }
    const { subject, message } = body;
    if (!subject || !message) {
      throw Object.assign(new Error("subject and message are required."), { statusCode: 400 });
    }

    // One bulk read — fine at this app's scale (dozens of users). If the
    // user base grows into the thousands, this should move to paginated
    // batches instead of loading everyone into memory at once.
    const usersSnap = await db.collection("users").get();
    const recipients = [];
    usersSnap.forEach((doc) => {
      const u = doc.data();
      if (u.email && !u.marketing_opt_out) recipients.push({ uid: doc.id, email: u.email, name: u.name });
    });

    // Message paragraphs preserved, each line escaped individually so a
    // typed message can't inject HTML into the template.
    const bodyHtml = escapeHtml(message)
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => `<p style="margin:0 0 14px;">${line}</p>`)
      .join("");

    let sent = 0;
    let failed = 0;
    for (let i = 0; i < recipients.length; i += CONCURRENCY) {
      const batch = recipients.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (r) => {
        try {
          const html = renderEmail({
            title: subject,
            bodyHtml,
            ctaText: "Open Olvra Boost",
            ctaUrl: "https://olvraboost.netlify.app",
            unsubscribeUrl: `https://olvraboost.netlify.app/.netlify/functions/unsubscribe?uid=${r.uid}`,
          });
          await sendEmail({ to: r.email, toName: r.name, subject, html });
          sent += 1;
        } catch (err) {
          console.error(`Broadcast email failed for ${r.email}:`, err.message);
          failed += 1;
        }
      }));
    }

    return ok({ success: true, totalUsers: usersSnap.size, recipientCount: recipients.length, sent, failed });
  } catch (err) {
    return fail(err);
  }
};
