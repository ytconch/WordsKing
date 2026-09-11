const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "guest-auth-test-secret";

const { clientDb } = require("../src/db/connections");
const { requireAuth, requireAdmin } = require("../src/middleware/auth");

test("guest token authenticates without reading or creating a database user", async () => {
  const originalGet = clientDb.get;
  clientDb.get = async () => {
    throw new Error("guest authentication must not query users");
  };

  try {
    const token = jwt.sign({ guest: true, role: "guest", sessionId: "test" }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      status() {
        throw new Error("guest token should be accepted");
      }
    };

    await new Promise((resolve) => requireAuth(req, res, resolve));

    assert.deepEqual(req.user, {
      id: null,
      username: "guest",
      role: "guest",
      isGuest: true
    });
    assert.equal(req.__skipAuditLog, true);
  } finally {
    clientDb.get = originalGet;
  }
});

test("guest cannot use administrator routes", () => {
  const req = { user: { role: "guest", isGuest: true } };
  let response;
  const res = {
    status(status) {
      response = { status };
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    }
  };

  requireAdmin(req, res, () => assert.fail("guest must not pass requireAdmin"));

  assert.equal(response.status, 403);
});
