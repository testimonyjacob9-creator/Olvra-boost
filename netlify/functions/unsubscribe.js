// netlify/functions/unsubscribe.js
//
// GET /.netlify/functions/unsubscribe?uid=<uid>
//
// One-click unsubscribe from marketing emails (admin broadcasts + the
// automated Olives re-engagement email) — required for these to be
// compliant, not just polite. Does NOT affect transactional emails
// (order confirmations, wallet funding receipts, password resets) —
// those aren't marketing and don't check this flag.
//
// Deliberately simple (uid in the query string, no signature) — worst
// case someone unsubscribes another user as a prank, which is a minor
// annoyance, not a security or financial risk. Not worth the extra
// complexity of signed tokens at this app's scale.

const { db, FieldValue } = require("./_lib/firebase-admin");

function page(message) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Unsubscribed — Olvra Boost</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background: #F4F7FE; margin: 0; padding: 40px 20px; text-align: center; color: #10162B; }
  .card { max-width: 400px; margin: 0 auto; background: #fff; border-radius: 20px; padding: 32px 24px; box-shadow: 0 6px 22px rgba(23,43,133,0.08); }
  h1 { font-size: 18px; margin: 0 0 10px; }
  p { color: #6B7590; font-size: 14px; line-height: 1.6; }
  a { color: #2C5CF6; text-decoration: none; font-weight: 700; }
</style></head>
<body><div class="card"><h1>🫒 Olvra Boost</h1><p>${message}</p><p><a href="https://olvraboost.netlify.app">Back to Olvra Boost</a></p></div></body></html>`,
  };
}

exports.handler = async (event) => {
  const uid = event.queryStringParameters?.uid;
  if (!uid) {
    return page("Missing link — nothing to unsubscribe.");
  }
  try {
    await db.collection("users").doc(uid).update({
      marketing_opt_out: true,
      marketing_opt_out_at: FieldValue.serverTimestamp(),
    });
    return page("You've been unsubscribed from marketing emails. You'll still get order and wallet receipts — those aren't marketing.");
  } catch (err) {
    console.error("unsubscribe failed:", err.message);
    return page("Something went wrong — try again shortly, or just ignore future emails.");
  }
};
