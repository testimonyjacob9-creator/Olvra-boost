// netlify/functions/admin-sync-services.js
//
// POST /.netlify/functions/admin-sync-services
// Headers: Authorization: Bearer <Firebase ID token>
//
// Lets an admin trigger the BigiSub → Firestore services sync on demand
// from the admin dashboard, instead of waiting for the 6-hour cron
// (sync-services.js) or needing the SYNC_TRIGGER_SECRET URL trick
// (sync-services-manual.js). Gated by Firestore admins/{uid} — Admin SDK
// bypasses firestore.rules, so that check has to happen here explicitly.

const { db } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const { runSync } = require("./_lib/sync-services-core");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return fail(Object.assign(new Error("Method not allowed"), { statusCode: 405 }));
  }

  try {
    const decoded = await requireAuth(event);
    const adminSnap = await db.collection("admins").doc(decoded.uid).get();
    if (!adminSnap.exists) {
      throw Object.assign(new Error("Admin access required."), { statusCode: 403 });
    }

    const { totalSynced, perPlatform } = await runSync();
    return ok({ success: true, totalSynced, perPlatform });
  } catch (err) {
    return fail(err);
  }
};
