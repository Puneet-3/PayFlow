const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const authRoutes = require("../routes/auth");

test("authentication validation and login", async (t) => {
  // Exercise real HTTP handlers, hashing, and JWTs without connecting to Supabase.
  let savedUser;
  let duplicateEmail = false;
  let calls = [];
  let releases = 0;
  const sessions = new Map();
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-only-secret-not-for-production";

  t.mock.method(db.pool, "connect", async () => {
    calls.push("connect");
    return {
      async query(sql, params) {
        const statement = sql.trim();
        calls.push(statement);
        if (statement.startsWith("INSERT INTO users")) {
          if (duplicateEmail) {
            throw Object.assign(new Error("Duplicate email"), { code: "23505" });
          }
          savedUser = {
            id: "00000000-0000-0000-0000-000000000001",
            name: params[0],
            email: params[1],
            password_hash: params[2],
          };
          return { rows: [{ id: savedUser.id, name: savedUser.name, email: savedUser.email }] };
        }
        if (statement.startsWith("INSERT INTO wallets")) {
          assert.equal(params[0], savedUser.id);
          return { rows: [{ id: "test-wallet", balance: "0.00", currency: "INR" }] };
        }
        assert.ok(["BEGIN", "COMMIT", "ROLLBACK"].includes(statement));
        return { rows: [] };
      },
      release() {
        releases += 1;
      },
    };
  });

  t.mock.method(db, "query", async (sql, params) => {
    if (sql.trim().startsWith("INSERT INTO auth_sessions")) {
      calls.push("create session");
      sessions.set(params[0], { userId: params[1], expiresAt: params[2] });
      return { rows: [] };
    }
    calls.push("lookup");
    assert.match(sql, /FROM users/);
    return { rows: savedUser && params[0] === savedUser.email ? [savedUser] : [] };
  });

  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;

  async function post(path, body) {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("Cache-Control") };
  }

  const registration = {
    name: "Alice",
    email: "alice@example.com",
    password: "PracticePassword123!",
  };
  const longEmail = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
  assert.equal(longEmail.length, 255);

  const invalidRegistrations = [
    ["missing body", undefined],
    ["array body", []],
    ["missing fields", {}],
    ["numeric name", { ...registration, name: 123 }],
    ["numeric email", { ...registration, email: 123 }],
    ["numeric password", { ...registration, password: 12345678 }],
    ["object email", { ...registration, email: {} }],
    ["null password", { ...registration, password: null }],
    ["blank name", { ...registration, name: " \t " }],
    ["long name", { ...registration, name: "a".repeat(101) }],
    ["blank email", { ...registration, email: "   " }],
    ["malformed email", { ...registration, email: "alice.example.com" }],
    ["email containing spaces", { ...registration, email: "ali ce@example.com" }],
    ["long email", { ...registration, email: `a${longEmail}` }],
    ["short password", { ...registration, password: "1234567" }],
  ];
  for (const [label, body] of invalidRegistrations) {
    await t.test(`registration rejects ${label} before database work`, async () => {
      calls = [];
      const response = await post("register", body);
      assert.equal(response.status, 400);
      assert.equal(typeof response.body.error, "string");
      assert.deepEqual(calls, []);
    });
  }

  const invalidLogins = [
    ["missing body", undefined],
    ["array body", []],
    ["missing fields", {}],
    ["numeric email", { email: 123, password: registration.password }],
    ["numeric password", { email: registration.email, password: 12345678 }],
    ["object password", { email: registration.email, password: {} }],
    ["blank email", { email: "   ", password: registration.password }],
    ["malformed email", { email: "alice", password: registration.password }],
    ["long email", { email: `a${longEmail}`, password: registration.password }],
  ];
  for (const [label, body] of invalidLogins) {
    await t.test(`login rejects ${label} before database work`, async () => {
      calls = [];
      const response = await post("login", body);
      assert.equal(response.status, 400);
      assert.equal(typeof response.body.error, "string");
      assert.deepEqual(calls, []);
    });
  }

  await t.test("registration normalizes name and email, preserving password spaces", async () => {
    calls = [];
    const password = "  PracticePassword123!  ";
    const response = await post("register", {
      name: "  Alice  ",
      email: "  ALICE@EXAMPLE.COM  ",
      password,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.user.name, "Alice");
    assert.equal(response.body.user.email, "alice@example.com");
    assert.equal(response.body.user.password_hash, undefined);
    assert.equal(response.body.wallet.balance, "0.00");
    assert.ok(await bcrypt.compare(password, savedUser.password_hash));
    assert.equal(await bcrypt.compare(password.trim(), savedUser.password_hash), false);
    assert.ok(calls.includes("COMMIT"));
    assert.equal(releases, 1);
  });

  await t.test("login normalizes email and issues a ten-minute token", async () => {
    const response = await post("login", {
      email: "  ALICE@EXAMPLE.COM  ",
      password: "  PracticePassword123!  ",
    });
    assert.equal(response.status, 200);
    const payload = jwt.verify(response.body.token, process.env.JWT_SECRET);
    assert.equal(payload.userId, savedUser.id);
    assert.equal(payload.exp - payload.iat, 600);
    assert.equal(sessions.get(payload.sessionId).userId, savedUser.id);
    assert.equal(sessions.get(payload.sessionId).expiresAt.getTime(), payload.exp * 1000);
    assert.equal(response.body.session.idleTimeoutSeconds, 300);
    assert.equal(response.cacheControl, "no-store");
    assert.equal(response.body.session.expiresAt, new Date(payload.exp * 1000).toISOString());
    assert.equal(response.body.user.password_hash, undefined);
  });

  await t.test("unknown account and incorrect password return the same 401", async () => {
    const unknown = await post("login", {
      email: "unknown@example.com",
      password: registration.password,
    });
    const wrongPassword = await post("login", {
      email: registration.email,
      password: "wrong-password",
    });
    assert.equal(unknown.status, 401);
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(unknown.body, { error: "Invalid email or password" });
    assert.deepEqual(wrongPassword.body, unknown.body);
  });

  await t.test("registration accepts the name and email length limits", async () => {
    const response = await post("register", {
      name: `  ${"a".repeat(100)}  `,
      email: `  ${longEmail}  `,
      password: "12345678",
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.user.name.length, 100);
    assert.equal(response.body.user.email.length, 255);
  });

  await t.test("duplicate email still returns 409 and releases the connection", async () => {
    calls = [];
    const previousReleases = releases;
    duplicateEmail = true;
    const response = await post("register", registration);
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "Email is already registered");
    assert.ok(calls.includes("ROLLBACK"));
    assert.ok(!calls.includes("COMMIT"));
    assert.equal(releases, previousReleases + 1);
  });
});
