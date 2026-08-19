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
    /* hosted APIs sleep and wake, so this is often just a cold start */
    throw Object.assign(new Error("Can't reach Doorstep just now — try again in a moment."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong"), { status: res.status, field: data.field });
  return data;
}

/* A listing either carries its own photograph (someone uploaded it) or names
   one from the shared library (the demo neighbourhood), which the browser
   fetches once and caches. */
const pictureOf = (item) =>
  (item.photos && item.photos[0]) || item.photo || (item.photoRef ? `${API}/photos/${item.photoRef}` : null);

const picturesOf = (item) => {
  if (item.photos && item.photos.length) return item.photos;
  if (item.photo) return [item.photo];
  return item.photoRef ? [`${API}/photos/${item.photoRef}`] : [];
};

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
    bread: (
      <>
        <path d="M9 22c0-5 4-8 17-8s17 3 17 8v14a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6z" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M17 22v20M26 22v20M35 22v20" stroke={g} strokeWidth="2" />
        <rect x="12" y="14" width="8" height="4" rx="2" fill={y} />
      </>
    ),
    veg: (
      <>
        <path d="M26 44c-8 0-13-6-13-13 0-7 5-12 13-12s13 5 13 12c0 7-5 13-13 13z" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M26 19c0-6 3-9 8-10-1 6-3 9-8 10z" fill={y} />
        <path d="M26 19v25" stroke={g} strokeWidth="2" />
      </>
    ),
    dairy: (
      <>
        <path d="M18 20h16v20a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M21 20v-6h10v6" fill="none" stroke={g} strokeWidth="2.5" />
        <rect x="21" y="28" width="10" height="5" rx="1.5" fill={y} />
      </>
    ),
    tin: (
      <>
        <rect x="15" y="14" width="22" height="28" rx="3" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M15 22h22M15 34h22" stroke={g} strokeWidth="2" />
        <rect x="20" y="25" width="12" height="6" rx="1.5" fill={y} />
      </>
    ),
    meal: (
      <>
        <path d="M10 26h32c0 9-7 16-16 16s-16-7-16-16z" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M8 26h36" stroke={g} strokeWidth="2.5" strokeLinecap="round" />
        <path d="M20 20c0-4 3-6 6-6s6 2 6 6" fill="none" stroke={g} strokeWidth="2.5" />
        <rect x="21" y="30" width="10" height="4" rx="2" fill={y} />
      </>
    ),
    drink: (
      <>
        <path d="M17 14h18l-3 28a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z" fill="none" stroke={g} strokeWidth="2.5" />
        <path d="M18 25h16" stroke={g} strokeWidth="2" />
        <rect x="20" y="30" width="12" height="6" rx="2" fill={y} />
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
  const shots = picturesOf(item);
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
const NONFOOD_CATS = [
  { cat: "Furniture", kind: "chairs" },
  { cat: "Kids", kind: "toys" },
  { cat: "Garden", kind: "garden" },
  { cat: "Electricals", kind: "bookcase" },
];

const FOOD_CATS = [
  { cat: "Bakery", kind: "bread" },
  { cat: "Fruit & veg", kind: "veg" },
  { cat: "Dairy", kind: "dairy" },
  { cat: "Store cupboard", kind: "tin" },
  { cat: "Ready meals", kind: "meal" },
  { cat: "Drinks", kind: "drink" },
];

const catsFor = (type) => (type === "food" ? FOOD_CATS : NONFOOD_CATS);
const kindFor = (type, cat) => (catsFor(type).find((c) => c.cat === cat) || {}).kind || "bookcase";
const GIVE_CATEGORIES = NONFOOD_CATS.map((c) => c.cat);

const SPOT_OPTIONS = [
  { v: "doorstep", label: "Doorstep / front steps" },
  { v: "front garden", label: "Front garden" },
  { v: "porch", label: "Porch" },
  { v: "building lobby", label: "Building lobby" },
  { v: "buzz and collect", label: "I'll bring it down — buzz" },
];

const RADII = [
  { v: 0.5, label: "0.5 mi" },
  { v: 1, label: "1 mi" },
  { v: 2, label: "2 mi" },
  { v: Infinity, label: "All" },
];

const EMPTY_GIVE = {
  type: "nonfood",
  title: "",
  note: "",
  cat: "Furniture",
  road: "",
  address: "",
  hours: 2,
  photos: [],
  spot: "doorstep",
  confirm: false,
  useBy: "",
  portions: 1,
};

/* how long until a use-by date, in words */
function untilUseBy(ms) {
  const days = Math.ceil((ms - Date.now()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `${days} days`;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
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
  /* Browsing needs no account: the app opens on the feed and only asks who
     you are at the moment you try to claim or give something. A sign-up wall
     in front of an empty-handed visitor is the surest way to lose them. */
  const [screen, setScreen] = useState(token ? "loading" : "home");
  const [pending, setPending] = useState(null);
  const [authReason, setAuthReason] = useState(null);
  const [mode, setMode] = useState("signup");
  const [form, setForm] = useState({ name: "", email: "", postcode: "", password: "", confirm: "" });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("Going soonest");
  const [typeFilter, setTypeFilter] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("time");
  const [radius, setRadius] = useState(2);
  const [items, setItems] = useState([]);
  /* how the current page relates to the whole result: total, whether there is
     more to fetch, and whether a fetch is in flight */
  const [feed, setFeed] = useState({ total: 0, more: false, loading: true });
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
  const [peek, setPeek] = useState(null);
  const [blocked, setBlocked] = useState([]);
  const [thanking, setThanking] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  /* a grid of photographs reads far better than a column of rows, which is
     what every marketplace app has settled on; the list stays for anyone who
     prefers the detail */
  const [view, setView] = useState(() => localStorage.getItem("ds_view") || "grid");
  const [demand, setDemand] = useState(0);
  const [stuff, setStuff] = useState(null);
  const [tab, setTab] = useState("toCollect");
  const [autospec, setAutospec] = useState({ configured: false, busy: false, done: false });
  const fileRef = useRef(null);
  const mapRef = useRef(null);
  const mapObj = useRef(null);

  useClock();

  /* Signing out drops you back to the feed as a guest. There is nothing to
     log in to see, so a sign-up form here would be a dead end. */
  const signOut = useCallback((message) => {
    const t = localStorage.getItem("ds_token");
    if (t) api("/auth/signout", { method: "POST", token: t }).catch(() => {});
    localStorage.removeItem("ds_token");
    setToken(null);
    setUser(null);
    setNotes([]);
    setUnread(0);
    setWishes([]);
    setStuff(null);
    setBlocked([]);
    setSavedOnly(false);
    setPending(null);
    setAuthReason(null);
    setScreen("home");
    if (message) setToast(message);
  }, []);

  /* The feed is paged and filtered by the database: with a few hundred live
     listings, searching only what happened to be on the current page would
     quietly miss most of the neighbourhood. */
  const fetchItems = useCallback(
    async (t, { append = false, offset = 0, sort, search, type, cat, radius, saved, limit = 24 } = {}) => {
      setFeed((f) => ({ ...f, loading: true }));
      try {
        const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
        if (sort === "near") params.set("sort", "near");
        if (search && search.trim()) params.set("q", search.trim());
        if (type && type !== "all") params.set("type", type);
        if (cat && cat !== "Going soonest") params.set("cat", cat);
        if (radius && Number.isFinite(radius)) params.set("radius", String(radius));
        if (saved) params.set("saved", "1");

        const data = await api(`/items?${params}`, { token: t || undefined });
        setItems((list) => {
          if (!append) return data.items;
          const seen = new Set(list.map((i) => i.id));
          return [...list, ...data.items.filter((i) => !seen.has(i.id))];
        });
        setFeed({ total: data.total ?? data.items.length, more: !!data.more, loading: false });
      } catch (e) {
        setFeed((f) => ({ ...f, loading: false }));
        if (e.status === 401) signOut("Your session expired — you're browsing as a guest.");
        else setToast(e.message);
      }
    },
    [signOut]
  );

  const refresh = useCallback(
    (t) => fetchItems(t ?? token, { sort, search: q, type: typeFilter, cat: filter, radius, saved: savedOnly }),
    [fetchItems, token, sort, q, typeFilter, filter, radius, savedOnly]
  );

  /* Anything that needs an account routes through here: remember what they
     were trying to do, ask them to sign in, then carry it out. */
  const needsAccount = useCallback(
    (reason, action) => {
      if (token) return false;
      setAuthReason(reason);
      setPending(action ? { action } : null);
      setMode("signup");
      setErrors({});
      setScreen("auth");
      return true;
    },
    [token]
  );

  /* restore session on load */
  useEffect(() => {
    if (!token || user) return;
    api("/me", { token })
      .then((data) => {
        setUser(data.user);
        setStats(data.stats);
        setScreen("home");
      })
      .catch(() => {
        /* an expired token is not worth a message — just carry on as a guest */
        localStorage.removeItem("ds_token");
        setToken(null);
        setUser(null);
        setScreen("home");
      });
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
      refresh();
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
    if (screen === "home") api("/items/recent").then((d) => setRecent(d.items)).catch(() => {});
    if (!token) return;
    if (screen === "wishes") api("/wishes", { token }).then((d) => setWishes(d.wishes)).catch(() => {});
    if (screen === "mine") {
      api("/me/stuff", { token }).then(setStuff).catch(() => {});
      if (tab === "wishes") api("/wishes", { token }).then((d) => setWishes(d.wishes)).catch(() => {});
    }
    if (screen === "impact") api("/impact", { token }).then(setImpact).catch(() => {});
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

  /* the feed refreshes for guests too */
  const browsing = ["home", "map", "detail", "give", "profile", "notifications", "wishes", "impact", "fallback", "mine"].includes(screen);
  useEffect(() => {
    if (!browsing) return;
    /* a map with only the first page of pins would look half empty */
    const query = { sort, search: q, type: typeFilter, cat: filter, radius, saved: savedOnly, limit: screen === "map" ? 60 : 24 };
    /* debounced, so typing does not fire a request per letter */
    const first = setTimeout(() => fetchItems(token, query), q ? 300 : 0);
    const poll = setInterval(() => fetchItems(token, query), 45 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [browsing, token, fetchItems, sort, q, typeFilter, filter, radius, savedOnly, screen]);

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
      const mine = it.owner || it.status === "yours";
      const food = it.type === "food";
      /* the photograph is the pin: far easier to read at a glance than a dot */
      const pic = pictureOf(it);
      const inner = pic
        ? `<img src="${esc(pic)}" alt="" />`
        : `<span class="pin-letter">${esc(it.title.slice(0, 1).toUpperCase())}</span>`;
      const icon = L.divIcon({
        className: "",
        html: `<div class="pin${urgent ? " urgent" : ""}${mine ? " mine" : ""}${food ? " food" : ""}">${inner}<i></i></div>`,
        iconSize: [46, 54],
        iconAnchor: [23, 52],
      });
      L.marker([it.lat, it.lng], { icon, riseOnHover: true })
        .addTo(layer)
        .on("click", () => setPeek(it.id));
    }

    /* fit the view to what is actually out there */
    if (live.length) {
      const pts = live.map((i) => [i.lat, i.lng]);
      if (user && user.lat != null) pts.push([user.lat, user.lng]);
      m.fitBounds(L.latLngBounds(pts).pad(0.18), { animate: false, maxZoom: 16 });
    }

    return () => {
      layer.remove();
    };
  }, [screen, items, user]);

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
    if (signup && !next.password) {
      if (!form.confirm) next.confirm = "Type your password again";
      else if (form.confirm !== form.password) next.confirm = "These don't match";
    }

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
      setAuthReason(null);
      await fetchItems(data.token, { sort, type: typeFilter });

      /* pick up whatever they were doing before we interrupted */
      const next = pending;
      setPending(null);
      if (next && next.action === "give") setScreen("give");
      else if (next && next.action === "wishes") setScreen("wishes");
      else if (next && next.action === "mine") setScreen("mine");
      else if (next && next.action === "claim" && next.id) {
        setScreen("home");
        const fresh = await api(`/items/${next.id}/claim`, { method: "POST", token: data.token }).catch((err) => {
          setToast(err.message);
          return null;
        });
        if (fresh) {
          setItems((list) => list.map((i) => (i.id === fresh.id ? fresh : i)));
          setToast(`Claimed. ${whereLine(fresh)} Collect within 30 minutes.`);
        }
      } else setScreen("home");
    } catch (e) {
      setErrors(e.field ? { [e.field]: e.message } : { _form: e.message });
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e) => { if (e.key === "Enter") submit(); };

  /* ---- claim / collect ---- */

  const claim = async (item) => {
    if (needsAccount(`Sign in to claim ${item.title.toLowerCase()}`, { action: "claim", id: item.id })) return;
    try {
      const updated = await api(`/items/${item.id}/claim`, { method: "POST", token });
      setItems((list) => list.map((it) => (it.id === updated.id ? updated : it)));
      setToast(`Claimed. ${whereLine(updated)} Collect within 30 minutes.`);
    } catch (e) {
      setToast(e.message);
      if (e.status === 409 || e.status === 410) refresh();
    }
  };

  const collected = async (item) => {
    try {
      await api(`/items/${item.id}/collected`, { method: "POST", token });
      setThanking(item);
      refresh();
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
    if (needsAccount("Sign in to save things for later")) return;
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
      setScreen("home");
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
      refresh();
    } catch (e) {
      setToast(e.message);
    }
  };

  const unblock = async (id) => {
    setBlocked((list) => list.filter((b) => b.id !== id));
    api(`/users/${id}/block`, { method: "DELETE", token }).catch(() => {});
    refresh();
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
        refresh();
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

  useEffect(() => {
    localStorage.setItem("ds_view", view);
  }, [view]);

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
    if (give.type === "food") {
      if (!give.useBy) next.useBy = "When does it need eating by?";
      else if (new Date(`${give.useBy}T23:59:59`).getTime() <= Date.now())
        next.useBy = "That date has passed — food past its use-by can't be passed on";
    }
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
          type: give.type,
          kind: kindFor(give.type, give.cat),
          useBy: give.useBy ? new Date(`${give.useBy}T23:59:59`).getTime() : null,
          portions: give.portions,
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

  /* the database applied the search, category, type, radius and saved
     filters — all that is left is dropping anything that expired while the
     page sat open */
  const visible = items.filter((it) => it.expiresAt > now);

  /* the headline counts what is actually on screen, filters and all —
     saying "13 things" above five cards is just wrong */
  const liveCount = feed.total || visible.length;

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
                {authReason ? authReason : signup ? "Give it away before you bin it." : "Welcome back."}
              </h1>
              <p className="auth-sub">
                {authReason
                  ? "It takes a moment, and your postcode is only used to show what's within walking distance."
                  : signup
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
                <div className={`field ${errors.confirm ? "bad" : ""}`}>
                  <label htmlFor="ds-confirm">Confirm password</label>
                  <input
                    id="ds-confirm"
                    type="password"
                    value={form.confirm}
                    onChange={set("confirm")}
                    onKeyDown={onKey}
                    placeholder="Type it again"
                    autoComplete="new-password"
                  />
                  {errors.confirm && <p className="field-note">{errors.confirm}</p>}
                  {!errors.confirm && form.confirm && form.confirm === form.password && form.password.length >= 8 && (
                    <p className="field-ok">Passwords match</p>
                  )}
                </div>
              )}

              {!signup && (
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
                {busy ? "One moment" : signup ? "Create account" : "Sign in"}
              </button>
              {errors._form && <p className="field-note form-note">{errors._form}</p>}

              <button
                className="browse-back"
                onClick={() => {
                  setAuthReason(null);
                  setPending(null);
                  setErrors({});
                  setScreen("home");
                }}
              >
                Keep looking around instead
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
                      {busy ? "Saving" : "Save changes"}
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

                <div className="facts">
                  <span className="fact">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
                      <circle cx="12" cy="10" r="2.4" />
                    </svg>
                    {item.owner ? "Your doorstep" : item.dist || item.road}
                  </span>
                  <span className="fact">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M3 10.5 12 3l9 7.5" />
                      <path d="M5.5 9.5V20h13V9.5" />
                    </svg>
                    {item.spot}
                  </span>
                  <span className="fact">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="8.5" />
                      <path d="M12 7.5V12l3 1.8" />
                    </svg>
                    {Math.round(item.windowMs / 3600000)}h window
                  </span>
                  <span className="fact">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <rect x="4" y="4" width="16" height="16" rx="3" />
                      <path d="M4 10h16" />
                    </svg>
                    {item.cat}
                  </span>
                  {item.type === "food" && item.portions > 1 && (
                    <span className="fact">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <path d="M4 12h16" />
                        <path d="M12 4v16" />
                      </svg>
                      {item.portions} portions
                    </span>
                  )}
                </div>

                {item.type === "food" && item.useBy && (
                  <p className="food-note">
                    <b>Eat by {untilUseBy(item.useBy)}</b> — check it over when you collect. Food past its use-by
                    date can't be passed on.
                  </p>
                )}

                <p className="detail-where">
                  {item.spot === "buzz and collect"
                    ? "The giver will bring it down — buzz when you arrive."
                    : `It'll be waiting on the ${item.spot}, on ${item.road}.`}
                </p>

                {item.giver && !item.owner && (
                  <div className="giver-card">
                    <span className="giver-avatar">{item.giver.name.slice(0, 1).toUpperCase()}</span>
                    <span className="giver-lines">
                      <b>{item.giver.name}</b>
                      <small>
                        {item.giver.handed > 0
                          ? `${item.giver.handed} thing${item.giver.handed === 1 ? "" : "s"} handed over`
                          : "New to the neighbourhood"}
                      </small>
                      {item.giver.verified && (
                        <em className="verified">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                          Address verified
                        </em>
                      )}
                    </span>
                  </div>
                )}

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

                {(() => {
                  const also = items
                    .filter((i) => i.id !== item.id && i.expiresAt > now && i.status !== "taken" && !i.owner)
                    .sort((a, b) => (a.cat === item.cat ? -1 : 1) - (b.cat === item.cat ? -1 : 1) || a.expiresAt - b.expiresAt)
                    .slice(0, 4);
                  if (!also.length) return null;
                  return (
                    <div className="also">
                      <p className="sub-head">Also going near you</p>
                      <div className="item-grid">
                        {also.map((a) => (
                          <article
                            key={a.id}
                            className="gcard"
                            onClick={() => {
                              setDetailId(a.id);
                              setShot(0);
                            }}
                          >
                            <div className="gcard-photo">
                              {pictureOf(a) ? (
                                <img src={pictureOf(a)} alt="" loading="lazy" />
                              ) : (
                                <span className="gcard-glyph">
                                  <Glyph kind={a.kind} size={44} />
                                </span>
                              )}
                              <span className="gcard-timer">{formatLeft(a.expiresAt - now)}</span>
                            </div>
                            <div className="gcard-copy">
                              <b>{a.title}</b>
                              <span>{[a.dist, a.road].filter(Boolean).join(" · ")}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                    </div>
                  );
                })()}

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
                  <div className="mine-thumb">{pictureOf(it) ? <img src={pictureOf(it)} alt="" /> : <Glyph kind={it.kind} size={34} />}</div>
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
                  <div className="mine-thumb">{pictureOf(it) ? <img src={pictureOf(it)} alt="" /> : <Glyph kind={it.kind} size={34} />}</div>
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
                  <div className="mine-thumb">{pictureOf(it) ? <img src={pictureOf(it)} alt="" /> : <Glyph kind={it.kind} size={34} />}</div>
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
                    within {w.radius === 0.5 ? "0.5 miles" : `${w.radius} miles`}
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
            placeholder="cot, desk, monstera"
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
                {r === 0.5 ? "0.5 miles" : `${r} miles`}
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
                within {w.radius === 0.5 ? "0.5 miles" : `${w.radius} miles`}
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
            <span>kg CO2e avoided</span>
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
          Authority. CO2 uses Freegle's published 0.51 tonnes per tonne reused, from WRAP's Benefits of
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
              <button
                className="back-btn"
                onClick={() => {
                  setPeek(null);
                  setScreen("home");
                }}
              >
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

              {(() => {
                const it = items.find((i) => i.id === peek);
                if (!it) return <p className="map-note">Pins are approximate until you claim — then the exact address is yours.</p>;
                const left = it.expiresAt - now;
                return (
                  <div className="peek" role="dialog" aria-label={it.title}>
                    <button className="peek-close" aria-label="Close" onClick={() => setPeek(null)}>
                      ×
                    </button>
                    <div
                      className="peek-body"
                      onClick={() => {
                        setDetailId(it.id);
                        setShot(0);
                        setScreen("detail");
                      }}
                    >
                      <div className="peek-photo">
                        {pictureOf(it) ? <img src={pictureOf(it)} alt="" /> : <Glyph kind={it.kind} size={38} />}
                      </div>
                      <div className="peek-copy">
                        <b>{it.title}</b>
                        <span>{[it.dist, it.road].filter(Boolean).join(" · ")}</span>
                        <span className={`peek-timer ${left < 15 * 60 * 1000 ? "urgent" : ""}`}>
                          {formatLeft(left)} left
                          {it.type === "food" && it.useBy ? ` · eat by ${untilUseBy(it.useBy)}` : ""}
                        </span>
                      </div>
                      <svg className="peek-go" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </div>
                  </div>
                );
              })()}
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
              {autospec.busy && <p className="spec-status working">Reading the photo</p>}
              {autospec.done && !autospec.busy && <p className="spec-status">Filled in from your photo — change anything that's off.</p>}
              {give.photos.length > 0 && autospec.configured && !autospec.busy && (
                <div className="photo-actions">
                  <button className="retake" onClick={() => runAutospec(give.photos[0])}>
                    Read the photo again
                  </button>
                </div>
              )}

              <div className="field">
                <label>What are you passing on</label>
                <div className="type-pills" role="group" aria-label="Food or not">
                  {[
                    { v: "nonfood", label: "Something" },
                    { v: "food", label: "Food" },
                  ].map((t) => (
                    <button
                      key={t.v}
                      className="type-pill"
                      aria-pressed={give.type === t.v}
                      onClick={() =>
                        setGive((g) => ({
                          ...g,
                          type: t.v,
                          cat: catsFor(t.v)[0].cat,
                          hours: t.v === "food" ? 4 : 2,
                        }))
                      }
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

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
                  {catsFor(give.type).map((c) => (
                    <button
                      key={c.cat}
                      className="chip"
                      aria-pressed={give.cat === c.cat}
                      onClick={() => setGive((g) => ({ ...g, cat: c.cat }))}
                    >
                      {c.cat}
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

              {give.type === "food" && (
                <>
                  <div className={`field ${giveErrors.useBy ? "bad" : ""}`}>
                    <label htmlFor="gv-useby">Use by</label>
                    <input
                      id="gv-useby"
                      type="date"
                      value={give.useBy}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={setG("useBy")}
                    />
                    {giveErrors.useBy ? (
                      <p className="field-note">{giveErrors.useBy}</p>
                    ) : (
                      <p className="safety-note">
                        The date on the packet. Food past its use-by can't be passed on — that one is the law,
                        not a preference.
                      </p>
                    )}
                  </div>

                  <div className="field">
                    <label>How many portions</label>
                    <div className="chips" role="group" aria-label="Portions">
                      {[1, 2, 3, 4, 6, 8].map((n) => (
                        <button
                          key={n}
                          className="chip"
                          aria-pressed={give.portions === n}
                          onClick={() => setGive((g) => ({ ...g, portions: n }))}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

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
                  {(give.type === "food"
                    ? [
                        { h: 2, label: "2 hours" },
                        { h: 4, label: "4 hours" },
                        { h: 8, label: "8 hours" },
                      ]
                    : [
                        { h: 2, label: "2 hours — easy carry" },
                        { h: 4, label: "4 hours — needs a van" },
                      ]
                  ).map((w) => (
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
                {busy ? "Listing" : "Put it on the doorstep"}
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
              <button
                className="give-top"
                onClick={() => {
                  if (needsAccount("Sign in to give something away", { action: "give" })) return;
                  setScreen("give");
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                  <circle cx="12" cy="13" r="3.4" />
                </svg>
                Give
              </button>
              <button
                className="place-btn"
                onClick={() => {
                  if (needsAccount("Sign in to join your neighbourhood")) return;
                  setScreen("profile");
                }}
              >
                {user ? user.postcode.toUpperCase() : "Sign in"}
              </button>
            </div>
          </header>

          <main className="feed">
            <h1 className="feed-head">
              {liveCount}{" "}
              {typeFilter === "food"
                ? `thing${liveCount === 1 ? "" : "s"} to eat near you`
                : `thing${liveCount === 1 ? "" : "s"} going near you`}
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
                placeholder="Search bookcase, bike, pots"
                aria-label="Search items"
              />
              {q && (
                <button className="search-clear" aria-label="Clear search" onClick={() => setQ("")}>
                  ×
                </button>
              )}
            </div>

            <div className="type-pills" role="group" aria-label="Food or not">
              {[
                { v: "all", label: "Everything" },
                { v: "food", label: "Food" },
                { v: "nonfood", label: "Non-food" },
              ].map((t) => (
                <button
                  key={t.v}
                  className="type-pill"
                  aria-pressed={typeFilter === t.v}
                  onClick={() => {
                    setTypeFilter(t.v);
                    setFilter("Going soonest");
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="cat-row" role="group" aria-label="Browse by category">
              {[
                { c: "Going soonest", kind: "clock", label: "All" },
                ...(typeFilter === "food" ? FOOD_CATS : typeFilter === "nonfood" ? NONFOOD_CATS : [...NONFOOD_CATS, ...FOOD_CATS])
                  .slice(0, typeFilter === "all" ? 4 : 6)
                  .map((c) => ({ c: c.cat, kind: c.kind, label: c.cat })),
              ].map((c) => (
                <button
                  key={c.c}
                  className="cat-btn"
                  aria-pressed={filter === c.c}
                  onClick={() => setFilter(c.c)}
                >
                  <span className="cat-ring">
                    {c.kind === "clock" ? (
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#234A3B" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="8.5" />
                        <path d="M12 7.5V12l3 1.8" />
                      </svg>
                    ) : (
                      <Glyph kind={c.kind} size={30} />
                    )}
                  </span>
                  {c.label}
                </button>
              ))}
            </div>

            <div className="scroll-strip">
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
              <div className="segment" role="group" aria-label="Layout">
                <button aria-pressed={view === "grid"} aria-label="Grid view" onClick={() => setView("grid")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" aria-hidden="true">
                    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
                    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
                    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
                    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
                  </svg>
                </button>
                <button aria-pressed={view === "list"} aria-label="List view" onClick={() => setView("list")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 6.5h16M4 12h16M4 17.5h16" />
                  </svg>
                </button>
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
            </div>

            {feed.loading && visible.length === 0 && (
              <div className="feed-loading" aria-hidden="true">
                <span className="skeleton" />
                <span className="skeleton" />
                <span className="skeleton" />
                <span className="skeleton" />
              </div>
            )}

            {!feed.loading && visible.length === 0 && (
              <div className="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" />
                  <path d="M9 8V6a3 3 0 0 1 6 0v2" />
                </svg>
                <b>
                  {q.trim()
                    ? `Nothing matching "${q.trim()}" just now`
                    : savedOnly
                      ? "Nothing saved yet"
                      : typeFilter === "food"
                        ? "No food going right now"
                        : "Nothing here right now"}
                </b>
                <span>
                  {q.trim() || filter !== "Going soonest"
                    ? "Try a wider radius, or add it to your wish list and we'll tell you the moment one appears."
                    : "Things come and go through the day. Have something to pass on instead?"}
                </span>
              </div>
            )}

            {recent.length > 0 && !q.trim() && (
              <div className="just-gone">
                <p className="sub-head">Just gone</p>
                <div className="gone-strip">
                  {recent.slice(0, 3).map((r, i) => (
                    <span key={i} className="gone-chip">
                      <Glyph kind={r.kind} size={26} />
                      <b>{r.title}</b>
                      <small>{r.agoMinutes < 60 ? `${r.agoMinutes} min ago` : `${Math.round(r.agoMinutes / 60)}h ago`}</small>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className={view === "grid" ? "item-grid" : "item-list"}>
              {visible.map((item) => {
                const remaining = item.expiresAt - now;
                const urgent = remaining < 15 * 60 * 1000;
                const pct = Math.max(0, Math.min(100, (remaining / item.windowMs) * 100));
                const mine = item.status === "yours";
                const gone = item.status === "taken";
                const open = () => {
                  setDetailId(item.id);
                  setShot(0);
                  setScreen("detail");
                };

                if (view === "grid") {
                  return (
                    <article
                      key={item.id}
                      className={`gcard ${urgent && !gone ? "urgent" : ""} ${gone && !item.owner ? "taken" : ""}`}
                      onClick={open}
                    >
                      <div className="gcard-photo">
                        {pictureOf(item) ? (
                          <img src={pictureOf(item)} alt="" loading="lazy" />
                        ) : (
                          <span className="gcard-glyph">
                            <Glyph kind={item.kind} size={54} />
                          </span>
                        )}
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
                        <span className={`gcard-timer ${urgent ? "urgent" : ""}`}>{formatLeft(remaining)}</span>
                        {item.type === "food" && !gone && !mine && !item.owner && (
                          <span className="gcard-food">Food</span>
                        )}
                        {(gone || mine || item.owner) && (
                          <span className="gcard-state">{mine ? "Yours" : item.owner ? "Your listing" : "Claimed"}</span>
                        )}
                      </div>
                      <div className="gcard-copy">
                        <b>{item.title}</b>
                        <span>{item.owner ? "Your doorstep" : [item.dist, item.road].filter(Boolean).join(" · ")}</span>
                        {item.type === "food" && item.useBy && (
                          <span className="useby">Eat by {untilUseBy(item.useBy)}</span>
                        )}
                      </div>
                    </article>
                  );
                }

                return (
                  <article
                    key={item.id}
                    className={`card ${urgent && !gone ? "urgent" : ""} ${gone && !item.owner ? "taken" : ""}`}
                    onClick={open}
                  >
                    <div className="card-body">
                      <div className="thumb">
                        {pictureOf(item) ? <img className="thumb-img" src={pictureOf(item)} alt="" loading="lazy" /> : <Glyph kind={item.kind} />}
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
                          {item.owner ? `Your doorstep · ${item.road}` : [item.dist, item.road].filter(Boolean).join(" · ")}
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
                          if (mine) open();
                          else claim(item);
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
            </div>

            {feed.more && (
              <button
                className="ghost-btn more-btn"
                disabled={feed.loading}
                onClick={() =>
                  fetchItems(token, {
                    append: true,
                    offset: items.length,
                    sort,
                    search: q,
                    type: typeFilter,
                    cat: filter,
                    radius,
                    saved: savedOnly,
                  })
                }
              >
                {feed.loading ? "Loading" : `Show more (${feed.total - items.length} to go)`}
              </button>
            )}


          </main>

          <nav className="tabbar" aria-label="Main">
            <button className="tabbar-btn" aria-current="page">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 10.5 12 3l9 7.5" />
                <path d="M5.5 9.5V20h13V9.5" />
              </svg>
              Near you
            </button>
            <button className="tabbar-btn" onClick={() => setScreen("map")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
                <circle cx="12" cy="10" r="2.5" />
              </svg>
              Map
            </button>
            <button
              className="tabbar-btn"
              onClick={() => {
                if (needsAccount("Sign in to see your things", { action: "mine" })) return;
                setTab("toCollect");
                setScreen("mine");
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" />
                <path d="M9 8V6a3 3 0 0 1 6 0v2" />
              </svg>
              Yours
            </button>
            <button
              className="tabbar-btn"
              onClick={() => {
                if (needsAccount("Sign in and we'll tell you when something you want appears", { action: "wishes" })) return;
                setScreen("notifications");
              }}
            >
              <span className="tabbar-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9z" />
                  <path d="M10.5 20a2 2 0 0 0 3 0" />
                </svg>
                {unread > 0 && <em>{unread > 9 ? "9+" : unread}</em>}
              </span>
              Alerts
            </button>
            <button
              className="tabbar-btn"
              onClick={() => {
                if (needsAccount("Sign in to see your profile")) return;
                setScreen("profile");
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="8" r="3.4" />
                <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
              </svg>
              You
            </button>
          </nav>
        </div>

        {sheets}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </div>
  );
}
