// _lib/respond.js
function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function ok(body) {
  return json(200, body);
}

// Turns a thrown error into a proper HTTP response. Errors can carry a
// .statusCode (set by requireAuth or thrown deliberately); default is 500.
function fail(err) {
  console.error(err);
  const statusCode = err.statusCode || 500;
  return json(statusCode, { error: err.message || "Internal error" });
}

module.exports = { json, ok, fail };
