// public/js/order-fields.js
// Renders the correct extra input field(s) inside the order modal's
// #order-fields container, based on the service's resolved order-create
// variant (see catalog-config.js::resolveVariant and the handoff doc's
// 9-variant table). Also validates + collects those fields back into the
// exact body shape place-order.js forwards to BigiSub.
//
// NOTE (handoff doc gap #1): exact request-body shapes for Comment Replies,
// Comment Likes, and Answer Poll weren't fully captured from BigiSub docs.
// Comment Replies/Likes are assumed to match Custom Comments/Default
// respectively; Answer Poll falls back to a link-only field until its real
// schema is confirmed. Double-check these against a live BigiSub test call
// before relying on them.

import { resolveVariant } from "./catalog-config.js";

function field(label, inputHtml, hint) {
  return `<div class="field-label">${label}</div>${inputHtml}${hint ? `<div style="font-size:11px;color:#9AA3C0;margin:2px 0 6px;">${hint}</div>` : ""}`;
}

function textInput(id, placeholder) {
  return `<input class="input" id="${id}" placeholder="${placeholder}">`;
}

function numberInput(id, placeholder, opts = "") {
  return `<input class="input" id="${id}" type="number" placeholder="${placeholder}" ${opts}>`;
}

// Each variant lists the DOM it needs and how to turn it into the request
// body place-order.js expects. `collect` returns { ok, error } or
// { ok: true, body }.
const VARIANT_DEFS = {
  default: {
    render: () => field("Link or username", textInput("f-link", "Post/profile link, or a username")),
    collect: () => {
      const val = document.getElementById("f-link").value.trim();
      if (!val) return { ok: false, error: "Enter a link or username." };
      // Non-URL input is treated as a username instead of a link.
      const isUrl = /^https?:\/\//i.test(val);
      return { ok: true, body: isUrl ? { link: val } : { username: val } };
    },
  },
  custom_comments: {
    render: () => field("Post link", textInput("f-link", "https://...")) +
      field("Comments", `<textarea class="input" id="f-custom-text" rows="3" placeholder="One comment per line"></textarea>`, "Each line is delivered as a separate comment."),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      const customText = document.getElementById("f-custom-text").value.trim();
      if (!link) return { ok: false, error: "Enter a post link." };
      if (!customText) return { ok: false, error: "Enter at least one comment." };
      return { ok: true, body: { link, custom_text: customText } };
    },
  },
  comment_replies: {
    // Assumed same shape as Custom Comments — see file header note.
    render: () => field("Post/comment link", textInput("f-link", "https://...")) +
      field("Replies", `<textarea class="input" id="f-custom-text" rows="3" placeholder="One reply per line"></textarea>`),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      const customText = document.getElementById("f-custom-text").value.trim();
      if (!link) return { ok: false, error: "Enter a link." };
      if (!customText) return { ok: false, error: "Enter at least one reply." };
      return { ok: true, body: { link, custom_text: customText } };
    },
  },
  comment_likes: {
    // Assumed same shape as Default — see file header note.
    render: () => field("Comment link", textInput("f-link", "https://...")),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      if (!link) return { ok: false, error: "Enter a comment link." };
      return { ok: true, body: { link } };
    },
  },
  mentions_hashtag: {
    render: () => field("Post link", textInput("f-link", "https://...")) +
      field("Hashtag", textInput("f-hashtag", "e.g. #summer")),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      const hashtag = document.getElementById("f-hashtag").value.trim();
      if (!link) return { ok: false, error: "Enter a post link." };
      if (!hashtag) return { ok: false, error: "Enter a hashtag." };
      return { ok: true, body: { link, hashtag } };
    },
  },
  mentions_media_likers: {
    render: () => field("Post link", textInput("f-link", "https://...")) +
      field("Source post (to pull likers from)", textInput("f-media", "https://...")),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      const media = document.getElementById("f-media").value.trim();
      if (!link) return { ok: false, error: "Enter a post link." };
      if (!media) return { ok: false, error: "Enter the source post link." };
      return { ok: true, body: { link, media } };
    },
  },
  mentions_user_followers: {
    render: () => field("Post link", textInput("f-link", "https://...")) +
      field("Username (to mention their followers)", textInput("f-username", "e.g. someuser")),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      const username = document.getElementById("f-username").value.trim();
      if (!link) return { ok: false, error: "Enter a post link." };
      if (!username) return { ok: false, error: "Enter a username." };
      return { ok: true, body: { link, username } };
    },
  },
  invites_from_groups: {
    render: () => field("Post/group link", textInput("f-link", "https://...")) +
      field("Groups", `<textarea class="input" id="f-groups" rows="3" placeholder="One group URL per line"></textarea>`),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      const groups = document.getElementById("f-groups").value.trim();
      if (!link) return { ok: false, error: "Enter a link." };
      if (!groups) return { ok: false, error: "Enter at least one group URL." };
      return { ok: true, body: { link, groups } };
    },
  },
  web_traffic: {
    render: () => field("Destination link", textInput("f-link", "https://...")) +
      field("Country", textInput("f-country", "e.g. NG")) +
      field("Device", `<select class="input" id="f-device"><option value="mobile">Mobile</option><option value="desktop">Desktop</option><option value="mixed">Mixed</option></select>`) +
      field("Traffic type", `<select class="input" id="f-traffic-type"><option value="direct">Direct</option><option value="search">Search</option><option value="social">Social</option></select>`) +
      field("Keyword (if search traffic)", textInput("f-keyword", "optional")),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      const country = document.getElementById("f-country").value.trim();
      if (!link) return { ok: false, error: "Enter a destination link." };
      if (!country) return { ok: false, error: "Enter a country." };
      return {
        ok: true,
        body: {
          link,
          country,
          device: document.getElementById("f-device").value,
          type_of_traffic: document.getElementById("f-traffic-type").value,
          google_keyword: document.getElementById("f-keyword").value.trim() || undefined,
        },
      };
    },
  },
  answer_poll: {
    // Exact schema unconfirmed (handoff doc) — link-only placeholder.
    render: () => field("Poll/post link", textInput("f-link", "https://...")),
    collect: () => {
      const link = document.getElementById("f-link").value.trim();
      if (!link) return { ok: false, error: "Enter a poll link." };
      return { ok: true, body: { link } };
    },
  },
  // "subscription" (Auto Services) intentionally has no entry here — those
  // services are filtered out of services.html and handled by their own
  // flow (index.html's auto-services screen).
};

export function renderOrderFields(container, service) {
  const variant = resolveVariant(service);
  const def = VARIANT_DEFS[variant] || VARIANT_DEFS.default;
  container.innerHTML = def.render();
  container.dataset.variant = variant;
}

export function collectOrderFields(container) {
  const variant = container.dataset.variant || "default";
  const def = VARIANT_DEFS[variant] || VARIANT_DEFS.default;
  return def.collect();
}
