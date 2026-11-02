import assert from "node:assert/strict";
import { test } from "node:test";
import { activityTotals, filterActivity, formatINR, normalizeAmount, toPaise } from "../src/lib/money.js";

test("payment inputs normalize to exact decimal strings", () => {
  assert.equal(normalizeAmount(" 0010.5 ", "transfer"), "10.50");
  assert.equal(normalizeAmount("0.01", "deposit"), "0.01");
  assert.equal(toPaise("0.10") + toPaise("0.20"), 30n);
  for (const value of ["0", "-1", "1e3", "1.001", "abc", "", "10000000000.00"]) {
    assert.throws(() => normalizeAmount(value, "transfer"));
  }
});

test("deposit limits match the API", () => {
  assert.equal(normalizeAmount("100000.00", "deposit"), "100000.00");
  assert.throws(() => normalizeAmount("100000.01", "deposit"), /per deposit/);
  assert.equal(normalizeAmount("100000.01", "transfer"), "100000.01");
});

test("currency formatting uses Indian grouping without floating-point arithmetic", () => {
  assert.equal(formatINR("1234567.89"), "₹12,34,567.89");
  assert.equal(formatINR(1n), "₹0.01");
  assert.equal(formatINR("0.00"), "₹0.00");
  assert.equal(formatINR("invalid"), "—");
});

test("activity totals include successful credits and debits only", () => {
  const totals = activityTotals([
    { amount: "0.10", direction: "CREDIT", status: "SUCCESS" },
    { amount: "0.20", direction: "CREDIT", status: "SUCCESS" },
    { amount: "0.01", direction: "DEBIT", status: "SUCCESS" },
    { amount: "500.00", direction: "CREDIT", status: "FAILED" },
    { amount: "500.00", direction: "DEBIT", status: "PENDING" },
  ]);
  assert.deepEqual(totals, { incoming: 30n, outgoing: 1n });
});

test("activity search combines recipient, note, and direction filters", () => {
  const transactions = [
    { id: "one", direction: "DEBIT", description: "Dinner", counterparty: { name: "Bob", email: "bob@example.com" } },
    { id: "two", direction: "CREDIT", description: "Wallet deposit", counterparty: { name: null, email: null } },
  ];
  assert.deepEqual(filterActivity(transactions, "DEBIT", " BOB ").map((item) => item.id), ["one"]);
  assert.deepEqual(filterActivity(transactions, "CREDIT", "bob"), []);
  assert.equal(filterActivity(transactions, "ALL", "").length, 2);
});
