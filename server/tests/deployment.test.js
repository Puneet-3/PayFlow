const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const db = require("../db");
const handler = require("../../api/index");

test("shared deployment handler", async (t) => {
  assert.equal(typeof handler, "function");
  const server = handler.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  await t.test("API metadata is reachable through the exported handler", async () => {
    const response = await fetch(`${base}/api`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, "Wallet API is running");
  });
  await t.test("health check works without opening a database connection", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
  await t.test("protected routes still require authentication", async () => {
    const response = await fetch(`${base}/api/wallet/balance`);
    assert.equal(response.status, 401);
  });
  await t.test("database readiness reports success through the handler", async () => {
    const mock = t.mock.method(db, "query", async () => ({ rows: [{ now: "test-time" }] }));
    try {
      const response = await fetch(`${base}/health/db`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "connected");
    } finally { mock.mock.restore(); }
  });
  await t.test("database failures do not expose connection details", async () => {
    const mock = t.mock.method(db, "query", async () => { throw new Error("private connection details"); });
    const logging = t.mock.method(console, "error", () => {});
    try {
      const response = await fetch(`${base}/health/db`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { status: "error", message: "Database connection unavailable" });
    } finally { mock.mock.restore(); logging.mock.restore(); }
  });
});
