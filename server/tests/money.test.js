const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MAX_BALANCE_PAISE, parseMoney, formatMoney } = require("../utils/money");

test("money parsing preserves exact paise and normalizes decimal strings", () => {
  for (const [input, paise, decimal] of [
    ["0", 0n, "0.00"],
    ["0.01", 1n, "0.01"],
    ["10.5", 1050n, "10.50"],
    [10.5, 1050n, "10.50"],
    ["  0010.50  ", 1050n, "10.50"],
    ["0000000000000000000000001.01", 101n, "1.01"],
    ["9999999999.99", MAX_BALANCE_PAISE, "9999999999.99"],
  ]) assert.deepEqual(parseMoney(input), { paise, decimal });
});

test("money parsing rejects malformed, imprecise, and out-of-range inputs", () => {
  for (const input of [
    null, undefined, true, false, [], [10], {}, NaN, Infinity, -Infinity,
    "", " ", "abc", "1abc", "+1", "-1", -1, "1e2", "1,000",
    "1.001", "1.", ".5", "10000000000.00", "99999999999999999999999",
    0.1 + 0.2,
  ]) assert.equal(parseMoney(input), null, `Unexpectedly accepted ${String(input)}`);
});

test("paise arithmetic is exact and formatting enforces the schema limit", () => {
  assert.equal(formatMoney(parseMoney("0.10").paise + parseMoney("0.20").paise), "0.30");
  assert.equal(formatMoney(parseMoney("0.30").paise - parseMoney("0.20").paise), "0.10");
  assert.equal(formatMoney(MAX_BALANCE_PAISE), "9999999999.99");
  for (const input of [-1n, MAX_BALANCE_PAISE + 1n, 10, "10"]) {
    assert.throws(() => formatMoney(input), RangeError);
  }
});
