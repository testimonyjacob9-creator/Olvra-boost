// netlify/functions/sync-services-owlet.js
// SCHEDULED FUNCTION — syncs Owlet's ("Global Source") catalog into
// Firestore. Runs once a DAY (see netlify.toml), not every 6 hours like
// BigiSub — Owlet's matched catalog is roughly 10x BigiSub's size, so
// syncing it that often was eating a large chunk of the daily Firestore
// write quota for a catalog that doesn't need that much freshness.
// (2026-09-03 — this was the main driver behind hitting the daily quota.)
//
// Split into its own function/schedule rather than a flag inside
// sync-services.js so the two can run at genuinely different times/
// frequencies without one blocking the other.

const { runSync } = require("./_lib/sync-services-core");

exports.handler = async () => {
  try {
    const { owletSynced } = await runSync({ includeBigisub: false });
    console.log(`Owlet sync complete. Total services synced: ${owletSynced}`);
    return { statusCode: 200, body: `Synced ${owletSynced} Owlet services` };
  } catch (err) {
    console.error("Owlet sync failed:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
