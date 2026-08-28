// netlify/functions/debug-firebase-config.js
//
// TEMPORARY DIAGNOSTIC ENDPOINT — visit this URL directly in your browser:
//   https://yoursite.netlify.app/.netlify/functions/debug-firebase-config
//
// It never exposes the actual private key — only whether each step of
// reading/decoding/parsing/validating it succeeds. Delete this file once
// the real issue is found; it doesn't belong in a shipped app.

const crypto = require("crypto");

exports.handler = async () => {
  const report = { steps: [] };

  function step(name, ok, detail) {
    report.steps.push({ name, ok, detail });
  }

  const base64Blob = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const jsonBlob = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const legacyKey = process.env.FIREBASE_PRIVATE_KEY;

  step("FIREBASE_SERVICE_ACCOUNT_BASE64 present", !!base64Blob, base64Blob ? `length ${base64Blob.length}` : "not set");
  step("FIREBASE_SERVICE_ACCOUNT_JSON present", !!jsonBlob, jsonBlob ? `length ${jsonBlob.length}` : "not set");
  step("FIREBASE_PRIVATE_KEY (legacy) present", !!legacyKey, legacyKey ? `length ${legacyKey.length}` : "not set");

  let parsed = null;
  let source = null;

  if (base64Blob) {
    source = "base64";
    try {
      const jsonStr = Buffer.from(base64Blob.trim(), "base64").toString("utf8");
      step("base64 decode", true, `decoded to ${jsonStr.length} chars`);
      try {
        parsed = JSON.parse(jsonStr);
        step("JSON.parse decoded string", true, "valid JSON");
      } catch (e) {
        step("JSON.parse decoded string", false, e.message);
      }
    } catch (e) {
      step("base64 decode", false, e.message);
    }
  } else if (jsonBlob) {
    source = "json";
    try {
      parsed = JSON.parse(jsonBlob);
      step("JSON.parse FIREBASE_SERVICE_ACCOUNT_JSON", true, "valid JSON");
    } catch (e) {
      step("JSON.parse FIREBASE_SERVICE_ACCOUNT_JSON", false, e.message);
    }
  }

  if (parsed) {
    step("project_id present", !!parsed.project_id, parsed.project_id || "missing");
    step("client_email present", !!parsed.client_email, parsed.client_email || "missing");
    step("private_key present", !!parsed.private_key, parsed.private_key ? `length ${parsed.private_key.length}` : "missing");

    if (parsed.private_key) {
      const pk = parsed.private_key;
      step("private_key starts with BEGIN marker", pk.startsWith("-----BEGIN PRIVATE KEY-----"), pk.slice(0, 40));
      step("private_key ends with END marker", pk.trim().endsWith("-----END PRIVATE KEY-----"), pk.trim().slice(-40));
      step("private_key contains real newlines", pk.includes("\n"), pk.includes("\n") ? "yes" : "no — this is the problem if false");

      try {
        crypto.createPrivateKey(pk);
        step("Node crypto can parse the private key", true, "VALID — this key works");
      } catch (e) {
        step("Node crypto can parse the private key", false, e.message);
      }
    }
  } else if (legacyKey) {
    const pk = legacyKey.replace(/\\n/g, "\n");
    step("private_key contains real newlines after \\n replace", pk.includes("\n"), pk.includes("\n") ? "yes" : "no");
    try {
      crypto.createPrivateKey(pk);
      step("Node crypto can parse the legacy private key", true, "VALID — this key works");
    } catch (e) {
      step("Node crypto can parse the legacy private key", false, e.message);
    }
  }

  report.source_used = source || (legacyKey ? "legacy_three_vars" : "none found");
  report.overall = report.steps.every((s) => s.ok) ? "ALL CHECKS PASSED" : "FAILURE FOUND — see first step with ok:false above";

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report, null, 2),
  };
};
