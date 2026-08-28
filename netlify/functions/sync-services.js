// netlify/functions/sync-services.js
// SCHEDULED FUNCTION — pulls live services from BigiSub, applies markup, writes
// to Firestore. Runs every 6 hours (see schedule in netlify.toml). The app
// reads from Firestore, never hits BigiSub directly from the client.
//
// Netlify scheduled functions ignore whatever you return to the caller —
// there is no caller, it's cron — so we just log and swallow the result.
// IMPORTANT: this does NOT run immediately after a deploy — only at its
// next scheduled cron tick. To force an immediate run (e.g. right after
// first deploying, or to test that BIGISUB_TOKEN actually works), use
// sync-services-manual.js instead.

const { runSync } = require("./_lib/sync-services-core");

exports.handler = async () => {
  try {
    const { totalSynced } = await runSync();
    console.log(`Sync complete. Total services synced: ${totalSynced}`);
    return { statusCode: 200, body: `Synced ${totalSynced} services` };
  } catch (err) {
    console.error("Sync failed:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
