// NUMERIC(12, 2) stores up to 9,999,999,999.99 rupees.
const MAX_BALANCE_PAISE = 999999999999n;

function formatMoney(paise) {
  if (typeof paise !== "bigint" || paise < 0n || paise > MAX_BALANCE_PAISE) {
    throw new RangeError("Money must be a non-negative BigInt within the wallet balance limit");
  }
  return `${paise / 100n}.${String(paise % 100n).padStart(2, "0")}`;
}

function parseMoney(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;

  const rupees = match[1].replace(/^0+(?=\d)/, "");
  if (rupees.length > 10) return null;
  const paise = BigInt(rupees) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  if (paise > MAX_BALANCE_PAISE) return null;

  return { paise, decimal: formatMoney(paise) };
}

module.exports = { MAX_BALANCE_PAISE, parseMoney, formatMoney };
