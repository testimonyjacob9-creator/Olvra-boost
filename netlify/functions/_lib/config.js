// _lib/config.js
// Central place for all platform settings. Edit these, don't scatter magic numbers.

module.exports = {
  BIGISUB_BASE_URL: "https://api.bigisub.ng",

  // ---- Owlet ("Global Source" / Source 2) ----
  // 2026-09-02: Testimony added a second provider (Owlet — shown to users
  // as "Global Source", never by its real name, per his request). Their
  // API is action-based: POST { key, action, ...params } to one endpoint.
  // Flat 5% markup on everything from Owlet, deliberately NOT using the
  // per-category/per-platform overrides above (Testimony's call — those
  // overrides are BigiSub-specific tuning, not meant to carry over).
  // Multiple Owlet-family accounts, all pooled into the same "Global
  // Source" the user picks from — Testimony's call (2026-09-03): more
  // stock under one option, not a third picker card. Each needs its OWN
  // API key as a Netlify env var (never hardcoded — same reasoning as
  // every other secret in this app) since each account only spends from
  // its own separate wallet balance.
  OWLET_SOURCES: [
    { id: "primary", baseUrl: "https://olvrahub.mysocials.store/api/store-v2", envKey: "OWLET_API_KEY" },
    { id: "a1socials", baseUrl: "https://a1socials.mysocials.store/api/store-v2", envKey: "OWLET_A1SOCIALS_API_KEY" },
  ],
  OWLET_MARKUP: 0.05,

  // Owlet's service list has no clean `platform` field (unlike BigiSub) —
  // just a messy free-text `category` string plus the service `name`.
  // Detected by substring match against both, lowercased. Deliberately
  // scoped to platforms Boost already supports (confirmed with Testimony
  // 2026-09-02 — "just social growth [platforms], matches what Olvra
  // Boost already does", not Owlet's full catalog) — anything that
  // doesn't match one of these aliases is skipped during sync, not
  // imported as "other". Aliases are intentionally loose (e.g. "fb" for
  // facebook) since Owlet's naming conventions aren't controlled by us.
  OWLET_PLATFORM_ALIASES: {
    instagram: ["instagram"],
    facebook: ["facebook"],
    twitter: ["twitter", "x.com", " x |", "| x "],
    tiktok: ["tiktok", "tik tok"],
    youtube: ["youtube"],
    linkedin: ["linkedin"],
    telegram: ["telegram"],
    whatsapp: ["whatsapp"],
    apple_music: ["apple music"],
    spotify: ["spotify"],
    audiomack: ["audiomack"],
    soundcloud: ["soundcloud"],
    google: ["google"],
    trustpilot: ["trustpilot"],
    snapchat: ["snapchat", "snap chat"],
    pinterest: ["pinterest"],
    discord: ["discord"],
    twitch: ["twitch"],
    threads: ["threads"],
    reddit: ["reddit"],
  },

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
};
