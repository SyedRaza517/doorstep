import React, { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

/* --- API client. Same-origin /api in the browser (Vite proxies it);
       native apps set VITE_API_URL to the machine running the server. --- */
const API = import.meta.env.VITE_API_URL || "/api";

async function api(path, { method = "GET", body, token } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error("Can't reach the server — is it running?"), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong"), { status: res.status, field: data.field });
  return data;
}

/* map popups are built with innerHTML, so user text must be escaped */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* --- small flat glyphs, drawn rather than photographed --- */
const Glyph = ({ kind, size = 52 }) => {
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
    <svg width={size} height={size} viewBox="0 0 52 52" aria-hidden="true">
      {shapes[kind] || shapes.bookcase}
    </svg>
  );
};

/* fake status bar — only visible inside the desktop phone shell */
const StatusBar = ({ time }) => (
  <div className="statusbar" aria-hidden="true">
    <span className="statusbar-time">{time}</span>
    <span className="statusbar-icons">
      <svg width="17" height="11" viewBox="0 0 17 11">
        <rect x="0" y="7" width="3" height="4" rx="1" fill="currentColor" />
        <rect x="4.5" y="5" width="3" height="6" rx="1" fill="currentColor" />
        <rect x="9" y="2.5" width="3" height="8.5" rx="1" fill="currentColor" />
        <rect x="13.5" y="0" width="3" height="11" rx="1" fill="currentColor" />
      </svg>
      <svg width="15" height="11" viewBox="0 0 15 11">
        <path d="M7.5 10.2 5.3 7.9a3.1 3.1 0 0 1 4.4 0Z" fill="currentColor" />
        <path d="M3.4 5.9a5.8 5.8 0 0 1 8.2 0L10.2 7.3a3.8 3.8 0 0 0-5.4 0Z" fill="currentColor" />
        <path d="M1.3 3.7a8.8 8.8 0 0 1 12.4 0L12.3 5.1a6.8 6.8 0 0 0-9.6 0Z" fill="currentColor" />
      </svg>
      <svg width="25" height="12" viewBox="0 0 25 12">
        <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" fill="none" stroke="currentColor" strokeOpacity="0.45" />
        <rect x="2" y="2" width="15" height="8" rx="2" fill="currentColor" />
        <path d="M23 3.8v4.4a2.3 2.3 0 0 0 0-4.4Z" fill="currentColor" fillOpacity="0.45" />
      </svg>
    </span>
  </div>
);

/* Item photos, one at a time with dots. Falls back to the drawn glyph when a
   giver lists without a photo. */
const Gallery = ({ item, shot, setShot }) => {
  const shots = item.photos && item.photos.length ? item.photos : [];
  const index = Math.min(shot, Math.max(0, shots.length - 1));
  return (
    <div className="detail-photo">
      {shots.length ? (
        <>
          <img src={shots[index]} alt={`${item.title}, photo ${index + 1} of ${shots.length}`} />
          {shots.length > 1 && (
            <>
              <button className="shot-nav prev" aria-label="Previous photo" onClick={() => setShot((index - 1 + shots.length) % shots.length)}>
                ‹
              </button>
              <button className="shot-nav next" aria-label="Next photo" onClick={() => setShot((index + 1) % shots.length)}>
                ›
              </button>
              <span className="shot-dots">
                {shots.map((_, i) => (
                  <i key={i} className={i === index ? "on" : ""} />
                ))}
              </span>
            </>
          )}
        </>
      ) : (
        <Glyph kind={item.kind} size={96} />
      )}
    </div>
  );
};

/* Shared chrome for the simple sub-screens. Defined at module scope: nesting it
   inside the component would make React remount the subtree on every render,
   which drops focus mid-keystroke in the saved-search field. */
const SubScreen = ({ title, time, toast, sheets, onBack, children }) => (
  <div className="ds-root">
    <div className="ds-phone on-home">
      <StatusBar time={time} />
      <div className="ds-frame">
        <header className="topbar">
          <button className="back-btn" onClick={onBack}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Back
          </button>
          <span className="topbar-title">{title}</span>
          <span className="topbar-spacer" aria-hidden="true" />
        </header>
        <main className="feed sub">{children}</main>
      </div>
      {sheets}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  </div>
);

const CATEGORIES = ["Going soonest", "Furniture", "Kids", "Garden", "Electricals"];
const GIVE_CATEGORIES = ["Furniture", "Kids", "Garden", "Electricals"];
const KIND_BY_CAT = { Furniture: "chairs", Kids: "toys", Garden: "garden", Electricals: "bookcase" };

const SPOT_OPTIONS = [
  { v: "doorstep", label: "Doorstep / front steps" },
  { v: "front garden", label: "Front garden" },
  { v: "porch", label: "Porch" },
  { v: "building lobby", label: "Building lobby" },
  { v: "buzz and collect", label: "I'll bring it down — buzz" },
];

const RADII = [
  { v: 0.5, label: "½ mi" },
  { v: 1, label: "1 mi" },
  { v: 2, label: "2 mi" },
  { v: Infinity, label: "All" },
];

const EMPTY_GIVE = { title: "", note: "", cat: "Furniture", road: "", address: "", hours: 2, photos: [], spot: "doorstep", confirm: false };
const MAX_PHOTOS = 5;

const REPORT_REASONS = [
  { key: "pavement", label: "It's on the pavement" },
  { key: "unsafe", label: "Looks unsafe or recalled" },
  { key: "not-free", label: "They're asking for money" },
  { key: "sold-on", label: "Being collected to resell" },
  { key: "offensive", label: "Offensive or illegal" },
  { key: "gone", label: "It wasn't there" },
  { key: "other", label: "Something else" },
];

const UPHOLSTERY_RE = /sofa|armchair|settee|couch|mattress|futon|upholster/i;

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

function whereLine(item) {
  return item.spot === "buzz and collect"
    ? `Buzz at ${item.address} and they'll bring it down.`
    : `It's waiting on the ${item.spot} at ${item.address}.`;
}

export default function Doorstep() {
  const [token, setToken] = useState(() => localStorage.getItem("ds_token"));
  const [user, setUser] = useState(null);
  const [screen, setScreen] = useState(token ? "loading" : "auth");
  const [mode, setMode] = useState("signup");
  const [form, setForm] = useState({ name: "", email: "", postcode: "", password: "" });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("Going soonest");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("time");
  const [radius, setRadius] = useState(2);
  const [items, setItems] = useState([]);
  const [toast, setToast] = useState(null);
  const [give, setGive] = useState(EMPTY_GIVE);
  const [giveErrors, setGiveErrors] = useState({});
  const [detailId, setDetailId] = useState(null);
  const [stats, setStats] = useState(null);
  const [notes, setNotes] = useState([]);
  const [unread, setUnread] = useState(0);
  const [wishes, setWishes] = useState([]);
  const [newWish, setNewWish] = useState({ keyword: "", cat: "Anything", radius: 1 });
  const [impact, setImpact] = useState(null);
  const [fallback, setFallback] = useState(null);
  const [recent, setRecent] = useState([]);
  const [reporting, setReporting] = useState(null);
  const [editing, setEditing] = useState(null);
  const [shot, setShot] = useState(0);
  const [blocked, setBlocked] = useState([]);
  const [thanking, setThanking] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [demand, setDemand] = useState(0);
  const [stuff, setStuff] = useState(null);
  const [tab, setTab] = useState("toCollect");
  const [autospec, setAutospec] = useState({ configured: false, busy: false, done: false });
  const fileRef = useRef(null);
  const mapRef = useRef(null);
  const mapObj = useRef(null);

  useClock();

  const signOut = useCallback((message) => {
    const t = localStorage.getItem("ds_token");
    if (t) api("/auth/signout", { method: "POST", token: t }).catch(() => {});
    localStorage.removeItem("ds_token");
    setToken(null);
    setUser(null);
    setItems([]);
    setScreen("auth");
    if (message) setToast(message);
  }, []);

  const fetchItems = useCallback(async (t) => {
    try {
      const data = await api("/items", { token: t });
      setItems(data.items);
    } catch (e) {
      if (e.status === 401) signOut("Your session expired — sign in again.");
      else setToast(e.message);
    }
  }, [signOut]);

  /* restore session on load */
  useEffect(() => {
    if (!token || user) return;
    api("/me", { token })
      .then((data) => {
        setUser(data.user);
        setStats(data.stats);
        setScreen("home");
      })
      .catch(() => signOut());
  }, [token, user, signOut]);

  /* fresh stats every time the profile opens */
  useEffect(() => {
    if (screen !== "profile" || !token) return;
    api("/me", { token })
      .then((data) => {
        setUser(data.user);
        setStats(data.stats);
      })
      .catch(() => {});
  }, [screen, token]);

  /* live alerts — instant and free, where Olio charges for fast ones.
     EventSource can't set headers, so the token goes in the query string. */
  useEffect(() => {
    if (!token || !user) return;
    const url = `${API}/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type !== "alert") return;
      setNotes((list) => [{ id: msg.id, itemId: msg.itemId, title: msg.title, body: msg.body, createdAt: msg.createdAt, read: false }, ...list]);
      setUnread((n) => n + 1);
      setToast(`${msg.title} — ${msg.body}`);
      fetchItems(token);
    };
    return () => es.close();
  }, [token, user, fetchItems]);

  /* unread count on sign-in */
  useEffect(() => {
    if (!token || !user) return;
    api("/notifications", { token })
      .then((d) => {
        setNotes(d.notifications);
        setUnread(d.unread);
      })
      .catch(() => {});
  }, [token, user]);

  /* per-screen data */
  useEffect(() => {
    if (!token) return;
    if (screen === "wishes") api("/wishes", { token }).then((d) => setWishes(d.wishes)).catch(() => {});
    if (screen === "mine") {
      api("/me/stuff", { token }).then(setStuff).catch(() => {});
      if (tab === "wishes") api("/wishes", { token }).then((d) => setWishes(d.wishes)).catch(() => {});
    }
    if (screen === "impact") api("/impact", { token }).then(setImpact).catch(() => {});
    if (screen === "home") api("/items/recent", { token }).then((d) => setRecent(d.items)).catch(() => {});
    if (screen === "profile") api("/blocks", { token }).then((d) => setBlocked(d.blocked)).catch(() => {});
    if (screen === "give") {
      api("/autospec/status", { token }).then((d) => setAutospec((a) => ({ ...a, configured: d.configured }))).catch(() => {});
      /* your usual address and spot, so listing again is two taps */
      if (user && user.address) {
        setGive((g) => ({
          ...g,
          address: g.address || user.address,
          road: g.road || user.road || "",
          spot: g.spot === "doorstep" && user.spot ? user.spot : g.spot,
        }));
      }
    }
    if (screen === "notifications" && unread > 0) {
      api("/notifications/read", { method: "POST", token }).catch(() => {});
      setUnread(0);
      setNotes((list) => list.map((n) => ({ ...n, read: true })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, token]);

  /* load the feed while signed in, refresh it in the background */
  const authed = ["home", "map", "detail", "give", "profile", "notifications", "wishes", "impact", "fallback", "mine"].includes(screen);
  useEffect(() => {
    if (!authed || !token) return;
    fetchItems(token);
    const t = setInterval(() => fetchItems(token), 45 * 1000);
    return () => clearInterval(t);
  }, [authed, token, fetchItems]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  /* ---- map lifecycle ---- */

  useEffect(() => {
    if (screen !== "map" || !mapRef.current) return;
    const centre = user && user.lat != null ? [user.lat, user.lng] : [51.5416, -0.0575];
    const m = L.map(mapRef.current, { zoomControl: false });
    m.setView(centre, 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(m);
    if (user && user.lat != null) {
      L.circleMarker(centre, { radius: 7, color: "#FFFFFF", weight: 2.5, fillColor: "#2B6CB0", fillOpacity: 1 })
        .addTo(m)
        .bindTooltip("You");
    }
    mapObj.current = m;
    return () => {
      m.remove();
      mapObj.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    const m = mapObj.current;
    if (screen !== "map" || !m) return;
    const layer = L.layerGroup().addTo(m);
    const nowMs = Date.now();
    const live = items.filter((it) => it.expiresAt > nowMs && it.lat != null && it.status !== "taken");
    for (const it of live) {
      const urgent = it.expiresAt - nowMs < 15 * 60 * 1000;
      const icon = L.divIcon({
        className: "",
        html: `<div class="pin-dot${urgent ? " urgent" : ""}${it.owner || it.status === "yours" ? " mine" : ""}"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const marker = L.marker([it.lat, it.lng], { icon }).addTo(layer);
      const el = document.createElement("div");
      el.className = "pin-pop";
      el.innerHTML = `<strong>${esc(it.title)}</strong><span>${esc(it.dist)} · ${formatLeft(it.expiresAt - nowMs)} left</span>`;
      const btn = document.createElement("button");
      btn.textContent = it.status === "yours" ? "Yours — details" : "View";
      btn.onclick = () => {
        setDetailId(it.id);
        setScreen("detail");
      };
      el.appendChild(btn);
      marker.bindPopup(el, { closeButton: false });
    }
    return () => {
      layer.remove();
    };
  }, [screen, items]);

  /* ---- auth handlers ---- */

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((prev) => (prev[key] || prev._form ? { ...prev, [key]: null, _form: null } : prev));
  };

  const submit = async () => {
    const next = {};
    const signup = mode === "signup";

    if (signup && !form.name.trim()) next.name = "Tell us what to call you";
    if (!form.email.trim()) next.email = "Enter your email";
    else if (!/^\S+@\S+\.\S+$/.test(form.email)) next.email = "That email doesn't look right";
    if (signup && !form.postcode.trim()) next.postcode = "We need this to show what's near you";
    else if (signup && !/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(form.postcode.trim()))
      next.postcode = "Enter a full UK postcode, like E8 3EP";
    if (!form.password) next.password = "Enter your password";
    else if (signup && form.password.length < 8) next.password = "Use at least 8 characters";

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      const data = await api(signup ? "/auth/signup" : "/auth/signin", {
        method: "POST",
        body: signup
          ? { name: form.name, email: form.email, postcode: form.postcode, password: form.password }
          : { email: form.email, password: form.password },
      });
      localStorage.setItem("ds_token", data.token);
      setToken(data.token);
      setUser(data.user);
      setScreen("home");
    } catch (e) {
      setErrors(e.field ? { [e.field]: e.message } : { _form: e.message });
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e) => { if (e.key === "Enter") submit(); };

  /* ---- claim / collect ---- */

  const claim = async (item) => {
    try {
      const updated = await api(`/items/${item.id}/claim`, { method: "POST", token });
      setItems((list) => list.map((it) => (it.id === updated.id ? updated : it)));
      setToast(`Claimed. ${whereLine(updated)} Collect within 30 minutes.`);
    } catch (e) {
      setToast(e.message);
      if (e.status === 409 || e.status === 410) fetchItems(token);
    }
  };

  const collected = async (item) => {
    try {
      await api(`/items/${item.id}/collected`, { method: "POST", token });
      setThanking(item);
      fetchItems(token);
    } catch (e) {
      setToast(e.message);
    }
  };

  /* ---- give handlers ---- */

  /* Downscale one picked file to a JPEG data URL. */
  const shrink = (file) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 900;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("unreadable"));
      };
      img.src = url;
    });

  const onPhoto = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;

    /* Wait for all of them, so the strip keeps the order they were picked in
       rather than whichever decoded first — the first photo is the cover. */
    const shots = (await Promise.all(files.map((f) => shrink(f).catch(() => null)))).filter(Boolean);
    if (!shots.length) {
      setGiveErrors((p) => ({ ...p, photo: "That photo didn't come through — try taking it again" }));
      return;
    }

    let cover = null;
    setGive((g) => {
      const photos = [...g.photos, ...shots].slice(0, MAX_PHOTOS);
      if (g.photos.length === 0) cover = photos[0];
      return { ...g, photos };
    });
    setGiveErrors((p) => (p.photo ? { ...p, photo: null } : p));
    if (cover && autospec.configured) runAutospec(cover);
  };

  const toggleSave = async (item) => {
    const next = !item.saved;
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, saved: next } : i)));
    try {
      await api(`/items/${item.id}/save`, { method: next ? "POST" : "DELETE", token });
    } catch {
      setItems((list) => list.map((i) => (i.id === item.id ? { ...i, saved: !next } : i)));
    }
  };

  const sendThanks = async (item, kind) => {
    setThanking(null);
    try {
      await api(`/items/${item.id}/thanks`, { method: "POST", token, body: { token: kind } });
      setToast("Sent. They'll see it in their alerts.");
    } catch (e) {
      setToast(e.message);
    }
  };

  const exportData = async () => {
    try {
      const data = await api("/me/export", { token });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "doorstep-my-data.json";
      a.click();
      URL.revokeObjectURL(url);
      setToast("Downloaded everything we hold about you.");
    } catch (e) {
      setToast(e.message);
    }
  };

  const deleteAccount = async () => {
    try {
      await api("/me", { method: "DELETE", token });
      localStorage.removeItem("ds_token");
      setToken(null);
      setUser(null);
      setItems([]);
      setConfirmDelete(false);
      setScreen("auth");
      setToast("Account erased. Anything already collected stays counted, without your name on it.");
    } catch (e) {
      setToast(e.message);
    }
  };

  const release = async (item) => {
    try {
      const updated = await api(`/items/${item.id}/release`, { method: "POST", token });
      setItems((list) => list.map((i) => (i.id === updated.id ? updated : i)));
      setScreen("home");
      setToast("Handed back, and straight into someone else's feed. No mark against you.");
    } catch (e) {
      setToast(e.message);
    }
  };

  const block = async (giver) => {
    try {
      await api(`/users/${giver.id}/block`, { method: "POST", token });
      setScreen("home");
      setToast(`Blocked. You won't see ${giver.name}'s listings or alerts. Undo it in your profile.`);
      fetchItems(token);
    } catch (e) {
      setToast(e.message);
    }
  };

  const unblock = async (id) => {
    setBlocked((list) => list.filter((b) => b.id !== id));
    api(`/users/${id}/block`, { method: "DELETE", token }).catch(() => {});
    fetchItems(token);
  };

  const report = async (reason) => {
    const item = reporting;
    setReporting(null);
    try {
      const res = await api(`/items/${item.id}/report`, { method: "POST", token, body: { reason } });
      setToast(
        res.alreadyReported
          ? "You've already reported this one — thanks, we have it."
          : res.hidden
            ? "Thanks. Enough people flagged it that it's now hidden pending review."
            : "Thanks — reported. We look at every one."
      );
      if (res.hidden) {
        fetchItems(token);
        setScreen("home");
      }
    } catch (e) {
      setToast(e.message);
    }
  };

  const saveEdit = async () => {
    setBusy(true);
    try {
      const updated = await api(`/items/${editing.id}`, {
        method: "PATCH",
        token,
        body: { title: editing.title, note: editing.note, spot: editing.spot, extendMinutes: editing.extendMinutes || 0 },
      });
      setItems((list) => list.map((i) => (i.id === updated.id ? updated : i)));
      setEditing(null);
      setToast(editing.extendMinutes ? "Updated, and the window's been extended." : "Listing updated.");
    } catch (e) {
      setToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (item) => {
    try {
      await api(`/items/${item.id}`, { method: "DELETE", token });
      setItems((list) => list.filter((i) => i.id !== item.id));
      setScreen("home");
      setToast("Taken down. Nothing's waiting outside.");
    } catch (e) {
      setToast(e.message);
    }
  };

  /* photo → draft listing. The giver confirms rather than types, and the
     estimated size picks the window (2h carry, 3h two-person, 4h van). */
  const runAutospec = async (photo) => {
    setAutospec((a) => ({ ...a, busy: true }));
    try {
      const spec = await api("/autospec", { method: "POST", token, body: { photo } });
      setGive((g) => ({
        ...g,
        title: spec.title,
        note: spec.note,
        cat: spec.cat,
        hours: Math.round((spec.windowMinutes || 120) / 60),
        hazards: spec.hazards || [],
      }));
      setAutospec((a) => ({ ...a, busy: false, done: true }));
      setToast(
        spec.confidence === "low"
          ? "Had a guess from the photo — check the details before listing."
          : "Filled in from your photo — change anything that's off."
      );
    } catch (e) {
      setAutospec((a) => ({ ...a, busy: false }));
      setToast(e.message);
    }
  };

  const addWish = async () => {
    try {
      const created = await api("/wishes", { method: "POST", token, body: newWish });
      setWishes((list) => [created, ...list]);
      setNewWish({ keyword: "", cat: "Anything", radius: 1 });
      if (created.alreadyOut > 0) {
        /* it was already out there — say so instead of promising the future */
        setToast(
          created.alreadyOut === 1
            ? "One's up already — it's in your alerts now."
            : `${created.alreadyOut} are up already — they're in your alerts now.`
        );
        api("/notifications", { token })
          .then((d) => {
            setNotes(d.notifications);
            setUnread(d.unread);
          })
          .catch(() => {});
      } else {
        setToast("On your wish list. We'll tell you the moment one appears.");
      }
    } catch (e) {
      setToast(e.message);
    }
  };

  const removeWish = async (id) => {
    setWishes((list) => list.filter((w) => w.id !== id));
    api(`/wishes/${id}`, { method: "DELETE", token }).catch(() => {});
  };

  const openFallback = async (item) => {
    try {
      const data = await api(`/items/${item.id}/fallback`, { token });
      setFallback(data);
      setScreen("fallback");
    } catch (e) {
      setToast(e.message);
    }
  };

  const setG = (key) => (e) => {
    setGive((g) => ({ ...g, [key]: e.target.value }));
    setGiveErrors((p) => (p[key] || p._form ? { ...p, [key]: null, _form: null } : p));
  };

  const submitGive = async () => {
    const next = {};
    if (!give.title.trim()) next.title = "Give it a name — 'Pine bookcase' beats 'stuff'";
    if (!give.road.trim()) next.road = "Which road is it on?";
    if (!give.address.trim()) next.address = "Only whoever claims it will see this";
    if (!give.confirm) next.confirm = "This one's non-negotiable — pavement items risk a £1,000 fine";
    setGiveErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      const created = await api("/items", {
        method: "POST",
        token,
        body: {
          title: give.title,
          note: give.note,
          cat: give.cat,
          kind: KIND_BY_CAT[give.cat] || "bookcase",
          road: give.road,
          address: give.address,
          windowMinutes: give.hours * 60,
          photos: give.photos,
          spot: give.spot,
        },
      });
      setItems((list) => [...list, created]);
      setGive(EMPTY_GIVE);
      setAutospec((a) => ({ ...a, done: false }));
      setScreen("home");
      setToast(
        created.wishers > 0
          ? created.wishers === 1
            ? `Listed — and one neighbour who wished for it has just been told.`
            : `Listed — and ${created.wishers} neighbours who wished for it have just been told.`
          : `On the doorstep for ${give.hours} hours. Neighbours nearby can see it now.`
      );
    } catch (e) {
      setGiveErrors(e.field ? { [e.field]: e.message } : { _form: e.message });
    } finally {
      setBusy(false);
    }
  };

  /* as a giver types, tell them if neighbours are already wishing for it */
  useEffect(() => {
    if (screen !== "give" || !token || !give.title.trim()) {
      setDemand(0);
      return;
    }
    const t = setTimeout(() => {
      api("/wishes/demand", { method: "POST", token, body: { title: give.title, note: give.note, cat: give.cat } })
        .then((d) => setDemand(d.wishers))
        .catch(() => setDemand(0));
    }, 500);
    return () => clearTimeout(t);
  }, [screen, token, give.title, give.note, give.cat]);

  /* ---- derived feed ---- */

  const now = Date.now();
  const timeNow = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const inRadius = (it) => it.miles == null || it.miles <= radius;
  const matchesSearch = (it) =>
    !q.trim() || `${it.title} ${it.note} ${it.road}`.toLowerCase().includes(q.trim().toLowerCase());

  const visible = items
    .filter((it) => it.expiresAt > now)
    .filter(inRadius)
    .filter(matchesSearch)
    .filter((it) => (savedOnly ? it.saved : true))
    .filter((it) => (filter === "Going soonest" ? true : it.cat === filter))
    .sort((a, b) => (sort === "near" && a.miles != null && b.miles != null ? a.miles - b.miles : a.expiresAt - b.expiresAt));

  const liveCount = items.filter((it) => it.expiresAt > now && it.status !== "taken" && inRadius(it)).length;

  /* Sheets belong to no single screen: they are opened from the feed, the
     detail screen and Your things, so they render alongside every one of
     them rather than living inside one screen's markup. */
  const sheets = (
    <>
      {reporting && (
        <div className="sheet-backdrop" onClick={() => setReporting(null)}>
          <div className="sheet" role="dialog" aria-label="Report this listing" onClick={(e) => e.stopPropagation()}>
            <h2>What's wrong with it?</h2>
            <p>Reports are anonymous. Three from different neighbours hides a listing while we look.</p>
            {REPORT_REASONS.map((r) => (
              <button key={r.key} onClick={() => report(r.key)}>
                {r.label}
              </button>
            ))}
            <button className="sheet-cancel" onClick={() => setReporting(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {thanking && (
        <div className="sheet-backdrop" onClick={() => setThanking(null)}>
          <div className="sheet" role="dialog" aria-label="Say thanks" onClick={(e) => e.stopPropagation()}>
            <h2>Got it — enjoy it.</h2>
            <p>
              That's one more thing that didn't become waste. Want to say thanks to{" "}
              {thanking.giver ? thanking.giver.name : "them"}?
            </p>
            {[
              { k: "wave", label: "Give a wave" },
              { k: "brew", label: "I owe you a brew" },
              { k: "plant", label: "Send a plant" },
              { k: "star", label: "You're a star" },
            ].map((t) => (
              <button key={t.k} onClick={() => sendThanks(thanking, t.k)}>
                {t.label}
              </button>
            ))}
            <button className="sheet-cancel" onClick={() => setThanking(null)}>
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );

  /* ---------------- restoring session ---------------- */

  if (screen === "loading") {
    return (
      <div className="ds-root">
        <div className="ds-phone on-auth">
          <StatusBar time={timeNow} />
          <div className="ds-frame">
            <div className="auth-wrap" style={{ justifyContent: "center", alignItems: "center" }}>
              <div className="wordmark">
                Doorstep <span className="wordmark-dot" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- auth ---------------- */

  if (screen === "auth") {
    const signup = mode === "signup";
    return (
      <div className="ds-root">
        <div className="ds-phone on-auth">
          <StatusBar time={timeNow} />
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
                  <input id="ds-postcode" value={form.postcode} onChange={set("postcode")} onKeyDown={onKey} placeholder="E8 3EP" autoComplete="postal-code" />
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
                    Leave items on your own doorstep, porch, garden or lobby — never on the pavement.
                    Councils treat pavement items as fly-tipping and fine householders up to £1,000,
                    even when you meant someone to take it.
                  </p>
                </div>
              )}

              <button className="primary-btn" onClick={submit} disabled={busy}>
                {busy ? "One moment…" : signup ? "Create account" : "Sign in"}
              </button>
              {errors._form && <p className="field-note form-note">{errors._form}</p>}

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
      </div>
    );
  }

  /* ---------------- item detail ---------------- */

  if (screen === "detail") {
    const item = items.find((it) => it.id === detailId);
    const gone = !item || item.expiresAt <= now;
    const mine = item && item.status === "yours";
    const taken = item && item.status === "taken";
    return (
      <div className="ds-root">
        <div className="ds-phone on-home">
          <StatusBar time={timeNow} />
          <div className="ds-frame">
            <header className="topbar">
              <button className="back-btn" onClick={() => setScreen("home")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back
              </button>
              <span className="topbar-title">{gone ? "Gone" : item.cat}</span>
              <span className="topbar-spacer" aria-hidden="true" />
            </header>

            {gone ? (
              <p className="empty">
                That one's gone — the window closed.
                <br />
                Plenty more nearby.
              </p>
            ) : item.owner && item.status !== "taken" ? (
              <main className="detail">
                <Gallery item={item} shot={shot} setShot={setShot} />
                <h1 className="detail-title">{item.title}</h1>
                {item.note && <p className="detail-note">{item.note}</p>}
                <div className="detail-meta">
                  <span>Your doorstep · {item.road}</span>
                  <span className="detail-spot">Waiting spot: {item.spot}</span>
                </div>
                <div className="meter-row detail-meter">
                  <span className="meter-time">{formatLeft(item.expiresAt - now)}</span>
                  <div className="meter-track">
                    <div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, ((item.expiresAt - now) / item.windowMs) * 100))}%` }} />
                  </div>
                </div>
                <div className="rule-card address-card">
                  <p className="rule-title">Your listing</p>
                  <p className="rule-body">{item.address}</p>
                </div>

                {editing && editing.id === item.id ? (
                  <div className="edit-panel">
                    <div className="field">
                      <label htmlFor="ed-title">What is it</label>
                      <input id="ed-title" value={editing.title} onChange={(e) => setEditing((s) => ({ ...s, title: e.target.value }))} />
                    </div>
                    <div className="field">
                      <label htmlFor="ed-note">Anything they should know</label>
                      <input id="ed-note" value={editing.note} onChange={(e) => setEditing((s) => ({ ...s, note: e.target.value }))} />
                    </div>
                    <div className="field">
                      <label>Where it waits</label>
                      <div className="chips" role="group" aria-label="Collection spot">
                        {SPOT_OPTIONS.map((s) => (
                          <button key={s.v} className="chip" aria-pressed={editing.spot === s.v} onClick={() => setEditing((p) => ({ ...p, spot: s.v }))}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="field">
                      <label>Give it longer</label>
                      <div className="chips" role="group" aria-label="Extend the window">
                        {[0, 60, 120, 240].map((m) => (
                          <button key={m} className="chip" aria-pressed={(editing.extendMinutes || 0) === m} onClick={() => setEditing((p) => ({ ...p, extendMinutes: m }))}>
                            {m === 0 ? "Leave it" : `+${m / 60}h`}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button className="primary-btn" onClick={saveEdit} disabled={busy}>
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                    <button className="retake" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="owner-actions">
                    <button className="ghost-btn" onClick={() => setEditing({ id: item.id, title: item.title, note: item.note, spot: item.spot, extendMinutes: 0 })}>
                      Edit or extend
                    </button>
                    <button className="ghost-btn" onClick={() => openFallback(item)}>
                      What if nobody takes it?
                    </button>
                    <button className="ghost-btn danger" onClick={() => withdraw(item)}>
                      Take it down
                    </button>
                  </div>
                )}
                <p className="detail-rule">It's live from your own property — never the pavement.</p>
              </main>
            ) : (
              <main className="detail">
                <Gallery item={item} shot={shot} setShot={setShot} />

                <h1 className="detail-title">{item.title}</h1>
                {item.note && <p className="detail-note">{item.note}</p>}

                <div className="detail-meta">
                  <span>{item.owner ? `Your doorstep · ${item.road}` : `${item.dist} · ${item.road}`}</span>
                  <span className="detail-spot">
                    {item.spot === "buzz and collect" ? "Giver will bring it down — buzz on arrival" : `Waiting spot: ${item.spot}`}
                  </span>
                  {item.giver && !item.owner && (
                    <span className="giver-badge">
                      {item.giver.verified && (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                      {item.giver.name}
                      {item.giver.verified ? ", address verified" : ""}
                      {item.giver.handed > 0 ? ` · ${item.giver.handed} handed over` : ""}
                    </span>
                  )}
                </div>

                <div className="meter-row detail-meter">
                  <span className="meter-time">{formatLeft(item.expiresAt - now)}</span>
                  <div className="meter-track">
                    <div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, ((item.expiresAt - now) / item.windowMs) * 100))}%` }} />
                  </div>
                </div>

                {(mine || item.owner) && (
                  <div className="rule-card address-card">
                    <p className="rule-title">{mine ? "Your collection address" : "Your listing"}</p>
                    <p className="rule-body">
                      {item.address}
                      {mine && item.claimExpiresAt && (
                        <>
                          <br />
                          Hold ends in {formatLeft(item.claimExpiresAt - now)}.
                        </>
                      )}
                    </p>
                  </div>
                )}

                {!mine && !item.owner && (
                  <button className="primary-btn" disabled={taken} onClick={() => claim(item)}>
                    {taken ? "Already claimed" : "Claim it"}
                  </button>
                )}
                {mine && (
                  <>
                    <button className="primary-btn collected-btn" onClick={() => collected(item)}>
                      Got it — mark as collected
                    </button>
                    <button className="ghost-btn" onClick={() => release(item)}>
                      Can't make it — hand it back
                    </button>
                  </>
                )}

                <p className="detail-rule">
                  {item.owner
                    ? "It's live from your own property — never the pavement."
                    : "It'll be on the giver's own property. Exact address appears when you claim."}
                </p>

                {!item.owner && (
                  <div className="detail-footer-actions">
                    <button className="report-btn" onClick={() => setReporting(item)}>
                      Report this listing
                    </button>
                    {item.giver && (
                      <button className="report-btn" onClick={() => block(item.giver)}>
                        Block {item.giver.name}
                      </button>
                    )}
                  </div>
                )}
              </main>
            )}
          </div>
          {sheets}
          {toast && <div className="toast" role="status">{toast}</div>}
        </div>
      </div>
    );
  }

  /* ---------------- my stuff ---------------- */

  if (screen === "mine") {
    const TABS = [
      { k: "toCollect", label: "To collect", n: stuff ? stuff.toCollect.length : 0 },
      { k: "collected", label: "Collected", n: stuff ? stuff.collected.length : 0 },
      { k: "listed", label: "Given", n: stuff ? stuff.listed.length : 0 },
      { k: "wishes", label: "Wish list", n: wishes.length },
    ];
    const when = (ms) =>
      new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

    return (
      <SubScreen title="Your things" time={timeNow} toast={toast} sheets={sheets} onBack={() => setScreen("home")}>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.k} role="tab" aria-selected={tab === t.k} className="tab" onClick={() => setTab(t.k)}>
              {t.label}
              {t.n > 0 && <em>{t.n}</em>}
            </button>
          ))}
        </div>

        {tab === "toCollect" && (
          <>
            {(!stuff || stuff.toCollect.length === 0) && (
              <p className="empty">
                Nothing on the go.
                <br />
                Claim something and it'll wait here with the address.
              </p>
            )}
            {stuff &&
              stuff.toCollect.map((it) => (
                <div key={it.id} className="mine-row urgent-row">
                  <div className="mine-thumb">{it.photo ? <img src={it.photo} alt="" /> : <Glyph kind={it.kind} size={34} />}</div>
                  <div className="mine-copy">
                    <b>{it.title}</b>
                    <span>{whereLine(it)}</span>
                    <span className="mine-timer">Hold ends in {formatLeft(it.holdEndsAt - now)}</span>
                  </div>
                  <div className="mine-actions">
                    <button
                      onClick={() => {
                        setDetailId(it.id);
                        setScreen("detail");
                      }}
                    >
                      Open
                    </button>
                    <button className="quiet" onClick={() => collected(it)}>
                      Got it
                    </button>
                  </div>
                </div>
              ))}
          </>
        )}

        {tab === "collected" && (
          <>
            {(!stuff || stuff.collected.length === 0) && (
              <p className="empty">
                Nothing collected yet.
                <br />
                Everything you take home shows up here.
              </p>
            )}
            {stuff &&
              stuff.collected.map((it) => (
                <div key={it.id} className="mine-row">
                  <div className="mine-thumb">{it.photo ? <img src={it.photo} alt="" /> : <Glyph kind={it.kind} size={34} />}</div>
                  <div className="mine-copy">
                    <b>{it.title}</b>
                    {it.note && <span>{it.note}</span>}
                    <span>
                      {it.giver ? `From ${it.giver.name} · ` : ""}
                      {it.address}
                    </span>
                    <span className="mine-when">Collected {when(it.collectedAt)}</span>
                  </div>
                  <div className="mine-actions">
                    {it.thanked ? (
                      <span className="thanked">Thanked</span>
                    ) : (
                      <button className="quiet" onClick={() => setThanking(it)}>
                        Say thanks
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </>
        )}

        {tab === "listed" && (
          <>
            {(!stuff || stuff.listed.length === 0) && (
              <p className="empty">
                You haven't passed anything on yet.
                <br />
                The camera's on the home screen.
              </p>
            )}
            {stuff &&
              stuff.listed.map((it) => (
                <div key={it.id} className="mine-row">
                  <div className="mine-thumb">{it.photo ? <img src={it.photo} alt="" /> : <Glyph kind={it.kind} size={34} />}</div>
                  <div className="mine-copy">
                    <b>{it.title}</b>
                    <span>{it.road}</span>
                    <span className={`state-tag ${it.state}`}>
                      {it.state === "gone"
                        ? `Collected ${when(it.collectedAt)}`
                        : it.state === "claimed"
                          ? "Claimed — someone's coming"
                          : it.state === "live"
                            ? `Live, ${formatLeft(it.expiresAt - now)} left`
                            : "Window closed"}
                    </span>
                    {it.thanks.length > 0 && <span className="mine-thanks">{it.thanks.length} thank-you{it.thanks.length === 1 ? "" : "s"} received</span>}
                  </div>
                  <div className="mine-actions">
                    {it.state === "live" || it.state === "claimed" ? (
                      <button
                        onClick={() => {
                          setDetailId(it.id);
                          setScreen("detail");
                        }}
                      >
                        Open
                      </button>
                    ) : it.state === "expired" ? (
                      <button className="quiet" onClick={() => openFallback(it)}>
                        What now?
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
          </>
        )}

        {tab === "wishes" && (
          <>
            <p className="sub-lede">
              What you're waiting for. If it's already up we tell you straight away, and the moment a
              neighbour lists one you'll know.
            </p>
            {wishes.length === 0 && (
              <p className="empty">
                Nothing on your wish list yet.
                <br />
                Add what you're after and we'll watch for it.
              </p>
            )}
            {wishes.map((w) => (
              <div key={w.id} className="alert-row">
                <span>
                  <b>{w.keyword || w.cat}</b>
                  <small>
                    {w.cat !== "Anything" && w.keyword ? `${w.cat} · ` : ""}
                    within {w.radius === 0.5 ? "½ mile" : `${w.radius} miles`}
                    {w.found > 0 ? ` · found ${w.found}` : ""}
                  </small>
                </span>
                <button aria-label={`Remove ${w.keyword || w.cat} from your wish list`} onClick={() => removeWish(w.id)}>
                  ×
                </button>
              </div>
            ))}
            <button className="ghost-btn" onClick={() => setScreen("wishes")}>
              Add something to my wish list
            </button>
          </>
        )}
      </SubScreen>
    );
  }

  /* ---------------- notifications ---------------- */

  if (screen === "notifications") {
    return (
      <SubScreen title="Alerts" time={timeNow} toast={toast} onBack={() => setScreen("home")}>
        {notes.length === 0 && (
          <p className="empty">
            Nothing yet.
            <br />
            Save a search and we'll tell you the moment something appears.
          </p>
        )}
        {notes.map((n) => (
          <button
            key={n.id}
            className={`note-row ${n.read ? "" : "fresh"}`}
            onClick={() => {
              setDetailId(n.itemId);
              setScreen("detail");
            }}
          >
            <span className="note-title">{n.title}</span>
            <span className="note-body">{n.body}</span>
            <span className="note-time">
              {new Date(n.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </button>
        ))}
        <button className="ghost-btn" onClick={() => setScreen("wishes")}>
          Manage your wish list
        </button>
      </SubScreen>
    );
  }

  /* ---------------- saved searches ---------------- */

  if (screen === "wishes") {
    return (
      <SubScreen title="Wish list" time={timeNow} toast={toast} onBack={() => setScreen("home")}>
        <p className="sub-lede">
          Say what you're after. If it's already up we'll tell you now, and the moment a neighbour lists
          one you'll know straight away. No posting a plea, no waiting for a reply.
        </p>

        <div className="field">
          <label htmlFor="al-word">I'm after</label>
          <input
            id="al-word"
            value={newWish.keyword}
            onChange={(e) => setNewWish((w) => ({ ...w, keyword: e.target.value }))}
            placeholder="cot, desk, monstera…"
          />
        </div>

        <div className="field">
          <label>Category</label>
          <div className="chips" role="group" aria-label="Wish category">
            {["Anything", ...GIVE_CATEGORIES].map((c) => (
              <button key={c} className="chip" aria-pressed={newWish.cat === c} onClick={() => setNewWish((w) => ({ ...w, cat: c }))}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Within</label>
          <div className="chips" role="group" aria-label="Wish radius">
            {[0.5, 1, 2, 5].map((r) => (
              <button key={r} className="chip" aria-pressed={newWish.radius === r} onClick={() => setNewWish((w) => ({ ...w, radius: r }))}>
                {r === 0.5 ? "½ mile" : `${r} miles`}
              </button>
            ))}
          </div>
        </div>

        <button className="primary-btn" onClick={addWish}>
          Add to my wish list
        </button>

        {wishes.length > 0 && <p className="sub-head">You're waiting for</p>}
        {wishes.map((w) => (
          <div key={w.id} className="alert-row">
            <span>
              <b>{w.keyword || w.cat}</b>
              <small>
                {w.cat !== "Anything" && w.keyword ? `${w.cat} · ` : ""}
                within {w.radius === 0.5 ? "½ mile" : `${w.radius} miles`}
                {w.found > 0 ? ` · found ${w.found}` : ""}
              </small>
            </span>
            <button aria-label={`Remove ${w.keyword || w.cat} from your wish list`} onClick={() => removeWish(w.id)}>
              ×
            </button>
          </div>
        ))}
      </SubScreen>
    );
  }

  /* ---------------- impact ---------------- */

  if (screen === "impact") {
    const you = impact ? impact.you : null;
    const hood = impact ? impact.neighbourhood : null;
    return (
      <SubScreen title="What it adds up to" time={timeNow} toast={toast} onBack={() => setScreen("home")}>
        <p className="sub-lede">
          Every collected item is one thing that didn't become waste. This is the report a council pays for.
        </p>

        <p className="sub-head">You</p>
        <div className="stats-row">
          <div className="stat-tile">
            <b>{you ? you.items : 0}</b>
            <span>Items rehomed</span>
          </div>
          <div className="stat-tile">
            <b>{you ? you.kg : 0}</b>
            <span>kg diverted</span>
          </div>
          <div className="stat-tile">
            <b>£{you ? you.avoidedCost : 0}</b>
            <span>Collection cost avoided</span>
          </div>
        </div>

        <p className="sub-head">London Fields</p>
        <div className="stats-row">
          <div className="stat-tile">
            <b>{hood ? hood.items : 0}</b>
            <span>Items rehomed</span>
          </div>
          <div className="stat-tile">
            <b>{hood ? hood.kgCo2e : 0}</b>
            <span>kg CO₂e avoided</span>
          </div>
          <div className="stat-tile">
            <b>£{hood ? hood.avoidedCost : 0}</b>
            <span>Cost avoided</span>
          </div>
        </div>

        {hood && hood.byDistrict.length > 0 && (
          <>
            <p className="sub-head">By postcode</p>
            {hood.byDistrict.map((d) => (
              <div key={d.district} className="district-row">
                <b>{d.district}</b>
                <span>
                  {d.items} item{d.items === 1 ? "" : "s"} · {d.kg} kg
                </span>
              </div>
            ))}
          </>
        )}

        {hood && hood.creditValue > 0 && (
          <p className="credit-line">
            Worth about £{hood.creditValue.toFixed(2)} in recycling credits, if claimed through a charity partner.
          </p>
        )}

        <p className="caveat">
          Weights are the Furniture Re-use Network averages published by Merseyside Recycling &amp; Waste
          Authority. CO₂ uses Freegle's published 0.51 tonnes per tonne reused, from WRAP's Benefits of
          Reuse tool. Avoided cost uses WRAP's 2025-26 gate fees: £34 a tonne to landfill plus £126.15
          landfill tax.
        </p>
      </SubScreen>
    );
  }

  /* ---------------- unclaimed fallback ---------------- */

  if (screen === "fallback" && fallback) {
    return (
      <SubScreen title="Nobody claimed it" time={timeNow} toast={toast} onBack={() => setScreen("home")}>
        <p className="sub-lede">
          <b>{fallback.title}</b> ran out of time. Don't put it on the pavement — here's what actually works,
          cheapest and kindest first.
        </p>
        {fallback.options.map((o) => (
          <div key={o.key} className="fb-card">
            <h3>{o.name}</h3>
            <p>{o.blurb}</p>
            {o.url ? (
              <a href={o.url} target="_blank" rel="noopener noreferrer">
                {o.action} →
              </a>
            ) : (
              <button
                onClick={() => {
                  setFallback(null);
                  setScreen("give");
                }}
              >
                {o.action} →
              </button>
            )}
          </div>
        ))}
      </SubScreen>
    );
  }

  /* ---------------- profile ---------------- */

  if (screen === "profile") {
    const initials = user
      ? user.name
          .split(/\s+/)
          .map((w) => w[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()
      : "";
    const since = user && user.memberSince
      ? new Date(user.memberSince).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      : "";
    return (
      <div className="ds-root">
        <div className="ds-phone on-home">
          <StatusBar time={timeNow} />
          <div className="ds-frame">
            <header className="topbar">
              <button className="back-btn" onClick={() => setScreen("home")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back
              </button>
              <span className="topbar-title">Your profile</span>
              <span className="topbar-spacer" aria-hidden="true" />
            </header>

            <main className="feed profile">
              <div className="avatar" aria-hidden="true">
                {initials}
                <span className="avatar-dot" />
              </div>
              <h1 className="profile-name">{user ? user.name : ""}</h1>
              <p className="profile-meta">{user ? user.email : ""}</p>
              <p className="profile-meta">
                {user ? user.postcode.toUpperCase() : ""}
                {since ? ` · Doorstepper since ${since}` : ""}
              </p>

              <div className="stats-row">
                <div className="stat-tile">
                  <b>{stats ? stats.given : 0}</b>
                  <span>Given away</span>
                </div>
                <div className="stat-tile">
                  <b>{stats ? stats.collected : 0}</b>
                  <span>Collected</span>
                </div>
                <div className={`stat-tile ${stats && stats.strikes > 0 ? "bad" : ""}`}>
                  <b>{stats ? stats.strikes : 0}</b>
                  <span>No-shows, 30d</span>
                </div>
              </div>

              {stats && stats.activeClaims > 0 && (
                <p className="profile-claims">
                  {stats.activeClaims === 1
                    ? "You have a claim on the go — the address is on the item."
                    : `You have ${stats.activeClaims} claims on the go — the addresses are on the items.`}
                </p>
              )}
              {stats && stats.strikes >= 3 && (
                <p className="profile-claims strike-warn">
                  Claiming is paused — three claims went uncollected this month.
                </p>
              )}

              <div className="rule-card">
                <p className="rule-title">The one rule</p>
                <p className="rule-body">
                  Items wait on your own property — doorstep, garden, porch or lobby.
                  Never the pavement.
                </p>
              </div>

              <div className="profile-links">
                <button onClick={() => { setTab("toCollect"); setScreen("mine"); }}>
                  Your things
                  <span>To collect, collected, given, and your wish list</span>
                </button>
                <button onClick={() => setScreen("wishes")}>
                  Add a wish
                  <span>Get told the moment someone lists what you want</span>
                </button>
                <button onClick={() => setScreen("impact")}>
                  What it adds up to
                  <span>Items rehomed, waste diverted, cost avoided</span>
                </button>
              </div>

              {blocked.length > 0 && (
                <div className="blocked-list">
                  <p className="sub-head">Blocked</p>
                  {blocked.map((b) => (
                    <div key={b.id} className="alert-row">
                      <span>
                        <b>{b.name}</b>
                        <small>You won't see their listings</small>
                      </span>
                      <button onClick={() => unblock(b.id)}>Unblock</button>
                    </div>
                  ))}
                </div>
              )}

              <div className="profile-links">
                <button onClick={exportData}>
                  Download my data
                  <span>Everything we hold about you, as a file</span>
                </button>
              </div>

              <button className="signout-btn" onClick={() => signOut()}>
                Sign out
              </button>

              {confirmDelete ? (
                <div className="danger-zone">
                  <p>
                    This erases your name, email and postcode, and takes down anything still listed.
                    Items already collected stay in the neighbourhood's totals, without your name on them.
                    It can't be undone.
                  </p>
                  <button className="signout-btn danger" onClick={deleteAccount}>
                    Yes, erase my account
                  </button>
                  <button className="retake" onClick={() => setConfirmDelete(false)}>
                    Keep my account
                  </button>
                </div>
              ) : (
                <button className="delete-link" onClick={() => setConfirmDelete(true)}>
                  Delete my account
                </button>
              )}
            </main>
          </div>
          {sheets}
          {toast && <div className="toast" role="status">{toast}</div>}
        </div>
      </div>
    );
  }

  /* ---------------- map ---------------- */

  if (screen === "map") {
    return (
      <div className="ds-root">
        <div className="ds-phone on-home">
          <StatusBar time={timeNow} />
          <div className="ds-frame map-frame">
            <header className="topbar">
              <button className="back-btn" onClick={() => setScreen("home")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back
              </button>
              <span className="topbar-title">Near you</span>
              <span className="topbar-spacer" aria-hidden="true" />
            </header>
            <div className="map-wrap">
              <div ref={mapRef} className="map-canvas" />
              <p className="map-note">Pins are approximate until you claim — then the exact address is yours.</p>
            </div>
          </div>
          {sheets}
          {toast && <div className="toast" role="status">{toast}</div>}
        </div>
      </div>
    );
  }

  /* ---------------- give something away ---------------- */

  if (screen === "give") {
    const upholstered = UPHOLSTERY_RE.test(give.title);
    return (
      <div className="ds-root">
        <div className="ds-phone on-home">
          <StatusBar time={timeNow} />
          <div className="ds-frame">
            <header className="topbar">
              <button
                className="back-btn"
                onClick={() => {
                  setScreen("home");
                  setGiveErrors({});
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back
              </button>
              <span className="topbar-title">Give something away</span>
              <span className="topbar-spacer" aria-hidden="true" />
            </header>

            <main className="feed give-form">
              <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={onPhoto} />
              <button
                className={`photo-box ${give.photos.length ? "has-photo" : ""}`}
                onClick={() => fileRef.current && fileRef.current.click()}
              >
                {give.photos.length ? (
                  <img src={give.photos[0]} alt="Your item" />
                ) : (
                  <span className="photo-hint">
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                      <circle cx="12" cy="13" r="3.5" />
                    </svg>
                    Take a photo
                    <small>{autospec.configured ? "We'll fill in the details from it" : "Opens the camera on your phone"}</small>
                  </span>
                )}
              </button>
              {give.photos.length > 0 && (
                <div className="thumb-strip">
                  {give.photos.map((p, i) => (
                    <span key={i} className={`strip-shot ${i === 0 ? "cover" : ""}`}>
                      <img src={p} alt={`Photo ${i + 1}`} />
                      <button
                        aria-label={`Remove photo ${i + 1}`}
                        onClick={() =>
                          setGive((g) => ({ ...g, photos: g.photos.filter((_, n) => n !== i) }))
                        }
                      >
                        ×
                      </button>
                      {i === 0 && <em>Cover</em>}
                    </span>
                  ))}
                  {give.photos.length < MAX_PHOTOS && (
                    <button className="strip-add" onClick={() => fileRef.current && fileRef.current.click()}>
                      + Add
                    </button>
                  )}
                </div>
              )}
              {autospec.busy && <p className="spec-status working">Reading the photo…</p>}
              {autospec.done && !autospec.busy && <p className="spec-status">Filled in from your photo — change anything that's off.</p>}
              {give.photos.length > 0 && autospec.configured && !autospec.busy && (
                <div className="photo-actions">
                  <button className="retake" onClick={() => runAutospec(give.photos[0])}>
                    Read the photo again
                  </button>
                </div>
              )}

              <div className={`field ${giveErrors.title ? "bad" : ""}`}>
                <label htmlFor="gv-title">What is it</label>
                <input id="gv-title" value={give.title} onChange={setG("title")} placeholder="Pine bookcase" />
                {giveErrors.title && <p className="field-note">{giveErrors.title}</p>}
                {demand > 0 && (
                  <p className="demand-note">
                    {demand === 1
                      ? "A neighbour has this on their wish list — they'll be told the moment you list it."
                      : `${demand} neighbours have this on their wish list — they'll be told the moment you list it.`}
                  </p>
                )}
                {upholstered && (
                  <p className="safety-note">
                    Upholstered or a mattress? Check the permanent fire label is still attached — claimers will be told to look for it.
                  </p>
                )}
              </div>

              <div className="field">
                <label htmlFor="gv-note">Anything they should know</label>
                <input id="gv-note" value={give.note} onChange={setG("note")} placeholder="Five shelves, slight mark on top" />
              </div>

              <div className="field">
                <label>Category</label>
                <div className="chips" role="group" aria-label="Category">
                  {GIVE_CATEGORIES.map((c) => (
                    <button
                      key={c}
                      className="chip"
                      aria-pressed={give.cat === c}
                      onClick={() => setGive((g) => ({ ...g, cat: c }))}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                {give.cat === "Electricals" && (
                  <p className="safety-note">
                    Electricals pass on untested — the claimer will be reminded to check the plug and cable before use.
                  </p>
                )}
              </div>

              <div className="field">
                <label>Where will it wait</label>
                <div className="chips" role="group" aria-label="Collection spot">
                  {SPOT_OPTIONS.map((s) => (
                    <button
                      key={s.v}
                      className="chip"
                      aria-pressed={give.spot === s.v}
                      onClick={() => setGive((g) => ({ ...g, spot: s.v }))}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={`field ${giveErrors.road ? "bad" : ""}`}>
                <label htmlFor="gv-road">Road</label>
                <input id="gv-road" value={give.road} onChange={setG("road")} placeholder="Ellingfort Road, E8" />
                {giveErrors.road && <p className="field-note">{giveErrors.road}</p>}
              </div>

              <div className={`field ${giveErrors.address ? "bad" : ""}`}>
                <label htmlFor="gv-address">Full address — shared only with the claimer</label>
                <input id="gv-address" value={give.address} onChange={setG("address")} placeholder="14 Ellingfort Road, London E8 3PA" />
                {giveErrors.address && <p className="field-note">{giveErrors.address}</p>}
              </div>

              <div className="field">
                <label>How long</label>
                <div className="chips" role="group" aria-label="Listing window">
                  {[
                    { h: 2, label: "2 hours — easy carry" },
                    { h: 4, label: "4 hours — needs a van" },
                  ].map((w) => (
                    <button
                      key={w.h}
                      className="chip"
                      aria-pressed={give.hours === w.h}
                      onClick={() => setGive((g) => ({ ...g, hours: w.h }))}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className={`confirm-row ${giveErrors.confirm ? "bad" : ""}`}>
                <input
                  type="checkbox"
                  checked={give.confirm}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setGive((g) => ({ ...g, confirm: on }));
                    setGiveErrors((p) => (p.confirm ? { ...p, confirm: null } : p));
                  }}
                />
                <span>It'll wait on my own property — doorstep, garden, porch or lobby. Never the pavement.</span>
              </label>
              {giveErrors.confirm && <p className="field-note">{giveErrors.confirm}</p>}

              <button className="primary-btn" onClick={submitGive} disabled={busy}>
                {busy ? "Listing…" : "Put it on the doorstep"}
              </button>
              {giveErrors._form && <p className="field-note form-note">{giveErrors._form}</p>}
            </main>
          </div>
          {sheets}
          {toast && <div className="toast" role="status">{toast}</div>}
        </div>
      </div>
    );
  }

  /* ---------------- home ---------------- */

  return (
    <div className="ds-root">
      <div className="ds-phone on-home">
        <StatusBar time={timeNow} />
        <div className="ds-frame">
          <header className="topbar">
            <div className="wordmark">
              Doorstep <span className="wordmark-dot" />
            </div>
            <div className="topbar-actions">
              <button className="icon-btn" aria-label="Map view" onClick={() => setScreen("map")}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
              </button>
              <button className="icon-btn" aria-label="Your things" onClick={() => { setTab("toCollect"); setScreen("mine"); }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" />
                  <path d="M9 8V6a3 3 0 0 1 6 0v2" />
                </svg>
              </button>
              <button className="icon-btn bell" aria-label={unread > 0 ? `Alerts, ${unread} new` : "Alerts"} onClick={() => setScreen("notifications")}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9z" />
                  <path d="M10.5 20a2 2 0 0 0 3 0" />
                </svg>
                {unread > 0 && <span className="bell-dot">{unread > 9 ? "9+" : unread}</span>}
              </button>
              <button className="icon-btn" aria-label="Your profile" onClick={() => setScreen("profile")}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="8" r="3.6" />
                  <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                </svg>
              </button>
              <button className="place-btn" onClick={() => setScreen("profile")}>
                {user ? user.postcode.toUpperCase() : ""}
              </button>
            </div>
          </header>

          <main className="feed">
            <h1 className="feed-head">
              {liveCount} thing{liveCount === 1 ? "" : "s"} going near you
            </h1>
            <p className="feed-sub">Claim it, then collect from the doorstep.</p>

            <div className="search-row">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search — bookcase, bike, pots…"
                aria-label="Search items"
              />
              {q && (
                <button className="search-clear" aria-label="Clear search" onClick={() => setQ("")}>
                  ×
                </button>
              )}
            </div>

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

            <div className="controls-row">
              <div className="segment" role="group" aria-label="Sort order">
                {[
                  { v: "time", label: "Soonest" },
                  { v: "near", label: "Nearest" },
                ].map((s) => (
                  <button key={s.v} aria-pressed={sort === s.v} onClick={() => setSort(s.v)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <button className="saved-toggle" aria-pressed={savedOnly} onClick={() => setSavedOnly((v) => !v)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill={savedOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                  <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
                </svg>
                Saved
              </button>
              <div className="segment" role="group" aria-label="Distance radius">
                {RADII.map((r) => (
                  <button key={r.label} aria-pressed={radius === r.v} onClick={() => setRadius(r.v)}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {visible.length === 0 && (
              <p className="empty">
                {q.trim() ? "Nothing matches that search right now." : "Nothing in this category right now."}
                <br />
                Have something to pass on instead?
              </p>
            )}

            {recent.length > 0 && !q.trim() && (
              <div className="just-gone">
                <p className="sub-head">Just gone</p>
                <div className="gone-strip">
                  {recent.map((r, i) => (
                    <span key={i} className="gone-chip">
                      <Glyph kind={r.kind} size={26} />
                      <b>{r.title}</b>
                      <small>{r.agoMinutes < 60 ? `${r.agoMinutes} min ago` : `${Math.round(r.agoMinutes / 60)}h ago`}</small>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {visible.map((item) => {
              const remaining = item.expiresAt - now;
              const urgent = remaining < 15 * 60 * 1000;
              const pct = Math.max(0, Math.min(100, (remaining / item.windowMs) * 100));
              const mine = item.status === "yours";
              const gone = item.status === "taken";

              return (
                <article
                  key={item.id}
                  className={`card ${urgent && !gone ? "urgent" : ""} ${gone && !item.owner ? "taken" : ""}`}
                  onClick={() => {
                    setDetailId(item.id);
                    setScreen("detail");
                  }}
                >
                  <div className="card-body">
                    <div className="thumb">
                      {item.photo ? <img className="thumb-img" src={item.photo} alt="" /> : <Glyph kind={item.kind} />}
                      {!item.owner && (
                        <button
                          className={`save-star ${item.saved ? "on" : ""}`}
                          aria-label={item.saved ? `Remove ${item.title} from saved` : `Save ${item.title}`}
                          aria-pressed={item.saved}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSave(item);
                          }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill={item.saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                            <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
                          </svg>
                        </button>
                      )}
                    </div>
                    <div className="card-copy">
                      <h2 className="card-title">{item.title}</h2>
                      <p className="card-meta">
                        {item.note}
                        {item.note ? <br /> : null}
                        {item.owner ? `Your doorstep · ${item.road}` : `${item.dist} · ${item.road}`}
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
                      disabled={(gone && !item.owner) || item.owner}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (mine) {
                          setDetailId(item.id);
                          setScreen("detail");
                        } else {
                          claim(item);
                        }
                      }}
                    >
                      {item.owner
                        ? gone
                          ? "Claimed — someone's collecting it"
                          : "Your listing"
                        : gone
                          ? "Already claimed"
                          : mine
                            ? "Yours — tap for the address"
                            : "Claim it"}
                    </button>
                  </div>
                </article>
              );
            })}
          </main>

          <div className="give-bar">
            <button className="give-btn" onClick={() => setScreen("give")}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
              Give something away
            </button>
          </div>
        </div>

        {sheets}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </div>
  );
}
