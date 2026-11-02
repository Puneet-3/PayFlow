require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const db = require("../db");
const walletRoutes = require("../routes/wallet");

test("wallet transactions against PostgreSQL in an isolated schema", { timeout: 300000 }, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  assert.ok(connectionString, "Set TEST_DATABASE_URL or DATABASE_URL before running integration tests");
  const schema = `wallet_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
      ? false : { rejectUnauthorized: false },
    max: 8,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    query_timeout: 20000,
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
      // This generated name is the only schema the test may remove.
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
      id UUID PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL
    );
    CREATE TABLE ${schema}.wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID UNIQUE NOT NULL REFERENCES ${schema}.users(id),
      balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ${schema}.transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_wallet_id UUID REFERENCES ${schema}.wallets(id),
      receiver_wallet_id UUID REFERENCES ${schema}.wallets(id),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      type VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL,
      description TEXT, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT reject_test_description CHECK (description IS DISTINCT FROM 'force-ledger-failure')
    );
  `);
  const aliceId = "00000000-0000-0000-0000-000000000001";
  const bobId = "00000000-0000-0000-0000-000000000002";
  await pool.query(`INSERT INTO ${schema}.users VALUES ($1, 'Alice', 'alice@example.com'), ($2, 'Bob', 'bob@example.com')`, [aliceId, bobId]);

  // Qualify every application table explicitly: no session search_path assumptions
  // and no application query can touch the project's public tables.
  const qualify = (sql) => sql.replace(/\b(users|wallets|transactions|payment_requests|auth_sessions)\b/g, `${schema}.$1`);
  const idempotencySchema = readFileSync(path.join(__dirname, "..", "migrations", "001_idempotency.sql"), "utf8");
  await pool.query(qualify(idempotencySchema));
  const sessionsSchema = readFileSync(path.join(__dirname, "..", "migrations", "002_auth_sessions.sql"), "utf8");
  await pool.query(qualify(sessionsSchema));
  await pool.query(`ALTER TABLE ${schema}.payment_requests ADD CONSTRAINT reject_test_response
    CHECK (idempotency_key <> 'force-result-write-failure' OR response_status IS NULL)`);
  t.mock.method(db, "query", (sql, params) => pool.query(qualify(sql), params));
  t.mock.method(db.pool, "connect", async () => {
    const client = await pool.connect();
    return {
      query: (sql, params) => client.query(qualify(sql), params),
      release: () => client.release(),
    };
  });
  const expectedErrors = [];
  t.mock.method(console, "error", (...args) => expectedErrors.push(args));
  const app = express();
  app.use(express.json());
  app.use("/api/wallet", walletRoutes);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/wallet`;
  const tokens = {};
  for (const id of [aliceId, bobId]) {
    const sessionId = randomUUID();
    await pool.query(`INSERT INTO ${schema}.auth_sessions (id, user_id, expires_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`, [sessionId, id]);
    tokens[id] = jwt.sign({ userId: id, sessionId }, process.env.JWT_SECRET, { expiresIn: "10m" });
  }

  async function request(path, userId, body, key = randomUUID()) {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${tokens[userId]}`,
        "Content-Type": "application/json",
        ...(body === undefined || key === null ? {} : { "Idempotency-Key": key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json(), replayed: response.headers.get("Idempotency-Replayed") };
  }
  async function seed(aliceBalance, bobBalance) {
    await pool.query(`DELETE FROM ${schema}.payment_requests`);
    await pool.query(`DELETE FROM ${schema}.transactions`);
    for (const [id, balance] of [[aliceId, aliceBalance], [bobId, bobBalance]]) {
      await pool.query(`INSERT INTO ${schema}.wallets (user_id, balance) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`, [id, balance]);
    }
  }
  async function balances(aliceBalance, bobBalance) {
    for (const [id, expected] of [[aliceId, aliceBalance], [bobId, bobBalance]]) {
      const response = await request("balance", id);
      assert.equal(response.status, 200);
      assert.equal(response.body.balance, expected);
    }
  }
  async function transactionCount(expected) {
    const result = await pool.query(`SELECT count(*)::int AS count FROM ${schema}.transactions`);
    assert.equal(result.rows[0].count, expected);
  }
  async function paymentCount(expected) {
    const result = await pool.query(`SELECT count(*)::int AS count FROM ${schema}.payment_requests`);
    assert.equal(result.rows[0].count, expected);
  }

  await t.test("small deposits retain exact decimal balances and history", async () => {
    await seed("0.00", "0.00");
    for (const amount of ["0.10", "0.20"]) {
      assert.equal((await request("deposit", aliceId, { amount })).status, 200);
    }
    await balances("0.30", "0.00");
    const history = await request("transactions", aliceId);
    assert.equal(history.body.count, 2);
    assert.deepEqual(history.body.transactions.map((tx) => tx.amount).sort(), ["0.10", "0.20"]);
  });

  await t.test("two competing transfers cannot overspend the same balance", async () => {
    await seed("75.00", "25.00");
    const results = await Promise.all([1, 2].map(() => request("transfer", aliceId, {
      recipientEmail: "bob@example.com", amount: "60.00",
    })));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
    assert.equal(results.find((result) => result.status === 400).body.error, "Insufficient funds");
    await balances("15.00", "85.00");
    await transactionCount(1);
    const aliceHistory = await request("transactions", aliceId);
    const bobHistory = await request("transactions", bobId);
    assert.equal(aliceHistory.body.transactions[0].direction, "DEBIT");
    assert.equal(bobHistory.body.transactions[0].direction, "CREDIT");
    assert.equal(aliceHistory.body.transactions[0].id, bobHistory.body.transactions[0].id);
  });

  await t.test("opposite-direction transfers finish and conserve the combined balance", async () => {
    await seed("100.00", "100.00");
    const results = await Promise.all(Array.from({ length: 4 }, () => [
      request("transfer", aliceId, { recipientEmail: "bob@example.com", amount: "1.00" }),
      request("transfer", bobId, { recipientEmail: "alice@example.com", amount: "1.00" }),
    ]).flat());
    assert.deepEqual(results.map((result) => result.status), Array(8).fill(200));
    await balances("100.00", "100.00");
    await transactionCount(8);
  });

  await t.test("failed history inserts undo transfer and deposit balance changes", async () => {
    await seed("75.00", "25.00");
    assert.equal((await request("transfer", aliceId, {
      recipientEmail: "bob@example.com", amount: "10.00", description: "force-ledger-failure",
    })).status, 500);
    assert.equal((await request("deposit", aliceId, {
      amount: "10.00", description: "force-ledger-failure",
    })).status, 500);
    await balances("75.00", "25.00");
    await transactionCount(0);
    assert.equal(expectedErrors.length, 2);
  });

  await t.test("deposit accepts the exact balance limit and rejects overflow", async () => {
    await seed("9999999999.98", "0.00");
    assert.equal((await request("deposit", aliceId, { amount: "0.01" })).status, 200);
    assert.equal((await request("deposit", aliceId, { amount: "0.01" })).status, 400);
    await balances("9999999999.99", "0.00");
    await transactionCount(1);
  });

  await t.test("recipient overflow rejects the transfer without changing either wallet", async () => {
    await seed("1.00", "9999999999.99");
    assert.equal((await request("transfer", aliceId, {
      recipientEmail: "bob@example.com", amount: "0.01",
    })).status, 400);
    await balances("1.00", "9999999999.99");
    await transactionCount(0);
  });

  await t.test("a missing recipient wallet is provisioned inside the transfer", async () => {
    await seed("1.00", "0.00");
    await pool.query(`DELETE FROM ${schema}.wallets WHERE user_id = $1`, [bobId]);
    assert.equal((await request("transfer", aliceId, {
      recipientEmail: "bob@example.com", amount: "0.50",
    })).status, 200);
    await balances("0.50", "0.50");
    await transactionCount(1);
  });

  for (const operation of ["deposit", "transfer"]) {
    const payment = {
      amount: "10.50",
      ...(operation === "transfer" ? { recipientEmail: "bob@example.com" } : {}),
      description: "Original payment",
    };

    await t.test(`${operation} replays the original result and rejects changed details`, async () => {
      await seed("75.00", "25.00");
      const key = randomUUID();
      const original = await request(operation, aliceId, payment, key);
      assert.equal(original.status, 200);
      const equivalent = { ...payment, amount: 10.5 };
      if (operation === "transfer") equivalent.recipientEmail = "  BOB@EXAMPLE.COM  ";
      const replay = await request(operation, aliceId, equivalent, key);
      assert.equal(replay.status, 200);
      assert.equal(replay.replayed, "true");
      assert.deepEqual(replay.body, original.body);

      for (const changed of [
        { ...payment, amount: "11.50" },
        { ...payment, description: "Different payment" },
        ...(operation === "transfer" ? [{ ...payment, recipientEmail: "alice@example.com" }] : []),
      ]) assert.equal((await request(operation, aliceId, changed, key)).status, 409);

      assert.equal((await request(operation, aliceId, { ...payment, amount: "1.00" })).status, 200);
      const oldResult = await request(operation, aliceId, payment, key);
      assert.equal(oldResult.status, 200);
      assert.deepEqual(oldResult.body, original.body);
      await balances(operation === "deposit" ? "86.50" : "63.50", operation === "deposit" ? "25.00" : "36.50");
      await transactionCount(2);
      await paymentCount(2);
    });

    await t.test(`${operation} processes simultaneous requests with the same key once`, async () => {
      await seed("75.00", "25.00");
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 3 }, () => request(operation, aliceId, payment, key)));
      assert.deepEqual(results.map((result) => result.status), [200, 200, 200]);
      for (const result of results) assert.deepEqual(result.body, results[0].body);
      assert.equal(results.filter((result) => result.replayed === "true").length, 2);
      await balances(operation === "deposit" ? "85.50" : "64.50", operation === "deposit" ? "25.00" : "35.50");
      await transactionCount(1);
      await paymentCount(1);
    });

    await t.test(`${operation} rolls back the key and money when history or response storage fails`, async () => {
      await seed("75.00", "25.00");
      const key = randomUUID();
      assert.equal((await request(operation, aliceId, {
        ...payment, description: "force-ledger-failure",
      }, key)).status, 500);
      await balances("75.00", "25.00");
      await transactionCount(0);
      await paymentCount(0);

      assert.equal((await request(operation, aliceId, payment, "force-result-write-failure")).status, 500);
      await balances("75.00", "25.00");
      await transactionCount(0);
      await paymentCount(0);

      // Failed transactions do not reserve a key, so the corrected request can retry.
      assert.equal((await request(operation, aliceId, payment, key)).status, 200);
      await balances(operation === "deposit" ? "85.50" : "64.50", operation === "deposit" ? "25.00" : "35.50");
      await transactionCount(1);
      await paymentCount(1);
    });
  }

  await t.test("keys are scoped to the authenticated user and payment operation", async () => {
    await seed("10.00", "0.00");
    const key = randomUUID();
    const aliceDeposit = await request("deposit", aliceId, { amount: "1.00" }, key);
    const bobDeposit = await request("deposit", bobId, { amount: "1.00" }, key);
    const transfer = await request("transfer", aliceId, { recipientEmail: "bob@example.com", amount: "1.00" }, key);
    assert.deepEqual([aliceDeposit.status, bobDeposit.status, transfer.status], [200, 200, 200]);
    assert.deepEqual((await request("deposit", aliceId, { amount: "1.00" }, key)).body, aliceDeposit.body);
    assert.deepEqual((await request("deposit", bobId, { amount: "1.00" }, key)).body, bobDeposit.body);
    assert.deepEqual((await request("transfer", aliceId, { recipientEmail: "bob@example.com", amount: "1.00" }, key)).body, transfer.body);
    await balances("10.00", "2.00");
    await transactionCount(3);
    await paymentCount(3);
  });

  await t.test("an insufficient-funds rejection leaves the key available for retry", async () => {
    await seed("0.00", "0.00");
    const key = randomUUID();
    const payment = { recipientEmail: "bob@example.com", amount: "1.00" };
    assert.equal((await request("transfer", aliceId, payment, key)).status, 400);
    await paymentCount(0);
    assert.equal((await request("deposit", aliceId, { amount: "1.00" })).status, 200);
    assert.equal((await request("transfer", aliceId, payment, key)).status, 200);
    await balances("0.00", "1.00");
    await transactionCount(2);
    await paymentCount(2);
  });
});
