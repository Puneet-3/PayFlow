import { useEffect, useState } from "react";
import { sessionDeadline } from "../lib/api.js";
import { activityTotals, formatINR } from "../lib/money.js";
import { Brand, Icon } from "./Icon.jsx";
import Activity, { dateParts } from "./Activity.jsx";
import PaymentPanel from "./PaymentPanel.jsx";

function SessionClock({ session, lastActivity }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const remaining = Math.max(0, Math.ceil((sessionDeadline(session, lastActivity) - now) / 1000));
  const time = String(Math.floor(remaining / 60)).padStart(2, "0") + ":" + String(remaining % 60).padStart(2, "0");
  return <span className={`session-badge ${remaining <= 60 ? "session-warning" : ""}`} title="Your session signs out when this countdown ends."><Icon name="clock" size={15} /><span>Session ends in <strong>{time}</strong></span></span>;
}

function Stats({ transactions, hidden, ready }) {
  const totals = activityTotals(transactions);
  return <div className="stats-grid">
    <div className="stat"><span className="stat-icon incoming"><Icon name="receive" size={19} /></span><div><p>Total received</p><strong>{!ready ? "—" : hidden ? "••••••" : formatINR(totals.incoming)}</strong></div></div>
    <div className="stat"><span className="stat-icon outgoing"><Icon name="send" size={19} /></span><div><p>Total sent</p><strong>{!ready ? "—" : hidden ? "••••••" : formatINR(totals.outgoing)}</strong></div></div>
    <div className="stat"><span className="stat-icon neutral"><Icon name="activity" size={19} /></span><div><p>Transactions</p><strong>{ready ? transactions.length : "—"}<small> recent</small></strong></div></div>
  </div>;
}

export default function Dashboard({ model }) {
  const [view, setView] = useState("overview");
  const [operation, setOperation] = useState(() => model.attempt?.payment.operation || "transfer");
  const [hidden, setHidden] = useState(false);
  const [reviewRequest, setReviewRequest] = useState(0);
  const user = model.session.user;
  const initials = user.name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase();
  const today = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date());
  const paymentLocked = model.paymentBusy || Boolean(model.attempt);

  function moveMoney(next) {
    setView("overview");
    setOperation(next);
    requestAnimationFrame(() => document.getElementById("move-money")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }
  function checkPayment() {
    setView("overview");
    setOperation(model.attempt.payment.operation);
    setReviewRequest((current) => current + 1);
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="bank-header">
      <div className="header-brand"><Brand onHome={() => setView("overview")} /><span className="portal-label">PERSONAL WALLET</span></div>
      <div className="header-user"><span className="avatar">{initials || "P"}</span><div><strong>{user.name}</strong><span>Personal account</span></div><button className="logout-button" disabled={model.logoutBusy || model.paymentBusy} onClick={model.logout}><Icon name="logout" size={17} />{model.logoutBusy ? "Signing out…" : "Sign out"}</button></div>
    </header>
    <nav className="bank-nav" aria-label="Main navigation"><div className="bank-nav-inner">
      <button className={`nav-item ${view === "overview" ? "selected" : ""}`} aria-current={view === "overview" ? "page" : undefined} onClick={() => setView("overview")}><Icon name="grid" size={18} />Account overview</button>
      <button className="nav-item" disabled={paymentLocked} onClick={() => moveMoney("transfer")}><Icon name="send" size={18} />Transfer funds</button>
      <button className="nav-item" disabled={paymentLocked} onClick={() => moveMoney("deposit")}><Icon name="plus" size={19} />Add funds</button>
      <button className={`nav-item ${view === "activity" ? "selected" : ""}`} aria-current={view === "activity" ? "page" : undefined} onClick={() => setView("activity")}><Icon name="activity" size={18} />Transaction history</button>
    </div></nav>
    <div className="bank-session-strip"><span><Icon name="shield" size={15} /> Practice wallet · No real money is moved</span><SessionClock session={model.session} lastActivity={model.lastActivity} /></div>
    <main className="dashboard-main" id="main-content">
      <div className="dashboard-content">
        <div className="breadcrumb">Personal wallet <Icon name="chevron" size={12} /><span>{view === "overview" ? "Account overview" : "Transaction history"}</span></div>
        <div className="page-heading"><div><p className="welcome-line">Welcome, {user.name.split(" ")[0]}</p><h1>{view === "overview" ? "Account overview" : "Transaction history"}</h1><p className="page-subtitle">{view === "overview" ? "Manage your wallet and everyday payments." : "Review your deposits, payments and transfers."}</p></div><div className="heading-actions"><span className="today-label">{today}</span><button className="button button-secondary refresh-button" disabled={model.loading || model.paymentBusy} onClick={() => model.refresh()}><Icon name="refresh" size={16} className={model.loading ? "spinning" : ""} />{model.loading ? "Refreshing…" : "Refresh account"}</button></div></div>
        {model.notice ? <div className={`notice notice-${model.notice.kind}`} role={model.notice.kind === "error" ? "alert" : "status"}><Icon name={model.notice.kind === "success" ? "check" : "info"} size={19} /><span>{model.notice.message}</span><button className="icon-button" aria-label="Dismiss message" onClick={model.dismissNotice}><Icon name="close" size={17} /></button></div> : null}
        {model.attempt && view === "activity" ? <div className="notice notice-info"><Icon name="info" size={19} /><span>A payment needs confirmation.</span><button className="text-button" onClick={checkPayment}>Check payment <Icon name="arrow" size={15} /></button></div> : null}
        {view === "overview" ? <div className="overview-grid">
          <div className="wallet-column">
            <section className="account-summary" aria-labelledby="account-heading">
              <div className="account-summary-heading"><span className="account-heading-icon"><Icon name="wallet" size={21} /></span><div><h2 id="account-heading">Wallet account</h2><p>Personal · INR</p></div><span className="account-type">Practice account</span></div>
              <div className="balance-card"><div className="balance-card-top"><span id="balance-label">Available balance</span><button className="icon-button balance-visibility" aria-label={hidden ? "Show amounts" : "Hide amounts"} onClick={() => setHidden((current) => !current)}><Icon name={hidden ? "eyeOff" : "eye"} size={19} /></button></div><div className="balance-amount" aria-labelledby="balance-label" aria-live="polite">{hidden ? "••••••" : model.wallet ? formatINR(model.wallet.balance) : "—"}</div><span className="balance-currency">Indian rupee (INR)</span></div>
              <dl className="account-details"><div><dt>Account holder</dt><dd>{user.name}</dd></div><div><dt>Registered email</dt><dd>{user.email}</dd></div></dl>
              <div className="account-actions"><button disabled={paymentLocked || !model.wallet} onClick={() => moveMoney("transfer")}><Icon name="send" size={17} />Transfer funds<Icon name="chevron" size={14} /></button><button disabled={paymentLocked || !model.wallet} onClick={() => moveMoney("deposit")}><Icon name="plus" size={18} />Add funds<Icon name="chevron" size={14} /></button></div>
            </section>
            <Stats transactions={model.transactions} hidden={hidden} ready={Boolean(model.wallet)} />
            <p className="stats-context">Totals for the latest {model.transactions.length || "available"} transactions.{model.wallet?.updatedAt ? " Balance last updated: " + dateParts(model.wallet.updatedAt).date + "." : ""}</p>
            <div className="wallet-tip"><Icon name="shield" size={22} /><div><strong>Before you transfer</strong><p>Verify the recipient’s email and amount. You’ll review the details before confirming.</p></div></div>
          </div>
          <PaymentPanel model={model} operation={operation} setOperation={setOperation} reviewRequest={reviewRequest} onReviewActivity={() => setView("activity")} />
        </div> : <><Stats transactions={model.transactions} hidden={hidden} ready={Boolean(model.wallet)} /><p className="stats-context">Totals reflect the latest {model.transactions.length} transactions shown below.</p></>}
        <Activity transactions={model.transactions} loading={model.loading} hidden={hidden} full={view === "activity"} onViewAll={() => setView("activity")} onAddFunds={() => moveMoney("deposit")} />
        <footer className="dashboard-footer"><span>© {new Date().getFullYear()} PayFlow Online</span><span>Learning project · Simulated funds only</span></footer>
      </div>
    </main>
  </div>;
}
