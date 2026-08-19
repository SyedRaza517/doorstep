import express from "express";
import { db, hashPassword, verifyPassword, newToken, refreshSeed, seedCollectedHistory } from "./db.js";
import { geocodePostcode, milesBetween, formatMiles, approxCoords, FALLBACK } from "./geo.js";
import { specFromPhoto, hasCredentials, WINDOW_BY_SIZE } from "./autospec.js";
import { impactFor } from "./impact.js";

const PORT = process.env.PORT || 4000;
const CLAIM_HOLD_MS = 30 * 60 * 1000;
const DEFAULT_WINDOW_MIN = 120;

const MAX_PHOTOS = 5;
/* anti-hoarding, Olio-style: they capped pickups after finding 10% of users
   took half of everything. Ours is tighter because windows are hours, not days. */
const MAX_ACTIVE_CLAIMS = 3;
const CLAIMS_PER_28_DAYS = 25;
/* three independent reports hide a listing pending review */
const REPORTS_TO_HIDE = 3;
const REPORT_REASONS = ["pavement", "unsafe", "not-free", "sold-on", "offensive", "gone", "other"];

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

refreshSeed();
seedCollectedHistory();

const app = express();
app.use(express.json({ limit: "3mb" })); /* room for one resized item photo */

/* permissive CORS so the Capacitor apps (capacitor:// / https origins) can call in */
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const fail = (res, status, error, field) => res.status(status).json({ error, ...(field ? { field } : {}) });

/* ---- live notification stream ----
   One-way server→client at small scale, so Server-Sent Events rather than a
   WebSocket. EventSource can't set headers, so the token rides the query
   string. Instant and free: Olio charges £2.99/mo for fast alerts. */

const streams = new Map(); /* userId → Set<res> */

function addStream(userId, res) {
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
}

function dropStream(userId, res) {
  const set = streams.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) streams.delete(userId);
}

function pushTo(userId, payload) {
  const set = streams.get(userId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(frame);
}

/* Does this item satisfy this wish? Keyword, category and the wisher's own
   radius, measured from where they actually live. */
function wishMatches(wish, item) {
  const haystack = `${item.title} ${item.note} ${item.road}`.toLowerCase();
  if (wish.keyword && !haystack.includes(wish.keyword.toLowerCase())) return null;
  if (wish.cat !== "Anything" && wish.cat !== item.cat) return null;
  if (wish.ulat == null || item.lat == null) return null;
  const miles = milesBetween(wish.ulat, wish.ulng, item.lat, item.lng);
  return miles <= wish.radius ? miles : null;
}

/* Tell one wisher about one item, at most once ever for that pairing. */
function tellWisher(wish, item, miles, { alreadyLive = false } = {}) {
  const now = Date.now();
  try {
    db.prepare("INSERT INTO wish_hits (wish_id, item_id, at) VALUES (?, ?, ?)").run(wish.id, item.id, now);
  } catch {
    return false; /* already told them */
  }
  const body = alreadyLive
    ? `On your wish list, and it's already up — ${formatMiles(miles)} away on ${item.road}.`
    : `${formatMiles(miles)} away on ${item.road} — claim it before the window closes.`;
  const info = db
    .prepare("INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(wish.user_id, item.id, item.title, body, now);
  pushTo(wish.user_id, {
    type: "alert",
    id: info.lastInsertRowid,
    itemId: item.id,
    title: item.title,
    body,
    createdAt: now,
  });
  return true;
}

const wishesQuery = `
  SELECT w.*, u.lat AS ulat, u.lng AS ulng
  FROM wishes w JOIN users u ON u.id = w.user_id
  WHERE w.user_id != ?
    AND w.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)`;

/* Someone listed something: tell everyone wishing for it. */
function notifyMatchingWishes(item, ownerId) {
  let told = 0;
  for (const wish of db.prepare(wishesQuery).all(ownerId, ownerId)) {
    const miles = wishMatches(wish, item);
    if (miles != null && tellWisher(wish, item, miles)) told++;
  }
  return told;
}

/* Someone added a wish: tell them about anything already live that fits, so
   a wish added at 9pm doesn't miss the sofa listed at 8:45. */
function notifyExistingMatches(wish) {
  const now = Date.now();
  const live = db
    .prepare(
      `SELECT * FROM items
       WHERE expires_at > ? AND hidden_at IS NULL AND collected_at IS NULL
         AND owner_id != ?
         AND owner_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
       ORDER BY expires_at`
    )
    .all(now, wish.user_id, wish.user_id);

  let told = 0;
  for (const item of live) {
    const miles = wishMatches(wish, item);
    if (miles != null && tellWisher(wish, item, miles, { alreadyLive: true })) told++;
  }
  return told;
}

/* How many neighbours are waiting for something like this — shown to the
   giver as encouragement while they list it. */
function wishersFor(item, ownerId) {
  let n = 0;
  for (const wish of db.prepare(wishesQuery).all(ownerId, ownerId)) {
    if (wishMatches(wish, item) != null) n++;
  }
  return n;
}

function auth(req, res, next) {
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const row = token
    ? db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?").get(token)
    : null;
  if (!row) return fail(res, 401, "Signed out — sign in again.");
  req.user = row;
  req.token = token;
  next();
}

const startSession = (user) => {
  const token = newToken();
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, user.id, Date.now());
  return { token, user: { id: user.id, name: user.name, email: user.email, postcode: user.postcode, lat: user.lat, lng: user.lng } };
};

/* An active claim is one whose 30-minute hold hasn't lapsed. A lapsed claim
   simply stops counting, so the item goes back to "live" until the window ends. */
/* Trust without ratings: a real first name, a verified postcode, and a count
   of things actually handed over. Nextdoor's residency check is why its
   giveaways feel safe; Freegle proves reliability signals matter. Star
   ratings are skipped deliberately — with no chat there's no conduct to rate. */
function giverBadge(ownerId) {
  const u = db.prepare("SELECT name, lat FROM users WHERE id = ?").get(ownerId);
  if (!u) return null;
  const handed = db.prepare("SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND collected_at IS NOT NULL").get(ownerId).n;
  return { id: ownerId, name: u.name.split(/\s+/)[0], verified: u.lat != null, handed };
}

const photoList = (it) => {
  if (it.photos) {
    try {
      const parsed = JSON.parse(it.photos);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {}
  }
  return it.photo ? [it.photo] : [];
};

/* photos arrive as data URLs; cap the count and the size of each */
function validPhotos(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  if (list.length > MAX_PHOTOS) return { ok: false, error: `Up to ${MAX_PHOTOS} photos` };
  for (const p of list) {
    if (typeof p !== "string" || !p.startsWith("data:image/") || p.length > 2_000_000)
      return { ok: false, error: "That photo didn't come through — try taking it again" };
  }
  return { ok: true, list };
}

function publicItem(it, user, now) {
  const claimActive = it.claimed_by != null && it.claim_expires_at > now;
  const mine = claimActive && it.claimed_by === user.id;
  const owner = it.owner_id === user.id;
  const hasGeo = it.lat != null && user.lat != null;
  const miles = hasGeo ? milesBetween(user.lat, user.lng, it.lat, it.lng) : null;
  /* pin is snapped to a ~110m grid until the viewer has a right to the door */
  const pin = it.lat != null ? (mine || owner ? { lat: it.lat, lng: it.lng } : approxCoords(it.lat, it.lng)) : null;
  return {
    id: it.id,
    title: it.title,
    note: it.note,
    cat: it.cat,
    kind: it.kind,
    dist: miles != null ? formatMiles(miles) : it.dist,
    miles,
    road: it.road,
    spot: it.spot,
    photo: photoList(it)[0] || null,
    photos: photoList(it),
    owner,
    lat: pin ? pin.lat : null,
    lng: pin ? pin.lng : null,
    giver: giverBadge(it.owner_id),
    saved: db.prepare("SELECT 1 FROM saves WHERE user_id = ? AND item_id = ?").get(user.id, it.id) != null,
    windowMs: it.window_ms,
    expiresAt: it.expires_at,
    status: mine ? "yours" : claimActive ? "taken" : "live",
    ...(mine || owner ? { address: it.address } : {}),
    ...(mine ? { claimExpiresAt: it.claim_expires_at } : {}),
  };
}

/* ---------------- auth ---------------- */

app.post("/api/auth/signup", async (req, res) => {
  const { name = "", email = "", postcode = "", password = "" } = req.body || {};
  if (!name.trim()) return fail(res, 400, "Tell us what to call you", "name");
  if (!EMAIL_RE.test(email)) return fail(res, 400, "That email doesn't look right", "email");
  if (!POSTCODE_RE.test(postcode.trim())) return fail(res, 400, "Enter a full UK postcode, like E8 3EP", "postcode");
  if (password.length < 8) return fail(res, 400, "Use at least 8 characters", "password");

  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email.trim()))
    return fail(res, 409, "That email already has an account — sign in instead", "email");

  /* real geocoding: a well-formed postcode that doesn't exist is rejected;
     if postcodes.io is unreachable we fall back to the launch-area centre */
  const geo = await geocodePostcode(postcode);
  if (!geo.ok && geo.reason === "invalid")
    return fail(res, 400, "That postcode doesn't seem to exist — double-check it", "postcode");
  const { lat, lng } = geo.ok ? geo : FALLBACK;

  const info = db
    .prepare("INSERT INTO users (name, email, postcode, password_hash, created_at, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(name.trim(), email.trim(), postcode.trim().toUpperCase(), hashPassword(password), Date.now(), lat, lng);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json(startSession(user));
});

app.post("/api/auth/signin", (req, res) => {
  const { email = "", password = "" } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim());
  if (!user || !verifyPassword(password, user.password_hash))
    return fail(res, 401, "Wrong email or password", "password");
  res.json(startSession(user));
});

app.post("/api/auth/signout", auth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.token);
  res.json({ ok: true });
});

app.patch("/api/me", auth, (req, res) => {
  const { address, road, spot } = req.body || {};
  if (spot != null && !SPOTS.includes(spot)) return fail(res, 400, "Pick where things usually wait", "spot");
  db.prepare("UPDATE users SET address = ?, road = ?, spot = ? WHERE id = ?").run(
    address != null ? String(address).trim() : req.user.address,
    road != null ? String(road).trim() : req.user.road,
    spot != null ? spot : req.user.spot,
    req.user.id
  );
  const u = db.prepare("SELECT address, road, spot FROM users WHERE id = ?").get(req.user.id);
  res.json({ ok: true, ...u });
});

app.get("/api/me", auth, (req, res) => {
  const now = Date.now();
  const { id, name, email, postcode, lat, lng, created_at, address, road, spot } = req.user;
  const given = db.prepare("SELECT COUNT(*) AS n FROM items WHERE owner_id = ?").get(id).n;
  const collected = db.prepare("SELECT COUNT(*) AS n FROM items WHERE claimed_by = ? AND collected_at IS NOT NULL").get(id).n;
  const activeClaims = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE claimed_by = ? AND collected_at IS NULL AND claim_expires_at > ?")
    .get(id, now).n;
  const strikes = db
    .prepare("SELECT COUNT(*) AS n FROM no_shows WHERE user_id = ? AND at > ?")
    .get(id, now - 30 * 24 * 60 * 60 * 1000).n;
  res.json({
    user: { id, name, email, postcode, lat, lng, memberSince: created_at, address, road, spot },
    stats: { given, collected, activeClaims, strikes },
  });
});

/* ---------------- items ---------------- */

/* a lapsed 30-minute hold counts as a no-show for the claimer and puts
   the item straight back in the feed */
function sweepLapsedClaims(now) {
  const lapsed = db
    .prepare("SELECT id, claimed_by FROM items WHERE claimed_by IS NOT NULL AND collected_at IS NULL AND claim_expires_at <= ?")
    .all(now);
  for (const it of lapsed) {
    db.prepare("INSERT INTO no_shows (user_id, item_id, at) VALUES (?, ?, ?)").run(it.claimed_by, it.id, now);
    db.prepare("UPDATE items SET claimed_by = NULL, claim_expires_at = NULL WHERE id = ?").run(it.id);
  }
}

app.get("/api/items", auth, (req, res) => {
  const now = Date.now();
  sweepLapsedClaims(now);
  const rows = db
    .prepare(
      `SELECT * FROM items
       WHERE expires_at > ?
         AND (hidden_at IS NULL OR owner_id = ?)
         AND owner_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
       ORDER BY expires_at`
    )
    .all(now, req.user.id, req.user.id);
  res.json({ items: rows.map((it) => publicItem(it, req.user, now)) });
});

/* what just went, so the feed still feels alive when little is live —
   Olio's "Just Gone" carousel, minus the tease of showing an address */
app.get("/api/items/recent", auth, (req, res) => {
  const now = Date.now();
  const rows = db
    .prepare("SELECT title, cat, kind, road, collected_at FROM items WHERE collected_at IS NOT NULL AND hidden_at IS NULL ORDER BY collected_at DESC LIMIT 8")
    .all();
  res.json({
    items: rows.map((r) => ({
      title: r.title,
      cat: r.cat,
      kind: r.kind,
      road: r.road,
      agoMinutes: Math.max(1, Math.round((now - r.collected_at) / 60000)),
    })),
  });
});

const SPOTS = ["doorstep", "front garden", "porch", "building lobby", "buzz and collect"];

/* items that are unsafe or unlawful to pass on second-hand: car seats and
   infant mattresses (hidden damage / SIDS guidance), plus age-restricted
   and dangerous goods */
/* Modelled on Olio's published banned list plus UK second-hand safety
   guidance: car seats and infant mattresses carry invisible risk, and the
   rest are age-restricted, dangerous, or not the giver's to give. */
const BANNED_RE = new RegExp(
  [
    "car seat", "booster seat", "cot mattress", "crib mattress", "carrycot mattress",
    "medicine", "medication", "prescription", "paracetamol", "ibuprofen", "antibiotic", "inhaler",
    "knife", "knives", "machete", "firearm", "shotgun", "air rifle", "weapon", "ammunition", "taser", "pepper spray",
    "firework", "flare", "solvent", "petrol", "acid", "bleach",
    "alcohol", "beer", "wine", "spirits", "vodka", "whisky",
    "vape", "e-cig", "cigarette", "tobacco", "nicotine",
    "cannabis", "cocaine", "illegal drug",
    "counterfeit", "replica", "fake designer",
    "gift card", "voucher", "discount code", "concert ticket",
    "puppy", "kitten", "livestock",
    "prescription glasses", "contact lens",
    "recalled",
  ].join("|"),
  "i"
);

app.post("/api/items", auth, (req, res) => {
  const { title = "", note = "", cat = "Furniture", kind = "bookcase", road = "", address = "", windowMinutes, photo = null, photos = null, spot = "doorstep" } = req.body || {};
  if (!title.trim()) return fail(res, 400, "Give the item a name", "title");
  if (!address.trim()) return fail(res, 400, "We need the address the claimer will collect from", "address");
  const shots = validPhotos(photos != null ? photos : photo);
  if (!shots.ok) return fail(res, 400, shots.error, "photo");
  if (!SPOTS.includes(spot)) return fail(res, 400, "Pick where the item will be waiting", "spot");
  if (BANNED_RE.test(`${title} ${note}`))
    return fail(res, 400, "Some things can't be passed on safely — car seats, cot mattresses, and age-restricted or dangerous items aren't allowed", "title");

  const now = Date.now();
  const windowMs = Math.max(15, Math.min(24 * 60, Number(windowMinutes) || DEFAULT_WINDOW_MIN)) * 60 * 1000;
  /* the item sits on the giver's own property, so it inherits their coordinates */
  const info = db
    .prepare(`INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, photo, photos, spot, postcode, lat, lng)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, title.trim(), note.trim(), cat, kind, road.trim() || "your road", address.trim(), "", windowMs, now + windowMs, now, shots.list[0] || null, JSON.stringify(shots.list), spot, req.user.postcode, req.user.lat, req.user.lng);

  /* remember it, so the next listing is prefilled */
  db.prepare("UPDATE users SET address = ?, road = ?, spot = ? WHERE id = ?")
    .run(address.trim(), road.trim() || req.user.road, spot, req.user.id);

  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(info.lastInsertRowid);
  const wishers = notifyMatchingWishes(item, req.user.id);
  res.status(201).json({ ...publicItem(item, req.user, now), wishers });
});

/* ---- editing and withdrawing your own listing ---- */

app.patch("/api/items/:id", auth, (req, res) => {
  const now = Date.now();
  const it = db.prepare("SELECT * FROM items WHERE id = ? AND owner_id = ?").get(req.params.id, req.user.id);
  if (!it) return fail(res, 404, "That isn't one of your listings");
  if (it.claimed_by != null && it.claim_expires_at > now)
    return fail(res, 409, "Someone's on their way for it — you can't change it now");

  const { title, note, cat, spot, road, address, extendMinutes } = req.body || {};
  if (title != null && !String(title).trim()) return fail(res, 400, "Give the item a name", "title");
  if (spot != null && !SPOTS.includes(spot)) return fail(res, 400, "Pick where the item will be waiting", "spot");
  if (title != null && BANNED_RE.test(`${title} ${note || ""}`))
    return fail(res, 400, "Some things can't be passed on safely", "title");

  const next = {
    title: title != null ? String(title).trim() : it.title,
    note: note != null ? String(note).trim() : it.note,
    cat: cat != null ? cat : it.cat,
    spot: spot != null ? spot : it.spot,
    road: road != null ? String(road).trim() : it.road,
    address: address != null ? String(address).trim() : it.address,
  };
  /* a giver can add time while the window is still open, up to 24h total */
  const extra = Math.max(0, Math.min(240, Number(extendMinutes) || 0)) * 60 * 1000;
  const expires = Math.min(it.expires_at + extra, now + 24 * 60 * 60 * 1000);

  db.prepare("UPDATE items SET title=?, note=?, cat=?, spot=?, road=?, address=?, expires_at=?, window_ms=? WHERE id=?")
    .run(next.title, next.note, next.cat, next.spot, next.road, next.address, expires, it.window_ms + extra, it.id);
  res.json(publicItem(db.prepare("SELECT * FROM items WHERE id = ?").get(it.id), req.user, now));
});

app.delete("/api/items/:id", auth, (req, res) => {
  const now = Date.now();
  const it = db.prepare("SELECT * FROM items WHERE id = ? AND owner_id = ?").get(req.params.id, req.user.id);
  if (!it) return fail(res, 404, "That isn't one of your listings");
  if (it.claimed_by != null && it.claim_expires_at > now)
    return fail(res, 409, "Someone's on their way for it — let them collect, or wait for the hold to lapse");
  /* expire rather than destroy, so notifications that point at it still resolve */
  db.prepare("UPDATE items SET expires_at = ? WHERE id = ?").run(now, it.id);
  res.json({ ok: true });
});

/* ---- reporting ---- */

app.post("/api/items/:id/report", auth, (req, res) => {
  const { reason = "other", detail = "" } = req.body || {};
  if (!REPORT_REASONS.includes(reason)) return fail(res, 400, "Pick a reason", "reason");
  const it = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
  if (!it) return fail(res, 404, "That item doesn't exist");
  if (it.owner_id === req.user.id) return fail(res, 400, "That's your own listing");

  try {
    db.prepare("INSERT INTO reports (item_id, reporter_id, reason, detail, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(it.id, req.user.id, reason, String(detail).slice(0, 500), Date.now());
  } catch {
    return res.json({ ok: true, alreadyReported: true });
  }

  const count = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE item_id = ?").get(it.id).n;
  if (count >= REPORTS_TO_HIDE && it.hidden_at == null)
    db.prepare("UPDATE items SET hidden_at = ? WHERE id = ?").run(Date.now(), it.id);
  res.json({ ok: true, hidden: count >= REPORTS_TO_HIDE });
});

app.get("/api/report-reasons", auth, (req, res) => {
  res.json({
    reasons: [
      { key: "pavement", label: "It's on the pavement" },
      { key: "unsafe", label: "Looks unsafe or recalled" },
      { key: "not-free", label: "They're asking for money" },
      { key: "sold-on", label: "Being collected to resell" },
      { key: "offensive", label: "Offensive or illegal" },
      { key: "gone", label: "It wasn't there" },
      { key: "other", label: "Something else" },
    ],
  });
});

/* Before you list: how many neighbours already want this? A giver deciding
   whether it's worth photographing the thing deserves to know someone is
   waiting for it. */
app.post("/api/wishes/demand", auth, (req, res) => {
  const { title = "", note = "", cat = "Furniture" } = req.body || {};
  if (req.user.lat == null) return res.json({ wishers: 0 });
  const wishers = wishersFor(
    { title, note, road: "", cat, lat: req.user.lat, lng: req.user.lng },
    req.user.id
  );
  res.json({ wishers });
});

/* ---- photo → draft listing ---- */

app.get("/api/autospec/status", auth, (req, res) => {
  res.json({ configured: hasCredentials });
});

app.post("/api/autospec", auth, async (req, res) => {
  if (!hasCredentials) return fail(res, 503, "Photo details aren't switched on — fill them in yourself");
  const { photo } = req.body || {};
  const result = await specFromPhoto(photo);
  if (!result.ok) return fail(res, 422, result.error);
  if (result.spec.blocked)
    return fail(res, 400, "That looks like something we can't pass on second-hand — car seats, cot mattresses and age-restricted items aren't allowed");
  res.json(result.spec);
});

/* ---- the wish list ---- */

app.get("/api/wishes", auth, (req, res) => {
  const rows = db.prepare("SELECT id, keyword, cat, radius, created_at FROM wishes WHERE user_id = ? ORDER BY id DESC").all(req.user.id);
  res.json({
    wishes: rows.map((w) => ({
      id: w.id,
      keyword: w.keyword,
      cat: w.cat,
      radius: w.radius,
      createdAt: w.created_at,
      /* how often this wish has actually turned something up */
      found: db.prepare("SELECT COUNT(*) AS n FROM wish_hits WHERE wish_id = ?").get(w.id).n,
    })),
  });
});

app.post("/api/wishes", auth, (req, res) => {
  const { keyword = "", cat = "Anything", radius = 1 } = req.body || {};
  if (!keyword.trim() && cat === "Anything")
    return fail(res, 400, "Say what you're after, or pick a category", "keyword");
  const count = db.prepare("SELECT COUNT(*) AS n FROM wishes WHERE user_id = ?").get(req.user.id).n;
  if (count >= 10) return fail(res, 400, "Ten wishes is the limit — remove one first");

  const r = Math.max(0.25, Math.min(5, Number(radius) || 1));
  const info = db
    .prepare("INSERT INTO wishes (user_id, keyword, cat, radius, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(req.user.id, keyword.trim(), cat, r, Date.now());

  /* check what is already out there before promising to watch the future */
  const wish = db
    .prepare("SELECT w.*, u.lat AS ulat, u.lng AS ulng FROM wishes w JOIN users u ON u.id = w.user_id WHERE w.id = ?")
    .get(info.lastInsertRowid);
  const alreadyOut = notifyExistingMatches(wish);

  res.status(201).json({ id: info.lastInsertRowid, keyword: keyword.trim(), cat, radius: r, found: alreadyOut, alreadyOut });
});

app.delete("/api/wishes/:id", auth, (req, res) => {
  const wish = db.prepare("SELECT id FROM wishes WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (wish) {
    db.prepare("DELETE FROM wish_hits WHERE wish_id = ?").run(wish.id);
    db.prepare("DELETE FROM wishes WHERE id = ?").run(wish.id);
  }
  res.json({ ok: true });
});

/* ---- notifications ---- */

app.get("/api/notifications", auth, (req, res) => {
  const rows = db
    .prepare("SELECT id, item_id, title, body, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 40")
    .all(req.user.id);
  res.json({
    notifications: rows.map((n) => ({ id: n.id, itemId: n.item_id, title: n.title, body: n.body, createdAt: n.created_at, read: n.read_at != null })),
    unread: rows.filter((n) => n.read_at == null).length,
  });
});

app.post("/api/notifications/read", auth, (req, res) => {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), req.user.id);
  res.json({ ok: true });
});

/* EventSource can't send an Authorization header, so the token comes as a
   query parameter over the same origin. */
app.get("/api/stream", (req, res) => {
  const row = db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
    .get(req.query.token || "");
  if (!row) return fail(res, 401, "Signed out — sign in again.");

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
  addStream(row.id, res);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    dropStream(row.id, res);
  });
});

/* ---- what happens when nobody claims it ---- */

app.get("/api/items/:id/fallback", auth, (req, res) => {
  const it = db.prepare("SELECT * FROM items WHERE id = ? AND owner_id = ?").get(req.params.id, req.user.id);
  if (!it) return fail(res, 404, "That isn't one of your listings");
  res.json({
    title: it.title,
    options: FALLBACK_OPTIONS.filter((o) => !o.cats || o.cats.includes(it.cat)),
  });
});

/* Verified in earlier research: Hackney routes reusable furniture to a charity
   partner and charges £15 for up to five bulky items; Lambeth uses Emmaus;
   BHF and Traid collect free London-wide. Charity first — free, and it keeps
   the item in use. Council booking last: it costs money and ends in disposal. */
const FALLBACK_OPTIONS = [
  {
    key: "bhf",
    name: "British Heart Foundation",
    blurb: "Free collection of furniture and electricals across London. Upholstery needs its fire label attached or they'll refuse it.",
    action: "Book a free collection",
    url: "https://www.bhf.org.uk/shop/donating-goods/book-a-collection",
    cats: ["Furniture", "Electricals"],
  },
  {
    key: "emmaus",
    name: "Emmaus",
    blurb: "Furniture reuse charity working across London — the official partner for several boroughs.",
    action: "Find your nearest community",
    url: "https://emmaus.org.uk/find-your-nearest/",
    cats: ["Furniture"],
  },
  {
    key: "traid",
    name: "Traid",
    blurb: "Free home collection for clothes and textiles, London-wide.",
    action: "Book a clothes collection",
    url: "https://traid.org.uk/home-collection/",
    cats: null,
  },
  {
    key: "relist",
    name: "Put it back on Doorstep",
    blurb: "Different time of day, different neighbours. Evenings and weekend mornings move fastest.",
    action: "List it again",
    url: null,
    cats: null,
  },
  {
    key: "council",
    name: "Council bulky collection",
    blurb: "Last resort — it costs money and the item is treated as waste. Hackney charges £15 for up to five items.",
    action: "Book with your council",
    url: "https://www.gov.uk/bulky-waste-collection",
    cats: null,
  },
];

/* ---- diversion reporting ---- */

app.get("/api/impact", auth, (req, res) => {
  res.json({ you: impactFor({ userId: req.user.id }), neighbourhood: impactFor({}) });
});

app.post("/api/items/:id/claim", auth, (req, res) => {
  const now = Date.now();
  const claim = db.transaction(() => {
    sweepLapsedClaims(now);

    /* three lapsed holds in 30 days pauses claiming — keeps the one-tap
       claim honest without ratings or chat */
    const recentNoShows = db
      .prepare("SELECT COUNT(*) AS n FROM no_shows WHERE user_id = ? AND at > ?")
      .get(req.user.id, now - 30 * 24 * 60 * 60 * 1000).n;
    if (recentNoShows >= 3)
      return { status: 403, error: "Three claims went uncollected this month — claiming is paused for now" };

    /* anti-hoarding: hold a few at a time, not the whole street */
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM items WHERE claimed_by = ? AND collected_at IS NULL AND claim_expires_at > ?")
      .get(req.user.id, now).n;
    if (active >= MAX_ACTIVE_CLAIMS)
      return { status: 429, error: `You're holding ${active} already — collect one before claiming another` };

    const monthly = db
      .prepare("SELECT COUNT(*) AS n FROM items WHERE claimed_by = ? AND claim_expires_at > ?")
      .get(req.user.id, now - 28 * 24 * 60 * 60 * 1000).n;
    if (monthly >= CLAIMS_PER_28_DAYS)
      return { status: 429, error: "That's a lot of claims this month — give someone else a turn and come back in a few days" };

    const it = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
    if (!it) return { status: 404, error: "That item doesn't exist" };
    if (it.hidden_at != null) return { status: 410, error: "That listing is under review" };
    if (it.expires_at <= now) return { status: 410, error: "Too late — the window has closed" };
    if (it.owner_id === req.user.id) return { status: 400, error: "That one's already yours — you listed it" };
    const claimActive = it.claimed_by != null && it.claim_expires_at > now;
    if (claimActive && it.claimed_by !== req.user.id)
      return { status: 409, error: "Someone beat you to it — it's already claimed" };

    db.prepare("UPDATE items SET claimed_by = ?, claim_expires_at = ? WHERE id = ?")
      .run(req.user.id, now + CLAIM_HOLD_MS, it.id);
    return { item: db.prepare("SELECT * FROM items WHERE id = ?").get(it.id) };
  })();

  if (claim.error) return fail(res, claim.status, claim.error);
  res.json(publicItem(claim.item, req.user, now));
});

/* Handing a claim back is always better than ghosting: the item returns to
   the feed immediately and the claimer keeps a clean record. Too Good To Go
   makes cancelling final at a cliff edge; here honesty is never punished. */
app.post("/api/items/:id/release", auth, (req, res) => {
  const now = Date.now();
  const it = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
  if (!it || it.claimed_by !== req.user.id || it.collected_at != null)
    return fail(res, 400, "That isn't yours to hand back");
  db.prepare("UPDATE items SET claimed_by = NULL, claim_expires_at = NULL WHERE id = ?").run(it.id);
  res.json(publicItem(db.prepare("SELECT * FROM items WHERE id = ?").get(it.id), req.user, now));
});

/* Everything of yours in one place: what you're on your way to collect, what
   you already have, and what you've put out. */
app.get("/api/me/stuff", auth, (req, res) => {
  const now = Date.now();
  sweepLapsedClaims(now);
  const id = req.user.id;

  const toCollect = db
    .prepare("SELECT * FROM items WHERE claimed_by = ? AND collected_at IS NULL AND claim_expires_at > ? ORDER BY claim_expires_at")
    .all(id, now)
    .map((it) => ({ ...publicItem(it, req.user, now), holdEndsAt: it.claim_expires_at }));

  const collected = db
    .prepare("SELECT * FROM items WHERE claimed_by = ? AND collected_at IS NOT NULL ORDER BY collected_at DESC")
    .all(id)
    .map((it) => ({
      ...publicItem(it, req.user, now),
      address: it.address,
      collectedAt: it.collected_at,
      thanked: db.prepare("SELECT 1 FROM thanks WHERE item_id = ? AND from_id = ?").get(it.id, id) != null,
    }));

  const listed = db
    .prepare("SELECT * FROM items WHERE owner_id = ? ORDER BY (expires_at > ?) DESC, expires_at DESC LIMIT 40")
    .all(id, now)
    .map((it) => {
      const claimActive = it.claimed_by != null && it.claim_expires_at > now;
      return {
        ...publicItem(it, req.user, now),
        collectedAt: it.collected_at,
        state: it.collected_at ? "gone" : claimActive ? "claimed" : it.expires_at > now ? "live" : "expired",
        thanks: db.prepare("SELECT token FROM thanks WHERE item_id = ?").all(it.id).map((t) => t.token),
      };
    });

  res.json({ toCollect, collected, listed });
});

/* ---- your data ----
   UK GDPR: people can take their data out and have their account erased.
   Olio keeps listings and ratings after deletion for its impact accounting;
   we anonymise instead, which keeps the diversion figures honest without
   holding on to a name, an email or an address. */

app.get("/api/me/export", auth, (req, res) => {
  const id = req.user.id;
  res.json({
    exportedAt: new Date().toISOString(),
    account: { name: req.user.name, email: req.user.email, postcode: req.user.postcode, joined: req.user.created_at },
    listings: db.prepare("SELECT title, note, cat, road, address, created_at, expires_at, collected_at FROM items WHERE owner_id = ?").all(id),
    claims: db.prepare("SELECT title, road, claim_expires_at, collected_at FROM items WHERE claimed_by = ?").all(id),
    wishList: db.prepare("SELECT keyword, cat, radius, created_at FROM wishes WHERE user_id = ?").all(id),
    watchlist: db.prepare("SELECT item_id, created_at FROM saves WHERE user_id = ?").all(id),
    notifications: db.prepare("SELECT title, body, created_at FROM notifications WHERE user_id = ?").all(id),
    blocked: db.prepare("SELECT blocked_id, created_at FROM blocks WHERE blocker_id = ?").all(id),
    noShows: db.prepare("SELECT item_id, at FROM no_shows WHERE user_id = ?").all(id),
  });
});

app.delete("/api/me", auth, (req, res) => {
  const id = req.user.id;
  const now = Date.now();
  db.transaction(() => {
    /* live listings come down; anything already collected is anonymised so
       the neighbourhood's diversion total stays true */
    db.prepare("UPDATE items SET expires_at = ? WHERE owner_id = ? AND collected_at IS NULL").run(now, id);
    db.prepare("UPDATE items SET claimed_by = NULL, claim_expires_at = NULL WHERE claimed_by = ? AND collected_at IS NULL").run(id);
    db.prepare("UPDATE items SET address = 'removed' WHERE owner_id = ?").run(id);
    db.prepare("DELETE FROM wish_hits WHERE wish_id IN (SELECT id FROM wishes WHERE user_id = ?)").run(id);
    db.prepare("DELETE FROM wishes WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM notifications WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM saves WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?").run(id, id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    db.prepare("UPDATE users SET name = 'Former neighbour', email = ?, postcode = '', lat = NULL, lng = NULL, password_hash = ? WHERE id = ?")
      .run(`deleted-${id}-${now}@doorstep.invalid`, newToken(), id);
  })();
  res.json({ ok: true });
});

/* ---- watchlist ---- */

app.post("/api/items/:id/save", auth, (req, res) => {
  const it = db.prepare("SELECT id FROM items WHERE id = ?").get(req.params.id);
  if (!it) return fail(res, 404, "That item doesn't exist");
  db.prepare("INSERT OR IGNORE INTO saves (user_id, item_id, created_at) VALUES (?, ?, ?)").run(req.user.id, it.id, Date.now());
  res.json({ ok: true, saved: true });
});

app.delete("/api/items/:id/save", auth, (req, res) => {
  db.prepare("DELETE FROM saves WHERE user_id = ? AND item_id = ?").run(req.user.id, req.params.id);
  res.json({ ok: true, saved: false });
});

/* ---- thanks ----
   A fixed set of tokens, so gratitude never becomes a chat box. Only the
   person who collected it can send one, and only once. */
const THANK_TOKENS = {
  wave: "gave you a wave",
  plant: "sent you a plant",
  brew: "owes you a brew",
  star: "says you're a star",
};

app.post("/api/items/:id/thanks", auth, (req, res) => {
  const { token: kind = "wave" } = req.body || {};
  if (!THANK_TOKENS[kind]) return fail(res, 400, "Pick a thank-you", "token");
  const it = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
  if (!it || it.claimed_by !== req.user.id || it.collected_at == null)
    return fail(res, 400, "You can thank someone once you've collected from them");

  const now = Date.now();
  try {
    db.prepare("INSERT INTO thanks (item_id, from_id, to_id, token, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(it.id, req.user.id, it.owner_id, kind, now);
  } catch {
    return fail(res, 409, "You've already thanked them for this");
  }

  const body = `${req.user.name.split(/\s+/)[0]} ${THANK_TOKENS[kind]} for the ${it.title.toLowerCase()}.`;
  const info = db
    .prepare("INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(it.owner_id, it.id, "Thank you", body, now);
  pushTo(it.owner_id, { type: "alert", id: info.lastInsertRowid, itemId: it.id, title: "Thank you", body, createdAt: now });
  res.json({ ok: true });
});

/* ---- blocking ---- */

app.post("/api/users/:id/block", auth, (req, res) => {
  const target = Number(req.params.id);
  if (target === req.user.id) return fail(res, 400, "You can't block yourself");
  if (!db.prepare("SELECT id FROM users WHERE id = ?").get(target)) return fail(res, 404, "No such neighbour");
  db.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)")
    .run(req.user.id, target, Date.now());
  res.json({ ok: true });
});

app.delete("/api/users/:id/block", auth, (req, res) => {
  db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").run(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.get("/api/blocks", auth, (req, res) => {
  const rows = db
    .prepare("SELECT u.id, u.name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC")
    .all(req.user.id);
  res.json({ blocked: rows.map((r) => ({ id: r.id, name: r.name.split(/\s+/)[0] })) });
});

/* claimer confirms the pickup happened — the item leaves the feed and the
   hold can never lapse into a no-show */
app.post("/api/items/:id/collected", auth, (req, res) => {
  const now = Date.now();
  const it = db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id);
  if (!it || it.claimed_by !== req.user.id || it.collected_at != null)
    return fail(res, 400, "That item isn't yours to confirm");
  db.prepare("UPDATE items SET collected_at = ?, expires_at = ? WHERE id = ?").run(now, now, it.id);
  res.json({ ok: true });
});

app.use((req, res) => fail(res, 404, "No such endpoint"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Doorstep API listening on http://localhost:${PORT}`);
});
