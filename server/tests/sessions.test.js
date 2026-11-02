const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const authRoutes = require("../routes/auth");
const walletRoutes = require("../routes/wallet");

test("server-side session authentication and logout", async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "session-test-secret";
  const aliceId = "00000000-0000-0000-0000-000000000001";
  const bobId = "00000000-0000-0000-0000-000000000002";
  const sessions = new Map();
  let clock;
  let sessionChecks;
  let protectedReads;
  let unavailable;
  let logoutUnavailable;

  t.beforeEach(() => {
    sessions.clear();
    clock = Date.now();
    sessionChecks = 0;
    protectedReads = 0;
    unavailable = false;
    logoutUnavailable = false;
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(db, "query", async (sql, params) => {
    const statement = sql.trim();
    if (statement.startsWith("UPDATE auth_sessions SET last_seen_at")) {
      sessionChecks += 1;
      if (unavailable) throw new Error("Session database unavailable");
      assert.equal(params[2], 300);
      const session = sessions.get(params[0]);
      if (!session || session.userId !== params[1] || session.revoked ||
          session.expiresAt <= clock || session.lastSeen <= clock - 300000) return { rows: [] };
      session.lastSeen = clock;
      return { rows: [{ id: params[0] }] };
    }
    if (statement.startsWith("UPDATE auth_sessions SET revoked_at")) {
      if (logoutUnavailable) throw new Error("Logout write unavailable");
      const session = sessions.get(params[0]);
      assert.equal(session.userId, params[1]);
      session.revoked = true;
      return { rows: [] };
    }
    protectedReads += 1;
    if (statement.startsWith("SELECT id, name, email")) {
      return { rows: [{ id: params[0], name: params[0] === aliceId ? "Alice" : "Bob" }] };
    }
    if (statement.startsWith("SELECT * FROM wallets")) {
      return { rows: [{ id: "wallet", balance: "15.00", currency: "INR" }] };
    }
    throw new Error(`Unexpected session test query: ${statement}`);
  });

  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use("/api/wallet", walletRoutes);
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  function loginToken(userId = aliceId) {
    const sessionId = randomUUID();
    sessions.set(sessionId, { userId, lastSeen: clock, expiresAt: clock + 600000, revoked: false });
    return { token: jwt.sign({ userId, sessionId }, process.env.JWT_SECRET, { expiresIn: "10m" }), sessionId };
  }
  async function request(path, token, method = "GET", authorization) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: token ? { Authorization: authorization || `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("Cache-Control") };
  }

  await t.test("an active session authorizes profile and wallet requests", async () => {
    const { token } = loginToken();
    assert.equal((await request("/api/auth/me", token)).status, 200);
    const balance = await request("/api/wallet/balance", token);
    assert.equal(balance.status, 200);
    assert.equal(balance.body.balance, "15.00");
    assert.equal(balance.cacheControl, "no-store");
    assert.equal(sessionChecks, 2);
    assert.equal(protectedReads, 2);
  });

  await t.test("logout revokes the current token while other sessions stay active", async () => {
    const first = loginToken();
    const second = loginToken();
    const bob = loginToken(bobId);
    assert.equal((await request("/api/auth/logout", first.token, "POST")).status, 200);
    assert.ok(sessions.get(first.sessionId).revoked);
    // The signature and expiry are still valid; server-side revocation rejects it.
    assert.equal(jwt.verify(first.token, process.env.JWT_SECRET).sessionId, first.sessionId);
    assert.equal((await request("/api/wallet/balance", first.token)).status, 401);
    assert.equal((await request("/api/auth/logout", first.token, "POST")).status, 401);
    assert.equal((await request("/api/auth/me", second.token)).status, 200);
    assert.equal((await request("/api/auth/me", bob.token)).status, 200);
  });

  await t.test("five minutes without activity expires a session and retries cannot revive it", async () => {
    const { token, sessionId } = loginToken();
    const lastSeen = sessions.get(sessionId).lastSeen;
    clock += 300000;
    assert.equal((await request("/api/auth/me", token)).status, 401);
    assert.equal((await request("/api/auth/me", token)).status, 401);
    assert.equal(sessions.get(sessionId).lastSeen, lastSeen);
    assert.equal(protectedReads, 0);
  });

  await t.test("activity refreshes inactivity time but never extends absolute expiry", async () => {
    const { token, sessionId } = loginToken();
    const expiresAt = sessions.get(sessionId).expiresAt;
    clock += 240000;
    assert.equal((await request("/api/auth/me", token)).status, 200);
    clock += 240000;
    assert.equal((await request("/api/auth/me", token)).status, 200);
    assert.equal(sessions.get(sessionId).expiresAt, expiresAt);
    clock = expiresAt;
    assert.equal((await request("/api/auth/me", token)).status, 401);
  });

  await t.test("a token cannot use another user's session", async () => {
    const { sessionId } = loginToken();
    const token = jwt.sign({ userId: bobId, sessionId }, process.env.JWT_SECRET, { expiresIn: "10m" });
    assert.equal((await request("/api/auth/me", token)).status, 401);
    assert.equal(protectedReads, 0);
  });

  await t.test("a missing server-side session rejects a correctly signed token", async () => {
    const { token, sessionId } = loginToken();
    sessions.delete(sessionId);
    assert.equal((await request("/api/auth/me", token)).status, 401);
    assert.equal(protectedReads, 0);
  });

  for (const [label, payload, options] of [
    ["legacy token without session", { userId: aliceId }, { expiresIn: "10m" }],
    ["invalid session ID", { userId: aliceId, sessionId: "invalid" }, { expiresIn: "10m" }],
    ["invalid user ID", { userId: "invalid", sessionId: randomUUID() }, { expiresIn: "10m" }],
    ["missing expiry", { userId: aliceId, sessionId: randomUUID() }, {}],
    ["missing creation time", { userId: aliceId, sessionId: randomUUID() }, { expiresIn: "10m", noTimestamp: true }],
  ]) {
    await t.test(`${label} is rejected before session database access`, async () => {
      const token = jwt.sign(payload, process.env.JWT_SECRET, options);
      assert.equal((await request("/api/auth/me", token)).status, 401);
      assert.equal(sessionChecks, 0);
      assert.equal(protectedReads, 0);
    });
  }

  await t.test("expired JWTs cannot refresh a session", async () => {
    const { sessionId } = loginToken();
    const token = jwt.sign({ userId: aliceId, sessionId, iat: Math.floor(Date.now() / 1000) - 601 },
      process.env.JWT_SECRET, { expiresIn: "10m" });
    assert.equal((await request("/api/auth/me", token)).status, 401);
    assert.equal(sessionChecks, 0);
  });

  await t.test("missing tokens, extra header text, and invalid signatures cannot reach the database", async () => {
    const { token, sessionId } = loginToken();
    assert.equal((await request("/api/auth/me")).status, 401);
    assert.equal((await request("/api/auth/me", token, "GET", `Bearer ${token} extra`)).status, 401);
    const wrongSignature = jwt.sign({ userId: aliceId, sessionId }, "wrong-secret", { expiresIn: "10m" });
    assert.equal((await request("/api/auth/me", wrongSignature)).status, 403);
    const wrongAlgorithm = jwt.sign({ userId: aliceId, sessionId }, process.env.JWT_SECRET, { expiresIn: "10m", algorithm: "HS384" });
    assert.equal((await request("/api/auth/me", wrongAlgorithm)).status, 403);
    assert.equal(sessionChecks, 0);
  });

  await t.test("session database errors return 503 without authorizing the request", async () => {
    const { token } = loginToken();
    unavailable = true;
    assert.equal((await request("/api/wallet/balance", token)).status, 503);
    assert.equal(protectedReads, 0);
  });

  await t.test("logout write errors report failure and do not falsely claim revocation", async () => {
    const { token, sessionId } = loginToken();
    logoutUnavailable = true;
    assert.equal((await request("/api/auth/logout", token, "POST")).status, 503);
    assert.equal(sessions.get(sessionId).revoked, false);
    logoutUnavailable = false;
    assert.equal((await request("/api/auth/me", token)).status, 200);
  });
});
