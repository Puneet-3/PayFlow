export function toPaise(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) throw new Error("Enter an amount with up to two decimal places.");
  return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

export function decimal(paise) {
  return `${paise / 100n}.${String(paise % 100n).padStart(2, "0")}`;
}

export function normalizeAmount(value, operation) {
  const paise = toPaise(value);
  if (paise <= 0n) throw new Error("Enter an amount greater than zero.");
  if (paise > 999999999999n) throw new Error("The amount exceeds the wallet limit.");
  if (operation === "deposit" && paise > 10000000n) {
    throw new Error("You can add up to ₹1,00,000 per deposit.");
  }
  return decimal(paise);
}

export function formatINR(value) {
  try {
    const paise = typeof value === "bigint" ? value : toPaise(value);
    return `₹${(paise / 100n).toLocaleString("en-IN")}.${String(paise % 100n).padStart(2, "0")}`;
  } catch {
    return "—";
  }
}

export function activityTotals(transactions) {
  return transactions.reduce((totals, transaction) => {
    if (transaction.status !== "SUCCESS") return totals;
    const amount = toPaise(transaction.amount);
    if (transaction.direction === "CREDIT") totals.incoming += amount;
    else if (transaction.direction === "DEBIT") totals.outgoing += amount;
    return totals;
  }, { incoming: 0n, outgoing: 0n });
}

export function filterActivity(transactions, direction, search) {
  const query = search.trim().toLowerCase();
  return transactions.filter((transaction) => {
    const matchesDirection = direction === "ALL" || transaction.direction === direction;
    const text = [transaction.description, transaction.type,
      transaction.counterparty?.name, transaction.counterparty?.email].filter(Boolean).join(" ").toLowerCase();
    return matchesDirection && (!query || text.includes(query));
  });
}
