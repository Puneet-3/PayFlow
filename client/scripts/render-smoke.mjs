import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { default: AuthScreen } = await vite.ssrLoadModule("/src/components/AuthScreen.jsx");
  const { default: Dashboard } = await vite.ssrLoadModule("/src/components/Dashboard.jsx");
  const auth = renderToStaticMarkup(React.createElement(AuthScreen, { authenticate() {}, busy: false, message: "" }));
  for (const text of ["Email address", "Password", "Create account", "Sign in"]) assert.ok(auth.includes(text));
  const model = {
    session: { token: "must-not-appear-in-markup", user: { id: "test", name: "Alice QA", email: "alice@example.com" },
      session: { expiresAt: new Date(Date.now() + 600000).toISOString(), idleTimeoutSeconds: 300 } },
    wallet: { walletId: "wallet", balance: "1234567.89", currency: "INR", updatedAt: new Date().toISOString() },
    transactions: [{ id: "one", type: "DEPOSIT", amount: "100.00", direction: "CREDIT", status: "SUCCESS", description: "Practice funds", createdAt: new Date().toISOString() }],
    loading: false, paymentBusy: false, logoutBusy: false, attempt: null, notice: null, lastActivity: Date.now(),
    refresh() {}, logout() {}, pay() {}, dismissConflict() {}, dismissNotice() {},
  };
  const dashboard = renderToStaticMarkup(React.createElement(Dashboard, { model }));
  for (const text of ["₹12,34,567.89", "Money added", "Practice funds", "Review transfer", "Sign out"]) assert.ok(dashboard.includes(text), `Missing ${text}`);
  assert.ok(!dashboard.includes("must-not-appear-in-markup"));
  const empty = renderToStaticMarkup(React.createElement(Dashboard, { model: { ...model, transactions: [] } }));
  assert.ok(empty.includes("Your story starts here"));
  console.log("PASS: authentication, populated dashboard, and empty wallet render correctly; token is not rendered into markup.");
} finally { await vite.close(); }
