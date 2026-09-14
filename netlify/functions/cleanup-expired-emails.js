// netlify/functions/cleanup-expired-emails.js
// SCHEDULED FUNCTION (see netlify.toml) — Mail.tm is a free service with a
// fair-use policy; leaving expired accounts sitting around unused is the
// kind of thing that gets a free API's access pulled for everyone. This
// clears out anything past its expiry that check-temp-email.js's lazy
// cleanup never got triggered for (user closed the app before revisiting).

const { db } = require("./_lib/firebase-admin");
const mailtm = require("./_lib/mailtm");

exports.handler = async () => {
  const snap = await db.collection("email_orders").where("status", "==", "ACTIVE").get();
  if (snap.empty) return { statusCode: 200, body: "0 active inboxes" };

  const now = Date.now();
  let cleaned = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const order = doc.data();
    if (new Date(order.expires_at).getTime() > now) { skipped++; continue; }

    try {
      const token = await mailtm.getToken({ address: order.address, password: order.password });
      await mailtm.deleteAccount(token, order.account_id);
    } catch (err) {
      console.error(`cleanup-expired-emails: delete failed for ${doc.id}:`, err.message);
    }
    await doc.ref.update({ status: "EXPIRED" });
    cleaned++;
  }

  const summary = `Checked ${snap.size} active inbox(es): ${cleaned} expired & cleaned up, ${skipped} still within window.`;
  console.log("cleanup-expired-emails:", summary);
  return { statusCode: 200, body: summary };
};
