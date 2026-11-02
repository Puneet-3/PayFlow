require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const db = require("../db");
const authRoutes = require("../routes/auth");
const walletRoutes = require("../routes/wallet");

test("login sessions against PostgreSQL in an isolated schema", { timeout: 180000 }, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  assert.ok(connectionString, "Set TEST_DATABASE_URL or DATABASE_URL before running integration tests");
  const schema = `wallet_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
      ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID();
  let server;
  let schemaCreated = false;
  t.after(async () => {
    try {
      if (server) await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      if (schemaCreated) {
        assert.match(schema, /^wallet_test_[a-f0-9]{32}$/);
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
      await pool.end();
    }
  });

  await pool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await pool.query(`
    CREATE TABLE ${schema}.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ${schema}.wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID UNIQUE NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      currency VARCHAR(3) NOT NULL DEFAULT 'INR', updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const qualify = (sql) => sql.replace(/\b(users|wallets|transactions|payment_requests|auth_sessions)\b/g, `${schema}.$1`);
  await pool.query(qualify(readFileSync(path.join(__dirname, "..", "migrations", "002_auth_sessions.sql"), "utf8")));
  t.mock.method(db, "query", (sql, params) => pool.query(qualify(sql), params));
  t.mock.method(db.pool, "connect", async () => {
    const client = await pool.connect();
    return { query: (sql, params) => client.query(qualify(sql), params), release: () => client.release() };
  });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use("/api/wallet", walletRoutes);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(method, route, token, body) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(route.startsWith("/api/wallet/") && method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json() };
  }
  const password = "PracticeSession123!";
  for (const name of ["Alice", "Bob"]) {
    const result = await request("POST", "/api/auth/register", null, {
      name, email: `${name.toLowerCase()}@example.com`, password,
    });
    assert.equal(result.status, 201);
  }
  async function login(email = "alice@example.com") {
    const response = await request("POST", "/api/auth/login", null, { email, password });
    assert.equal(response.status, 200);
    const payload = jwt.verify(response.body.token, process.env.JWT_SECRET);
    return { ...response.body, payload };
  }
  async function session(id) {
    return (await pool.query(`SELECT * FROM ${schema}.auth_sessions WHERE id = $1`, [id])).rows[0];
  }

  await t.test("login persists the session and authorizes profile and balance requests", async () => {
    const loggedIn = await login();
    const stored = await session(loggedIn.payload.sessionId);
    assert.equal(stored.user_id, loggedIn.user.id);
    assert.equal(stored.revoked_at, null);
    assert.equal(stored.expires_at.getTime(), loggedIn.payload.exp * 1000);
    assert.equal(loggedIn.payload.exp - loggedIn.payload.iat, 600);
    assert.equal(loggedIn.session.idleTimeoutSeconds, 300);
    assert.equal((await request("GET", "/api/auth/me", loggedIn.token)).status, 200);
    const balance = await request("GET", "/api/wallet/balance", loggedIn.token);
    assert.equal(balance.status, 200);
    assert.equal(balance.body.balance, "0.00");
  });

  await t.test("an idle session expires and repeated requests cannot revive it", async () => {
    const loggedIn = await login();
    await pool.query(`UPDATE ${schema}.auth_sessions SET last_seen_at = CURRENT_TIMESTAMP - INTERVAL '301 seconds' WHERE id = $1`, [loggedIn.payload.sessionId]);
    const before = await session(loggedIn.payload.sessionId);
    assert.equal((await request("GET", "/api/auth/me", loggedIn.token)).status, 401);
    assert.equal((await request("GET", "/api/wallet/balance", loggedIn.token)).status, 401);
    const after = await session(loggedIn.payload.sessionId);
    assert.equal(after.last_seen_at.getTime(), before.last_seen_at.getTime());
  });

  await t.test("activity updates last-seen time without extending the session lifetime", async () => {
    const loggedIn = await login();
    const before = await session(loggedIn.payload.sessionId);
    await pool.query(`UPDATE ${schema}.auth_sessions SET last_seen_at = CURRENT_TIMESTAMP - INTERVAL '4 minutes' WHERE id = $1`, [loggedIn.payload.sessionId]);
    assert.equal((await request("GET", "/api/auth/me", loggedIn.token)).status, 200);
    const after = await session(loggedIn.payload.sessionId);
    assert.ok(after.last_seen_at > before.last_seen_at);
    assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
  });

  await t.test("absolute database expiry rejects a still-valid JWT despite recent activity", async () => {
    const loggedIn = await login();
    await pool.query(`UPDATE ${schema}.auth_sessions SET
      created_at = CURRENT_TIMESTAMP - INTERVAL '11 minutes',
      expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second', last_seen_at = CURRENT_TIMESTAMP
      WHERE id = $1`, [loggedIn.payload.sessionId]);
    jwt.verify(loggedIn.token, process.env.JWT_SECRET);
    assert.equal((await request("GET", "/api/auth/me", loggedIn.token)).status, 401);
  });

  await t.test("logout immediately revokes one session and leaves other logins active", async () => {
    const first = await login();
    const second = await login();
    const bob = await login("bob@example.com");
    assert.notEqual(first.payload.sessionId, second.payload.sessionId);
    assert.equal((await request("POST", "/api/auth/logout", first.token)).status, 200);
    const revoked = await session(first.payload.sessionId);
    assert.ok(revoked.revoked_at instanceof Date);
    const rejected = await Promise.all([
      request("GET", "/api/auth/me", first.token),
      request("GET", "/api/wallet/balance", first.token),
      request("POST", "/api/wallet/deposit", first.token, { amount: "1.00" }),
    ]);
    assert.deepEqual(rejected.map((result) => result.status), [401, 401, 401]);
    assert.equal((await session(first.payload.sessionId)).last_seen_at.getTime(), revoked.last_seen_at.getTime());
    assert.equal((await request("GET", "/api/auth/me", second.token)).status, 200);
    assert.equal((await request("GET", "/api/auth/me", bob.token)).status, 200);
  });

  await t.test("a session ID cannot authorize another user's signed token", async () => {
    const alice = await login();
    const bob = await login("bob@example.com");
    const mismatched = jwt.sign({ userId: bob.user.id, sessionId: alice.payload.sessionId },
      process.env.JWT_SECRET, { expiresIn: "10m" });
    assert.equal((await request("GET", "/api/auth/me", mismatched)).status, 401);
    assert.equal((await request("GET", "/api/auth/me", alice.token)).status, 200);
  });

  await t.test("legacy tokens and tokens without a stored session are rejected", async () => {
    const loggedIn = await login();
    const legacy = jwt.sign({ userId: loggedIn.user.id }, process.env.JWT_SECRET, { expiresIn: "10m" });
    assert.equal((await request("GET", "/api/auth/me", legacy)).status, 401);
    await pool.query(`DELETE FROM ${schema}.auth_sessions WHERE id = $1`, [loggedIn.payload.sessionId]);
    assert.equal((await request("GET", "/api/auth/me", loggedIn.token)).status, 401);
  });

  await t.test("deleting an account removes its sessions and invalidates its token", async () => {
    assert.equal((await request("POST", "/api/auth/register", null, {
      name: "Charlie", email: "charlie@example.com", password,
    })).status, 201);
    const loggedIn = await login("charlie@example.com");
    await pool.query(`DELETE FROM ${schema}.users WHERE id = $1`, [loggedIn.user.id]);
    assert.equal(await session(loggedIn.payload.sessionId), undefined);
    assert.equal((await request("GET", "/api/auth/me", loggedIn.token)).status, 401);
  });
});
