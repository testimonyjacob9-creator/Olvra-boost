// _lib/pin.js
// Transaction PIN — hashed with scrypt (Node built-in, no new dependency).
// A PIN is optional: if a user hasn't set one, spend endpoints let them
// through unchanged (nothing breaks for existing users). If they HAVE set
// one, every wallet-spending endpoint requires it going forward.

const crypto = require("crypto");

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pin), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPinHash(pin, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(String(pin), salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Call at the top of any wallet-spending function, right after loading
 * the user doc. Transaction PIN is now MANDATORY for everyone:
 * - No PIN set at all -> blocks with PIN_NOT_SET so the frontend can
 *   send the user to set one before retrying.
 * - PIN set but none/wrong supplied -> blocks with PIN_REQUIRED /
 *   PIN_INCORRECT as before.
 */
function requirePinIfSet(userData, suppliedPin) {
  if (!userData?.pin_hash) {
    throw Object.assign(new Error("Set a Transaction PIN to continue — required for all purchases."), { statusCode: 401, code: "PIN_NOT_SET" });
  }
  if (!suppliedPin) {
    throw Object.assign(new Error("Enter your transaction PIN to continue."), { statusCode: 401, code: "PIN_REQUIRED" });
  }
  if (!verifyPinHash(suppliedPin, userData.pin_hash)) {
    throw Object.assign(new Error("Incorrect PIN."), { statusCode: 401, code: "PIN_INCORRECT" });
  }
  return true;
}

module.exports = { hashPin, verifyPinHash, requirePinIfSet };
