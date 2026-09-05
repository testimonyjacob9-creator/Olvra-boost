// public/js/catalog-config.js
// Shared platform/category/variant metadata for pages that import it as a
// module (services.html, order-fields.js). index.html keeps its own inline
// copy of this same data on purpose (see the comment above PLATFORMS in
// index.html) so it can stay a single file to upload — if you change one
// copy, change both, or finish the refactor by having index.html import
// this file too.

export const PLATFORMS = [
  { id: "instagram",   label: "Instagram",   color: "#E1306C", curated: true },
  { id: "facebook",    label: "Facebook",    color: "#1877F2", curated: true },
  { id: "twitter",     label: "Twitter",     color: "#1DA1F2", curated: true },
  { id: "tiktok",      label: "TikTok",      color: "#000000", curated: true },
  { id: "youtube",     label: "YouTube",     color: "#FF0000", curated: true },
  { id: "linkedin",    label: "LinkedIn",    color: "#0A66C2", curated: false },
  { id: "telegram",    label: "Telegram",    color: "#26A5E4", curated: false },
  { id: "whatsapp",    label: "WhatsApp",    color: "#25D366", curated: false },
  { id: "apple_music", label: "Apple Music", color: "#FA243C", curated: false },
  { id: "spotify",     label: "Spotify",     color: "#1DB954", curated: false },
  { id: "audiomack",   label: "Audiomack",   color: "#FFA200", curated: false },
  { id: "soundcloud",  label: "SoundCloud",  color: "#FF5500", curated: false },
  { id: "google",      label: "Google",      color: "#4285F4", curated: false },
  { id: "trustpilot",  label: "Trustpilot",  color: "#00B67A", curated: false },
  { id: "snapchat",    label: "Snapchat",    color: "#FFFC00", curated: false },
  { id: "pinterest",   label: "Pinterest",   color: "#E60023", curated: false },
  { id: "discord",     label: "Discord",     color: "#5865F2", curated: false },
  { id: "twitch",      label: "Twitch",      color: "#9146FF", curated: false },
  { id: "threads",     label: "Threads",     color: "#101010", curated: false },
  { id: "reddit",      label: "Reddit",      color: "#FF4500", curated: false },
  { id: "other",       label: "Other",       color: "#9AA3C0", curated: false },
];

export const CATEGORY_META = {
  followers: { label: "Followers", icon: "👥" }, likes: { label: "Likes", icon: "❤️" },
  views: { label: "Views", icon: "👁️" }, comments: { label: "Post Comments", icon: "💬" },
  custom_comments: { label: "Custom Comments", icon: "💬" }, shares: { label: "Post Share", icon: "🔁" },
  video_share: { label: "Video Share", icon: "🔁" }, video_view: { label: "Video View", icon: "👁️" },
  page_follow: { label: "Page Follow", icon: "⭐" }, page_review: { label: "Page Review", icon: "👁️" },
  group_join: { label: "Group Join", icon: "⭐" }, post_like: { label: "Post Like", icon: "❤️" },
  mentions_hashtag: { label: "Hashtag Mentions", icon: "#️⃣" },
  mentions_media_likers: { label: "Mentions (Likers)", icon: "❤️" },
  mentions_user_followers: { label: "Mentions (Followers)", icon: "👥" },
  invites_from_groups: { label: "Group Invites", icon: "✉️" },
  web_traffic: { label: "Web Traffic", icon: "🌐" },
  subscription: { label: "Auto Service", icon: "🔄" },
  answer_poll: { label: "Poll Answers", icon: "🗳️" },
};

export const SERVICE_TYPE_TO_VARIANT = {
  followers: "default", likes: "default", views: "default", shares: "default",
  post_like: "default", video_share: "default", video_view: "default",
  page_follow: "default", page_review: "default", group_join: "default",
  custom_comments: "custom_comments", comments: "custom_comments",
  comment_replies: "comment_replies", comment_likes: "comment_likes",
  mentions_hashtag: "mentions_hashtag", mentions_media_likers: "mentions_media_likers",
  mentions_user_followers: "mentions_user_followers", invites_from_groups: "invites_from_groups",
  web_traffic: "web_traffic", subscription: "subscription", answer_poll: "answer_poll",
};

export function humanizeCategoryKey(key) {
  return key.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function resolveVariant(service) {
  const byType = service.service_type && SERVICE_TYPE_TO_VARIANT[service.service_type];
  if (byType) {
    if (byType === "custom_comments" && service.requires_custom_text === false) return "default";
    return byType;
  }
  const catKey = service.category && service.category.toLowerCase().replace(/\s+/g, "_");
  const byCategory = catKey && SERVICE_TYPE_TO_VARIANT[catKey];
  if (byCategory) return byCategory;
  if (service.requires_custom_text) return "custom_comments";
  return "default";
}

// A short, plain-language label for what the service actually does —
// e.g. "Followers", "Likes", "Comments" — instead of the raw provider
// string, which is often dense jargon ("HQ+REAL | Superinstant |
// Speed: 5K/H | 30 Days ♻️"). Deliberately does NOT try to extract or
// restate delivery speed, quantity-per-day, or quality claims from free
// text — that's unreliable to parse correctly across hundreds of
// providers, and a wrong claim on a paid order is worse than no claim.
// The raw name should still be shown alongside this for full detail.
const KIND_KEYWORDS = [
  { re: /follower/i, label: "Followers" },
  { re: /subscri/i, label: "Subscribers" },
  { re: /\blikes?\b/i, label: "Likes" },
  { re: /view|play/i, label: "Views" },
  { re: /custom comment/i, label: "Custom Comments" },
  { re: /comment/i, label: "Comments" },
  { re: /emoticon|reaction|react/i, label: "Reactions" },
  { re: /group member/i, label: "Group Members" },
  { re: /repost|retweet/i, label: "Reposts" },
  { re: /\bshare/i, label: "Shares" },
  { re: /up ?vote/i, label: "Upvotes" },
  { re: /down ?vote/i, label: "Downvotes" },
  { re: /\bvote/i, label: "Votes" },
  { re: /\breview/i, label: "Reviews" },
  { re: /page follow/i, label: "Page Follows" },
  { re: /group join/i, label: "Group Joins" },
  { re: /download/i, label: "Downloads" },
  { re: /save/i, label: "Saves" },
];

export function friendlyKind(service) {
  const text = `${service.category || ""} ${service.name || ""}`;
  for (const { re, label } of KIND_KEYWORDS) {
    if (re.test(text)) return label;
  }
  return null;
}
