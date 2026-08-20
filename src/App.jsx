import React, { useState, useEffect, useRef, useCallback } from "react";
import { App as CapacitorApp } from "@capacitor/app";
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

/* A drawn kerb pile for spots posted without a photo: a box of odds and ends
   with a FREE sign leaning against it, in brick — the wilder cousin of the
   railing-green doorstep glyphs. */
const KerbPile = ({ size = 52 }) => {
  const b = "#A64B2A";
  const g = "#234A3B";
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" aria-hidden="true">
      <path d="M6 44h40" stroke={g} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M12 30h20v14H12z" fill="none" stroke={b} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M12 30l3-6h14l3 6" fill="none" stroke={b} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M22 24v-7m0 0c-3 0-5-2-5-5 3 0 5 2 5 5zm0 0c3 0 5-2 5-5-3 0-5 2-5 5z" fill="none" stroke={g} strokeWidth="2" strokeLinecap="round" />
      <rect x="34" y="26" width="12" height="10" rx="1.5" fill="#F5C518" stroke={b} strokeWidth="2" />
      <path d="M36.5 31.5v-3h2m-2 1.5h1.5M41 28.5v3m0-3h2m-2 1.5h1.5" stroke={b} strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M40 36v8" stroke={b} strokeWidth="2" strokeLinecap="round" />
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

/* The handover gesture. A tap is too easy to fire by accident while someone is
   juggling a sofa cushion on a doorstep, so confirming collection asks for a
   deliberate slide — the same idea Too Good To Go uses at the counter. Pointer
   events cover mouse and touch alike, and setPointerCapture keeps the drag
   alive even when the finger wanders off the thumb. Keyboard users shouldn't
   have to mime a drag, so Enter or Space on the thumb confirms directly.
   Defined at module scope for the same remount reason as SubScreen above. */
const SlideToCollect = ({ onConfirm }) => {
  const trackRef = useRef(null);
  /* Where the pointer started relative to the thumb's current offset, so a
     grab mid-track doesn't make the thumb jump under the finger. */
  const grabRef = useRef(0);
  /* The handler must only ever fire once, even if pointer events keep
     arriving after the threshold — a ref survives the same-tick re-renders
     that state wouldn't. */
  const firedRef = useRef(false);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  /* the ref is the truth, the state only styles: a fast swipe can land its
     first moves before React commits the state, and those must not be lost */
  const draggingRef = useRef(false);
  const [done, setDone] = useState(false);

  /* The distance the thumb can travel: track width minus its own diameter and
     the 3px inset each side. Measured on demand rather than cached, because
     the phone frame can resize while the sheet is open. */
  const travel = () => (trackRef.current ? trackRef.current.clientWidth - 48 - 6 : 0);

  const confirm = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    setDone(true);
    draggingRef.current = false;
    setDragging(false);
    setX(travel());
    /* The brief green "Collected ✓" state shows immediately; the handler's own
       refresh replaces this screen shortly after, so no timer is needed. */
    onConfirm();
  };

  const down = (e) => {
    if (firedRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    grabRef.current = e.clientX - x;
    draggingRef.current = true;
    setDragging(true);
  };
  const move = (e) => {
    if (!draggingRef.current || firedRef.current) return;
    const max = travel();
    const next = Math.min(max, Math.max(0, e.clientX - grabRef.current));
    /* Crossing 85% of the way is commitment enough — snap home and fire. */
    if (max > 0 && next >= max * 0.85) confirm();
    else setX(next);
  };
  const up = () => {
    if (firedRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    /* Released short of the threshold: spring back. The transition lives in
       CSS so prefers-reduced-motion can make it instant. */
    setX(0);
  };
  const key = (e) => {
    /* Accessibility beats theatre: a keyboard press confirms outright. The
       preventDefault stops Space scrolling the feed behind the control. */
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      confirm();
    }
  };

  return (
    <div className={done ? "slide-collect done" : "slide-collect"} ref={trackRef}>
      <span className="slide-collect-label">{done ? "Collected ✓" : "Slide to confirm collection"}</span>
      <button
        type="button"
        className={dragging ? "slide-collect-thumb dragging" : "slide-collect-thumb"}
        style={{ transform: `translateX(${x}px)` }}
        aria-label="Slide to confirm collection"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
};

const CATEGORIES = ["Going soonest", "Furniture", "Kids", "Garden", "Electricals"];
/* `kind` is the drawn glyph used when a listing has no picture; `pic` is the
   illustration that stands for the whole category in the shortcut row. */
const NONFOOD_CATS = [
  { cat: "Furniture", kind: "chairs", pic: "armchair" },
  { cat: "Kids", kind: "toys", pic: "toy-kitchen" },
  { cat: "Garden", kind: "garden", pic: "houseplant" },
  { cat: "Electricals", kind: "bookcase", pic: "floor-lamp" },
];

const FOOD_CATS = [
  { cat: "Bakery", kind: "bread", pic: "bread" },
  { cat: "Fruit & veg", kind: "veg", pic: "vegetables" },
  { cat: "Dairy", kind: "dairy", pic: "dairy" },
  { cat: "Store cupboard", kind: "tin", pic: "tins" },
  { cat: "Ready meals", kind: "meal", pic: "ready-meal" },
  { cat: "Drinks", kind: "drink", pic: "drinks" },
];

/* What a neighbour needs to know before walking over. The questions differ
   by category, because a highchair and a floor lamp raise different ones. */
const DETAIL_COMMON = [
  { key: "condition", label: "Condition", type: "choice", options: ["New", "As good as new", "Good", "Fair", "Well used"] },
  { key: "carry", label: "Getting it home", type: "choice", options: ["One person can carry it", "Two people", "Needs a car or van"] },
];

const DETAIL_BY_CAT = {
  Furniture: [
    { key: "width", label: "Width", type: "cm" },
    { key: "depth", label: "Depth", type: "cm" },
    { key: "height", label: "Height", type: "cm" },
    { key: "material", label: "Material", type: "choice", options: ["Wood", "Metal", "Glass", "Fabric", "Plastic", "Mixed"] },
    { key: "colour", label: "Colour", type: "text" },
    { key: "brand", label: "Make", type: "text" },
    { key: "flatpack", label: "Comes apart", type: "choice", options: ["Yes, flat packs", "No, one piece"] },
  ],
  Kids: [
    { key: "ages", label: "Suits ages", type: "choice", options: ["0-1", "1-3", "3-5", "5-8", "8-12", "Any age"] },
    { key: "brand", label: "Make", type: "text" },
    { key: "pieces", label: "All pieces there", type: "choice", options: ["Yes, complete", "Some pieces missing"] },
    { key: "washed", label: "Cleaned", type: "choice", options: ["Yes, cleaned", "Needs a wipe"] },
  ],
  Garden: [
    { key: "width", label: "Width", type: "cm" },
    { key: "height", label: "Height", type: "cm" },
    { key: "material", label: "Material", type: "choice", options: ["Terracotta", "Plastic", "Wood", "Metal", "Stone"] },
    { key: "quantity", label: "How many", type: "text" },
  ],
  Electricals: [
    { key: "works", label: "Working order", type: "choice", options: ["Works fine", "Works, with a fault", "Not working, for parts"] },
    { key: "cable", label: "Cable or charger", type: "choice", options: ["Included", "Not included"] },
    { key: "brand", label: "Make", type: "text" },
    { key: "age", label: "Roughly how old", type: "choice", options: ["Under a year", "1-3 years", "3-5 years", "Over 5 years"] },
  ],
  food: [
    { key: "storage", label: "How to keep it", type: "choice", options: ["Cupboard", "Fridge", "Freezer"] },
    { key: "opened", label: "Packaging", type: "choice", options: ["Unopened", "Opened but sealed inside", "Loose"] },
    { key: "diet", label: "Suitable for", type: "choice", options: ["Anyone", "Vegetarian", "Vegan"] },
    { key: "allergens", label: "Contains", type: "text", hint: "Nuts, milk, gluten and so on - copy what the packet says" },
  ],
};

const fieldsFor = (type, cat) => [...DETAIL_COMMON, ...(type === "food" ? DETAIL_BY_CAT.food : DETAIL_BY_CAT[cat] || [])];

const catsFor = (type) => (type === "food" ? FOOD_CATS : NONFOOD_CATS);
const kindFor = (type, cat) => (catsFor(type).find((c) => c.cat === cat) || {}).kind || "bookcase";
const GIVE_CATEGORIES = NONFOOD_CATS.map((c) => c.cat);
/* people wish for food too, so the wish list offers every category */
const WISH_CATS = [...NONFOOD_CATS, ...FOOD_CATS];
const picForCat = (cat) => (WISH_CATS.find((c) => c.cat === cat) || {}).pic || null;

/* "1 miles" reads wrong. Say it the way a person would. */
const milesLabel = (r) => {
  if (r === 0.25) return "a quarter mile";
  if (r === 0.5) return "half a mile";
  if (r === 1) return "1 mile";
  return `${r} miles`;
};

/* the home screen greets you like a neighbour, not a database */
const greeting = (name) => {
  const h = new Date().getHours();
  const part = h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  return name ? `${part}, ${name.split(" ")[0]}` : `${part}, neighbour`;
};

/* "216h ago" is not something anyone says out loud */
const agoLabel = (mins) => {
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) {
    const h = Math.round(mins / 60);
    return h === 1 ? "an hour ago" : `${h} hours ago`;
  }
  const d = Math.round(mins / (24 * 60));
  return d === 1 ? "yesterday" : `${d} days ago`;
};

const addedOn = (ms) => {
  if (!ms) return "";
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return "added today";
  if (days === 1) return "added yesterday";
  if (days < 7) return `added ${days} days ago`;
  if (days < 14) return "added last week";
  return `added ${Math.floor(days / 7)} weeks ago`;
};

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
  wanted: false,
  claimMode: "instant",
  underCover: false,
  dibs: false,
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
  details: {},
  /* set when relisting something collected through the app — links the two
     listings into one lineage, so the item's passport travels with it */
  passFrom: null,
};

/* 1 → "1st", 2 → "2nd", 23 → "23rd" — for "2nd home" on a passport */
function ordinal(n) {
  const tail = n % 100;
  const suffix = tail >= 11 && tail <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${suffix}`;
}

/* "August 2026" — when the story began */
const monthYear = (ms) => new Date(ms).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

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

/* The three-slide pitch a brand-new guest sees once. The drawings are flat
   and geometric in the app's own few colours rather than photographs,
   because a photo promises a particular sofa and we can only promise the
   neighbourhood. */
const INTRO_SLIDES = [
  {
    head: "Your neighbours are giving things away, right now",
    sub: "Furniture, food, plants, kids' kit — free, and minutes away on foot.",
    art: (
      <svg className="intro-art" viewBox="0 0 220 170" aria-hidden="true">
        <circle cx="110" cy="85" r="72" fill="#FFFFFF" />
        <circle cx="54" cy="42" r="8" fill="#F5C518" />
        <rect x="88" y="30" width="64" height="88" rx="6" fill="#234A3B" />
        <rect x="98" y="42" width="44" height="26" rx="3" fill="#2E5F4B" />
        <rect x="98" y="76" width="44" height="32" rx="3" fill="#2E5F4B" />
        <circle cx="145" cy="76" r="4" fill="#F5C518" />
        <rect x="80" y="118" width="80" height="10" rx="3" fill="#CDD2C9" />
        <rect x="42" y="128" width="136" height="10" rx="3" fill="#CDD2C9" />
        <path d="M38 98 L28 87 L48 91 Z" fill="#A64B2A" opacity="0.65" />
        <path d="M78 98 L88 87 L68 91 Z" fill="#A64B2A" opacity="0.65" />
        <rect x="38" y="98" width="40" height="30" rx="3" fill="#A64B2A" />
        <rect x="55" y="98" width="7" height="30" fill="#F5C518" />
        <path d="M58 98 C56 82 64 72 76 68 C76 80 70 92 58 98 Z" fill="#2E5F4B" />
      </svg>
    ),
  },
  {
    head: "Claim it, then collect from the doorstep",
    sub: "No chat needed. The exact address appears the moment it's yours.",
    art: (
      <svg className="intro-art" viewBox="0 0 220 170" aria-hidden="true">
        <circle cx="110" cy="85" r="72" fill="#FFFFFF" />
        <path d="M48 132 H172" stroke="#CDD2C9" strokeWidth="4" strokeLinecap="round" strokeDasharray="1 12" />
        <circle cx="84" cy="44" r="11" fill="#234A3B" />
        <path d="M84 60 V92" stroke="#234A3B" strokeWidth="13" strokeLinecap="round" />
        <path d="M84 90 L66 128" stroke="#234A3B" strokeWidth="8" strokeLinecap="round" />
        <path d="M84 90 L102 112 L106 130" stroke="#234A3B" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d="M84 66 L100 82" stroke="#234A3B" strokeWidth="7" strokeLinecap="round" />
        <path d="M84 66 L68 84" stroke="#234A3B" strokeWidth="7" strokeLinecap="round" />
        <path d="M120 70 H148" stroke="#F5C518" strokeWidth="9" strokeLinecap="round" />
        <path d="M144 58 L160 70 L144 82" stroke="#F5C518" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <rect x="146" y="104" width="22" height="28" rx="3" fill="#A64B2A" />
        <circle cx="163" cy="118" r="2.5" fill="#F5C518" />
      </svg>
    ),
  },
  {
    head: "Nothing good goes to waste in Hackney",
    sub: "Every collection is one thing that never became bin lorry cargo.",
    art: (
      <svg className="intro-art" viewBox="0 0 220 170" aria-hidden="true">
        <circle cx="110" cy="85" r="72" fill="#FFFFFF" />
        <circle cx="156" cy="48" r="6" fill="#F5C518" />
        <path d="M110 135 A50 50 0 0 1 110 35" stroke="#234A3B" strokeWidth="8" fill="none" strokeLinecap="round" />
        <path d="M110 35 A50 50 0 0 1 110 135" stroke="#234A3B" strokeWidth="8" fill="none" strokeLinecap="round" />
        <path d="M110 26 L126 35 L110 44 Z" fill="#234A3B" />
        <path d="M110 126 L94 135 L110 144 Z" fill="#234A3B" />
        <path d="M96 58 C118 62 130 84 118 106 C96 102 86 78 96 58 Z" fill="#2E5F4B" />
        <path d="M100 66 C106 80 110 92 114 104" stroke="#E5E7DF" strokeWidth="3" fill="none" strokeLinecap="round" />
        <path d="M116 108 C112 118 108 124 106 130" stroke="#2E5F4B" strokeWidth="4" fill="none" strokeLinecap="round" />
      </svg>
    ),
  },
];

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
     in front of an empty-handed visitor is the surest way to lose them.
     The one exception is a guest we have never met at all — they get the
     three-slide pitch once, because the feed only sells itself to someone
     who already knows the things on it are free and around the corner. */
  const [screen, setScreen] = useState(() => {
    if (token) return "loading";
    return localStorage.getItem("ds_seen_intro") ? "home" : "intro";
  });
  /* which pitch slide is in view, and the rail itself so the Next button
     and the dots can drive the scroll rather than duplicate it */
  const [introSlide, setIntroSlide] = useState(0);
  const introRail = useRef(null);
  const [pending, setPending] = useState(null);
  const [authReason, setAuthReason] = useState(null);
  const [mode, setMode] = useState("signup");
  const [form, setForm] = useState({ name: "", email: "", postcode: "", password: "", confirm: "" });
  /* what the postcode turned into: the street we found, the houses to pick
     from if a licensed lookup is configured, and what they chose */
  const [addr, setAddr] = useState({ state: "idle", road: null, options: [], picked: null, house: "", city: "", county: "", country: "" });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  /* two eyes and a signature: what you typed, on request, and your yes to
     the privacy policy recorded as part of the signup itself */
  const [showPw, setShowPw] = useState(false);
  const [showPw2, setShowPw2] = useState(false);
  const [acceptPolicy, setAcceptPolicy] = useState(false);
  const [filter, setFilter] = useState("Going soonest");
  const [typeFilter, setTypeFilter] = useState("all");
  const [q, setQ] = useState("");
  const [hints, setHints] = useState([]);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [sort, setSort] = useState("time");
  const [radius, setRadius] = useState(2);
  const [customRadius, setCustomRadius] = useState(false);
  const [items, setItems] = useState([]);
  /* how the current page relates to the whole result: total, whether there is
     more to fetch, and whether a fetch is in flight */
  const [feed, setFeed] = useState({ total: 0, elsewhere: 0, more: false, loading: true });
  const [toast, setToast] = useState(null);
  const [give, setGive] = useState(EMPTY_GIVE);
  const [giveErrors, setGiveErrors] = useState({});
  const [detailId, setDetailId] = useState(null);
  const [stats, setStats] = useState(null);
  const [badges, setBadges] = useState([]);
  const [notes, setNotes] = useState([]);
  const [unread, setUnread] = useState(0);
  const [wishes, setWishes] = useState([]);
  const [newWish, setNewWish] = useState({ keyword: "", cat: "Anything", radius: 1 });
  const [impact, setImpact] = useState(null);
  const [fallback, setFallback] = useState(null);
  const [recent, setRecent] = useState([]);
  const goneStrip = useRef(null);
  /* kerbside piles spotted by passers-by: the strip on the home screen, the
     little compose form, and its own file input so a spot photo never lands
     in a half-written give form */
  const [spots, setSpots] = useState([]);
  const [spotForm, setSpotForm] = useState({ note: "", road: "", photo: null, freeSign: false });
  const [spotErrors, setSpotErrors] = useState({});
  const spotFileRef = useRef(null);
  /* the arrangement threads: the list, the open one, and what's unread */
  const [chats, setChats] = useState([]);
  const [chatUnread, setChatUnread] = useState(0);
  const [chatTab, setChatTab] = useState("all");
  const [chatId, setChatId] = useState(null);
  const [thread, setThread] = useState(null);
  const [hands, setHands] = useState([]);
  const [sky, setSky] = useState(null);
  const [wants, setWants] = useState([]);
  const [draft, setDraft] = useState("");
  const chatEnd = useRef(null);
  const [reporting, setReporting] = useState(null);
  const [editing, setEditing] = useState(null);
  const [shot, setShot] = useState(0);
  const [peek, setPeek] = useState(null);
  const [blocked, setBlocked] = useState([]);
  const [thanking, setThanking] = useState(null);
  /* an optional line for the item's passport, offered alongside the thank-you */
  const [storyLine, setStoryLine] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [asksOnly, setAsksOnly] = useState(false);
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
    async (t, { append = false, offset = 0, sort, search, type, cat, radius, saved, asks, limit = 24 } = {}) => {
      setFeed((f) => ({ ...f, loading: true }));
      try {
        const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
        if (sort === "near") params.set("sort", "near");
        if (search && search.trim()) params.set("q", search.trim());
        if (type && type !== "all") params.set("type", type);
        if (cat && cat !== "Going soonest") params.set("cat", cat);
        if (radius && Number.isFinite(radius)) params.set("radius", String(radius));
        if (saved) params.set("saved", "1");
        if (asks) params.set("asks", "1");

        const data = await api(`/items?${params}`, { token: t || undefined });
        setItems((list) => {
          if (!append) return data.items;
          const seen = new Set(list.map((i) => i.id));
          return [...list, ...data.items.filter((i) => !seen.has(i.id))];
        });
        setFeed({
          total: data.total ?? data.items.length,
          elsewhere: data.elsewhere || 0,
          more: !!data.more,
          loading: false,
        });
      } catch (e) {
        setFeed((f) => ({ ...f, loading: false }));
        if (e.status === 401) signOut("Your session expired — you're browsing as a guest.");
        else setToast(e.message);
      }
    },
    [signOut]
  );

  const refresh = useCallback(
    (t) => fetchItems(t ?? token, { sort, search: q, type: typeFilter, cat: filter, radius, saved: savedOnly, asks: asksOnly }),
    [fetchItems, token, sort, q, typeFilter, filter, radius, savedOnly, asksOnly]
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
        setBadges(data.badges || []);
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
        setBadges(data.badges || []);
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
      if (msg.type === "message") {
        /* if that very thread is open, the words just appear; anywhere else
           the messages badge ticks up and a toast passes by */
        setChatUnread((n) => n + 1);
        api("/chats", { token }).then((d) => { setChats(d.chats); setChatUnread(d.unread); }).catch(() => {});
        if (screenRef.current === "chat" && chatIdRef.current) {
          api(`/chats/${chatIdRef.current}`, { token }).then(setThread).catch(() => {});
        } else {
          setToast(msg.body.length > 60 ? `${msg.body.slice(0, 60)}…` : msg.body);
        }
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

  /* the newest words are the reason you're here */
  useEffect(() => {
    if (screen === "chat" && chatEnd.current) chatEnd.current.scrollIntoView({ block: "end" });
  }, [screen, thread]);

  /* Every screen opens at its own top — the frame is one scroller shared by
     all of them, so without this a detail page inherits however far down the
     feed you were, and opens on the middle of the description instead of the
     photos. The feed itself is the one exception: coming Back should land
     you exactly where you left off, so its position is remembered. */
  const scrollMemo = useRef(0);
  useEffect(() => {
    const frame = document.querySelector(".ds-frame");
    if (!frame) return;
    frame.scrollTop = screen === "home" ? scrollMemo.current : 0;
    return () => {
      if (screen === "home") scrollMemo.current = frame.scrollTop;
    };
  }, [screen, detailId]);

  /* the SSE closure outlives renders, so it reads these instead of state */
  const screenRef = useRef(screen);
  const chatIdRef = useRef(chatId);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { chatIdRef.current = chatId; }, [chatId]);

  /* sheets need the same treatment: the hardware back should close what's
     on top before it moves between screens */
  const sheetRef = useRef({ thanking: null, reporting: null });
  useEffect(() => { sheetRef.current = { thanking, reporting }; }, [thanking, reporting]);

  /* Android's own back button drives the same navigation the on-screen Back
     does. Without this the system gesture killed the whole app from any
     screen — the one habit every Android thumb has, broken. On the web the
     listener simply never fires. Home is the floor: back from there hands
     control to the system, which minimises the app the way Android expects. */
  useEffect(() => {
    const sub = CapacitorApp.addListener("backButton", () => {
      const sheet = sheetRef.current;
      if (sheet.thanking) return setThanking(null);
      if (sheet.reporting) return setReporting(null);

      const here = screenRef.current;
      const upFrom = {
        detail: "home",
        map: "home",
        give: "home",
        spot: "home",
        notifications: "home",
        profile: "home",
        wishes: "home",
        impact: "home",
        fallback: "home",
        auth: "home",
        chat: "chats",
        chats: "profile",
        mine: "profile",
        radar: "profile",
      };
      if (upFrom[here]) {
        if (here === "chat") {
          setThread(null);
          setChatId(null);
        }
        setScreen(upFrom[here]);
      } else {
        CapacitorApp.exitApp();
      }
    });
    return () => {
      sub.then((h) => h.remove()).catch(() => {});
    };
  }, []);

  /* unread count on sign-in */
  useEffect(() => {
    if (!token || !user) return;
    api("/notifications", { token })
      .then((d) => {
        setNotes(d.notifications);
        setUnread(d.unread);
      })
      .catch(() => {});
    api("/chats", { token })
      .then((d) => {
        setChats(d.chats);
        setChatUnread(d.unread);
      })
      .catch(() => {});
  }, [token, user]);

  /* per-screen data */
  useEffect(() => {
    if (screen === "home") api("/items/recent").then((d) => setRecent(d.items)).catch(() => {});
    /* spotted piles ride along with the home feed, and the map needs them
       too so its pins can show the wilder kerbside finds beside the doorsteps */
    if (screen === "home" || screen === "map")
      api("/spots", { token: token || undefined }).then((d) => setSpots(d.spots)).catch(() => {});
    if (!token) return;
    if (screen === "wishes") api("/wishes", { token }).then((d) => setWishes(d.wishes)).catch(() => {});
    if (screen === "mine") {
      api("/me/stuff", { token }).then(setStuff).catch(() => {});
      /* always, not just when the wish tab happens to be open: this effect
         does not re-run on a tab change, so the tab was left empty while the
         standalone screen showed the same wishes fine */
      api("/wishes", { token }).then((d) => setWishes(d.wishes)).catch(() => {});
    }
    if (screen === "impact") api("/impact", { token }).then(setImpact).catch(() => {});
    if (screen === "radar") api("/demand", { token }).then((d) => setWants(d.wants)).catch(() => {});
    if (screen === "chats") api("/chats", { token }).then((d) => { setChats(d.chats); setChatUnread(d.unread); }).catch(() => {});
    if (screen === "detail" && detailId) {
      const it = items.find((x) => x.id === detailId);
      if (it && it.owner && it.claimMode === "fair") {
        api(`/items/${detailId}/hands`, { token }).then((d) => setHands(d.hands)).catch(() => setHands([]));
      } else {
        setHands([]);
      }
    }
    if (screen === "chat" && chatId) {
      api(`/chats/${chatId}`, { token }).then((d) => {
        setThread(d);
        /* opening it read it, so the badge can let go of those */
        api("/chats", { token }).then((x) => setChatUnread(x.unread)).catch(() => {});
      }).catch(() => {});
    }
    if (screen === "profile") api("/blocks", { token }).then((d) => setBlocked(d.blocked)).catch(() => {});
    if (screen === "give") {
      api("/autospec/status", { token }).then((d) => setAutospec((a) => ({ ...a, configured: d.configured }))).catch(() => {});
      api("/weather?hours=4", { token }).then((d) => setSky(d.warning)).catch(() => setSky(null));
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
  }, [screen, token, tab, chatId]);

  /* the feed refreshes for guests too */
  const browsing = ["home", "map", "detail", "give", "profile", "notifications", "wishes", "impact", "fallback", "mine", "chats", "chat", "radar"].includes(screen);
  useEffect(() => {
    if (!browsing) return;
    /* a map with only the first page of pins would look half empty */
    const query = { sort, search: q, type: typeFilter, cat: filter, radius, saved: savedOnly, asks: asksOnly, limit: screen === "map" ? 60 : 24 };
    /* debounced, so typing does not fire a request per letter */
    const first = setTimeout(() => fetchItems(token, query), q ? 300 : 0);
    const poll = setInterval(() => fetchItems(token, query), 45 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [browsing, token, fetchItems, sort, q, typeFilter, filter, radius, savedOnly, asksOnly, screen]);

  /* suggestions come from what is genuinely listed right now */
  useEffect(() => {
    if (!hintsOpen || q.trim().length < 2) {
      setHints([]);
      return;
    }
    const t = setTimeout(() => {
      api(`/suggest?q=${encodeURIComponent(q.trim())}`, { token: token || undefined })
        .then((d) => setHints(d.suggestions))
        .catch(() => setHints([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, hintsOpen, token]);

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

    /* Spotted kerbside piles get their own pin: a brick parcel rather than a
       photograph, because nobody owns them and there is no detail screen to
       open — a popup with the note and how long ago says everything. */
    const piles = spots.filter((s) => s.lat != null);
    for (const s of piles) {
      const icon = L.divIcon({
        className: "",
        html: `<div class="spot-pin"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg><i></i></div>`,
        iconSize: [34, 40],
        iconAnchor: [17, 38],
      });
      L.marker([s.lat, s.lng], { icon, riseOnHover: true })
        .addTo(layer)
        .bindPopup(`<b>${esc(s.note)}</b><br/>spotted ${s.agoMinutes} min ago`);
    }

    /* fit the view to what is actually out there */
    if (live.length || piles.length) {
      const pts = [...live.map((i) => [i.lat, i.lng]), ...piles.map((s) => [s.lat, s.lng])];
      if (user && user.lat != null) pts.push([user.lat, user.lng]);
      m.fitBounds(L.latLngBounds(pts).pad(0.18), { animate: false, maxZoom: 16 });
    }

    return () => {
      layer.remove();
    };
  }, [screen, items, spots, user]);

  /* ---- auth handlers ---- */

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((prev) => (prev[key] || prev._form ? { ...prev, [key]: null, _form: null } : prev));
  };

  /* Postcode in, address out. There is no free source of UK house-level
     addresses — Royal Mail's file is licensed — so without a provider key
     this verifies the postcode, names the street, and lets someone add their
     own house number. With a key it returns the real list to choose from. */
  const findAddress = async () => {
    const pc = form.postcode.trim();
    if (!/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(pc)) {
      setErrors((e) => ({ ...e, postcode: "Enter a full UK postcode, like E8 3EP" }));
      return;
    }
    setAddr((a) => ({ ...a, state: "looking" }));
    try {
      const found = await api(`/address?postcode=${encodeURIComponent(pc)}`);
      setErrors((e) => ({ ...e, postcode: null }));
      setAddr({
        state: found.mode === "list" ? "choose" : "street",
        road: found.road || null,
        options: found.addresses || [],
        picked: null,
        house: "",
        /* the postcode already knows where it lives — these arrive filled
           in, and stay editable for the rare case the data is stale */
        city: found.city || "",
        county: found.county || "",
        country: found.country || "",
      });
    } catch (e) {
      setAddr({ state: "idle", road: null, options: [], picked: null, house: "", city: "", county: "", country: "" });
      setErrors((prev) => ({ ...prev, postcode: e.message }));
    }
  };

  /* the address as it will be stored and shown when they give something away */
  const addressLine = () => {
    if (addr.picked) return addr.picked.line;
    if (addr.house.trim() && addr.road) return `${addr.house.trim()} ${addr.road}`;
    return addr.house.trim();
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
    if (signup && !acceptPolicy) next.privacy = "Have a read, then tick the box";

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      const data = await api(signup ? "/auth/signup" : "/auth/signin", {
        method: "POST",
        body: signup
          ? {
              name: form.name,
              email: form.email,
              postcode: form.postcode,
              password: form.password,
              address: addressLine(),
              road: (addr.picked && addr.picked.road) || addr.road || "",
              uprn: (addr.picked && addr.picked.id) || null,
              city: addr.city,
              county: addr.county,
              country: addr.country,
              acceptPrivacy: acceptPolicy,
            }
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
      if (updated.fair) {
        /* no race here — a hand went up, and the giver will pick */
        setItems((list) => list.map((it) => (it.id === item.id ? { ...it, handUp: true, hands: updated.hands } : it)));
        setToast(
          updated.hands === 1
            ? "Your hand's up — you're the first to ask. The giver picks."
            : `Your hand's up — ${updated.hands} asking so far. The giver picks.`
        );
        return;
      }
      setItems((list) => list.map((it) => (it.id === updated.id ? updated : it)));
      setToast(`Claimed. ${whereLine(updated)} Collect within 30 minutes.`);
    } catch (e) {
      setToast(e.message);
      if (e.status === 409 || e.status === 410) refresh();
    }
  };

  /* One trip: the claim is already held, so adding another of the same
     giver's listings joins the walk rather than starting a new arrangement.
     The server returns the freshly claimed items, which replace their stale
     twins in the feed so the row disappears from the panel on its own. */
  const bundle = async (anchor, extra) => {
    try {
      const d = await api(`/items/${anchor.id}/bundle`, { method: "POST", token, body: { itemIds: [extra.id] } });
      const updated = new Map((d.items || []).map((i) => [i.id, i]));
      setItems((list) => list.map((i) => (updated.has(i.id) ? updated.get(i.id) : i)));
      setToast("Added to the trip — same doorstep, same half hour.");
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

  /* Follow a giver whose taste you trust — the button flips optimistically on
     every card they own, and quietly flips back if the server disagrees. */
  const toggleFollow = async (item) => {
    if (needsAccount("Sign in to follow this giver")) return;
    const giverId = item.giver.id;
    const next = !item.giver.following;
    const flip = (val) => (list) =>
      list.map((i) =>
        i.giver && i.giver.id === giverId
          ? { ...i, giver: { ...i.giver, following: val, followers: Math.max(0, (i.giver.followers || 0) + (val ? 1 : -1)) } }
          : i
      );
    setItems(flip(next));
    try {
      await api(`/givers/${giverId}/follow`, { method: next ? "POST" : "DELETE", token });
    } catch {
      setItems(flip(!next));
    }
  };

  /* The passport line is a bonus, never a blocker: if it fails, the thanks
     (or the dismissal) still goes through without a murmur. */
  const sendStoryLine = (item) => {
    const line = storyLine.trim();
    setStoryLine("");
    if (!line || !item) return;
    api(`/items/${item.id}/passport-note`, { method: "POST", token, body: { body: line } }).catch(() => {});
  };

  const sendThanks = async (item, kind) => {
    setThanking(null);
    sendStoryLine(item);
    try {
      await api(`/items/${item.id}/thanks`, { method: "POST", token, body: { token: kind } });
      setToast("Sent. They'll see it in their alerts.");
    } catch (e) {
      setToast(e.message);
    }
  };

  /* ---- spotted piles ---- */

  /* one photo, not a strip: a spot is a snapshot in passing, not a listing */
  const onSpotPhoto = async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    const shot = await shrink(file).catch(() => null);
    if (!shot) {
      setSpotErrors((p) => ({ ...p, photo: "That photo didn't come through — try taking it again" }));
      return;
    }
    setSpotForm((f) => ({ ...f, photo: shot }));
    setSpotErrors((p) => (p.photo ? { ...p, photo: null } : p));
  };

  const submitSpot = async () => {
    const next = {};
    if (!spotForm.note.trim()) next.note = "Say what's in the pile";
    if (!spotForm.freeSign) next.freeSign = "Only post piles that are clearly being given away";
    setSpotErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      const created = await api("/spots", {
        method: "POST",
        token,
        body: { note: spotForm.note.trim(), photo: spotForm.photo, road: spotForm.road.trim(), freeSign: true },
      });
      setSpots((list) => [created, ...list].slice(0, 20));
      setSpotForm({ note: "", road: "", photo: null, freeSign: false });
      setScreen("home");
      setToast("Spotted. Everyone nearby can see it for 2 hours.");
    } catch (e) {
      setSpotErrors(e.field ? { [e.field]: e.message } : { _form: e.message });
    } finally {
      setBusy(false);
    }
  };

  const tookFromSpot = async (s) => {
    if (needsAccount("Sign in to tell the spotter something's been grabbed")) return;
    try {
      const d = await api(`/spots/${s.id}/took`, { method: "POST", token });
      setSpots((list) => list.map((x) => (x.id === s.id ? { ...x, takenCount: d.takenCount } : x)));
      if (!d.alreadyTook) setToast(s.mine ? "Noted — the pile's still doing its job." : "Noted — and the spotter's been thanked.");
    } catch (e) {
      setToast(e.message);
    }
  };

  const reportSpot = async (s) => {
    if (needsAccount("Sign in to report a spotted pile")) return;
    try {
      const d = await api(`/spots/${s.id}/report`, { method: "POST", token });
      /* two reports kill it, so if this was the second the strip loses it now */
      if (d.hidden) setSpots((list) => list.filter((x) => x.id !== s.id));
      setToast(d.alreadyReported ? "You've already flagged that one." : "Flagged. Two flags take a spot down.");
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

  /* One wish list, built once and shown in both places. It used to be two
     hand-written copies that had already drifted apart — different wording,
     an empty state on one and a blank void on the other. */
  const wishReady = Boolean(newWish.keyword.trim()) || newWish.cat !== "Anything";

  const wishPanel = (
    <>
      <p className="sub-lede">
        Say what you're after. If it's already up we'll tell you now, and the moment a neighbour lists
        one you'll know straight away.
      </p>

      <div className="wish-compose">
        <div className="field">
          <label htmlFor="al-word">I'm after</label>
          <input
            id="al-word"
            value={newWish.keyword}
            onChange={(e) => setNewWish((w) => ({ ...w, keyword: e.target.value }))}
            placeholder="cot, desk, monstera, bread"
            onKeyDown={(e) => e.key === "Enter" && wishReady && addWish()}
          />
        </div>

        <div className="field">
          <label>Category</label>
          <div className="wish-cats" role="group" aria-label="Wish category">
            {[{ cat: "Anything", pic: null }, ...WISH_CATS].map((c) => (
              <button
                key={c.cat}
                className="wish-cat"
                aria-pressed={newWish.cat === c.cat}
                onClick={() => setNewWish((w) => ({ ...w, cat: c.cat }))}
              >
                <span className="wish-cat-art">
                  {c.pic ? (
                    <img src={`${API}/photos/${c.pic}`} alt="" loading="lazy" />
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M5 12h14M12 5v14" />
                    </svg>
                  )}
                </span>
                <small>{c.cat}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="al-radius">Within {milesLabel(newWish.radius)} of home</label>
          <input
            id="al-radius"
            className="range"
            type="range"
            min="0.25"
            max="10"
            step="0.25"
            value={newWish.radius}
            onChange={(e) => setNewWish((w) => ({ ...w, radius: Number(e.target.value) }))}
          />
          <div className="range-ends">
            <span>a quarter mile</span>
            <span>10 miles</span>
          </div>
        </div>

        <button className="primary-btn" onClick={() => addWish()} disabled={!wishReady}>
          {wishReady ? "Add to my wish list" : "Type what you're after"}
        </button>
        <p className="field-hint">
          {wishes.length >= 10
            ? "Ten wishes is the limit — remove one to add another."
            : `You can keep up to ten. ${10 - wishes.length} left.`}
        </p>
      </div>

      {wishes.length === 0 ? (
        <div className="wish-empty">
          <img src={`${API}/photos/houseplant`} alt="" />
          <b>Nothing on your wish list yet</b>
          <span>
            Tell us what you're after and we'll watch every listing for it — day or night, so you don't
            have to keep checking.
          </span>
        </div>
      ) : (
        <>
          <p className="sub-head">
            You're waiting for {wishes.length === 1 ? "one thing" : `${wishes.length} things`}
          </p>
          <div className="wish-list">
            {wishes.map((w) => {
              const named = Boolean(w.keyword);
              const pic = picForCat(w.cat);
              return (
                <div key={w.id} className="wish-card">
                  <span className="wish-art">
                    {pic ? (
                      <img src={`${API}/photos/${pic}`} alt="" loading="lazy" />
                    ) : (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 20.5S3.5 15 3.5 9.2A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 8.5 2.2c0 5.8-8.5 11.3-8.5 11.3Z" />
                      </svg>
                    )}
                  </span>

                  <span className="wish-what">
                    <b>{named ? w.keyword : `Anything in ${w.cat}`}</b>
                    <small>
                      {named && w.cat !== "Anything" ? `${w.cat} · ` : ""}
                      within {milesLabel(w.radius)}
                      {w.createdAt ? ` · ${addedOn(w.createdAt)}` : ""}
                    </small>
                  </span>

                  <span className="wish-side">
                    {w.upNow > 0 ? (
                      <button
                        className="wish-live"
                        onClick={() => {
                          /* take them straight to the things that match it */
                          setQ(w.keyword || "");
                          setFilter(w.cat === "Anything" ? "Going soonest" : w.cat);
                          setRadius(w.radius);
                          setCustomRadius(true);
                          setScreen("home");
                        }}
                      >
                        {w.upNow === 1 ? "1 up now" : `${w.upNow} up now`}
                      </button>
                    ) : (
                      <span className="wish-watch">Watching</span>
                    )}
                    <button
                      className="wish-x"
                      aria-label={`Remove ${w.keyword || w.cat} from your wish list`}
                      onClick={() => removeWish(w.id)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );

  /* "Just gone" moves by itself. It is the proof the neighbourhood is alive,
     and nobody swipes a strip they haven't noticed. It steps one card at a
     time, loops back to the start, and stops the moment someone touches it or
     the screen is hidden — and never runs at all for anyone who has asked for
     less motion. */
  useEffect(() => {
    const strip = goneStrip.current;
    if (screen !== "home" || !strip || recent.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let paused = false;
    const hold = () => (paused = true);
    const release = () => (paused = false);

    strip.addEventListener("pointerdown", hold);
    strip.addEventListener("pointerenter", hold);
    strip.addEventListener("pointerleave", release);
    strip.addEventListener("touchstart", hold, { passive: true });
    strip.addEventListener("touchend", release, { passive: true });

    const tick = setInterval(() => {
      if (paused || document.hidden) return;
      const card = strip.firstElementChild;
      if (!card) return;
      const step = card.getBoundingClientRect().width + 10;
      const end = strip.scrollWidth - strip.clientWidth - 4;
      strip.scrollTo({ left: strip.scrollLeft >= end ? 0 : strip.scrollLeft + step, behavior: "smooth" });
    }, 2600);

    return () => {
      clearInterval(tick);
      strip.removeEventListener("pointerdown", hold);
      strip.removeEventListener("pointerenter", hold);
      strip.removeEventListener("pointerleave", release);
      strip.removeEventListener("touchstart", hold);
      strip.removeEventListener("touchend", release);
    };
  }, [screen, recent.length]);

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

  /* straight from an item to its conversation, wherever you are */
  const openChatForItem = async (itemId) => {
    try {
      const d = await api("/chats", { token });
      setChats(d.chats);
      setChatUnread(d.unread);
      const c = d.chats.find((x) => x.itemId === itemId);
      if (c) {
        setChatId(c.id);
        setScreen("chat");
      } else {
        setScreen("chats");
      }
    } catch {
      setScreen("chats");
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
    if (!give.title.trim())
      next.title = give.wanted ? "Say what you're after — 'moving boxes' beats 'help'" : "Give it a name — 'Pine bookcase' beats 'stuff'";
    /* an ask has no doorstep, no condition, no fine to warn about */
    if (!give.wanted && !give.road.trim()) next.road = "Which road is it on?";
    if (!give.wanted && !give.address.trim()) next.address = "Only whoever claims it will see this";
    if (!give.wanted && !give.confirm) next.confirm = "This one's non-negotiable — pavement items risk a £1,000 fine";
    if (!give.wanted && !give.details.condition) next.condition = "What sort of condition is it in?";
    if (!give.wanted && give.type !== "food" && give.cat === "Furniture" && !give.details.width)
      next.width = "Roughly how wide is it? It's the first thing anyone asks about furniture";
    if (!give.wanted && give.type === "food") {
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
          details: give.details,
          road: give.road,
          address: give.address,
          windowMinutes: give.hours * 60,
          photos: give.photos,
          spot: give.spot,
          wanted: give.wanted,
          claimMode: give.claimMode,
          underCover: give.underCover,
          dibs: give.dibs,
          passFrom: give.passFrom,
        },
      });
      setItems((list) => [...list, created]);
      setGive(EMPTY_GIVE);
      setAutospec((a) => ({ ...a, done: false }));
      setScreen("home");
      setToast(
        give.wanted
          ? "Your ask is up. Anyone nearby with one can message you directly."
          : created.wishers > 0
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
            <input
              className="passport-line-input"
              type="text"
              maxLength={120}
              placeholder="Add a line to its story (optional)"
              value={storyLine}
              onChange={(e) => setStoryLine(e.target.value)}
            />
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
            <button
              className="sheet-cancel"
              onClick={() => {
                /* skipping the thanks shouldn't lose a line they bothered to write */
                sendStoryLine(thanking);
                setThanking(null);
              }}
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );

  /* ---------------- first-run pitch ---------------- */

  if (screen === "intro") {
    /* Leaving by any exit counts as having seen the pitch — skip, the final
       CTA, it makes no difference — because a pitch only lands on someone
       who has never met the app, and showing it twice spends goodwill. */
    const finishIntro = () => {
      localStorage.setItem("ds_seen_intro", "1");
      setScreen("home");
    };
    const goToSlide = (i) => {
      const rail = introRail.current;
      if (rail) rail.scrollTo({ left: i * rail.clientWidth, behavior: "smooth" });
    };
    const onLast = introSlide === INTRO_SLIDES.length - 1;
    return (
      <div className="ds-root">
        <div className="ds-phone on-auth">
          <StatusBar time={timeNow} />
          <div className="ds-frame">
            <div className="intro-wrap">
              <button className="intro-skip" onClick={finishIntro}>
                Skip
              </button>
              <div
                className="intro-rail"
                data-carousel="intro"
                ref={introRail}
                onScroll={(e) => {
                  /* the scroller itself is the source of truth for the dots,
                     so a thumb-swipe and a Next tap can never disagree */
                  const el = e.currentTarget;
                  setIntroSlide(Math.max(0, Math.min(INTRO_SLIDES.length - 1, Math.round(el.scrollLeft / el.clientWidth))));
                }}
              >
                {INTRO_SLIDES.map((s, i) => (
                  <section key={s.head} className="intro-slide" aria-label={`Slide ${i + 1} of ${INTRO_SLIDES.length}`}>
                    {s.art}
                    <h2>{s.head}</h2>
                    <p>{s.sub}</p>
                  </section>
                ))}
              </div>
              <div className="intro-foot">
                <div className="intro-dots">
                  {INTRO_SLIDES.map((s, i) => (
                    <button
                      key={s.head}
                      className={i === introSlide ? "here" : ""}
                      aria-label={`Go to slide ${i + 1}`}
                      aria-current={i === introSlide}
                      onClick={() => goToSlide(i)}
                    />
                  ))}
                </div>
                <button
                  className={`primary-btn intro-next ${onLast ? "" : "quiet"}`}
                  onClick={() => (onLast ? finishIntro() : goToSlide(introSlide + 1))}
                >
                  {onLast ? "Show me what's going" : "Next"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
                  <div className="pc-row">
                    <input
                      id="ds-postcode"
                      value={form.postcode}
                      onChange={(e) => {
                        set("postcode")(e);
                        /* changing the postcode invalidates whatever was found for the old one */
                        setAddr({ state: "idle", road: null, options: [], picked: null, house: "", city: "", county: "", country: "" });
                      }}
                      onKeyDown={(e) => e.key === "Enter" && findAddress()}
                      placeholder="E8 3EP"
                      autoComplete="postal-code"
                    />
                    <button className="pc-find" onClick={findAddress} disabled={addr.state === "looking"}>
                      {addr.state === "looking" ? "Looking…" : "Find address"}
                    </button>
                  </div>
                  {errors.postcode && <p className="field-note">{errors.postcode}</p>}

                  {/* a licensed lookup gave us the actual houses */}
                  {addr.state === "choose" && !addr.picked && (
                    <div className="addr-picker">
                      <p className="addr-lede">Pick your address</p>
                      <div className="addr-list">
                        {addr.options.map((o) => (
                          <button key={o.id} className="addr-opt" onClick={() => setAddr((a) => ({ ...a, picked: o }))}>
                            {o.line}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* no licensed lookup: verified postcode, the street we found,
                      and they add the bit only they can tell us */}
                  {addr.state === "street" && (
                    <div className="addr-picker">
                      <p className="addr-lede">
                        {addr.road ? (
                          <>
                            That's <b>{addr.road}</b>. Which number?
                          </>
                        ) : (
                          "Postcode found. What's your house number or name?"
                        )}
                      </p>
                      <input
                        className="addr-house"
                        value={addr.house}
                        onChange={(e) => setAddr((a) => ({ ...a, house: e.target.value }))}
                        placeholder="42, or Flat 3"
                        autoComplete="address-line1"
                      />
                    </div>
                  )}

                  {(addr.state === "street" || addr.state === "choose") && (
                    <div className="place-grid">
                      <div className="field">
                        <label htmlFor="ds-city">City</label>
                        <input id="ds-city" value={addr.city} onChange={(e) => setAddr((a) => ({ ...a, city: e.target.value }))} autoComplete="address-level2" />
                      </div>
                      <div className="field">
                        <label htmlFor="ds-county">County</label>
                        <input id="ds-county" value={addr.county} onChange={(e) => setAddr((a) => ({ ...a, county: e.target.value }))} autoComplete="address-level1" />
                      </div>
                      <div className="field">
                        <label htmlFor="ds-country">Country</label>
                        <input id="ds-country" value={addr.country} onChange={(e) => setAddr((a) => ({ ...a, country: e.target.value }))} autoComplete="country-name" />
                      </div>
                    </div>
                  )}

                  {(addr.picked || (addr.state === "street" && addr.house.trim())) && (
                    <p className="addr-done">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      {addressLine()}
                      {addr.picked && (
                        <button className="addr-change" onClick={() => setAddr((a) => ({ ...a, picked: null }))}>
                          change
                        </button>
                      )}
                    </p>
                  )}

                  <p className="addr-why">
                    Only used to fill in your address when you give something away. Neighbours never see it
                    until you've handed something over.
                  </p>
                </div>
              )}

              <div className={`field ${errors.password ? "bad" : ""}`}>
                <label htmlFor="ds-password">Password</label>
                <div className="pw-wrap">
                  <input id="ds-password" type={showPw ? "text" : "password"} value={form.password} onChange={set("password")} onKeyDown={onKey} placeholder={signup ? "At least 8 characters" : "Your password"} autoComplete={signup ? "new-password" : "current-password"} />
                  <button type="button" className="pw-eye" aria-label={showPw ? "Hide password" : "Show password"} aria-pressed={showPw} onClick={() => setShowPw((v) => !v)}>
                    {showPw ? <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.6 10.6 0 0 1 12 19c-6.5 0-10-7-10-7a17.7 17.7 0 0 1 4.1-4.9M9.9 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17.8 17.8 0 0 1-2.2 3.1" /><path d="M3 3l18 18" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg> : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>}
                  </button>
                </div>
                {errors.password && <p className="field-note">{errors.password}</p>}
              </div>

              {signup && (
                <div className={`field ${errors.confirm ? "bad" : ""}`}>
                  <label htmlFor="ds-confirm">Confirm password</label>
                  <div className="pw-wrap">
                  <input
                    id="ds-confirm"
                    type={showPw2 ? "text" : "password"}
                    value={form.confirm}
                    onChange={set("confirm")}
                    onKeyDown={onKey}
                    placeholder="Type it again"
                    autoComplete="new-password"
                  />
                  <button type="button" className="pw-eye" aria-label={showPw2 ? "Hide password" : "Show password"} aria-pressed={showPw2} onClick={() => setShowPw2((v) => !v)}>
                    {showPw2 ? <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.6 10.6 0 0 1 12 19c-6.5 0-10-7-10-7a17.7 17.7 0 0 1 4.1-4.9M9.9 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17.8 17.8 0 0 1-2.2 3.1" /><path d="M3 3l18 18" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg> : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>}
                  </button>
                  </div>
                  {errors.confirm && <p className="field-note">{errors.confirm}</p>}
                  {!errors.confirm && form.confirm && form.confirm === form.password && form.password.length >= 8 && (
                    <p className="field-ok">Passwords match</p>
                  )}
                </div>
              )}

              {signup && (
                <label className={`consent-row ${errors.privacy ? "bad" : ""}`}>
                  <input
                    type="checkbox"
                    checked={acceptPolicy}
                    onChange={(e) => {
                      setAcceptPolicy(e.target.checked);
                      setErrors((prev) => (prev.privacy ? { ...prev, privacy: null } : prev));
                    }}
                  />
                  <span>
                    I've read the{" "}
                    <button type="button" className="policy-link" onClick={() => setScreen("privacy")}>
                      privacy policy
                    </button>{" "}
                    — what Doorstep holds about me, and why
                  </span>
                </label>
              )}
              {signup && errors.privacy && <p className="field-note">{errors.privacy}</p>}

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

                {(() => {
                  const rows = fieldsFor(item.type, item.cat)
                    .map((f) => ({ label: f.label, value: item.details && item.details[f.key] }))
                    .filter((r) => r.value !== undefined && r.value !== "" && r.value !== null)
                    .map((r) => ({ ...r, value: typeof r.value === "number" ? `${r.value} cm` : r.value }));

                  const size = ["width", "depth", "height"]
                    .map((k) => item.details && item.details[k])
                    .filter(Boolean);

                  if (!rows.length) return null;
                  return (
                    <div className="spec">
                      <p className="sub-head">Details</p>
                      {size.length >= 2 && (
                        <div className="spec-row spec-size">
                          <span>Size</span>
                          <b>{size.join(" x ")} cm</b>
                        </div>
                      )}
                      {rows
                        .filter((r) => !(size.length >= 2 && ["Width", "Depth", "Height"].includes(r.label)))
                        .map((r) => (
                          <div className="spec-row" key={r.label}>
                            <span>{r.label}</span>
                            <b>{r.value}</b>
                          </div>
                        ))}
                    </div>
                  );
                })()}

                {item.passport && (
                  <div className="passport-card">
                    <span className="passport-stamp" aria-hidden="true">
                      {/* a hand-drawn stamp: a circle with a leaf, the mark of a thing still in use */}
                      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="16" cy="16" r="13" />
                        <circle cx="16" cy="16" r="10.4" strokeDasharray="2.2 2.6" strokeWidth="1" />
                        <path d="M16 22c-3.4-1.6-5-4.2-5-7 0-2.4 1.8-4.6 5-5.6 3.2 1 5 3.2 5 5.6 0 2.8-1.6 5.4-5 7Z" />
                        <path d="M16 22v-8" strokeWidth="1.2" />
                      </svg>
                    </span>
                    <div className="passport-lines">
                      <b>{ordinal(item.passport.homes)} home</b>
                      <span>First shared on Doorstep in {monthYear(item.passport.firstSharedAt)}</span>
                      {item.passport.notes.length > 0 && (
                        <ul className="passport-notes">
                          {item.passport.notes.map((n, i) => (
                            <li key={i}>&ldquo;{n.body}&rdquo;</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}

                {item.giver && !item.owner && (
                  <div className="giver-card">
                    <span className="giver-avatar">{item.giver.name.slice(0, 1).toUpperCase()}</span>
                    <span className="giver-lines">
                      <b>
                        {item.giver.name}
                        {item.giver.area && <em className="giver-area"> · {item.giver.area}</em>}
                      </b>
                      <small>
                        {item.giver.stars != null && (
                          <span className="giver-stars">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" /></svg>
                            {item.giver.stars} ({item.giver.rated}) ·{" "}
                          </span>
                        )}
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
                    <button
                      className={`follow-btn${item.giver.following ? " following" : ""}`}
                      aria-pressed={Boolean(item.giver.following)}
                      onClick={() => toggleFollow(item)}
                    >
                      {item.giver.following ? "Following ✓" : "Follow"}
                    </button>
                  </div>
                )}

                <div className="meter-row detail-meter">
                  <span className="meter-time">{formatLeft(item.expiresAt - now)}</span>
                  <div className="meter-track">
                    <div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, ((item.expiresAt - now) / item.windowMs) * 100))}%` }} />
                  </div>
                </div>

                {item.owner && item.claimMode === "fair" && item.status !== "taken" && hands.length > 0 && (
                  <div className="hands-panel">
                    <p className="sub-head">{hands.length === 1 ? "One hand up" : `${hands.length} hands up`} — you pick</p>
                    {hands.map((h) => (
                      <div key={h.userId} className="hand-row">
                        <span className="hand-copy">
                          <b>
                            {h.name}
                            {h.area && <em> · {h.area}</em>}
                          </b>
                          <small>
                            {[h.miles, h.collected > 0 ? `${h.collected} collected` : "first collection", h.stars != null ? `★ ${h.stars}` : null]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        </span>
                        <button
                          className="hand-pick"
                          onClick={async () => {
                            try {
                              await api(`/items/${item.id}/pick`, { method: "POST", token, body: { userId: h.userId } });
                              setToast(`${h.name} gets it — they've been told, and the thread is open.`);
                              setHands([]);
                              refresh();
                            } catch (e) {
                              setToast(e.message);
                            }
                          }}
                        >
                          Pick
                        </button>
                      </div>
                    ))}
                  </div>
                )}

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

                {/* One trip: while the hold is yours, anything else live on the
                    same doorstep can join the walk — one knock instead of two. */}
                {mine &&
                  (() => {
                    const more = items
                      .filter(
                        (i) =>
                          i.giver && item.giver && i.giver.id === item.giver.id && i.status === "live" && !i.owner && !i.wanted && i.id !== item.id
                      )
                      .slice(0, 3);
                    if (!more.length) return null;
                    return (
                      <div className="trip-panel">
                        <p className="sub-head">Make it one trip</p>
                        <p className="trip-blurb">
                          {item.giver.name} has more waiting on the same doorstep — add it to this walk.
                        </p>
                        {more.map((i) => (
                          <div className="trip-row" key={i.id}>
                            {pictureOf(i) ? (
                              <img className="trip-thumb" src={pictureOf(i)} alt="" />
                            ) : (
                              <span className="trip-thumb trip-thumb-glyph" aria-hidden="true">
                                <Glyph kind={i.kind} size={28} />
                              </span>
                            )}
                            <span className="trip-copy">
                              <b>{i.title}</b>
                              <small>{i.cat}</small>
                            </span>
                            <button className="trip-add" onClick={() => bundle(item, i)}>
                              Add
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                {item.owner && !item.wanted && item.status !== "taken" && (
                  <button
                    className="ghost-btn rain-btn"
                    onClick={async () => {
                      try {
                        const d = await api(`/items/${item.id}/raincheck`, { method: "POST", token });
                        setToast(
                          `Rain check called — back out until ${new Date(d.until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Savers have been told.`
                        );
                        refresh();
                      } catch (e) {
                        setToast(e.message);
                      }
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 16.6A5 5 0 0 0 18 7h-1.3A7 7 0 1 0 5 15.3" /><path d="M8 19v2M12 20v2M16 19v2" /></svg>
                    Rain check — push it back two hours
                  </button>
                )}

                {item.wanted && !item.owner && (
                  <div className="claim-dock">
                    <span className="claim-left">
                      <b>{formatLeft(item.expiresAt - now)}</b>
                      <small>ask still open</small>
                    </span>
                    <button
                      className="primary-btn claim-cta"
                      onClick={async () => {
                        if (needsAccount("Sign in to offer yours", { action: "detail" })) return;
                        try {
                          const d = await api(`/items/${item.id}/offer`, { method: "POST", token });
                          setChatId(d.conversationId);
                          setScreen("chat");
                        } catch (e) {
                          setToast(e.message);
                        }
                      }}
                    >
                      I have one — message {item.giver ? item.giver.name : "them"}
                    </button>
                  </div>
                )}
                {!item.wanted && !mine && !item.owner && !(item.dibsOpensAt > now) && item.claimMode === "fair" && item.status !== "taken" && (
                  <div className="claim-dock">
                    <span className="claim-left">
                      <b>{formatLeft(item.expiresAt - now)}</b>
                      <small>{item.hands === 1 ? "1 hand up" : `${item.hands || 0} hands up`}</small>
                    </span>
                    <button className="primary-btn claim-cta" disabled={item.handUp} onClick={() => claim(item)}>
                      {item.handUp ? "Your hand's up — giver picks" : "Put my hand up"}
                    </button>
                  </div>
                )}
                {!item.wanted && !mine && !item.owner && item.dibsOpensAt > now && item.status !== "taken" && (
                  <div className="claim-dock">
                    <span className="claim-left">
                      <b>{formatLeft(item.dibsOpensAt - now)}</b>
                      <small>street's dibs first</small>
                    </span>
                    <button className="primary-btn claim-cta" disabled>
                      Opens to you at {new Date(item.dibsOpensAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    </button>
                  </div>
                )}
                {!item.wanted && !mine && !item.owner && !(item.dibsOpensAt > now) && !(item.claimMode === "fair" && item.status !== "taken") && (
                  <div className="claim-dock">
                    <span className="claim-left">
                      <b className={item.expiresAt - now < 15 * 60 * 1000 ? "urgent" : ""}>{formatLeft(item.expiresAt - now)}</b>
                      <small>{taken ? "someone got there first" : item.lastOrders ? "last orders — exact pin's on the map" : "left to claim"}</small>
                    </span>
                    <button className="primary-btn claim-cta" disabled={taken} onClick={() => claim(item)}>
                      {taken ? "Already claimed" : "Claim it — free"}
                    </button>
                  </div>
                )}
                {mine && (
                  <>
                    {/* Keyed by item so a fresh claim always starts with the thumb at rest. */}
                    <SlideToCollect key={item.id} onConfirm={() => collected(item)} />
                    <button className="ghost-btn" onClick={() => openChatForItem(item.id)}>
                      Message {item.giver ? item.giver.name : "the giver"}
                    </button>
                    <button className="ghost-btn" onClick={() => release(item)}>
                      Can't make it — hand it back
                    </button>
                  </>
                )}
                {item.owner && item.status === "taken" && (
                  <button className="ghost-btn" onClick={() => openChatForItem(item.id)}>
                    Message the collector
                  </button>
                )}

                <p className="detail-rule">
                  {item.owner
                    ? "It's live from your own property — never the pavement."
                    : "It'll be on the giver's own property. Exact address appears when you claim."}
                </p>

                {(() => {
                  const live = items.filter((i) => i.id !== item.id && i.expiresAt > now && i.status !== "taken" && !i.owner);
                  /* Everything else this giver has live right now. Seeing a
                     giver's other listings turns one collection trip into two,
                     which is why this rail sits above the general one. */
                  const fromGiver = live
                    .filter((i) => i.giver && item.giver && i.giver.id === item.giver.id)
                    .sort((a, b) => a.expiresAt - b.expiresAt)
                    .slice(0, 4);
                  const giverIds = new Set(fromGiver.map((i) => i.id));
                  /* The general rail must not repeat anything already shown in
                     the giver rail, or the page looks like it's stuttering. */
                  const also = live
                    .filter((i) => !giverIds.has(i.id))
                    .sort((a, b) => (a.cat === item.cat ? -1 : 1) - (b.cat === item.cat ? -1 : 1) || a.expiresAt - b.expiresAt)
                    .slice(0, 4);
                  /* Both rails share the same gcard so the styling stays in step. */
                  const rail = (list) =>
                    list.map((a) => (
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
                    ));
                  if (!fromGiver.length && !also.length) return null;
                  return (
                    <>
                      {fromGiver.length > 0 && (
                        <div className="also">
                          <p className="sub-head">More from {item.giver.name.split(" ")[0]}</p>
                          <div className="item-grid">{rail(fromGiver)}</div>
                        </div>
                      )}
                      {also.length > 0 && (
                        <div className="also">
                          <p className="sub-head">Also going near you</p>
                          <div className="item-grid">{rail(also)}</div>
                        </div>
                      )}
                    </>
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
                    <button
                      className="quiet"
                      onClick={() => {
                        /* relist it with the link back to this collection, so the
                           two listings join into one passport — the composer keeps
                           the doorstep details already on file */
                        setGive((g) => ({
                          ...EMPTY_GIVE,
                          title: it.title,
                          cat: it.cat,
                          passFrom: it.id,
                          address: g.address,
                          road: g.road,
                          spot: g.spot,
                        }));
                        setScreen("give");
                      }}
                    >
                      Pass it on
                    </button>
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
                      <>
                        <button
                          onClick={async () => {
                            try {
                              await api(`/items/${it.id}/relist`, { method: "POST", token });
                              setToast("Back up for another window. Wishers have been told.");
                              api("/me/stuff", { token }).then(setStuff).catch(() => {});
                              refresh();
                            } catch (e) {
                              setToast(e.message);
                            }
                          }}
                        >
                          Put it back up
                        </button>
                        <button className="quiet" onClick={() => openFallback(it)}>
                          What now?
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
          </>
        )}

        {tab === "wishes" && wishPanel}
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
        {notes.map((n) => {
          /* what kind of news this is, told from the words themselves */
          const isThanks = /thank|star/i.test(n.body) && !/wish/i.test(n.body);
          const isWish = /wish list|claim it before/i.test(n.body);
          return (
            <button
              key={n.id}
              className={`note-row ${n.read ? "" : "unread"}`}
              onClick={() => {
                setDetailId(n.itemId);
                setScreen("detail");
              }}
            >
              <span className={`note-ic ${isThanks ? "thanks" : isWish ? "wish" : "plain"}`} aria-hidden="true">
                {isThanks ? (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 20.5S3.5 15 3.5 9.2A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 8.5 2.2c0 5.8-8.5 11.3-8.5 11.3Z" /></svg>
                ) : isWish ? (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5z" /></svg>
                ) : (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
                )}
              </span>
              <span className="note-body">
                <b>{n.title}</b>
                <p>{n.body}</p>
              </span>
              <span className="note-when">{agoLabel(Math.max(1, Math.round((Date.now() - n.createdAt) / 60000)))}</span>
            </button>
          );
        })}
        <button className="ghost-btn" onClick={() => setScreen("wishes")}>
          Manage your wish list
        </button>
      </SubScreen>
    );
  }

  /* ---------------- messages ---------------- */

  if (screen === "chats") {
    const shown = chats.filter((c) =>
      chatTab === "unread" ? c.unread > 0 : chatTab === "sent" ? c.lastMine : true
    );
    const when = (ms) => {
      const d = new Date(ms);
      const today = new Date().toDateString() === d.toDateString();
      if (today) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      const days = Math.round((Date.now() - ms) / 86400000);
      if (days === 1) return "yesterday";
      if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    };

    return (
      <SubScreen title="Chats" time={timeNow} toast={toast} onBack={() => setScreen("home")}>
        <div className="chat-tabs" role="tablist" aria-label="Filter conversations">
          {[
            { k: "all", label: "All" },
            { k: "unread", label: `Unread${chatUnread > 0 ? ` (${chatUnread > 9 ? "9+" : chatUnread})` : ""}` },
            { k: "sent", label: "Sent" },
          ].map((t) => (
            <button key={t.k} role="tab" aria-selected={chatTab === t.k} onClick={() => setChatTab(t.k)}>
              {t.label}
            </button>
          ))}
        </div>

        {shown.length === 0 && (
          <div className="wish-empty">
            <img src={`${API}/photos/armchair`} alt="" />
            <b>{chatTab === "unread" ? "Nothing unread" : chatTab === "sent" ? "Nothing waiting on a reply" : "No conversations yet"}</b>
            <span>
              {chatTab === "all"
                ? "Claim something, or have something claimed, and the thread to arrange the handover starts itself."
                : "All caught up. That's the good kind of empty."}
            </span>
          </div>
        )}

        {shown.map((c) => (
          <button
            key={c.id}
            className={`chat-row ${c.unread > 0 ? "unread" : ""}`}
            onClick={() => {
              setChatId(c.id);
              setScreen("chat");
            }}
          >
            <span className="chat-pic">
              {c.photoRef || c.photo ? (
                <img src={c.photo || `${API}/photos/${c.photoRef}`} alt="" loading="lazy" />
              ) : (
                <span className="chat-initial">{c.with.slice(0, 1).toUpperCase()}</span>
              )}
              <i className={`chat-role ${c.role}`} aria-hidden="true">
                {c.role === "giving" ? "↑" : "↓"}
              </i>
            </span>
            <span className="chat-lines">
              <b>
                {c.with}
                <em> · {c.title}</em>
              </b>
              <small className={c.unread > 0 ? "loud" : ""}>
                {c.lastMine ? "You: " : ""}
                {c.lastBody.length > 52 ? `${c.lastBody.slice(0, 52)}…` : c.lastBody}
              </small>
            </span>
            <span className="chat-side">
              <small className={c.unread > 0 ? "loud" : ""}>{when(c.lastAt)}</small>
              {c.unread > 0 ? <i className="chat-dot">{c.unread}</i> : c.done ? <i className="chat-done" aria-label="Handover complete">✓</i> : null}
            </span>
          </button>
        ))}
      </SubScreen>
    );
  }

  if (screen === "chat") {
    const sendMsg = async (text) => {
      const body = (text || draft).trim();
      if (!body || !thread) return;
      setDraft("");
      /* optimistic: the words appear as they're said */
      setThread((t) => ({ ...t, messages: [...t.messages, { id: `tmp-${Date.now()}`, mine: true, body, createdAt: Date.now() }] }));
      try {
        await api(`/chats/${thread.id}`, { method: "POST", token, body: { body } });
      } catch (e) {
        setToast(e.message);
      }
    };
    const QUICK = thread && thread.role === "collecting"
      ? ["On my way now", "Running 10 minutes late — still coming", "Which house number is it?", "Got it — thank you!"]
      : ["It's outside the front door", "No rush — it'll be there", "Buzz flat when you arrive", "Glad it's going to a good home"];

    return (
      <SubScreen
        title={thread ? `${thread.with} · ${thread.title.length > 18 ? `${thread.title.slice(0, 18)}…` : thread.title}` : "Messages"}
        time={timeNow}
        toast={toast}
        onBack={() => {
          setScreen("chats");
          setThread(null);
          setChatId(null);
        }}
      >
        {thread && (
          <div className="chat-thread">
            {thread.address && (
              <p className="chat-address">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z" /><circle cx="12" cy="10" r="3" /></svg>
                {thread.address}
              </p>
            )}

            <div className="chat-scroll">
              {thread.messages.map((m) =>
                m.system ? (
                  <p key={m.id} className="msg-system">{m.body}</p>
                ) : (
                  <p key={m.id} className={`msg ${m.mine ? "mine" : ""}`}>{m.body}</p>
                )
              )}
              <span ref={chatEnd} />
            </div>

            {thread.canRate && (
              <div className="rate-strip">
                <b>How did the handover go?</b>
                <span className="rate-stars">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      aria-label={`${n} star${n === 1 ? "" : "s"}`}
                      onClick={async () => {
                        try {
                          await api(`/items/${thread.itemId}/rate`, { method: "POST", token, body: { stars: n } });
                          setThread((t) => ({ ...t, canRate: false }));
                          setToast(n >= 4 ? "Stars given. Good neighbours get known." : "Noted — thanks for being honest.");
                        } catch (e) {
                          setToast(e.message);
                        }
                      }}
                    >
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" /></svg>
                    </button>
                  ))}
                </span>
              </div>
            )}

            <div className="quick-row">
              {QUICK.map((qr) => (
                <button key={qr} className="quick-chip" onClick={() => sendMsg(qr)}>
                  {qr}
                </button>
              ))}
            </div>

            <div className="composer">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMsg()}
                placeholder="Message…"
                aria-label="Message"
                maxLength={500}
              />
              <button className="send-btn" aria-label="Send" disabled={!draft.trim()} onClick={() => sendMsg()}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></svg>
              </button>
            </div>
          </div>
        )}
      </SubScreen>
    );
  }

  /* ---------------- saved searches ---------------- */

  if (screen === "wishes") {
    return (
      <SubScreen title="Wish list" time={timeNow} toast={toast} onBack={() => setScreen("home")}>
        {wishPanel}
      </SubScreen>
    );
  }

  /* ---------------- privacy ---------------- */

  if (screen === "privacy") {
    return (
      <SubScreen title="Privacy" time={timeNow} toast={toast} onBack={() => setScreen(token ? "profile" : "auth")}>
        <div className="policy">
          <p className="sub-lede">
            Written to be read, not scrolled past. This is everything Doorstep holds about you, why it
            holds it, and who else is involved. Doorstep is operated by TwelveTech Systems Limited.
          </p>

          <p className="sub-head">What we collect, and why</p>
          <p>
            <b>Your name.</b> Neighbours see your first name only — on your listings, in the
            arrangement thread, and beside your record.
          </p>
          <p>
            <b>Your email address.</b> Used to sign you in and for nothing else. It is never shown to
            neighbours and never sold or shared for marketing.
          </p>
          <p>
            <b>Your password.</b> Stored only as a salted scrypt hash. We cannot read it, and neither
            can anyone who steals the database.
          </p>
          <p>
            <b>Your postcode, and the address you give at signup.</b> Your postcode becomes coordinates
            so distances are honest. Your house number and street are shown to exactly one person: a
            neighbour who has claimed something from you, for the half hour they are on their way.
            Everyone else sees your area ("London Fields") and a map pin blurred to roughly a street
            block. In the final half hour of an unclaimed listing the pin sharpens so passers-by can
            find it — the written address stays hidden even then. City, county and country are kept so
            your address is complete when it is shown to a claimer.
          </p>
          <p>
            <b>What you list, wish for, save, spot and say.</b> Listings and their photos, your wish
            list, saved items, kerbside piles you post, messages in arrangement threads, ratings you
            give and receive, thank-yous, follows, and reports or blocks you make. This is the product
            working, not profiling: none of it is used for advertising, and there is no advertising.
          </p>
          <p>
            <b>What we work out.</b> Distances between you and listings, your given and collected
            counts, badges, no-show strikes, and the neighbourhood's waste-diversion figures — all
            derived from the activity above.
          </p>

          <p className="sub-head">Who else touches the data</p>
          <p>
            The database is hosted by <b>Supabase</b>, the API by <b>Render</b>, and the web app by{" "}
            <b>Vercel</b> — they store and move the data on our instructions and for no purpose of
            their own. Your postcode alone is sent to <b>postcodes.io</b> to find its coordinates;
            coordinates alone go to <b>OpenStreetMap's Nominatim</b> to name your street and to{" "}
            <b>Open-Meteo</b> to check for rain. If photo auto-fill is enabled, the photo you take is
            sent to <b>Anthropic</b> to draft the listing and is not used to train models. No analytics
            trackers, no ad networks, no data brokers.
          </p>

          <p className="sub-head">How long we keep it</p>
          <p>
            While your account exists. Arrangement threads close 48 hours after a handover and their
            purpose ends with them. Notifications age out of view after your most recent forty.
          </p>

          <p className="sub-head">Your rights</p>
          <p>
            Under UK GDPR you can have a copy of everything (<b>Download my data</b>, on your profile —
            it arrives as a file, immediately), and you can leave (<b>Delete my account</b>, same
            place). Deletion is immediate and real: your name becomes "Former neighbour", your email,
            address and coordinates are erased, your sessions are revoked, and your wishes, messages,
            saves and follows are deleted. Collected items stay counted — anonymously — so the
            neighbourhood's diversion figures stay true, and any line you added to an item's story
            stays with the item, without your name. You can also complain to the ICO
            (ico.org.uk) — though we would rather you told us first.
          </p>

          <p className="sub-head">Questions</p>
          <p>
            Contact TwelveTech Systems Limited through the email address on our app-store listing.
            This policy changes only when the app's behaviour changes, and the signup screen always
            links to the current version.
          </p>
        </div>
      </SubScreen>
    );
  }

  /* ---------------- the demand radar ---------------- */

  if (screen === "radar") {
    return (
      <SubScreen title="What neighbours want" time={timeNow} toast={toast} onBack={() => setScreen("profile")}>
        <p className="sub-lede">
          What people near you are already waiting for. List one of these and someone gets told the
          second it goes up — no waiting, no hoping.
        </p>
        {wants.length === 0 && (
          <div className="wish-empty">
            <img src={`${API}/photos/houseplant`} alt="" />
            <b>Quiet on the radar</b>
            <span>No wishes are pointed at your doorstep just now. It changes daily — worth a look back.</span>
          </div>
        )}
        {wants.map((w) => (
          <div key={w.label} className="want-row">
            <span className="want-copy">
              <b>{w.label}</b>
              <small>
                {w.count === 1 ? "One neighbour nearby is" : `${w.count} neighbours nearby are`} waiting for this
              </small>
            </span>
            <button
              className="want-give"
              onClick={() => {
                /* straight into the composer with the want already named */
                setGive((g) => ({
                  ...EMPTY_GIVE,
                  title: w.label.startsWith("anything in") ? "" : w.label,
                  cat: w.cat !== "Anything" ? w.cat : g.cat,
                  address: g.address,
                  road: g.road,
                  spot: g.spot,
                }));
                setScreen("give");
              }}
            >
              I have one
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
              <div className="profile-hero">
                <div className="avatar" aria-hidden="true">
                  {initials}
                  <span className="avatar-dot" />
                </div>
                <h1 className="profile-name">{user ? user.name : ""}</h1>
                <p className="profile-meta">{user ? user.email : ""}</p>
                  <p className="profile-meta">
                  {user && user.area ? `${user.area} · ` : ""}
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

              {badges.length > 0 && (
                <div className="badge-shelf">
                  <p className="sub-head">Badges</p>
                  {badges.map((b) => (
                    <div key={b.track} className={`badge-row ${b.current ? "earned" : ""}`}>
                      <span className="badge-medal" aria-hidden="true">
                        {b.track === "given" ? (
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12v9H4v-9" /><path d="M2 7h20v5H2z" /><path d="M12 22V7" /><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" /><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" /></svg>
                        ) : b.track === "collected" ? (
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></svg>
                        ) : (
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 20.5S3.5 15 3.5 9.2A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 8.5 2.2c0 5.8-8.5 11.3-8.5 11.3Z" /></svg>
                        )}
                      </span>
                      <span className="badge-copy">
                        <b>{b.current || b.next.label}</b>
                        {b.next ? (
                          <small>
                            {b.next.have} of {b.next.need} to {b.current ? b.next.label.toLowerCase() : "earn it"}
                          </small>
                        ) : (
                          <small>The whole ladder — there's nothing above this</small>
                        )}
                      </span>
                      {b.next && (
                        <span className="badge-track" aria-hidden="true">
                          <i style={{ width: `${Math.round((b.next.have / b.next.need) * 100)}%` }} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="rule-card">
                <p className="rule-title">The one rule</p>
                <p className="rule-body">
                  Items wait on your own property — doorstep, garden, porch or lobby.
                  Never the pavement.
                </p>
              </div>

              <div className="profile-links">
                <button onClick={() => setScreen("chats")}>
                  <span className="link-ic" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                  </span>
                  <span className="link-copy">
                    Messages
                    <span>Arrange handovers with your neighbours</span>
                  </span>
                  {chatUnread > 0 ? <span className="link-badge">{chatUnread > 9 ? "9+" : chatUnread}</span> : <span className="link-go" aria-hidden="true">›</span>}
                </button>
                <button onClick={() => { setTab("toCollect"); setScreen("mine"); }}>
                  <span className="link-ic" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></svg>
                  </span>
                  <span className="link-copy">
                    Your things
                    <span>To collect, collected, given, and your wish list</span>
                  </span>
                  <span className="link-go" aria-hidden="true">›</span>
                </button>
                <button onClick={() => setScreen("wishes")}>
                  <span className="link-ic" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20.5S3.5 15 3.5 9.2A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 8.5 2.2c0 5.8-8.5 11.3-8.5 11.3Z" /></svg>
                  </span>
                  <span className="link-copy">
                    Add a wish
                    <span>Get told the moment someone lists what you want</span>
                  </span>
                  <span className="link-go" aria-hidden="true">›</span>
                </button>
                <button onClick={() => setScreen("radar")}>
                  <span className="link-ic" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5" /></svg>
                  </span>
                  <span className="link-copy">
                    What neighbours want
                    <span>The wishes pointed at your doorstep — list one, make a day</span>
                  </span>
                  <span className="link-go" aria-hidden="true">›</span>
                </button>
                <button onClick={() => setScreen("impact")}>
                  <span className="link-ic" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18M5.5 12.5L12 19l6.5-6.5" /></svg>
                  </span>
                  <span className="link-copy">
                    What it adds up to
                    <span>Items rehomed, waste diverted, cost avoided</span>
                  </span>
                  <span className="link-go" aria-hidden="true">›</span>
                </button>
              </div>

              <button
                className={`away-toggle ${user && user.away ? "on" : ""}`}
                onClick={async () => {
                  const next = !(user && user.away);
                  try {
                    await api("/me", { method: "PATCH", token, body: { away: next } });
                    setUser((u) => ({ ...u, away: next }));
                    setToast(next ? "Away mode on — your listings are hidden until you're back." : "Welcome back — your listings are visible again.");
                    refresh();
                  } catch (e) {
                    setToast(e.message);
                  }
                }}
              >
                <span className="link-copy">
                  Away mode
                  <span>{user && user.away ? "On — your listings are hidden" : "Hide your listings while you're away"}</span>
                </span>
                <span className={`switch ${user && user.away ? "on" : ""}`} aria-hidden="true" />
              </button>

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
                <button onClick={() => setScreen("privacy")}>
                  Privacy policy
                  <span>What we hold, why, and who else is involved — in plain words</span>
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

  /* ---------------- spotted a pile ---------------- */

  if (screen === "spot") {
    return (
      <SubScreen title="Spotted a pile?" time={timeNow} toast={toast} sheets={sheets} onBack={() => { setScreen("home"); setSpotErrors({}); }}>
        <p className="spot-intro">
          Someone's put a FREE pile out on the street. It isn't yours to promise to anyone — this just tells
          neighbours it's there, exactly where it is, for the next two hours.
        </p>

        <input ref={spotFileRef} type="file" accept="image/*" capture="environment" hidden onChange={onSpotPhoto} />
        <button
          className={`photo-box spot-photo ${spotForm.photo ? "has-photo" : ""}`}
          onClick={() => spotFileRef.current && spotFileRef.current.click()}
        >
          {spotForm.photo ? (
            <img src={spotForm.photo} alt="The pile" />
          ) : (
            <span className="photo-hint">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
              Photograph the pile
              <small>A picture is what gets people to walk over</small>
            </span>
          )}
        </button>
        {spotErrors.photo && <p className="field-note">{spotErrors.photo}</p>}

        <div className={`field ${spotErrors.note ? "bad" : ""}`}>
          <label htmlFor="sp-note">What's there</label>
          <input
            id="sp-note"
            value={spotForm.note}
            maxLength={140}
            onChange={(e) => {
              const v = e.target.value;
              setSpotForm((f) => ({ ...f, note: v }));
              setSpotErrors((p) => (p.note || p._form ? { ...p, note: null, _form: null } : p));
            }}
            placeholder="Box of books and a lamp, outside the church"
          />
          {spotErrors.note && <p className="field-note">{spotErrors.note}</p>}
        </div>

        <div className="field">
          <label htmlFor="sp-road">Which road</label>
          <input
            id="sp-road"
            value={spotForm.road}
            onChange={(e) => {
              const v = e.target.value;
              setSpotForm((f) => ({ ...f, road: v }));
            }}
            placeholder="Wilton Way, E8"
          />
        </div>

        <label className={`cover-row spot-confirm ${spotErrors.freeSign ? "bad" : ""}`}>
          <input
            type="checkbox"
            checked={spotForm.freeSign}
            onChange={(e) => {
              const v = e.target.checked;
              setSpotForm((f) => ({ ...f, freeSign: v }));
              setSpotErrors((p) => (p.freeSign ? { ...p, freeSign: null } : p));
            }}
          />
          <span>There's a FREE sign, or it's clearly a giveaway pile</span>
        </label>
        {spotErrors.freeSign && <p className="field-note">{spotErrors.freeSign}</p>}
        {spotErrors._form && <p className="field-note">{spotErrors._form}</p>}

        <button className="primary-btn" disabled={busy} onClick={submitSpot}>
          {busy ? "Posting…" : "Post it — 2 hours, then it's gone"}
        </button>
        <p className="spot-small-print">
          No claims, no holds — first come, first served. If it's actually someone's property, neighbours can flag
          it and it comes straight down.
        </p>
      </SubScreen>
    );
  }

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
              {!give.wanted && (
              <>
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
              </>
              )}

              <div className="field">
                <label>What's happening</label>
                <div className="type-pills" role="group" aria-label="Giving or asking">
                  {[
                    { v: "nonfood", label: "Giving away", wanted: false },
                    { v: "food", label: "Giving food", wanted: false },
                    { v: "nonfood", label: "I'm after it", wanted: true },
                  ].map((t) => (
                    <button
                      key={t.label}
                      className="type-pill"
                      aria-pressed={give.type === t.v && give.wanted === t.wanted}
                      onClick={() =>
                        setGive((g) => ({
                          ...g,
                          type: t.v,
                          wanted: t.wanted,
                          cat: catsFor(t.v)[0].cat,
                          hours: t.wanted ? 24 : t.v === "food" ? 4 : 2,
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

              {!give.wanted && (
              <>
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

              {!give.wanted && sky && (
                <div className="rain-note">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 16.6A5 5 0 0 0 18 7h-1.3A7 7 0 1 0 5 15.3" /><path d="M8 19v2M12 20v2M16 19v2" /></svg>
                  <span>
                    Rain looks likely from <b>{sky.from}</b> ({sky.prob}%). A shorter window, or somewhere under cover?
                  </span>
                </div>
              )}
              {!give.wanted && (
                <label className="cover-row">
                  <input
                    type="checkbox"
                    checked={give.underCover}
                    onChange={(e) => setGive((g) => ({ ...g, underCover: e.target.checked }))}
                  />
                  <span>It'll be under cover — porch, lobby or sheltered step</span>
                </label>
              )}
              {!give.wanted && (
                <label className="cover-row">
                  <input
                    type="checkbox"
                    checked={give.dibs}
                    onChange={(e) => setGive((g) => ({ ...g, dibs: e.target.checked }))}
                  />
                  <span>
                    My street gets first dibs — the first 15 minutes belong to neighbours within a quarter
                    mile, then it opens out
                  </span>
                </label>
              )}

              <div className="field">
                <label>Who gets it</label>
                <div className="chips" role="group" aria-label="Claim mode">
                  {[
                    { v: "instant", label: "First to claim" },
                    { v: "fair", label: "I'll pick — fair chance" },
                  ].map((m) => (
                    <button
                      key={m.v}
                      className="chip"
                      aria-pressed={give.claimMode === m.v}
                      onClick={() => setGive((g) => ({ ...g, claimMode: m.v }))}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                {give.claimMode === "fair" && (
                  <p className="safety-note">
                    Hands go up instead of a race. You'll see who's asking — how near, how reliable — and pick.
                  </p>
                )}
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

              </>
              )}

              {!give.wanted && (
              <div className="detail-fields">
                <p className="sub-head">The details people ask for</p>
                <p className="detail-hint">
                  Every one of these saves a message that this app deliberately doesn't have. Skip anything
                  that doesn't apply.
                </p>

                {fieldsFor(give.type, give.cat).map((f) => (
                  <div className="field" key={f.key}>
                    <label htmlFor={`gv-${f.key}`}>
                      {f.label}
                      {f.type === "cm" ? " (cm)" : ""}
                    </label>

                    {f.type === "choice" ? (
                      <div className="chips" role="group" aria-label={f.label}>
                        {f.options.map((o) => (
                          <button
                            key={o}
                            className="chip"
                            aria-pressed={give.details[f.key] === o}
                            onClick={() =>
                              setGive((g) => ({
                                ...g,
                                details: { ...g.details, [f.key]: g.details[f.key] === o ? "" : o },
                              }))
                            }
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <input
                        id={`gv-${f.key}`}
                        type={f.type === "cm" ? "number" : "text"}
                        inputMode={f.type === "cm" ? "numeric" : undefined}
                        value={give.details[f.key] || ""}
                        placeholder={f.type === "cm" ? "e.g. 80" : ""}
                        onChange={(e) =>
                          setGive((g) => ({ ...g, details: { ...g.details, [f.key]: e.target.value } }))
                        }
                      />
                    )}
                    {f.hint && <p className="detail-hint">{f.hint}</p>}
                  </div>
                ))}
              </div>

              )}

              {!give.wanted && (
              <>
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
              </>
              )}

              <div className="field">
                <label>{give.wanted ? "How long should the ask stay up" : "How long"}</label>
                <div className="chips" role="group" aria-label="Listing window">
                  {(give.wanted
                    ? [
                        { h: 24, label: "A day" },
                        { h: 48, label: "Two days" },
                        { h: 72, label: "Three days" },
                      ]
                    : give.type === "food"
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

              {!give.wanted && (
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
              )}
              {giveErrors.confirm && <p className="field-note">{giveErrors.confirm}</p>}

              {give.passFrom != null && (
                <p className="passport-passing">This one's getting its next home — its passport travels with it.</p>
              )}
              <button className="primary-btn" onClick={submitGive} disabled={busy}>
                {busy ? (give.wanted ? "Asking" : "Listing") : give.wanted ? "Put the ask up" : "Put it on the doorstep"}
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

          <div className="hero">
            <p className="hero-hi">{greeting(user && user.name)}</p>
            <h1 className="feed-head">
              {liveCount}{" "}
              {typeFilter === "food"
                ? `thing${liveCount === 1 ? "" : "s"} to eat near you`
                : `thing${liveCount === 1 ? "" : "s"} going near you`}
            </h1>
            <p className="feed-sub">Claim it, then collect from the doorstep.</p>

            <div className="search-wrap">
              <div className={`search-row ${hintsOpen && hints.length ? "open" : ""}`}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setHintsOpen(true);
                  }}
                  onFocus={() => setHintsOpen(true)}
                  onBlur={() => setTimeout(() => setHintsOpen(false), 140)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setHintsOpen(false);
                    if (e.key === "Enter") setHintsOpen(false);
                  }}
                  placeholder="What are you after?"
                  aria-label="Search items"
                  autoComplete="off"
                />
                {q && (
                  <button
                    className="search-clear"
                    aria-label="Clear search"
                    onClick={() => {
                      setQ("");
                      setHintsOpen(false);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>

              {hintsOpen && hints.length > 0 && (
                <ul className="hints" role="listbox" aria-label="Suggestions">
                  {hints.map((h, i) => (
                    <li key={`${h.kind}-${h.label}-${i}`}>
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          if (h.kind === "category") {
                            setQ("");
                            setFilter(h.label);
                          } else {
                            setQ(h.label);
                          }
                          setHintsOpen(false);
                        }}
                      >
                        {h.kind === "category" ? (
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <rect x="4" y="4" width="16" height="16" rx="3" />
                            <path d="M4 10h16" />
                          </svg>
                        ) : (
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                            <circle cx="11" cy="11" r="7" />
                            <path d="M21 21l-4.3-4.3" />
                          </svg>
                        )}
                        <span>{h.label}</span>
                        {h.kind === "category" ? (
                          <em>category</em>
                        ) : h.type === "food" ? (
                          <em className="food">food</em>
                        ) : (
                          <em>{h.cat}</em>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

          </div>

          <main className="feed">
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
                { c: "Going soonest", pic: null, label: "All" },
                ...(typeFilter === "food" ? FOOD_CATS : typeFilter === "nonfood" ? NONFOOD_CATS : [...NONFOOD_CATS, ...FOOD_CATS])
                  .slice(0, typeFilter === "all" ? 4 : 6)
                  .map((c) => ({ c: c.cat, pic: c.pic, label: c.cat })),
              ].map((c) => (
                <button
                  key={c.c}
                  className="cat-btn"
                  aria-pressed={filter === c.c}
                  onClick={() => setFilter(c.c)}
                >
                  <span className="cat-ring">
                    {c.pic ? (
                      <img src={`${API}/photos/${c.pic}`} alt="" loading="lazy" />
                    ) : (
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="8.5" />
                        <path d="M12 7.5V12l3 1.8" />
                      </svg>
                    )}
                  </span>
                  {c.label}
                </button>
              ))}
            </div>

            <div className="scroll-strip" data-carousel="controls">
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
                <button aria-pressed={false} aria-label="Map view" onClick={() => setScreen("map")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
                    <circle cx="12" cy="10" r="2.5" />
                  </svg>
                </button>
              </div>

              <button className="saved-toggle" aria-pressed={asksOnly} onClick={() => setAsksOnly((v) => !v)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 17h.01" />
                  <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.4-3 4" />
                  <circle cx="12" cy="12" r="9.2" />
                </svg>
                Asks
              </button>
              <button className="saved-toggle" aria-pressed={savedOnly} onClick={() => setSavedOnly((v) => !v)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill={savedOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                  <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
                </svg>
                Saved
              </button>
              <div className="segment" role="group" aria-label="Distance radius">
                {RADII.map((r) => (
                  <button
                    key={r.label}
                    aria-pressed={!customRadius && radius === r.v}
                    onClick={() => {
                      setCustomRadius(false);
                      setRadius(r.v);
                    }}
                  >
                    {r.label}
                  </button>
                ))}
                <button
                  aria-pressed={customRadius}
                  onClick={() => {
                    setCustomRadius(true);
                    if (!Number.isFinite(radius)) setRadius(3);
                  }}
                >
                  Set it
                </button>
              </div>
            </div>
            </div>

            {customRadius && (
              <div className="radius-set">
                <label htmlFor="radius-slider">
                  Within <b>{radius < 1 ? `${Math.round(radius * 1760)} yards` : `${radius} miles`}</b>
                </label>
                <input
                  id="radius-slider"
                  type="range"
                  min="0.25"
                  max="10"
                  step="0.25"
                  value={Number.isFinite(radius) ? radius : 3}
                  onChange={(e) => setRadius(Number(e.target.value))}
                />
                <span className="radius-ends">
                  <em>quarter mile</em>
                  <em>10 miles</em>
                </span>
              </div>
            )}

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
                  {feed.elsewhere > 0
                    ? `Nothing within ${radius === 0.5 ? "half a mile" : `${radius} miles`} of you`
                    : q.trim()
                      ? `Nothing matching "${q.trim()}" just now`
                      : savedOnly
                        ? "Nothing saved yet"
                        : typeFilter === "food"
                          ? "No food going right now"
                          : "Nothing here right now"}
                </b>

                {/* an empty screen looks broken. If things are going, just
                    further away, say so and open the door. */}
                {feed.elsewhere > 0 && (
                  <>
                    <span>
                      {feed.elsewhere === 1
                        ? "One thing is going further out."
                        : `${feed.elsewhere} things are going further out.`}{" "}
                      Doorstep is starting in Hackney, so most of it is around London Fields for now.
                    </span>
                    <button
                      className="primary-btn"
                      onClick={() => {
                        setRadius(0);
                        setCustomRadius(false);
                      }}
                    >
                      Show me everything
                    </button>
                  </>
                )}

                <span>
                  {q.trim() || filter !== "Going soonest"
                    ? "Try a wider radius — or let the app do the waiting."
                    : "Things come and go through the day. Have something to pass on instead?"}
                </span>

                {/* a failed search is a wish that hasn't been made yet */}
                {q.trim() && feed.elsewhere === 0 && !savedOnly && (
                  <button
                    className="primary-btn"
                    onClick={async () => {
                      if (needsAccount("Sign in and we'll watch the neighbourhood for it", { action: "home" })) return;
                      try {
                        const created = await api("/wishes", {
                          method: "POST",
                          token,
                          body: { keyword: q.trim(), cat: "Anything", radius: Number.isFinite(radius) && radius > 0 ? radius : 2 },
                        });
                        setWishes((list) => [created, ...list]);
                        setToast(`On your wish list — the moment a ${q.trim().toLowerCase()} appears nearby, you'll know.`);
                      } catch (e) {
                        setToast(e.message);
                      }
                    }}
                  >
                    Wish for "{q.trim()}" — we'll watch for one
                  </button>
                )}
              </div>
            )}

            {recent.length > 0 && !q.trim() && (
              <div className="just-gone">
                <p className="sub-head">Just gone</p>
                <div className="gone-strip" ref={goneStrip}>
                  {recent.map((r, i) => (
                    <span key={i} className="gone-chip">
                      <span className="gone-pic">
                        {r.photoRef ? (
                          <img src={`${API}/photos/${r.photoRef}`} alt="" loading="lazy" />
                        ) : (
                          <Glyph kind={r.kind} size={24} />
                        )}
                      </span>
                      <b>{r.title}</b>
                      <small>{agoLabel(r.agoMinutes)}</small>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Kerbside piles spotted by passers-by: not listings, not
                claimable, just "it's there right now, go and look". They sit
                between Just gone and the grid because they are the most
                perishable thing on the screen. */}
            {spots.length > 0 && !q.trim() && (
              <div className="spotted">
                <p className="sub-head">Spotted on the kerb</p>
                <div className="spot-strip" data-carousel="spots">
                  {spots.map((s) => (
                    <div key={s.id} className="spot-card">
                      <div className="spot-pic">
                        {s.photo ? <img src={s.photo} alt="" loading="lazy" /> : <KerbPile size={40} />}
                      </div>
                      <p className="spot-note">{s.note}</p>
                      <small className="spot-meta">
                        {[s.road, agoLabel(s.agoMinutes)].filter(Boolean).join(" · ")}
                        {s.takenCount > 0 ? ` · ${s.takenCount} grabbed` : ""}
                      </small>
                      <div className="spot-actions">
                        <button className="spot-took" onClick={() => tookFromSpot(s)}>
                          I took something
                        </button>
                        <button className="spot-flag" aria-label="Report this pile" title="Report this pile" onClick={() => reportSpot(s)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M4 21V4m0 1h13l-2.5 4L17 13H4" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="spot-add"
                    onClick={() => {
                      if (needsAccount("Sign in to post a pile you've spotted")) return;
                      setSpotErrors({});
                      setScreen("spot");
                    }}
                  >
                    Spotted a pile?
                    <small>Post it for 2 hours</small>
                  </button>
                </div>
              </div>
            )}
            {/* no piles about, but a signed-in neighbour might be looking at one right now */}
            {spots.length === 0 && !q.trim() && token && (
              <button
                className="spot-empty-cta"
                onClick={() => {
                  setSpotErrors({});
                  setScreen("spot");
                }}
              >
                <KerbPile size={26} />
                <span>
                  Walked past a FREE pile? <b>Spot it</b> — everyone nearby sees it for 2 hours.
                </span>
              </button>
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
                        <span className={`gcard-timer ${item.lastOrders ? "last-orders" : urgent ? "urgent" : ""}`}>
                          {item.lastOrders ? `Last orders · ${formatLeft(remaining)}` : formatLeft(remaining)}
                        </span>
                        {item.dist && <span className="gcard-dist">{item.dist}</span>}
                        {item.wanted && <span className="gcard-want">Wanted</span>}
                        {item.type === "food" && !item.wanted && !gone && !mine && !item.owner && (
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
            <button
              className="tabbar-btn"
              onClick={() => {
                if (needsAccount("Sign in to message your neighbours")) return;
                setScreen("chats");
              }}
            >
              <span className="tabbar-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                {chatUnread > 0 && <em>{chatUnread > 9 ? "9+" : chatUnread}</em>}
              </span>
              Chats
            </button>

            {/* the one thing the app wants you to do, sat under the thumb */}
            <button
              className="tabbar-give"
              aria-label="Give something away"
              onClick={() => {
                if (needsAccount("Sign in to give something away", { action: "give" })) return;
                setScreen("give");
              }}
            >
              <span className="give-ring">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                  <circle cx="12" cy="13" r="3.4" />
                </svg>
              </span>
              Give
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
