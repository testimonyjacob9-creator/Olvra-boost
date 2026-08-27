// config.js
// Central place for all platform settings. Edit these, don't scatter magic numbers.

module.exports = {
  BIGISUB_BASE_URL: "https://api.bigisub.ng",

  // Flat markup applied to every service price during sync.
  // 0.05 = 5%. sell_price = cost_price * (1 + MARKUP)
  MARKUP: 0.05,

  // Platforms to sync. Start with all 5; comment any out to launch narrower.
  PLATFORMS: ["instagram", "facebook", "tiktok", "twitter", "youtube"],

  // How many services to fetch per page from BigiSub (their API is paginated).
  PAGE_SIZE: 100,
};
