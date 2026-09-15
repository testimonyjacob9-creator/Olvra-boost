// _lib/mailtm.js
// Thin wrapper around Mail.tm (https://mail.tm) — a completely free
// temporary-email API, no API key required. Used for the free "Email OTP"
// feature: no wallet charge to users, so there's no pricing/refund logic
// here at all, unlike fivesim.js.
//
// Mail.tm's own terms require attribution wherever this is used (see the
// "Powered by Mail.tm" link on the Email OTP screen) and prohibit wrapping
// their API as a *paid* product — this feature must stay free to comply.

const axios = require("axios");

const BASE_URL = "https://api.mail.tm";

function client(token) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    timeout: 8000,
  });
}

/** Active domains Mail.tm currently issues addresses on. */
async function getDomains() {
  const res = await client().get("/domains");
  const all = res.data["hydra:member"] || res.data.member || (Array.isArray(res.data) ? res.data : []);
  const active = all.filter((d) => d.isActive !== false);
  // Prefer the isActive-filtered list, but if that field isn't actually
  // present/true on anything (API shape drift, or a stricter filter than
  // intended), fall back to the raw list rather than reporting "no
  // domains" when domains genuinely exist.
  return active.length > 0 ? active : all;
}

/** Creates a new temp-email account. Caller picks address/password. */
async function createAccount({ address, password }) {
  const res = await client().post("/accounts", { address, password });
  return res.data; // { id, address, ... }
}

/** Exchanges address+password for a fresh bearer token. */
async function getToken({ address, password }) {
  const res = await client().post("/token", { address, password });
  return res.data.token;
}

/** Message list for an inbox (summaries only — from/subject/intro). */
async function listMessages(token) {
  const res = await client(token).get("/messages");
  return res.data["hydra:member"] || [];
}

/** Full message body (text/html) for one message ID. */
async function getMessage(token, messageId) {
  const res = await client(token).get(`/messages/${messageId}`);
  return res.data;
}

/** Deletes the account entirely — used when the user is done with it. */
async function deleteAccount(token, accountId) {
  await client(token).delete(`/accounts/${accountId}`);
}

module.exports = { getDomains, createAccount, getToken, listMessages, getMessage, deleteAccount };
