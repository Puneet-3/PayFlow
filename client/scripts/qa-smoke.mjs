// Run only with server/integration/ui-preview.cjs and Vite proxying that API.
import assert from "node:assert/strict";
import { apiRequest, createPaymentAttempt, sendPayment } from "../src/lib/api.js";

const base = process.env.QA_FRONTEND_URL || "http://127.0.0.1:5173";
const marker = await fetch(`${base}/api/__qa`).then((response) => response.json());
assert.equal(marker.isolated, true, "Refusing to run against a non-QA API");
const options = { fetchImpl: (url, init) => fetch(`${base}${url}`, init) };
const call = (path, init = {}) => apiRequest(path, { ...options, ...init });
const login = (email) => call("/auth/login", { method: "POST", body: { email, password: "PracticeWallet123!" } });
const alice = await login("alice.ui@example.com");
const phase = process.argv[2];
const balance = async (session) => (await call("/wallet/balance", { token: session.token })).balance;
const history = async () => (await call("/wallet/transactions", { token: alice.token })).transactions;
const lostPayment = () => createPaymentAttempt(alice.user.id, "transfer", {
  amount: "10.00", recipientEmail: "bob.ui@example.com", description: "Lost-response retry check",
}, () => "ui-lost-transfer");

if (phase === "initial") {
  assert.equal(await balance(alice), "12851.00");
  assert.equal((await history()).length, 4);
  const deposit = createPaymentAttempt(alice.user.id, "deposit", { amount: "100.00", description: "UI smoke deposit" }, () => "ui-deposit-once");
  const original = await sendPayment(deposit, alice.token, options);
  const replay = await sendPayment(deposit, alice.token, options);
  assert.equal(original.transaction.id, replay.transaction.id);
  assert.equal(await balance(alice), "12951.00");
  const transfer = createPaymentAttempt(alice.user.id, "transfer", {
    amount: "25.00", recipientEmail: "bob.ui@example.com", description: "UI smoke transfer",
  }, () => "ui-transfer-once");
  await sendPayment(transfer, alice.token, options);
  await sendPayment(transfer, alice.token, options);
  const bob = await login("bob.ui@example.com");
  assert.equal(await balance(alice), "12926.00");
  assert.equal(await balance(bob), "5174.00");
  assert.equal((await history()).length, 6);
  console.log("PASS: login, balance, history, deposit, transfer, and duplicate requests through Vite proxy.");
} else if (phase === "lost") {
  // Vite may turn an upstream socket failure into a 502 response.
  await assert.rejects(sendPayment(lostPayment(), alice.token, options), (error) =>
    error.uncertain && (error.status === 0 || error.status >= 500));
  assert.equal(await balance(alice), "12916.00");
  assert.equal((await history()).length, 7);
  console.log("PASS: a response lost after commit is classified as uncertain; the payment was processed once.");
} else if (phase === "retry") {
  const result = await sendPayment(lostPayment(), alice.token, options);
  assert.equal(result.newBalance, "12916.00");
  assert.equal(await balance(alice), "12916.00");
  const transactions = await history();
  assert.equal(transactions.length, 7);
  assert.equal(transactions.filter((item) => item.description === "Lost-response retry check").length, 1);
  const bob = await login("bob.ui@example.com");
  assert.equal(await balance(bob), "5184.00");
  await call("/auth/logout", { method: "POST", token: alice.token });
  await assert.rejects(balance(alice), (error) => error.status === 401);
  assert.equal(await balance(bob), "5184.00");
  await call("/auth/register", { method: "POST", body: {
    name: "Charlie QA", email: "charlie.ui@example.com", password: "PracticeWallet123!",
  } });
  const charlie = await login("charlie.ui@example.com");
  assert.equal(await balance(charlie), "0.00");
  console.log("PASS: retry after fresh login uses the original key, balances stay correct, logout revokes access, and registration starts an empty wallet.");
} else throw new Error("Choose phase: initial, lost, or retry");
