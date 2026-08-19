import React, { useState, useEffect, useRef } from "react";

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap');

.ds-root {
  --ink: #14261F;
  --railing: #234A3B;
  --railing-lift: #2E5F4B;
  --render: #E5E7DF;
  --card: #FFFFFF;
  --signal: #F5C518;
  --brick: #A64B2A;
  --hush: #6E7B73;
  --rule: #CDD2C9;

  --display: 'Bricolage Grotesque', system-ui, sans-serif;
  --body: 'Instrument Sans', system-ui, sans-serif;
  --meter: 'DM Mono', ui-monospace, monospace;

  font-family: var(--body);
  color: var(--ink);
  background: var(--render);
  min-height: 100vh;
  display: flex;
  justify-content: center;
  -webkit-font-smoothing: antialiased;
}

.ds-root *, .ds-root *::before, .ds-root *::after { box-sizing: border-box; }

.ds-frame {
  width: 100%;
  max-width: 460px;
  background: var(--render);
  display: flex;
  flex-direction: column;
  position: relative;
  min-height: 100vh;
}

.ds-root button:focus-visible,
.ds-root input:focus-visible,
.ds-root a:focus-visible {
  outline: 2px solid var(--railing);
  outline-offset: 2px;
}

/* ---------- auth ---------- */

.auth-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 40px 24px 32px;
}

.wordmark {
  font-family: var(--display);
  font-weight: 800;
  font-size: 34px;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--railing);
  display: flex;
  align-items: center;
  gap: 10px;
}

.wordmark-dot {
  width: 13px; height: 13px;
  background: var(--signal);
  border-radius: 50%;
  flex: none;
  margin-top: 4px;
}

.auth-lede {
  font-family: var(--display);
  font-weight: 400;
  font-size: 25px;
  line-height: 1.25;
  letter-spacing: -0.02em;
  margin: 34px 0 8px;
  max-width: 19ch;
}

.auth-sub {
  font-size: 15px;
  line-height: 1.55;
  color: var(--hush);
  margin: 0 0 26px;
  max-width: 34ch;
}

.field { margin-bottom: 14px; }

.field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--hush);
  margin-bottom: 6px;
}

.field input {
  width: 100%;
  font-family: var(--body);
  font-size: 16px;
  color: var(--ink);
  padding: 13px 14px;
  background: var(--card);
  border: 1.5px solid var(--rule);
  border-radius: 10px;
  transition: border-color .15s;
}

.field input::placeholder { color: #A9B2AB; }
.field input:hover { border-color: #B6BDB4; }
.field input:focus { border-color: var(--railing); outline-offset: 1px; }
.field.bad input { border-color: var(--brick); }

.field-note {
  font-size: 13px;
  color: var(--brick);
  margin-top: 5px;
}

.postcode input {
  font-family: var(--meter);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.rule-card {
  background: var(--railing);
  color: #EFF2EC;
  border-radius: 12px;
  padding: 16px 17px;
  margin: 6px 0 22px;
  position: relative;
  overflow: hidden;
}

.rule-card::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 4px;
  background: var(--signal);
}

.rule-title {
  font-family: var(--display);
  font-weight: 600;
  font-size: 15px;
  margin: 0 0 5px;
  letter-spacing: -0.01em;
}

.rule-body { font-size: 13.5px; line-height: 1.55; margin: 0; color: #C3D0C7; }

.primary-btn {
  width: 100%;
  font-family: var(--body);
  font-weight: 600;
  font-size: 16px;
  color: #FFF;
  background: var(--railing);
  border: none;
  border-radius: 10px;
  padding: 15px;
  cursor: pointer;
  transition: background .15s, transform .08s;
}

.primary-btn:hover { background: var(--railing-lift); }
.primary-btn:active { transform: translateY(1px); }

.swap {
  margin-top: 20px;
  text-align: center;
  font-size: 14.5px;
  color: var(--hush);
}

.swap button {
  font-family: var(--body);
  font-size: 14.5px;
  font-weight: 600;
  color: var(--railing);
  background: none;
  border: none;
  padding: 2px 3px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* ---------- home ---------- */

.topbar {
  background: var(--railing);
  color: #FFF;
  padding: 14px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 20;
}

.topbar .wordmark { font-size: 20px; color: #FFF; gap: 7px; }
.topbar .wordmark-dot { width: 9px; height: 9px; margin-top: 2px; }

.place-btn {
  font-family: var(--meter);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--railing);
  background: var(--signal);
  border: none;
  border-radius: 20px;
  padding: 6px 12px;
  cursor: pointer;
}

.feed { flex: 1; padding: 22px 20px 110px; }

.feed-head {
  font-family: var(--display);
  font-weight: 600;
  font-size: 23px;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0 0 4px;
}

.feed-sub { font-size: 13.5px; color: var(--hush); margin: 0 0 18px; }

.chips { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 16px; margin: 0 -20px 4px; padding-left: 20px; padding-right: 20px; scrollbar-width: none; }
.chips::-webkit-scrollbar { display: none; }

.chip {
  font-family: var(--body);
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--railing);
  background: transparent;
  border: 1.5px solid var(--rule);
  border-radius: 18px;
  padding: 7px 14px;
  cursor: pointer;
  transition: background .14s, border-color .14s, color .14s;
}

.chip:hover { border-color: var(--railing); }
.chip[aria-pressed="true"] { background: var(--railing); border-color: var(--railing); color: #FFF; }

.card {
  background: var(--card);
  border-radius: 14px;
  border: 1.5px solid var(--rule);
  margin-bottom: 13px;
  overflow: hidden;
  transition: border-color .2s;
}

.card.urgent { border-color: var(--signal); }
.card.taken { opacity: 0.55; }

.card-body { display: flex; gap: 14px; padding: 14px; }

.thumb {
  width: 86px; height: 86px;
  flex: none;
  border-radius: 10px;
  background: var(--render);
  display: flex;
  align-items: center;
  justify-content: center;
}

.card-copy { flex: 1; min-width: 0; }

.card-title {
  font-family: var(--display);
  font-weight: 600;
  font-size: 17px;
  letter-spacing: -0.015em;
  margin: 1px 0 3px;
}

.card-meta { font-size: 13.5px; color: var(--hush); margin: 0 0 9px; line-height: 1.45; }

.meter-row { display: flex; align-items: center; gap: 9px; }

.meter-time {
  font-family: var(--meter);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--railing);
}

.card.urgent .meter-time { color: var(--brick); }

.meter-track {
  flex: 1;
  height: 5px;
  background: var(--render);
  border-radius: 3px;
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  background: var(--railing);
  border-radius: 3px;
  transition: width 1s linear;
}

.card.urgent .meter-fill { background: var(--signal); }

.card-action { display: flex; border-top: 1.5px solid var(--rule); }

.claim-btn {
  flex: 1;
  font-family: var(--body);
  font-size: 14.5px;
  font-weight: 600;
  color: var(--railing);
  background: transparent;
  border: none;
  padding: 13px;
  cursor: pointer;
  transition: background .14s;
}

.claim-btn:hover:not(:disabled) { background: #F1F4EF; }
.claim-btn:disabled { color: var(--hush); cursor: default; }

.claim-btn.mine { background: var(--signal); color: var(--ink); }

.empty {
  text-align: center;
  padding: 46px 20px;
  color: var(--hush);
  font-size: 14.5px;
  line-height: 1.6;
}

.give-bar {
  position: sticky;
  bottom: 0;
  padding: 14px 20px 22px;
  background: linear-gradient(to top, var(--render) 62%, rgba(229,231,223,0));
}

.give-btn {
  width: 100%;
  font-family: var(--body);
  font-weight: 600;
  font-size: 16px;
  color: #FFF;
  background: var(--railing);
  border: none;
  border-radius: 12px;
  padding: 15px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  transition: background .15s, transform .08s;
}

.give-btn:hover { background: var(--railing-lift); }
.give-btn:active { transform: translateY(1px); }

.toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  background: var(--ink);
  color: #EFF2EC;
  font-size: 14px;
  line-height: 1.45;
  padding: 12px 17px;
  border-radius: 10px;
  max-width: 330px;
  width: calc(100% - 48px);
  z-index: 40;
  animation: rise .22s ease-out;
}

@keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

@media (prefers-reduced-motion: reduce) {
  .ds-root *, .ds-root *::before { animation: none !important; transition: none !important; }
}
`;

/* --- small flat glyphs, drawn rather than photographed --- */
const Glyph = ({ kind }) => {
  const g = "#234A3B";
  const y = "#F5C518";
  const shapes = {
    bookcase: (
      <>
        <rect x="12" y="8" width="28" height="36" rx="2" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M12 20h28M12 32h28" stroke={g} strokeWidth="2.5" />
        <rect x="16" y="11" width="4" height="7" fill={y} />
        <rect x="22" y="12" width="3" height="6" fill={g} />
        <rect x="16" y="24" width="3" height="6" fill={g} />
      </>
    ),
    toys: (
      <>
        <rect x="10" y="18" width="32" height="26" rx="3" fill="none" stroke={g} strokeWidth="2.5" />
        <circle cx="19" cy="27" r="3.5" fill={y} />
        <circle cx="33" cy="27" r="3.5" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M16 36h20" stroke={g} strokeWidth="2.5" />
        <path d="M18 18v-4h16v4" fill="none" stroke={g} strokeWidth="2.5" />
      </>
    ),
    chairs: (
      <>
        <path d="M17 42V22h18v20" fill="none" stroke={g} strokeWidth="2.5" />
        <rect x="14" y="22" width="24" height="7" rx="2" fill={y} />
        <path d="M20 10h12v12H20z" fill="none" stroke={g} strokeWidth="2.5" />
      </>
    ),
    garden: (
      <>
        <path d="M15 22h22l-3 20H18z" fill="none" stroke={g} strokeWidth="2.5" />
        <rect x="13" y="17" width="26" height="5" rx="1.5" fill={y} />
        <path d="M26 17c0-6 4-8 4-8" fill="none" stroke={g} strokeWidth="2.5" />
      </>
    ),
    bike: (
      <>
        <circle cx="17" cy="33" r="8" fill="none" stroke={g} strokeWidth="2.5" />
        <circle cx="36" cy="33" r="8" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M17 33l7-13h8l4 13" fill="none" stroke={g} strokeWidth="2.5" />
        <rect x="21" y="17" width="9" height="3" rx="1.5" fill={y} />
      </>
    ),
    baby: (
      <>
        <path d="M12 26h28v10a6 6 0 0 1-6 6H18a6 6 0 0 1-6-6z" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M14 26c0-7 5-11 12-11s12 4 12 11" fill="none" stroke={g} strokeWidth="2.5" />
        <rect x="19" y="30" width="14" height="4" rx="2" fill={y} />
      </>
    ),
  };
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
      {shapes[kind] || shapes.bookcase}
    </svg>
  );
};

const WINDOW_MS = 2 * 60 * 60 * 1000;

const SEED = [
  { id: 1, title: "Pine bookcase", note: "Five shelves, slight mark on top", cat: "Furniture", kind: "bookcase", dist: "0.3 mi", road: "Alma Road", left: 12 },
  { id: 2, title: "Toy kitchen", note: "All pieces there, outgrown", cat: "Kids", kind: "toys", dist: "0.5 mi", road: "Windermere Ave", left: 41 },
  { id: 3, title: "Two dining chairs", note: "Oak, seats need a wipe", cat: "Furniture", kind: "chairs", dist: "0.2 mi", road: "Kingsholm Rd", left: 68 },
  { id: 4, title: "Terracotta plant pots", note: "Bag of nine, various sizes", cat: "Garden", kind: "garden", dist: "0.7 mi", road: "Denmark Rd", left: 94 },
  { id: 5, title: "Child's bike", note: "16 inch, tyres need air", cat: "Kids", kind: "bike", dist: "0.4 mi", road: "Sebert Street", left: 111 },
  { id: 6, title: "Moses basket", note: "Barely used, stand included", cat: "Kids", kind: "baby", dist: "0.6 mi", road: "Heathville Rd", left: 6, taken: true },
];

const CATEGORIES = ["Going soonest", "Furniture", "Kids", "Garden", "Electricals"];

function useClock() {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

function formatLeft(ms) {
  if (ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function Doorstep() {
  const [screen, setScreen] = useState("auth");
  const [mode, setMode] = useState("signup");
  const [form, setForm] = useState({ name: "", email: "", postcode: "", password: "" });
  const [errors, setErrors] = useState({});
  const [filter, setFilter] = useState("Going soonest");
  const [claimed, setClaimed] = useState([]);
  const [toast, setToast] = useState(null);

  const start = useRef(Date.now());
  const items = useRef(
    SEED.map((it) => ({ ...it, expires: start.current + it.left * 60 * 1000 }))
  ).current;

  useClock();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev));
  };

  const submit = () => {
    const next = {};
    const signup = mode === "signup";

    if (signup && !form.name.trim()) next.name = "Tell us what to call you";
    if (!form.email.trim()) next.email = "Enter your email";
    else if (!/^\S+@\S+\.\S+$/.test(form.email)) next.email = "That email doesn't look right";
    if (signup && !form.postcode.trim()) next.postcode = "We need this to show what's near you";
    else if (signup && !/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(form.postcode.trim()))
      next.postcode = "Enter a full UK postcode, like GL1 2EQ";
    if (!form.password) next.password = "Enter your password";
    else if (signup && form.password.length < 8) next.password = "Use at least 8 characters";

    setErrors(next);
    if (Object.keys(next).length === 0) setScreen("home");
  };

  const onKey = (e) => { if (e.key === "Enter") submit(); };

  const claim = (item) => {
    setClaimed((c) => [...c, item.id]);
    setToast(`Claimed. Collect from ${item.road} within 30 minutes — the address is in your messages.`);
  };

  const now = Date.now();
  const visible = items
    .filter((it) => (filter === "Going soonest" ? true : it.cat === filter))
    .filter((it) => it.expires > now)
    .sort((a, b) => a.expires - b.expires);

  const liveCount = items.filter((it) => it.expires > now && !it.taken).length;

  /* ---------------- auth ---------------- */

  if (screen === "auth") {
    const signup = mode === "signup";
    return (
      <div className="ds-root">
        <style>{STYLES}</style>
        <div className="ds-frame">
          <div className="auth-wrap">
            <div className="wordmark">
              Doorstep <span className="wordmark-dot" />
            </div>

            <h1 className="auth-lede">
              {signup ? "Give it away before you bin it." : "Welcome back."}
            </h1>
            <p className="auth-sub">
              {signup
                ? "See what your neighbours are passing on right now, and pass on the things you're done with."
                : "Sign in to see what's going near you."}
            </p>

            {signup && (
              <div className={`field ${errors.name ? "bad" : ""}`}>
                <label htmlFor="ds-name">Name</label>
                <input id="ds-name" value={form.name} onChange={set("name")} onKeyDown={onKey} placeholder="Ayesha Khan" autoComplete="name" />
                {errors.name && <p className="field-note">{errors.name}</p>}
              </div>
            )}

            <div className={`field ${errors.email ? "bad" : ""}`}>
              <label htmlFor="ds-email">Email</label>
              <input id="ds-email" type="email" value={form.email} onChange={set("email")} onKeyDown={onKey} placeholder="you@example.com" autoComplete="email" />
              {errors.email && <p className="field-note">{errors.email}</p>}
            </div>

            {signup && (
              <div className={`field postcode ${errors.postcode ? "bad" : ""}`}>
                <label htmlFor="ds-postcode">Postcode</label>
                <input id="ds-postcode" value={form.postcode} onChange={set("postcode")} onKeyDown={onKey} placeholder="GL1 2EQ" autoComplete="postal-code" />
                {errors.postcode && <p className="field-note">{errors.postcode}</p>}
              </div>
            )}

            <div className={`field ${errors.password ? "bad" : ""}`}>
              <label htmlFor="ds-password">Password</label>
              <input id="ds-password" type="password" value={form.password} onChange={set("password")} onKeyDown={onKey} placeholder={signup ? "At least 8 characters" : "Your password"} autoComplete={signup ? "new-password" : "current-password"} />
              {errors.password && <p className="field-note">{errors.password}</p>}
            </div>

            {signup && (
              <div className="rule-card">
                <p className="rule-title">One rule, and it matters</p>
                <p className="rule-body">
                  Leave items on your own driveway, path or garden — never on the pavement.
                  Councils treat pavement items as fly-tipping and fine householders for it,
                  even when you meant someone to take it.
                </p>
              </div>
            )}

            <button className="primary-btn" onClick={submit}>
              {signup ? "Create account" : "Sign in"}
            </button>

            <p className="swap">
              {signup ? "Already have an account? " : "New here? "}
              <button
                onClick={() => {
                  setMode(signup ? "signin" : "signup");
                  setErrors({});
                }}
              >
                {signup ? "Sign in" : "Create one"}
              </button>
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- home ---------------- */

  return (
    <div className="ds-root">
      <style>{STYLES}</style>
      <div className="ds-frame">
        <header className="topbar">
          <div className="wordmark">
            Doorstep <span className="wordmark-dot" />
          </div>
          <button className="place-btn" onClick={() => setScreen("auth")}>
            {form.postcode ? form.postcode.toUpperCase() : "GL1 2EQ"}
          </button>
        </header>

        <main className="feed">
          <h1 className="feed-head">
            {liveCount} thing{liveCount === 1 ? "" : "s"} going near you
          </h1>
          <p className="feed-sub">Sorted by time left. Claim it, then collect from the doorstep.</p>

          <div className="chips" role="group" aria-label="Filter items">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                className="chip"
                aria-pressed={filter === c}
                onClick={() => setFilter(c)}
              >
                {c}
              </button>
            ))}
          </div>

          {visible.length === 0 && (
            <p className="empty">
              Nothing in this category right now.
              <br />
              Have something to pass on instead?
            </p>
          )}

          {visible.map((item) => {
            const remaining = item.expires - now;
            const urgent = remaining < 15 * 60 * 1000;
            const pct = Math.max(0, Math.min(100, (remaining / WINDOW_MS) * 100));
            const mine = claimed.includes(item.id);
            const gone = item.taken && !mine;

            return (
              <article key={item.id} className={`card ${urgent && !gone ? "urgent" : ""} ${gone ? "taken" : ""}`}>
                <div className="card-body">
                  <div className="thumb">
                    <Glyph kind={item.kind} />
                  </div>
                  <div className="card-copy">
                    <h2 className="card-title">{item.title}</h2>
                    <p className="card-meta">
                      {item.note}
                      <br />
                      {item.dist} · {item.road}
                    </p>
                    <div className="meter-row">
                      <span className="meter-time" aria-label={`${formatLeft(remaining)} left`}>
                        {formatLeft(remaining)}
                      </span>
                      <div className="meter-track">
                        <div className="meter-fill" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="card-action">
                  <button
                    className={`claim-btn ${mine ? "mine" : ""}`}
                    disabled={gone || mine}
                    onClick={() => claim(item)}
                  >
                    {gone ? "Already claimed" : mine ? "Yours — collect within 30 min" : "Claim it"}
                  </button>
                </div>
              </article>
            );
          })}
        </main>

        <div className="give-bar">
          <button
            className="give-btn"
            onClick={() => setToast("Next screen: photograph it, we fill in the details, you confirm.")}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            Give something away
          </button>
        </div>

        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </div>
  );
}
