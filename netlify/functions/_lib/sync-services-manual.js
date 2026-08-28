// netlify/functions/sync-services-manual.js
// Same sync as sync-services.js, but callable on-demand by visiting its URL
// with a secret — Netlify blocks direct HTTP calls to scheduled functions,
// so this is the way to force an immediate sync (right after first deploy,
// or to test whether BIGISUB_TOKEN actually works) instead of waiting up
// to 6 hours for the next cron tick.
//
// Usage: visit
//   https://<your-site>.netlify.app/.netlify/functions/sync-services-manual?secret=YOUR_SECRET
// in any browser. Set SYNC_TRIGGER_SECRET in Netlify env vars first — pick
// any long random string, it just needs to match what you put in the URL.
// Without a matching secret this returns 403 and does nothing, so it's
// safe to leave deployed.

const { runSync } = require("./_lib/sync-services-core");

exports.handler = async (event) => {
  const providedSecret = (event.queryStringParameters || {}).secret;
  const expectedSecret = process.env.SYNC_TRIGGER_SECRET;

  if (!expectedSecret) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "SYNC_TRIGGER_SECRET is not set in Netlify env vars." }),
    };
  }
  if (!providedSecret || providedSecret !== expectedSecret) {
    return { statusCode: 403, body: JSON.stringify({ error: "Invalid or missing secret." }) };
  }

  try {
    const { totalSynced, perPlatform } = await runSync();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, totalSynced, perPlatform }),
    };
  } catch (err) {
    console.error("Manual sync failed:", err.message);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
