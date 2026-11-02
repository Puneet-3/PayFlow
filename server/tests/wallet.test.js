const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const walletRoutes = require("../routes/wallet");

test("wallet request validation", async (t) => {
  // Use real HTTP and JWT verification, with no connection to Supabase.
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "wallet-validation-test-secret";
  const aliceId = "00000000-0000-0000-0000-000000000001";
  const bobId = "00000000-0000-0000-0000-000000000002";
  const sessionId = randomUUID();
  const token = jwt.sign({ userId: aliceId, sessionId }, process.env.JWT_SECRET, { expiresIn: "10m" });
  let calls = [];
  let allowDatabase = false;
  let recordedDescription;
  let releases = 0;
  const payments = new Map();

  t.mock.method(db, "query", async (sql, params) => {
    // Session checks are expected; calls tracks only payment database work.
    if (sql.trim().startsWith("UPDATE auth_sessions SET last_seen_at")) {
      assert.deepEqual(params, [sessionId, aliceId, 300]);
      return { rows: [{ id: sessionId }] };
    }
    calls.push("pool query");
    throw new Error("Unexpected pool query");
  });
  t.mock.method(db.pool, "connect", async () => {
    calls.push("connect");
    assert.ok(allowDatabase, "Invalid input must not acquire a database connection");
    return {
      async query(sql, params) {
        const statement = sql.trim().replace(/\s+/g, " ");
        calls.push(statement);
        if (["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
        const paymentKey = JSON.stringify(params?.slice(0, 3));
        if (statement.startsWith("INSERT INTO payment_requests")) {
          if (payments.has(paymentKey)) return { rows: [] };
          payments.set(paymentKey, { request_hash: params[3], response_status: null, response_body: null });
          return { rows: [{ idempotency_key: params[2] }] };
        }
        if (statement.startsWith("SELECT request_hash")) {
          return { rows: payments.has(paymentKey) ? [payments.get(paymentKey)] : [] };
        }
        if (statement.startsWith("UPDATE payment_requests")) {
          const payment = payments.get(paymentKey);
          assert.ok(payment);
          payment.response_status = 200;
          payment.response_body = JSON.parse(params[3]);
          return { rows: [{ idempotency_key: params[2] }] };
        }
        if (statement.startsWith("SELECT id, email FROM users")) {
          return { rows: [{ id: aliceId, email: "alice@example.com" }] };
        }
        if (statement.startsWith("SELECT id, name, email FROM users")) {
          assert.equal(params[0], "bob@example.com");
          return { rows: [{ id: bobId, name: "Bob", email: "bob@example.com" }] };
        }
        if (statement.startsWith("INSERT INTO wallets")) {
          assert.deepEqual(params[0], [aliceId, bobId]);
          return { rows: [] };
        }
        if (statement.startsWith("SELECT * FROM wallets") && statement.includes("FOR UPDATE")) {
          assert.match(statement, /ORDER BY user_id FOR UPDATE/);
          return { rows: params[0].map((userId) => ({ id: `${userId}-wallet`, user_id: userId, balance: "100.00", currency: "INR" })) };
        }
        if (statement.startsWith("SELECT * FROM wallets")) {
          return { rows: [{ id: `${params[0]}-wallet`, user_id: params[0], balance: "100.00", currency: "INR" }] };
        }
        if (statement.startsWith("UPDATE wallets")) {
          assert.equal(params[0], "10.50");
          return { rows: [{ id: "alice-wallet", balance: statement.includes("balance -") ? "89.50" : "110.50", currency: "INR" }] };
        }
        if (statement.startsWith("INSERT INTO transactions")) {
          const transfer = statement.includes("'TRANSFER'");
          assert.equal(params[transfer ? 2 : 1], "10.50");
          recordedDescription = params[transfer ? 3 : 2];
          return { rows: [{ id: "test-transaction", amount: "10.50", type: transfer ? "TRANSFER" : "DEPOSIT", status: "SUCCESS", description: recordedDescription }] };
        }
        throw new Error(`Unexpected query: ${statement}`);
      },
      release() {
        releases += 1;
      },
    };
  });

  const app = express();
  app.use(express.json());
  app.use("/api/wallet", walletRoutes);
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
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/wallet`;

  async function post(path, body, authenticated = true, key = randomUUID()) {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), replayed: response.headers.get("Idempotency-Replayed") };
  }

  for (const path of ["deposit", "transfer"]) {
    const valid = { amount: "10.50", ...(path === "transfer" ? { recipientEmail: "bob@example.com" } : {}) };
    const invalidBodies = [
      ["missing body", undefined],
      ["array body", [valid]],
      ["missing fields", {}],
    ];
    for (const [label, amount] of [
      ["array amount", [10.5]],
      ["object amount", {}],
      ["boolean amount", true],
      ["false amount", false],
      ["null amount", null],
      ["missing amount", undefined],
      ["zero amount", 0],
      ["negative amount", -10],
      ["blank amount", "   "],
      ["non-numeric amount", "abc"],
      ["too many decimal places", "10.501"],
      ["amount above the database limit", "10000000000.00"],
      ["floating-point calculation", 0.1 + 0.2],
    ]) invalidBodies.push([label, { ...valid, amount }]);
    for (const description of [123, true, null, [], {}]) {
      invalidBodies.push([`${JSON.stringify(description)} description`, { ...valid, description }]);
    }
    if (path === "deposit") {
      invalidBodies.push(["deposit above the limit", { ...valid, amount: "100000.01" }]);
    } else {
      for (const recipientEmail of [123, true, null, [], {}, ""]) {
        invalidBodies.push([`${JSON.stringify(recipientEmail)} recipient`, { ...valid, recipientEmail }]);
      }
    }

    for (const [label, body] of invalidBodies) {
      await t.test(`${path} rejects ${label} before payment database work`, async () => {
        calls = [];
        const response = await post(path, body);
        assert.equal(response.status, 400);
        assert.equal(typeof response.body.error, "string");
        assert.deepEqual(calls, []);
      });
    }

    await t.test(`${path} still requires authentication`, async () => {
      calls = [];
      const response = await post(path, valid, false);
      assert.equal(response.status, 401);
      assert.deepEqual(calls, []);
    });

    for (const key of [null, "a".repeat(129), "bad key", "key,duplicate", "_invalid-start"]) {
      await t.test(`${path} rejects an invalid or missing idempotency key (${String(key).slice(0, 20)})`, async () => {
        calls = [];
        const response = await post(path, valid, true, key);
        assert.equal(response.status, 400);
        assert.match(response.body.error, /Idempotency-Key/);
        assert.deepEqual(calls, []);
      });
    }

    for (const amount of ["10.50", 10.5]) {
      await t.test(`${path} accepts a valid ${typeof amount} amount`, async () => {
        calls = [];
        allowDatabase = true;
        const previousReleases = releases;
        try {
          const response = await post(path, { ...valid, amount });
          assert.equal(response.status, 200);
          assert.equal(path === "deposit" ? response.body.wallet.balance : response.body.newBalance,
            path === "deposit" ? "110.50" : "89.50");
          assert.equal(recordedDescription, path === "deposit" ? "Wallet deposit" : "Transfer to Bob");
          assert.ok(calls.includes("COMMIT"));
          assert.ok(!calls.includes("ROLLBACK"));
          assert.equal(releases, previousReleases + 1);
        } finally {
          allowDatabase = false;
        }
      });
    }

    await t.test(`${path} accepts a string description`, async () => {
      allowDatabase = true;
      try {
        const response = await post(path, { ...valid, description: "  Practice payment  " });
        assert.equal(response.status, 200);
        assert.equal(recordedDescription, path === "deposit" ? "  Practice payment  " : "Practice payment");
      } finally {
        allowDatabase = false;
      }
    });

    await t.test(`${path} replays the saved response for equivalent payment details`, async () => {
      allowDatabase = true;
      try {
        const key = randomUUID();
        const original = await post(path, valid, true, key);
        assert.equal(original.status, 200);
        calls = [];
        const equivalent = { ...valid, amount: 10.5 };
        if (path === "transfer") equivalent.recipientEmail = "  BOB@EXAMPLE.COM  ";
        const replay = await post(path, equivalent, true, key);
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.body, original.body);
        assert.equal(replay.replayed, "true");
        assert.ok(!calls.some((sql) => /^(UPDATE wallets|INSERT INTO transactions)/.test(sql)));
        assert.ok(calls.includes("ROLLBACK"));
      } finally {
        allowDatabase = false;
      }
    });

    await t.test(`${path} rejects the same key with changed payment details`, async () => {
      allowDatabase = true;
      try {
        const key = randomUUID();
        assert.equal((await post(path, valid, true, key)).status, 200);
        calls = [];
        const response = await post(path, { ...valid, amount: "11.50" }, true, key);
        assert.equal(response.status, 409);
        assert.match(response.body.error, /different payment details/);
        assert.ok(!calls.some((sql) => /^(UPDATE wallets|INSERT INTO transactions)/.test(sql)));
      } finally {
        allowDatabase = false;
      }
    });

    await t.test(`${path} returns JSON when acquiring a database connection fails`, async (st) => {
      const errors = [];
      st.mock.method(console, "error", (...args) => errors.push(args));
      st.mock.method(db.pool, "connect", async () => {
        throw new Error("Test database unavailable");
      });
      const response = await post(path, valid);
      assert.equal(response.status, 500);
      assert.equal(response.body.error,
        path === "deposit" ? "Deposit transaction failed" : "Transfer failed due to internal error");
      assert.equal(errors.length, 1);
    });
  }
});
