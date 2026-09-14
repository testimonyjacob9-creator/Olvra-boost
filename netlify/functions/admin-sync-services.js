// netlify/functions/admin-sync-services.js
//
// POST /.netlify/functions/admin-sync-services
// Headers: Authorization: Bearer <Firebase ID token>
//
// Lets an admin trigger the BigiSub → Firestore services sync on demand
// from the admin dashboard, instead of waiting for the daily cron
// (sync-services.js, netlify.toml) or needing the SYNC_TRIGGER_SECRET URL
// trick (sync-services-manual.js). Gated by Firestore admins/{uid} — Admin
// SDK bypasses firestore.rules, so that check has to happen here explicitly.
//
// COOLDOWN (added 2026-09-15): each run reads the ENTIRE existing services
// collection (~5,900 documents) per platform to diff against BigiSub's
// live catalog, even when nothing changed. With no rate limit, a few
// impatient re-taps of "Sync now" during testing could burn tens of
// thousands of reads in minutes — almost certainly what actually drove
// the Spark plan's 50K/day quota to blow out, not real user traffic.

const { db, FieldValue } = require("./_lib/firebase-admin");
const { requireAuth } = require("./_lib/require-auth");
const { ok, fail } = require("./_lib/respond");
const { runSync } = require("./_lib/sync-services-core");

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min — plenty to prevent accidental repeat-taps, short enough not to get in the way of real use

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

    const cooldownRef = db.collection("catalog_meta").doc("last_manual_sync");
    const cooldownSnap = await cooldownRef.get();
    if (cooldownSnap.exists) {
      const lastRunMs = cooldownSnap.data().at?.toDate?.().getTime();
      if (lastRunMs && Date.now() - lastRunMs < COOLDOWN_MS) {
        const waitSec = Math.ceil((COOLDOWN_MS - (Date.now() - lastRunMs)) / 1000);
        throw Object.assign(
          new Error(`A sync just ran — wait ${waitSec}s before running another one. The full catalog scan is expensive; back-to-back runs waste reads for no benefit.`),
          { statusCode: 429 }
        );
      }
    }
    await cooldownRef.set({ at: FieldValue.serverTimestamp() }, { merge: true });

    const { totalSynced, perPlatform } = await runSync();
    return ok({ success: true, totalSynced, perPlatform });
  } catch (err) {
    return fail(err);
  }
};
