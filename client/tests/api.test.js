import assert from "node:assert/strict";
import { test } from "node:test";
import { apiRequest, createPaymentAttempt, sendPayment, sessionDeadline } from "../src/lib/api.js";

const receipt = { transaction: { id: "one-payment", amount: "10.00" }, wallet: { balance: "110.00" } };
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });

test("protected requests send the token only in an authorization header", async () => {
  let captured;
  await apiRequest("/wallet/balance", { token: "private-token", fetchImpl: async (url, options) => {
    captured = { url, options };
    return jsonResponse({ balance: "100.00" });
  } });
  assert.equal(captured.url, "/api/wallet/balance");
  assert.equal(captured.options.headers.Authorization, "Bearer private-token");
  assert.equal(captured.options.cache, "no-store");
  assert.ok(!captured.url.includes("private-token"));
});

test("a payment attempt keeps immutable details and one key across a lost response and retry", async () => {
  let generated = 0;
  const body = { amount: "10.00", description: "Dinner" };
  const attempt = createPaymentAttempt("alice", "deposit", body, () => { generated += 1; return "same-payment-key"; });
  body.amount = "99.00";
  assert.throws(() => { attempt.body.amount = "50.00"; }, TypeError);
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, key: options.headers["Idempotency-Key"], body: options.body });
    if (requests.length === 1) throw new TypeError("Connection lost after the server committed");
    return jsonResponse(receipt);
  };
  await assert.rejects(sendPayment(attempt, "first-session-token", { fetchImpl }), (error) => error.status === 0 && error.uncertain);
  const result = await sendPayment(attempt, "new-session-token", { fetchImpl });
  assert.equal(result.transaction.id, "one-payment");
  assert.equal(generated, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(JSON.parse(requests[1].body).amount, "10.00");
});

test("separate payments receive separate keys", () => {
  let sequence = 0;
  const key = () => `payment-${++sequence}`;
  const first = createPaymentAttempt("alice", "transfer", { amount: "1.00" }, key);
  const second = createPaymentAttempt("alice", "transfer", { amount: "1.00" }, key);
  assert.notEqual(first.key, second.key);
  assert.throws(() => createPaymentAttempt("alice", "unknown", {}, key));
});

for (const [status, uncertain] of [[400, false], [401, false], [403, false], [409, false], [500, true], [503, true]]) {
  test(`HTTP ${status} retains its status and payment outcome classification`, async () => {
    await assert.rejects(apiRequest("/wallet/transfer", {
      method: "POST", body: { amount: "1.00" }, fetchImpl: async () => jsonResponse({ error: "Request failed" }, status),
    }), (error) => error.status === status && error.uncertain === uncertain);
  });
}

test("a malformed successful payment response stays uncertain", async () => {
  const attempt = createPaymentAttempt("alice", "deposit", { amount: "10.00" }, () => "saved-key");
  for (const fetchImpl of [async () => new Response("broken JSON", { status: 200 }), async () => jsonResponse({ message: "Missing receipt" })]) {
    await assert.rejects(sendPayment(attempt, "token", { fetchImpl }), (error) => error.uncertain && error.status === 200);
    assert.equal(attempt.key, "saved-key");
  }
});

test("aborting a payment does not imply the server rolled it back", async () => {
  const abort = new AbortController();
  const pending = apiRequest("/wallet/deposit", {
    method: "POST", signal: abort.signal,
    fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })),
  });
  abort.abort();
  await assert.rejects(pending, (error) => error.aborted && error.uncertain);
});

test("session deadlines honor both inactivity and the fixed maximum lifetime", () => {
  const start = Date.UTC(2026, 9, 29, 10, 0, 0);
  const session = { session: { expiresAt: new Date(start + 600000).toISOString(), idleTimeoutSeconds: 300 } };
  assert.equal(sessionDeadline(session, start), start + 300000);
  assert.equal(sessionDeadline(session, start + 480000), start + 600000);
});
