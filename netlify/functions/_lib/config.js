// _lib/config.js
// Central place for all platform settings. Edit these, don't scatter magic numbers.

module.exports = {
  BIGISUB_BASE_URL: "https://api.bigisub.ng",

  // Flat markup applied to every service price during sync.
  // 0.05 = 5%. sell_price = cost_price * (1 + MARKUP)
  MARKUP: 0.05,

  // Platforms to sync. Originally launched narrow with just 5 — expanded
  // 2026-08-28 to match BigiSub's real "Select Platform" list confirmed
  // live in their own app (their documented /marketinghub/platforms/
  // endpoint only lists 5 and has already proven stale once before, same
  // as the /services/ response shape). If any of these come back with 0
  // services or a fetch error for your account/plan, just remove that
  // one entry — a missing platform fails safe (0 synced), it won't
  // crash the whole sync.
  PLATFORMS: [
    "instagram", "facebook", "twitter", "tiktok", "youtube",
    "linkedin", "telegram", "whatsapp", "apple_music", "spotify",
    "audiomack", "soundcloud", "google", "trustpilot", "other",
  ],

  // How many services to fetch per page from BigiSub (their API is paginated).
  PAGE_SIZE: 100,
};
