// netlify/functions/contact-support.js
//
// POST /.netlify/functions/contact-support
// Headers: Authorization: Bearer <Firebase ID token>
// Body:    { message, attachment?: { content: base64, name, mime } }
//
// Used by the "Olives" chat widget's escalate-to-a-human flow. Emails
// SUPPORT_EMAIL (olvraboost@outlook.com) with replyTo set to the user's own
// address, so support can just hit reply. Also saves a copy to Firestore
// `support_messages` for a record even if email delivery fails.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const { sendEmail, supportEscalationEmail } = require("./_lib/brevo");

const SUPPORT_EMAIL = "olvraboost@outlook.com";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const uid = decoded.uid;
    const userEmail = decoded.email || "unknown@user.com";

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
    }

    const { message, attachment } = body;
    if (!message && !attachment) {
      throw Object.assign(new Error("message or attachment is required."), { statusCode: 400 });
    }

    // Always record it, even if the email send below fails.
    const docRef = await db.collection("support_messages").add({
      uid,
      email: userEmail,
      message: message || "(screenshot attached)",
      has_attachment: !!attachment,
      created_at: FieldValue.serverTimestamp(),
    });

    let emailed = true;
    try {
      const { subject, html } = supportEscalationEmail({
        userEmail,
        message: message || "(screenshot attached)",
        hasAttachment: !!attachment,
      });
      await sendEmail({
        to: SUPPORT_EMAIL,
        subject,
        html,
        replyTo: userEmail,
        attachment: attachment ? { content: attachment.content, name: attachment.name } : undefined,
      });
    } catch (emailErr) {
      console.error("contact-support email failed:", emailErr.message);
      emailed = false;
      // Flag it on the saved record so it's visible in the admin Support tab —
      // this is the safety net when email delivery fails, not a duplicate channel.
      try {
        await db.collection("support_messages").doc(docRef.id).update({ email_failed: true });
      } catch (flagErr) {
        console.error("Failed to flag email_failed on support message:", flagErr.message);
      }
    }

    return ok({ received: true, emailed });
  } catch (err) {
    return fail(err);
  }
};
