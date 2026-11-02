import { useEffect, useRef, useState } from "react";
import { formatINR, normalizeAmount } from "../lib/money.js";
import { Icon } from "./Icon.jsx";

function ReviewDialog({ review, busy, attempt, error, onClose, onConfirm, onReviewActivity }) {
  const ref = useRef(null);
  const conflict = attempt?.state === "conflict";
  const uncertain = attempt?.state === "uncertain";
  const deposit = review.operation === "deposit";
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return <dialog ref={ref} className="review-dialog" aria-labelledby="review-heading"
    onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="dialog-content"><div className="dialog-top"><span className="dialog-icon"><Icon name={deposit ? "plus" : "send"} size={25} /></span><button className="icon-button" type="button" aria-label="Close payment review" disabled={busy} onClick={onClose}><Icon name="close" /></button></div>
      <span className="eyebrow">{uncertain ? "CHECK YOUR PAYMENT" : "ONE LAST LOOK"}</span>
      <h2 id="review-heading">{deposit ? "Review your deposit" : "Review your transfer"}</h2>
      <p className="dialog-subtitle">{deposit ? "These are practice funds. No real money is moved." : "Make sure the amount and recipient look right."}</p>
      <div className="review-amount">{formatINR(review.body.amount)}</div>
      <dl className="review-details"><div><dt>{deposit ? "Destination" : "To"}</dt><dd>{deposit ? "Your PayFlow wallet" : review.body.recipientEmail}</dd></div><div><dt>Note</dt><dd>{review.body.description || (deposit ? "Wallet deposit" : "Personal transfer")}</dd></div><div><dt>Transfer fee</dt><dd>₹0.00</dd></div></dl>
      {uncertain ? <div className="payment-warning" role="status"><Icon name="info" size={18} /><p>We couldn’t confirm the result. Check again using this same payment; it will only be processed once. Keep this page open until the result is confirmed.</p></div> : null}
      {conflict ? <div className="payment-warning" role="alert"><Icon name="info" size={18} /><p>This request conflicts with an earlier payment. Review your activity before starting another.</p></div> : error && !busy ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose} autoFocus>{uncertain || conflict ? "Close" : "Back"}</button><button type="button" className="button button-primary" disabled={busy} onClick={conflict ? onReviewActivity : onConfirm}>{busy ? <><span className="spinner" /> Processing…</> : conflict ? "Review activity" : uncertain ? "Check payment" : deposit ? "Confirm deposit" : "Confirm transfer"}{!busy ? <Icon name={conflict ? "activity" : "arrow"} size={17} /> : null}</button></div>
    </div>
  </dialog>;
}

export default function PaymentPanel({ model, operation, setOperation, reviewRequest, onReviewActivity }) {
  const [form, setForm] = useState({ amount: "", recipientEmail: "", description: "" });
  const [error, setError] = useState("");
  const [review, setReview] = useState(() => model.attempt ? { operation: model.attempt.payment.operation, body: model.attempt.payment.body } : null);
  const formRef = useRef(null);
  const deposit = operation === "deposit";
  const locked = model.paymentBusy || Boolean(model.attempt);

  useEffect(() => {
    if (reviewRequest && model.attempt) {
      setReview({ operation: model.attempt.payment.operation, body: model.attempt.payment.body });
      setError("");
    }
  }, [reviewRequest, model.attempt]);

  function change(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
    setError("");
  }
  function submit(event) {
    event.preventDefault();
    setError("");
    try {
      const amount = normalizeAmount(form.amount, operation);
      const recipientEmail = form.recipientEmail.trim().toLowerCase();
      if (!deposit && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientEmail.length > 255)) {
        formRef.current.elements.namedItem("recipientEmail").focus();
        throw new Error("Enter the recipient’s email address.");
      }
      if (!deposit && recipientEmail === model.session.user.email.toLowerCase()) throw new Error("Choose someone else’s wallet to send money to.");
      const body = { amount, ...(!deposit ? { recipientEmail } : {}), ...(form.description.trim() ? { description: form.description.trim() } : {}) };
      setReview({ operation, body });
    } catch (validationError) {
      setError(validationError.message);
    }
  }
  async function confirm() {
    setError("");
    const result = await model.pay(review.operation, review.body);
    if (result.ok) {
      setReview(null);
      setForm({ amount: "", recipientEmail: "", description: "" });
    } else if (result.error && !result.error.uncertain && ![0, 401, 403, 409].includes(result.error.status)) {
      setReview(null);
      setError(result.error.message);
    }
  }

  return <section className="payment-card" id="move-money" aria-labelledby="payment-heading">
    <div className="section-heading"><div><h2 id="payment-heading">Payments & transfers</h2><p>Choose a service to get started.</p></div><span className="small-round-icon"><Icon name="send" size={19} /></span></div>
    <div className="payment-switch" aria-label="Payment type"><button type="button" aria-pressed={!deposit} className={!deposit ? "active" : ""} disabled={locked} onClick={() => { setOperation("transfer"); setError(""); }}><Icon name="send" size={16} /> Send money</button><button type="button" aria-pressed={deposit} className={deposit ? "active" : ""} disabled={locked} onClick={() => { setOperation("deposit"); setError(""); }}><Icon name="plus" size={17} /> Add funds</button></div>
    {model.attempt && !model.paymentBusy ? <div className="pending-payment"><Icon name="info" size={20} /><div><strong>A payment needs a check</strong><p>Confirm its result before starting another.</p><button className="text-button" onClick={() => setReview({ operation: model.attempt.payment.operation, body: model.attempt.payment.body })}>Review payment <Icon name="arrow" size={15} /></button></div></div> : null}
    <form ref={formRef} onSubmit={submit} noValidate>
      {!deposit ? <div className="field"><label htmlFor="recipient-email">Recipient’s email</label><input id="recipient-email" name="recipientEmail" type="email" autoComplete="off" value={form.recipientEmail} onChange={change} placeholder="friend@example.com" maxLength={255} disabled={locked} /></div> : null}
      <div className="field"><label htmlFor="payment-amount">Amount <span>INR</span></label><div className="amount-input"><span aria-hidden="true">₹</span><input id="payment-amount" name="amount" type="text" inputMode="decimal" autoComplete="off" value={form.amount} onChange={change} placeholder="0.00" maxLength={32} disabled={locked} aria-describedby={error ? "payment-error" : undefined} /></div></div>
      {deposit ? <div className="amount-chips" aria-label="Quick deposit amounts">{["100", "500", "1000"].map((amount) => <button type="button" key={amount} disabled={locked} onClick={() => { setForm((current) => ({ ...current, amount })); setError(""); }}>{formatINR(amount).replace(".00", "")}</button>)}</div> : null}
      <div className="field"><label htmlFor="payment-note">What’s it for? <span>Optional</span></label><input id="payment-note" name="description" value={form.description} onChange={change} placeholder={deposit ? "A little extra for later" : "Dinner, coffee, a little thank you…"} maxLength={160} disabled={locked} /></div>
      {error ? <p className="field-error" id="payment-error" role="alert">{error}</p> : null}
      <button className="button button-primary payment-submit" type="submit" disabled={locked || !model.wallet || model.loading}>{deposit ? "Review deposit" : "Review transfer"}<Icon name="arrow" size={18} /></button>
    </form>
    <p className="payment-footnote"><Icon name={deposit ? "info" : "shield"} size={14} />{deposit ? "Practice funds only · Up to ₹1,00,000 per deposit" : "Review every detail before you send."}</p>
    {review ? <ReviewDialog review={review} busy={model.paymentBusy} attempt={model.attempt} error={error} onClose={() => setReview(null)} onConfirm={confirm} onReviewActivity={() => { model.dismissConflict(); setReview(null); onReviewActivity(); }} /> : null}
  </section>;
}
