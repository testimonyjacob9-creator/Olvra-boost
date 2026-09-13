// _lib/config.js
// Central place for all platform settings. Edit these, don't scatter magic numbers.

module.exports = {
  BIGISUB_BASE_URL: "https://api.bigisub.ng",

  // Flat markup applied to every service price during sync, EXCEPT
  // categories listed in CATEGORY_MARKUP_OVERRIDES below, which use their
  // own rate instead. 0.05 = 5%. sell_price = cost_price * (1 + rate).
  MARKUP: 0.05,

  // Per-category markup overrides. Keys are BigiSub's `category` field,
  // lowercased with spaces turned into underscores (same normalization
  // public/index.html already does for category matching) — e.g. a
  // BigiSub category of "Post Like" becomes "post_like" here. Any
  // category NOT listed here just uses the flat MARKUP above.
  //
  // 2026-08-30: Oliver asked for likes + views specifically to carry a
  // higher margin (followers/comments were already fine at the flat 5%).
  // Covers both the plain categories ("likes", "views") and their
  // single-item variants BigiSub also uses ("post_like", "video_view") —
  // deliberately does NOT include "shares"/"video_share", which weren't
  // part of the request.
  CATEGORY_MARKUP_OVERRIDES: {
    likes: 0.15,
    views: 0.15,
    post_like: 0.15,
    video_view: 0.15,
  },

  // Platform + category overrides — checked BEFORE CATEGORY_MARKUP_OVERRIDES
  // above, so these win when both could apply. Keys are `platform` from
  // BigiSub (lowercase, matches the PLATFORMS list below), then the same
  // normalized category key used in CATEGORY_MARKUP_OVERRIDES.
  //
  // 2026-08-31: Oliver asked for TikTok followers specifically at 2%
  // (lower than the 5% flat rate everything else defaults to) — followers
  // on other platforms are untouched.
  PLATFORM_CATEGORY_MARKUP_OVERRIDES: {
    tiktok: {
      followers: 0.02,
      follower: 0.02,
    },
  },

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
    "audiomack", "soundcloud", "google", "trustpilot",
    "snapchat", "pinterest", "discord", "twitch", "threads", "reddit",
    "other",
  ],

  // How many services to fetch per page from BigiSub (their API is paginated).
  PAGE_SIZE: 100,

  // ===================== 5sim (virtual numbers — "Rent Number") =====================
  FIVESIM_BASE_URL: "https://5sim.net",

  // Markup applied on top of 5sim's USD price before converting to Naira.
  // 0.6 = 60% — numbers are cheap in absolute terms (often $0.05-$0.20), so a
  // flat-percentage markup alone can round to ₦0 profit; FIVESIM_MIN_MARGIN_NGN
  // below is the floor that actually protects margin on the cheapest numbers.
  FIVESIM_MARKUP: 0.6,
  FIVESIM_MIN_MARGIN_NGN: 150,

  // 5sim settles in USD with no NGN-native top-up, so unlike everything else
  // in this app there's no live provider exchange rate to read — this is set
  // by hand (parallel-market rate, not CBN official) and only ever changes
  // when Testimony updates it here after topping up the 5sim balance.
  // Last set 2026-09-13.
  FIVESIM_USD_TO_NGN: 1650,

  // Curated product list shown in the "Rent Number" picker — 5sim supports
  // 1000+ products, most irrelevant to this app's users. Add to this list as
  // demand shows up; `label` is what the UI shows, `product` is 5sim's slug.
  FIVESIM_PRODUCTS: [
    { product: "whatsapp", label: "WhatsApp" },
    { product: "telegram", label: "Telegram" },
    { product: "google", label: "Google / Gmail" },
    { product: "facebook", label: "Facebook" },
    { product: "instagram", label: "Instagram" },
    { product: "tiktok", label: "TikTok" },
    { product: "twitter", label: "Twitter / X" },
    { product: "discord", label: "Discord" },
    { product: "amazon", label: "Amazon" },
    { product: "openai", label: "OpenAI / ChatGPT" },
    { product: "other", label: "Other" },
  ],

  // Curated country list. "any"/"america"/etc. use 5sim's own aggregate
  // country slugs where useful — see 5sim.net/docs for the full list.
  FIVESIM_COUNTRIES: [
    { country: "nigeria", label: "Nigeria" },
    { country: "usa", label: "USA" },
    { country: "england", label: "UK" },
    { country: "russia", label: "Russia" },
    { country: "indonesia", label: "Indonesia" },
    { country: "ghana", label: "Ghana" },
    { country: "kenya", label: "Kenya" },
  ],
};
