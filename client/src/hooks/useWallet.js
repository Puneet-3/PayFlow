import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, createPaymentAttempt, sendPayment, sessionDeadline } from "../lib/api.js";

export function useWallet() {
  const [session, setSession] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [attempt, setAttempt] = useState(null);
  const [notice, setNotice] = useState(null);
  const [authMessage, setAuthMessage] = useState("");
  const [lastActivity, setLastActivity] = useState(0);
  const sessionRef = useRef(null);
  const abortRef = useRef(null);
  const busyRef = useRef(false);
  const authBusyRef = useRef(false);
  const attemptsRef = useRef(new Map());

  const isCurrent = useCallback((active) => Boolean(active && sessionRef.current?.token === active.token), []);
  const clearSession = useCallback((message) => {
    abortRef.current?.abort();
    sessionRef.current = null;
    setSession(null);
    setWallet(null);
    setTransactions([]);
    setAttempt(null);
    setLoading(false);
    setNotice(null);
    setAuthMessage(message);
  }, []);

  const recordActivity = useCallback((active) => {
    if (isCurrent(active)) setLastActivity(Date.now());
  }, [isCurrent]);

  const handleError = useCallback((error, active) => {
    if (!isCurrent(active)) return;
    if ([401, 403].includes(error.status)) {
      clearSession("Your session has ended. Please sign in again.");
    } else if (!error.aborted) {
      setNotice({ kind: "error", message: error.message });
    }
  }, [clearSession, isCurrent]);

  const refresh = useCallback(async (active = sessionRef.current, paymentCompleted = false) => {
    if (!active || !isCurrent(active)) return;
    setLoading(true);
    const options = { token: active.token, signal: abortRef.current?.signal };
    try {
      const [balance, history] = await Promise.all([
        apiRequest("/wallet/balance", options),
        apiRequest("/wallet/transactions", options),
      ]);
      if (!balance.walletId || typeof balance.balance !== "string" || !Array.isArray(history.transactions)) {
        throw new Error("We couldn’t read your wallet. Please refresh and try again.");
      }
      if (!isCurrent(active)) return;
      recordActivity(active);
      setWallet(balance);
      setTransactions(history.transactions);
    } catch (error) {
      if (paymentCompleted && isCurrent(active)) {
        if ([401, 403].includes(error.status)) clearSession("Your payment completed. Sign in again to view your updated wallet.");
        else if (!error.aborted) setNotice({ kind: "error", message: "Your payment completed, but activity couldn’t refresh. Use Refresh to update it." });
      } else handleError(error, active);
    } finally {
      if (isCurrent(active)) setLoading(false);
    }
  }, [clearSession, handleError, isCurrent, recordActivity]);

  const authenticate = useCallback(async (mode, form) => {
    if (authBusyRef.current) return;
    authBusyRef.current = true;
    setAuthBusy(true);
    setAuthMessage("");
    try {
      if (mode === "register") {
        await apiRequest("/auth/register", { method: "POST", body: form });
      }
      const result = await apiRequest("/auth/login", {
        method: "POST", body: { email: form.email, password: form.password },
      });
      if (!result.token || !result.user?.id || !Number.isFinite(Date.parse(result.session?.expiresAt)) ||
          !Number.isFinite(result.session?.idleTimeoutSeconds)) {
        throw new Error("We couldn’t start your session. Please sign in again.");
      }
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      sessionRef.current = result;
      setSession(result);
      setLastActivity(Date.now());
      setAttempt(attemptsRef.current.get(result.user.id) || null);
      setWallet(null);
      setTransactions([]);
      setNotice(null);
      await refresh(result);
      return true;
    } catch (error) {
      setAuthMessage(error.message);
      return false;
    } finally {
      authBusyRef.current = false;
      setAuthBusy(false);
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    const active = sessionRef.current;
    if (!active || busyRef.current || logoutBusy) return;
    setLogoutBusy(true);
    try {
      await apiRequest("/auth/logout", { method: "POST", token: active.token });
      if (isCurrent(active)) clearSession("You’re signed out. See you soon.");
    } catch (error) {
      handleError(error, active);
    } finally {
      setLogoutBusy(false);
    }
  }, [clearSession, handleError, isCurrent, logoutBusy]);

  const updateAttempt = useCallback((userId, next) => {
    if (next) attemptsRef.current.set(userId, next);
    else attemptsRef.current.delete(userId);
    if (sessionRef.current?.user.id === userId) setAttempt(next);
  }, []);

  const pay = useCallback(async (operation, body) => {
    const active = sessionRef.current;
    if (!active || busyRef.current) return { ok: false };
    busyRef.current = true;
    setPaymentBusy(true);
    setNotice(null);
    const previous = attemptsRef.current.get(active.user.id);
    const payment = previous?.payment || createPaymentAttempt(active.user.id, operation, body);
    updateAttempt(active.user.id, { payment, state: "processing" });
    try {
      const result = await sendPayment(payment, active.token, { signal: abortRef.current?.signal });
      updateAttempt(active.user.id, null);
      if (!isCurrent(active)) {
        if (!sessionRef.current) setAuthMessage("Your last payment completed. Sign in again to view your activity.");
        return { ok: true };
      }
      recordActivity(active);
      setNotice({ kind: "success", message: payment.operation === "deposit" ? "Money added to your wallet." : "Your transfer is complete." });
      // The payment has succeeded even if the separate balance refresh fails.
      if (payment.operation === "deposit") setWallet((current) => current ? { ...current, balance: result.wallet.balance } : current);
      else setWallet((current) => current ? { ...current, balance: result.newBalance } : current);
      void refresh(active, true);
      return { ok: true, result };
    } catch (error) {
      if (error.uncertain || [0, 401, 403].includes(error.status)) {
        updateAttempt(active.user.id, { payment, state: "uncertain", error: error.message });
      } else if (error.status === 409) {
        updateAttempt(active.user.id, { payment, state: "conflict", error: error.message });
      } else {
        updateAttempt(active.user.id, null);
        recordActivity(active);
      }
      handleError(error, active);
      return { ok: false, error };
    } finally {
      busyRef.current = false;
      setPaymentBusy(false);
    }
  }, [handleError, isCurrent, recordActivity, refresh, updateAttempt]);

  const dismissConflict = useCallback(() => {
    const active = sessionRef.current;
    if (active && attemptsRef.current.get(active.user.id)?.state === "conflict") {
      updateAttempt(active.user.id, null);
    }
  }, [updateAttempt]);

  useEffect(() => {
    if (!session) return;
    const deadline = sessionDeadline(session, lastActivity);
    const check = () => {
      if (Date.now() >= deadline && isCurrent(session)) {
        clearSession("Your session expired. Please sign in again.");
      }
    };
    check();
    const timer = setInterval(check, 1000);
    const checkOnFocus = () => check();
    window.addEventListener("focus", checkOnFocus);
    document.addEventListener("visibilitychange", checkOnFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", checkOnFocus);
      document.removeEventListener("visibilitychange", checkOnFocus);
    };
  }, [clearSession, isCurrent, lastActivity, session]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { session, wallet, transactions, loading, authBusy, logoutBusy, paymentBusy,
    attempt, notice, authMessage, lastActivity, authenticate, logout, pay, refresh,
    dismissConflict, dismissNotice: () => setNotice(null) };
}
