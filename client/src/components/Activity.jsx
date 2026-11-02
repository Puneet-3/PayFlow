import { useState } from "react";
import { filterActivity, formatINR } from "../lib/money.js";
import { Icon } from "./Icon.jsx";

const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const timeFormat = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function dateParts(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? { date: "—", time: "" } : { date: dateFormat.format(date), time: timeFormat.format(date) };
}

export default function Activity({ transactions, loading, hidden, full, onViewAll, onAddFunds }) {
  const [direction, setDirection] = useState("ALL");
  const [search, setSearch] = useState("");
  const filtered = filterActivity(transactions, direction, search);
  const visible = full ? filtered : filtered.slice(0, 5);

  return <section className="activity-card" aria-labelledby="activity-heading" aria-busy={loading}>
    <div className="section-heading"><div><h2 id="activity-heading">{full ? "Transaction history" : "Recent transactions"}</h2><p>{transactions.length ? `Your latest ${transactions.length} transaction${transactions.length === 1 ? "" : "s"}` : "Your deposits and transfers will appear here."}</p></div>{!full && transactions.length ? <button className="text-button view-all" onClick={onViewAll}>View all <Icon name="arrow" size={16} /></button> : null}</div>
    <div className="activity-tools">
      <label className="search-input"><Icon name="search" size={18} /><span className="sr-only">Search activity</span><input type="search" placeholder="Search activity…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="filter-select"><span className="sr-only">Filter activity</span><select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="ALL">All activity</option><option value="CREDIT">Money in</option><option value="DEBIT">Money out</option></select></label>
    </div>
    {loading && !transactions.length ? <div className="activity-skeleton" role="status" aria-label="Loading activity">{[1, 2, 3].map((item) => <div className="skeleton-row" key={item}><span /><i /><b /></div>)}</div> : visible.length ? <div className="table-scroll"><table><caption className="sr-only">Wallet transaction history</caption><thead><tr><th scope="col">Transaction</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col" className="amount-column">Amount</th></tr></thead><tbody>{visible.map((transaction) => {
      const incoming = transaction.direction === "CREDIT";
      const deposit = transaction.type === "DEPOSIT";
      const title = deposit ? "Money added" : transaction.type === "WITHDRAW" ? "Withdrawal" : `${incoming ? "From" : "To"} ${transaction.counterparty?.name || transaction.counterparty?.email || "another wallet"}`;
      const { date, time } = dateParts(transaction.createdAt);
      return <tr key={transaction.id}><td><div className="transaction-person"><span className={`transaction-icon ${incoming ? "incoming" : "outgoing"}`}><Icon name={deposit ? "plus" : incoming ? "receive" : "send"} size={19} /></span><div><strong>{title}</strong><span title={transaction.description || ""}>{transaction.description || transaction.counterparty?.email || "Wallet transaction"}</span></div></div></td><td><span className="table-date">{date}</span><span className="table-subtext">{time}</span></td><td><span className={`status-pill ${transaction.status === "SUCCESS" ? "completed" : "pending"}`}><i />{transaction.status === "SUCCESS" ? "Completed" : transaction.status === "FAILED" ? "Failed" : "Pending"}</span></td><td className={`amount-column transaction-amount ${incoming ? "credit-amount" : ""}`}>{hidden ? "••••••" : `${incoming ? "+" : "−"}${formatINR(transaction.amount)}`}</td></tr>;
    })}</tbody></table></div> : <div className="empty-state"><span className="empty-icon"><Icon name={transactions.length ? "search" : "activity"} size={27} /></span><h3>{transactions.length ? "No matching activity" : "Your story starts here"}</h3><p>{transactions.length ? "Try another search or change your filter." : "Add some practice funds to make your first move."}</p>{transactions.length ? <button className="text-button" onClick={() => { setSearch(""); setDirection("ALL"); }}>Clear filters</button> : <button className="text-button" onClick={onAddFunds}>Add your first funds <Icon name="arrow" size={16} /></button>}</div>}
    <div className="activity-footer"><Icon name="shield" size={14} /><span>{transactions.length >= 50 ? "Showing the latest 50 transactions." : "Your activity stays with your wallet."}</span>{loading && transactions.length ? <span className="updating-label">Updating…</span> : null}</div>
  </section>;
}
