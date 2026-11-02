import { useState } from "react";
import { Brand, Icon } from "./Icon.jsx";

export default function AuthScreen({ authenticate, busy, message }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [showPassword, setShowPassword] = useState(false);
  const registering = mode === "register";

  function update(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: "" }));
  }

  async function submit(event) {
    event.preventDefault();
    const next = {};
    if (registering && (!form.name.trim() || form.name.trim().length > 100)) next.name = "Enter a name between 1 and 100 characters.";
    if (form.email.trim().length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) next.email = "Enter a valid email address.";
    if (!form.password || (registering && form.password.length < 8)) next.password = registering ? "Use at least 8 characters." : "Enter your password.";
    setErrors(next);
    if (Object.keys(next).length) {
      event.currentTarget.elements.namedItem(Object.keys(next)[0])?.focus();
      return;
    }
    await authenticate(mode, { ...form, name: form.name.trim(), email: form.email.trim().toLowerCase() });
  }

  function switchMode(next) {
    setMode(next);
    setErrors({});
    setForm((current) => ({ ...current, password: "" }));
  }

  return <main className="auth-layout">
    <header className="bank-header auth-header"><Brand /><span className="portal-label">PERSONAL WALLET</span><span className="header-assurance"><Icon name="shield" size={17} /> Practice banking portal</span></header>
    <div className="auth-titlebar"><span>Welcome to PayFlow Online</span><span>Simple access. Clear records.</span></div>
    <div className="auth-content">
    <section className="auth-story" aria-label="About PayFlow">
      <span className="eyebrow">YOUR MONEY. YOUR CONTROL.</span>
      <h1>Your everyday wallet.<br /><span>Now, all in one place.</span></h1>
      <p>Check your balance, send payments and keep track of every transaction with PayFlow Online.</p>
      <div className="bank-feature-list">
        <div><span><Icon name="wallet" size={23} /></span><div><h3>Account at a glance</h3><p>Your available balance and recent transactions.</p></div></div>
        <div><span><Icon name="send" size={23} /></span><div><h3>Easy wallet transfers</h3><p>Send practice funds using a recipient’s email.</p></div></div>
        <div><span><Icon name="activity" size={23} /></span><div><h3>A record of every payment</h3><p>Search and review your wallet activity anytime.</p></div></div>
      </div>
      <div className="auth-safety"><Icon name="shield" size={23} /><div><strong>Stay alert. Stay in control.</strong><p>Never share your password. Always review the recipient and amount before confirming a transfer.</p></div></div>
    </section>
    <section className="auth-form-side">
      <div className="auth-form-wrap">
        <div className="auth-switch" aria-label="Account access">
          <button type="button" aria-pressed={!registering} className={!registering ? "active" : ""} disabled={busy} onClick={() => switchMode("login")}>Sign in</button>
          <button type="button" aria-pressed={registering} className={registering ? "active" : ""} disabled={busy} onClick={() => switchMode("register")}>Create account</button>
        </div>
        <span className="eyebrow">PAYFLOW ONLINE</span>
        <h2>{registering ? "Open your wallet" : "Login to your wallet"}</h2>
        <p className="auth-subtitle">{registering ? "Register to start using your practice wallet." : "Enter your registered email and password."}</p>
        {message ? <div className="auth-message" role="status"><Icon name="info" size={18} /><span>{message}</span></div> : null}
        <form onSubmit={submit} noValidate>
          {registering ? <div className="field"><label htmlFor="auth-name">Full name</label><input id="auth-name" name="name" autoComplete="name" value={form.name} onChange={update} placeholder="Your name" maxLength={100} disabled={busy} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "name-error" : undefined} />{errors.name ? <p className="field-error" id="name-error">{errors.name}</p> : null}</div> : null}
          <div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" name="email" autoComplete="username" value={form.email} onChange={update} placeholder="you@example.com" maxLength={255} disabled={busy} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "email-error" : undefined} />{errors.email ? <p className="field-error" id="email-error">{errors.email}</p> : null}</div>
          <div className="field"><label htmlFor="auth-password">Password</label><div className="password-input"><input id="auth-password" type={showPassword ? "text" : "password"} name="password" autoComplete={registering ? "new-password" : "current-password"} value={form.password} onChange={update} placeholder={registering ? "At least 8 characters" : "Your password"} disabled={busy} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "password-error" : undefined} /><button className="icon-button" type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? "Hide password" : "Show password"}><Icon name={showPassword ? "eyeOff" : "eye"} size={19} /></button></div>{errors.password ? <p className="field-error" id="password-error">{errors.password}</p> : null}</div>
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? <><span className="spinner" /> {registering ? "Creating your wallet…" : "Signing in…"}</> : <>{registering ? "Create your wallet" : "Sign in"}<Icon name="arrow" size={19} /></>}</button>
        </form>
        <p className="auth-alternative">{registering ? "Already registered?" : "New to PayFlow?"} <button type="button" className="text-button" disabled={busy} onClick={() => switchMode(registering ? "login" : "register")}>{registering ? "Sign in" : "Create an account"}</button></p>
        <div className="auth-assurance"><Icon name="shield" size={18} /><span>A private session, with automatic sign-out.</span></div>
      </div>
    </section>
    </div>
    <footer className="auth-footer"><span>© {new Date().getFullYear()} PayFlow. Personal wallet portal.</span><span>Learning project · Simulated funds only</span></footer>
  </main>;
}
