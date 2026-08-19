import express from "express";
import {
  query,
  one,
  tx,
  initDb,
  refreshSeed,
  hashPassword,
  verifyPassword,
  newToken,
  foldEmail,
  num,
} from "./db.js";
import { geocodePostcode, milesBetween, formatMiles, approxCoords, FALLBACK } from "./geo.js";
import { specFromPhoto, hasCredentials } from "./autospec.js";
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

const SPOTS = ["doorstep", "front garden", "porch", "building lobby", "buzz and collect"];

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

const app = express();
app.use(express.json({ limit: "6mb" })); /* room for a few resized item photos */

/* The web app (Vercel), the Android app (capacitor://) and the iOS app all
   call this from a different origin, and every route is bearer-token
   authenticated rather than cookie based, so a wildcard is safe here. */
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const fail = (res, status, error, field) => res.status(status).json({ error, ...(field ? { field } : {}) });

/* Async handlers need their rejections turned into responses, otherwise a
   database hiccup hangs the request instead of answering it. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "doorstep-api", time: new Date().toISOString() });
});

/* Postgres returns BIGINT as a string so it never loses precision. Left
   alone, `expires_at + extra` would concatenate rather than add, so every
   numeric column is cast once, on the way out of the database. */
const castItem = (it) =>
  it && {
    ...it,
    id: num(it.id),
    owner_id: num(it.owner_id),
    claimed_by: num(it.claimed_by),
    window_ms: num(it.window_ms),
    expires_at: num(it.expires_at),
    claim_expires_at: num(it.claim_expires_at),
    created_at: num(it.created_at),
    collected_at: num(it.collected_at),
    hidden_at: num(it.hidden_at),
  };

const castUser = (u) => u && { ...u, id: num(u.id), created_at: num(u.created_at) };

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

/* ---- wishes ---- */

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
async function tellWisher(wish, item, miles, { alreadyLive = false } = {}) {
  const now = Date.now();
  const claimed = await query(
    "INSERT INTO wish_hits (wish_id, item_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING wish_id",
    [wish.id, item.id, now]
  );
  if (!claimed.length) return false; /* already told them */

  const body = alreadyLive
    ? `On your wish list, and it's already up — ${formatMiles(miles)} away on ${item.road}.`
    : `${formatMiles(miles)} away on ${item.road} — claim it before the window closes.`;
  const row = await one(
    "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [wish.user_id, item.id, item.title, body, now]
  );
  pushTo(num(wish.user_id), {
    type: "alert",
    id: num(row.id),
    itemId: num(item.id),
    title: item.title,
    body,
    createdAt: now,
  });
  return true;
}

const WISHES_SQL = `
  SELECT w.*, u.lat AS ulat, u.lng AS ulng
  FROM wishes w JOIN users u ON u.id = w.user_id
  WHERE w.user_id <> $1
    AND w.user_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = $1)`;

/* Someone listed something: tell everyone wishing for it. */
async function notifyMatchingWishes(item, ownerId) {
  const wishes = await query(WISHES_SQL, [ownerId]);
  let told = 0;
  for (const wish of wishes) {
    const miles = wishMatches(wish, item);
    if (miles != null && (await tellWisher(wish, item, miles))) told++;
  }
  return told;
}

/* Someone added a wish: tell them about anything already live that fits, so
   a wish added at 9pm doesn't miss the sofa listed at 8:45. */
async function notifyExistingMatches(wish) {
  const now = Date.now();
  const live = (
    await query(
      `SELECT * FROM items
       WHERE expires_at > $1 AND hidden_at IS NULL AND collected_at IS NULL
         AND owner_id <> $2
         AND owner_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $2)
       ORDER BY expires_at`,
      [now, wish.user_id]
    )
  ).map(castItem);

  let told = 0;
  for (const item of live) {
    const miles = wishMatches(wish, item);
    if (miles != null && (await tellWisher(wish, item, miles, { alreadyLive: true }))) told++;
  }
  return told;
}

/* How many neighbours are waiting for something like this — shown to the
   giver as encouragement while they list it. */
async function wishersFor(item, ownerId) {
  const wishes = await query(WISHES_SQL, [ownerId]);
  return wishes.filter((w) => wishMatches(w, item) != null).length;
}

/* ---- auth middleware ---- */

const auth = wrap(async (req, res, next) => {
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const row = token
    ? await one("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1", [token])
    : null;
  if (!row) return fail(res, 401, "Signed out — sign in again.");
  req.user = castUser(row);
  req.token = token;
  next();
});

/* Browsing needs no account. Nextdoor, Gumtree and Freegle all let people
   look before they join, and an empty-handed sign-up wall is the surest way
   to lose someone who just wanted to see whether anything is going nearby.
   A guest sees the same listings, minus anything personal to them. */
const GUEST = { id: -1, lat: null, lng: null, guest: true };

const maybeAuth = wrap(async (req, res, next) => {
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const row = token
    ? await one("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1", [token])
    : null;
  req.user = row ? castUser(row) : GUEST;
  req.guest = !row;
  next();
});

async function startSession(user) {
  const token = newToken();
  await query("INSERT INTO sessions (token, user_id, created_at) VALUES ($1,$2,$3)", [token, user.id, Date.now()]);
  return {
    token,
    user: { id: num(user.id), name: user.name, email: user.email, postcode: user.postcode, lat: user.lat, lng: user.lng },
  };
}

/* ---- shaping items for the client ----
   Trust without ratings: a real first name, a verified postcode, and a count
   of things actually handed over. Nextdoor's residency check is why its
   giveaways feel safe; Freegle proves reliability signals matter. Star
   ratings are skipped deliberately — with no chat there's no conduct to rate.

   These used to be two queries per item. Against SQLite in the same process
   that was merely wasteful; against a database across the network it would be
   a round trip per card, so both are now fetched once for the whole page. */
async function itemContext(items, user) {
  const ownerIds = [...new Set(items.map((i) => Number(i.owner_id)))];
  const itemIds = items.map((i) => Number(i.id));
  if (!ownerIds.length) return { givers: new Map(), saved: new Set() };

  const givers = await query(
    `SELECT u.id, u.name, u.lat,
            (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id AND i.collected_at IS NOT NULL) AS handed
     FROM users u WHERE u.id = ANY($1::bigint[])`,
    [ownerIds]
  );
  const saved = itemIds.length
    ? await query("SELECT item_id FROM saves WHERE user_id = $1 AND item_id = ANY($2::bigint[])", [user.id, itemIds])
    : [];

  return {
    givers: new Map(
      givers.map((g) => [
        num(g.id),
        { id: num(g.id), name: String(g.name).split(/\s+/)[0], verified: g.lat != null, handed: num(g.handed) },
      ])
    ),
    saved: new Set(saved.map((s) => num(s.item_id))),
  };
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

function publicItem(it, user, now, ctx) {
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
    giver: ctx.givers.get(it.owner_id) || null,
    saved: ctx.saved.has(it.id),
    windowMs: it.window_ms,
    expiresAt: it.expires_at,
    status: mine ? "yours" : claimActive ? "taken" : "live",
    ...(mine || owner ? { address: it.address } : {}),
    ...(mine ? { claimExpiresAt: it.claim_expires_at } : {}),
  };
}

/* one item, when we don't have a page of them */
async function publicOne(it, user, now) {
  const ctx = await itemContext([it], user);
  return publicItem(it, user, now, ctx);
}

/* ---------------- auth ---------------- */

app.post(
  "/api/auth/signup",
  wrap(async (req, res) => {
    const { name = "", email = "", postcode = "", password = "" } = req.body || {};
    if (!name.trim()) return fail(res, 400, "Tell us what to call you", "name");
    if (!EMAIL_RE.test(email)) return fail(res, 400, "That email doesn't look right", "email");
    if (!POSTCODE_RE.test(postcode.trim())) return fail(res, 400, "Enter a full UK postcode, like E8 3EP", "postcode");
    if (password.length < 8) return fail(res, 400, "Use at least 8 characters", "password");

    if (await one("SELECT id FROM users WHERE email = $1", [foldEmail(email)]))
      return fail(res, 409, "That email already has an account — sign in instead", "email");

    /* real geocoding: a well-formed postcode that doesn't exist is rejected;
       if postcodes.io is unreachable we fall back to the launch-area centre */
    const geo = await geocodePostcode(postcode);
    if (!geo.ok && geo.reason === "invalid")
      return fail(res, 400, "That postcode doesn't seem to exist — double-check it", "postcode");
    const { lat, lng } = geo.ok ? geo : FALLBACK;

    const row = await one(
      "INSERT INTO users (name, email, postcode, password_hash, created_at, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [name.trim(), foldEmail(email), postcode.trim().toUpperCase(), hashPassword(password), Date.now(), lat, lng]
    );
    res.status(201).json(await startSession(castUser(row)));
  })
);

app.post(
  "/api/auth/signin",
  wrap(async (req, res) => {
    const { email = "", password = "" } = req.body || {};
    const user = await one("SELECT * FROM users WHERE email = $1", [foldEmail(email)]);
    if (!user || !verifyPassword(password, user.password_hash))
      return fail(res, 401, "Wrong email or password", "password");
    res.json(await startSession(castUser(user)));
  })
);

app.post(
  "/api/auth/signout",
  auth,
  wrap(async (req, res) => {
    await query("DELETE FROM sessions WHERE token = $1", [req.token]);
    res.json({ ok: true });
  })
);

app.patch(
  "/api/me",
  auth,
  wrap(async (req, res) => {
    const { address, road, spot } = req.body || {};
    if (spot != null && !SPOTS.includes(spot)) return fail(res, 400, "Pick where things usually wait", "spot");
    await query("UPDATE users SET address = $1, road = $2, spot = $3 WHERE id = $4", [
      address != null ? String(address).trim() : req.user.address,
      road != null ? String(road).trim() : req.user.road,
      spot != null ? spot : req.user.spot,
      req.user.id,
    ]);
    const u = await one("SELECT address, road, spot FROM users WHERE id = $1", [req.user.id]);
    res.json({ ok: true, ...u });
  })
);

app.get(
  "/api/me",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const { id, name, email, postcode, lat, lng, created_at, address, road, spot } = req.user;
    const [given, collected, active, strikes] = await Promise.all([
      one("SELECT COUNT(*) AS n FROM items WHERE owner_id = $1", [id]),
      one("SELECT COUNT(*) AS n FROM items WHERE claimed_by = $1 AND collected_at IS NOT NULL", [id]),
      one("SELECT COUNT(*) AS n FROM items WHERE claimed_by = $1 AND collected_at IS NULL AND claim_expires_at > $2", [id, now]),
      one("SELECT COUNT(*) AS n FROM no_shows WHERE user_id = $1 AND at > $2", [id, now - 30 * 24 * 60 * 60 * 1000]),
    ]);
    res.json({
      user: { id, name, email, postcode, lat, lng, memberSince: created_at, address, road, spot },
      stats: {
        given: num(given.n),
        collected: num(collected.n),
        activeClaims: num(active.n),
        strikes: num(strikes.n),
      },
    });
  })
);

/* ---------------- items ---------------- */

/* a lapsed 30-minute hold counts as a no-show for the claimer and puts
   the item straight back in the feed */
async function sweepLapsedClaims(now) {
  const lapsed = await query(
    "SELECT id, claimed_by FROM items WHERE claimed_by IS NOT NULL AND collected_at IS NULL AND claim_expires_at <= $1",
    [now]
  );
  for (const it of lapsed) {
    await query("INSERT INTO no_shows (user_id, item_id, at) VALUES ($1,$2,$3)", [it.claimed_by, it.id, now]);
    await query("UPDATE items SET claimed_by = NULL, claim_expires_at = NULL WHERE id = $1", [it.id]);
  }
}

app.get(
  "/api/items",
  maybeAuth,
  wrap(async (req, res) => {
    const now = Date.now();
    await sweepLapsedClaims(now);
    const rows = (
      req.guest
        ? await query("SELECT * FROM items WHERE expires_at > $1 AND hidden_at IS NULL ORDER BY expires_at", [now])
        : await query(
            `SELECT * FROM items
             WHERE expires_at > $1
               AND (hidden_at IS NULL OR owner_id = $2)
               AND owner_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $2)
             ORDER BY expires_at`,
            [now, req.user.id]
          )
    ).map(castItem);
    const ctx = await itemContext(rows, req.user);
    res.json({ items: rows.map((it) => publicItem(it, req.user, now, ctx)), guest: req.guest });
  })
);

/* what just went, so the feed still feels alive when little is live —
   Olio's "Just Gone" carousel, minus the tease of showing an address */
app.get(
  "/api/items/recent",
  maybeAuth,
  wrap(async (req, res) => {
    const now = Date.now();
    const rows = await query(
      `SELECT title, cat, kind, road, collected_at FROM items
       WHERE collected_at IS NOT NULL AND hidden_at IS NULL
       ORDER BY collected_at DESC LIMIT 8`
    );
    res.json({
      items: rows.map((r) => ({
        title: r.title,
        cat: r.cat,
        kind: r.kind,
        road: r.road,
        agoMinutes: Math.max(1, Math.round((now - num(r.collected_at)) / 60000)),
      })),
    });
  })
);

/* Everything of yours in one place: what you're on your way to collect, what
   you already have, and what you've put out. */
app.get(
  "/api/me/stuff",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    await sweepLapsedClaims(now);
    const id = req.user.id;

    const [toCollectRows, collectedRows, listedRows] = await Promise.all([
      query("SELECT * FROM items WHERE claimed_by = $1 AND collected_at IS NULL AND claim_expires_at > $2 ORDER BY claim_expires_at", [id, now]),
      query("SELECT * FROM items WHERE claimed_by = $1 AND collected_at IS NOT NULL ORDER BY collected_at DESC", [id]),
      query("SELECT * FROM items WHERE owner_id = $1 ORDER BY (expires_at > $2) DESC, expires_at DESC LIMIT 40", [id, now]),
    ]);

    const all = [...toCollectRows, ...collectedRows, ...listedRows].map(castItem);
    const ctx = await itemContext(all, req.user);

    const thankedRows = await query("SELECT item_id FROM thanks WHERE from_id = $1", [id]);
    const thanked = new Set(thankedRows.map((t) => num(t.item_id)));

    const listedIds = listedRows.map((r) => num(r.id));
    const thanksRows = listedIds.length
      ? await query("SELECT item_id, token FROM thanks WHERE item_id = ANY($1::bigint[])", [listedIds])
      : [];
    const thanksByItem = new Map();
    for (const t of thanksRows) {
      const k = num(t.item_id);
      thanksByItem.set(k, [...(thanksByItem.get(k) || []), t.token]);
    }

    res.json({
      toCollect: toCollectRows.map(castItem).map((it) => ({
        ...publicItem(it, req.user, now, ctx),
        holdEndsAt: it.claim_expires_at,
      })),
      collected: collectedRows.map(castItem).map((it) => ({
        ...publicItem(it, req.user, now, ctx),
        address: it.address,
        collectedAt: it.collected_at,
        thanked: thanked.has(it.id),
      })),
      listed: listedRows.map(castItem).map((it) => {
        const claimActive = it.claimed_by != null && it.claim_expires_at > now;
        return {
          ...publicItem(it, req.user, now, ctx),
          collectedAt: it.collected_at,
          state: it.collected_at ? "gone" : claimActive ? "claimed" : it.expires_at > now ? "live" : "expired",
          thanks: thanksByItem.get(it.id) || [],
        };
      }),
    });
  })
);

app.post(
  "/api/items",
  auth,
  wrap(async (req, res) => {
    const {
      title = "",
      note = "",
      cat = "Furniture",
      kind = "bookcase",
      road = "",
      address = "",
      windowMinutes,
      photo = null,
      photos = null,
      spot = "doorstep",
    } = req.body || {};
    if (!title.trim()) return fail(res, 400, "Give the item a name", "title");
    if (!address.trim()) return fail(res, 400, "We need the address the claimer will collect from", "address");
    const shots = validPhotos(photos != null ? photos : photo);
    if (!shots.ok) return fail(res, 400, shots.error, "photo");
    if (!SPOTS.includes(spot)) return fail(res, 400, "Pick where the item will be waiting", "spot");
    if (BANNED_RE.test(`${title} ${note}`))
      return fail(
        res,
        400,
        "Some things can't be passed on safely — car seats, cot mattresses, and age-restricted or dangerous items aren't allowed",
        "title"
      );

    const now = Date.now();
    const windowMs = Math.max(15, Math.min(24 * 60, Number(windowMinutes) || DEFAULT_WINDOW_MIN)) * 60 * 1000;
    /* the item sits on the giver's own property, so it inherits their coordinates */
    const row = await one(
      `INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, photo, photos, spot, postcode, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        req.user.id,
        title.trim(),
        note.trim(),
        cat,
        kind,
        road.trim() || "your road",
        address.trim(),
        windowMs,
        now + windowMs,
        now,
        shots.list[0] || null,
        JSON.stringify(shots.list),
        spot,
        req.user.postcode,
        req.user.lat,
        req.user.lng,
      ]
    );

    /* remember it, so the next listing is prefilled */
    await query("UPDATE users SET address = $1, road = $2, spot = $3 WHERE id = $4", [
      address.trim(),
      road.trim() || req.user.road,
      spot,
      req.user.id,
    ]);

    const item = castItem(row);
    const wishers = await notifyMatchingWishes(item, req.user.id);
    res.status(201).json({ ...(await publicOne(item, req.user, now)), wishers });
  })
);

/* ---- editing and withdrawing your own listing ---- */

app.patch(
  "/api/items/:id",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const it = castItem(await one("SELECT * FROM items WHERE id = $1 AND owner_id = $2", [req.params.id, req.user.id]));
    if (!it) return fail(res, 404, "That isn't one of your listings");
    if (it.claimed_by != null && it.claim_expires_at > now)
      return fail(res, 409, "Someone's on their way for it — you can't change it now");

    const { title, note, cat, spot, road, address, extendMinutes } = req.body || {};
    if (title != null && !String(title).trim()) return fail(res, 400, "Give the item a name", "title");
    if (spot != null && !SPOTS.includes(spot)) return fail(res, 400, "Pick where the item will be waiting", "spot");
    if (title != null && BANNED_RE.test(`${title} ${note || ""}`))
      return fail(res, 400, "Some things can't be passed on safely", "title");

    /* a giver can add time while the window is still open, up to 24h total */
    const extra = Math.max(0, Math.min(240, Number(extendMinutes) || 0)) * 60 * 1000;
    const expires = Math.min(it.expires_at + extra, now + 24 * 60 * 60 * 1000);

    const row = await one(
      `UPDATE items SET title=$1, note=$2, cat=$3, spot=$4, road=$5, address=$6, expires_at=$7, window_ms=$8
       WHERE id=$9 RETURNING *`,
      [
        title != null ? String(title).trim() : it.title,
        note != null ? String(note).trim() : it.note,
        cat != null ? cat : it.cat,
        spot != null ? spot : it.spot,
        road != null ? String(road).trim() : it.road,
        address != null ? String(address).trim() : it.address,
        expires,
        it.window_ms + extra,
        it.id,
      ]
    );
    res.json(await publicOne(castItem(row), req.user, now));
  })
);

app.delete(
  "/api/items/:id",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const it = castItem(await one("SELECT * FROM items WHERE id = $1 AND owner_id = $2", [req.params.id, req.user.id]));
    if (!it) return fail(res, 404, "That isn't one of your listings");
    if (it.claimed_by != null && it.claim_expires_at > now)
      return fail(res, 409, "Someone's on their way for it — let them collect, or wait for the hold to lapse");
    /* expire rather than destroy, so notifications that point at it still resolve */
    await query("UPDATE items SET expires_at = $1 WHERE id = $2", [now, it.id]);
    res.json({ ok: true });
  })
);

/* ---- reporting ---- */

app.post(
  "/api/items/:id/report",
  auth,
  wrap(async (req, res) => {
    const { reason = "other", detail = "" } = req.body || {};
    if (!REPORT_REASONS.includes(reason)) return fail(res, 400, "Pick a reason", "reason");
    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it) return fail(res, 404, "That item doesn't exist");
    if (it.owner_id === req.user.id) return fail(res, 400, "That's your own listing");

    const inserted = await query(
      `INSERT INTO reports (item_id, reporter_id, reason, detail, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [it.id, req.user.id, reason, String(detail).slice(0, 500), Date.now()]
    );
    if (!inserted.length) return res.json({ ok: true, alreadyReported: true });

    const { n } = await one("SELECT COUNT(*) AS n FROM reports WHERE item_id = $1", [it.id]);
    const hidden = num(n) >= REPORTS_TO_HIDE;
    if (hidden && it.hidden_at == null)
      await query("UPDATE items SET hidden_at = $1 WHERE id = $2", [Date.now(), it.id]);
    res.json({ ok: true, hidden });
  })
);

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

/* ---- photo → draft listing ---- */

app.get("/api/autospec/status", auth, (req, res) => {
  res.json({ configured: hasCredentials });
});

app.post(
  "/api/autospec",
  auth,
  wrap(async (req, res) => {
    if (!hasCredentials) return fail(res, 503, "Photo details aren't switched on — fill them in yourself");
    const { photo } = req.body || {};
    const result = await specFromPhoto(photo);
    if (!result.ok) return fail(res, 422, result.error);
    if (result.spec.blocked)
      return fail(
        res,
        400,
        "That looks like something we can't pass on second-hand — car seats, cot mattresses and age-restricted items aren't allowed"
      );
    res.json(result.spec);
  })
);

/* ---- the wish list ---- */

app.get(
  "/api/wishes",
  auth,
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT w.id, w.keyword, w.cat, w.radius, w.created_at,
              (SELECT COUNT(*) FROM wish_hits h WHERE h.wish_id = w.id) AS found
       FROM wishes w WHERE w.user_id = $1 ORDER BY w.id DESC`,
      [req.user.id]
    );
    res.json({
      wishes: rows.map((w) => ({
        id: num(w.id),
        keyword: w.keyword,
        cat: w.cat,
        radius: w.radius,
        createdAt: num(w.created_at),
        found: num(w.found),
      })),
    });
  })
);

app.post(
  "/api/wishes",
  auth,
  wrap(async (req, res) => {
    const { keyword = "", cat = "Anything", radius = 1 } = req.body || {};
    if (!keyword.trim() && cat === "Anything")
      return fail(res, 400, "Say what you're after, or pick a category", "keyword");
    const { n } = await one("SELECT COUNT(*) AS n FROM wishes WHERE user_id = $1", [req.user.id]);
    if (num(n) >= 10) return fail(res, 400, "Ten wishes is the limit — remove one first");

    const r = Math.max(0.25, Math.min(5, Number(radius) || 1));
    const row = await one(
      "INSERT INTO wishes (user_id, keyword, cat, radius, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.user.id, keyword.trim(), cat, r, Date.now()]
    );

    /* check what is already out there before promising to watch the future */
    const wish = await one(
      "SELECT w.*, u.lat AS ulat, u.lng AS ulng FROM wishes w JOIN users u ON u.id = w.user_id WHERE w.id = $1",
      [row.id]
    );
    const alreadyOut = await notifyExistingMatches(wish);

    res.status(201).json({ id: num(row.id), keyword: keyword.trim(), cat, radius: r, found: alreadyOut, alreadyOut });
  })
);

app.delete(
  "/api/wishes/:id",
  auth,
  wrap(async (req, res) => {
    await query("DELETE FROM wishes WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    res.json({ ok: true });
  })
);

/* Before you list: how many neighbours already want this? A giver deciding
   whether it's worth photographing the thing deserves to know someone is
   waiting for it. */
app.post(
  "/api/wishes/demand",
  auth,
  wrap(async (req, res) => {
    const { title = "", note = "", cat = "Furniture" } = req.body || {};
    if (req.user.lat == null) return res.json({ wishers: 0 });
    const wishers = await wishersFor({ title, note, road: "", cat, lat: req.user.lat, lng: req.user.lng }, req.user.id);
    res.json({ wishers });
  })
);

/* ---- notifications ---- */

app.get(
  "/api/notifications",
  auth,
  wrap(async (req, res) => {
    const rows = await query(
      "SELECT id, item_id, title, body, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 40",
      [req.user.id]
    );
    res.json({
      notifications: rows.map((n) => ({
        id: num(n.id),
        itemId: num(n.item_id),
        title: n.title,
        body: n.body,
        createdAt: num(n.created_at),
        read: n.read_at != null,
      })),
      unread: rows.filter((n) => n.read_at == null).length,
    });
  })
);

app.post(
  "/api/notifications/read",
  auth,
  wrap(async (req, res) => {
    await query("UPDATE notifications SET read_at = $1 WHERE user_id = $2 AND read_at IS NULL", [Date.now(), req.user.id]);
    res.json({ ok: true });
  })
);

/* EventSource can't send an Authorization header, so the token comes as a
   query parameter over the same origin. */
app.get(
  "/api/stream",
  wrap(async (req, res) => {
    const row = await one("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1", [
      req.query.token || "",
    ]);
    if (!row) return fail(res, 401, "Signed out — sign in again.");
    const userId = num(row.id);

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    addStream(userId, res);

    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      dropStream(userId, res);
    });
  })
);

/* ---- claiming ---- */

app.post(
  "/api/items/:id/claim",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    await sweepLapsedClaims(now);

    const outcome = await tx(async (q) => {
      /* three lapsed holds in 30 days pauses claiming — keeps the one-tap
         claim honest without ratings or chat */
      const [{ n: strikes }] = await q("SELECT COUNT(*) AS n FROM no_shows WHERE user_id = $1 AND at > $2", [
        req.user.id,
        now - 30 * 24 * 60 * 60 * 1000,
      ]);
      if (num(strikes) >= 3)
        return { status: 403, error: "Three claims went uncollected this month — claiming is paused for now" };

      /* anti-hoarding: hold a few at a time, not the whole street */
      const [{ n: active }] = await q(
        "SELECT COUNT(*) AS n FROM items WHERE claimed_by = $1 AND collected_at IS NULL AND claim_expires_at > $2",
        [req.user.id, now]
      );
      if (num(active) >= MAX_ACTIVE_CLAIMS)
        return { status: 429, error: `You're holding ${num(active)} already — collect one before claiming another` };

      const [{ n: monthly }] = await q("SELECT COUNT(*) AS n FROM items WHERE claimed_by = $1 AND claim_expires_at > $2", [
        req.user.id,
        now - 28 * 24 * 60 * 60 * 1000,
      ]);
      if (num(monthly) >= CLAIMS_PER_28_DAYS)
        return {
          status: 429,
          error: "That's a lot of claims this month — give someone else a turn and come back in a few days",
        };

      /* lock the row so two neighbours tapping at once cannot both win */
      const [raw] = await q("SELECT * FROM items WHERE id = $1 FOR UPDATE", [req.params.id]);
      const it = castItem(raw);
      if (!it) return { status: 404, error: "That item doesn't exist" };
      if (it.hidden_at != null) return { status: 410, error: "That listing is under review" };
      if (it.expires_at <= now) return { status: 410, error: "Too late — the window has closed" };
      if (it.owner_id === req.user.id) return { status: 400, error: "That one's already yours — you listed it" };
      const claimActive = it.claimed_by != null && it.claim_expires_at > now;
      if (claimActive && it.claimed_by !== req.user.id)
        return { status: 409, error: "Someone beat you to it — it's already claimed" };

      const [updated] = await q("UPDATE items SET claimed_by = $1, claim_expires_at = $2 WHERE id = $3 RETURNING *", [
        req.user.id,
        now + CLAIM_HOLD_MS,
        it.id,
      ]);
      return { item: castItem(updated) };
    });

    if (outcome.error) return fail(res, outcome.status, outcome.error);
    res.json(await publicOne(outcome.item, req.user, now));
  })
);

/* Handing a claim back is always better than ghosting: the item returns to
   the feed immediately and the claimer keeps a clean record. Too Good To Go
   makes cancelling final at a cliff edge; here honesty is never punished. */
app.post(
  "/api/items/:id/release",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it || it.claimed_by !== req.user.id || it.collected_at != null)
      return fail(res, 400, "That isn't yours to hand back");
    const row = await one("UPDATE items SET claimed_by = NULL, claim_expires_at = NULL WHERE id = $1 RETURNING *", [it.id]);
    res.json(await publicOne(castItem(row), req.user, now));
  })
);

/* claimer confirms the pickup happened — the item leaves the feed and the
   hold can never lapse into a no-show */
app.post(
  "/api/items/:id/collected",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it || it.claimed_by !== req.user.id || it.collected_at != null)
      return fail(res, 400, "That item isn't yours to confirm");
    await query("UPDATE items SET collected_at = $1, expires_at = $1 WHERE id = $2", [now, it.id]);
    res.json({ ok: true });
  })
);

/* ---- watchlist ---- */

app.post(
  "/api/items/:id/save",
  auth,
  wrap(async (req, res) => {
    const it = await one("SELECT id FROM items WHERE id = $1", [req.params.id]);
    if (!it) return fail(res, 404, "That item doesn't exist");
    await query("INSERT INTO saves (user_id, item_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
      req.user.id,
      it.id,
      Date.now(),
    ]);
    res.json({ ok: true, saved: true });
  })
);

app.delete(
  "/api/items/:id/save",
  auth,
  wrap(async (req, res) => {
    await query("DELETE FROM saves WHERE user_id = $1 AND item_id = $2", [req.user.id, req.params.id]);
    res.json({ ok: true, saved: false });
  })
);

/* ---- thanks ----
   A fixed set of tokens, so gratitude never becomes a chat box. Only the
   person who collected it can send one, and only once. */
const THANK_TOKENS = {
  wave: "gave you a wave",
  plant: "sent you a plant",
  brew: "owes you a brew",
  star: "says you're a star",
};

app.post(
  "/api/items/:id/thanks",
  auth,
  wrap(async (req, res) => {
    const { token: kind = "wave" } = req.body || {};
    if (!THANK_TOKENS[kind]) return fail(res, 400, "Pick a thank-you", "token");
    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it || it.claimed_by !== req.user.id || it.collected_at == null)
      return fail(res, 400, "You can thank someone once you've collected from them");

    const now = Date.now();
    const inserted = await query(
      `INSERT INTO thanks (item_id, from_id, to_id, token, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [it.id, req.user.id, it.owner_id, kind, now]
    );
    if (!inserted.length) return fail(res, 409, "You've already thanked them for this");

    const body = `${req.user.name.split(/\s+/)[0]} ${THANK_TOKENS[kind]} for the ${it.title.toLowerCase()}.`;
    const row = await one(
      "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [it.owner_id, it.id, "Thank you", body, now]
    );
    pushTo(it.owner_id, { type: "alert", id: num(row.id), itemId: it.id, title: "Thank you", body, createdAt: now });
    res.json({ ok: true });
  })
);

/* ---- blocking ---- */

app.post(
  "/api/users/:id/block",
  auth,
  wrap(async (req, res) => {
    const target = Number(req.params.id);
    if (target === req.user.id) return fail(res, 400, "You can't block yourself");
    if (!(await one("SELECT id FROM users WHERE id = $1", [target]))) return fail(res, 404, "No such neighbour");
    await query("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
      req.user.id,
      target,
      Date.now(),
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  "/api/users/:id/block",
  auth,
  wrap(async (req, res) => {
    await query("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2", [req.user.id, req.params.id]);
    res.json({ ok: true });
  })
);

app.get(
  "/api/blocks",
  auth,
  wrap(async (req, res) => {
    const rows = await query(
      "SELECT u.id, u.name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at DESC",
      [req.user.id]
    );
    res.json({ blocked: rows.map((r) => ({ id: num(r.id), name: String(r.name).split(/\s+/)[0] })) });
  })
);

/* ---- your data ----
   UK GDPR: people can take their data out and have their account erased.
   Olio keeps listings and ratings after deletion for its impact accounting;
   we anonymise instead, which keeps the diversion figures honest without
   holding on to a name, an email or an address. */

app.get(
  "/api/me/export",
  auth,
  wrap(async (req, res) => {
    const id = req.user.id;
    const [listings, claims, wishList, watchlist, notifications, blocked, noShows] = await Promise.all([
      query("SELECT title, note, cat, road, address, created_at, expires_at, collected_at FROM items WHERE owner_id = $1", [id]),
      query("SELECT title, road, claim_expires_at, collected_at FROM items WHERE claimed_by = $1", [id]),
      query("SELECT keyword, cat, radius, created_at FROM wishes WHERE user_id = $1", [id]),
      query("SELECT item_id, created_at FROM saves WHERE user_id = $1", [id]),
      query("SELECT title, body, created_at FROM notifications WHERE user_id = $1", [id]),
      query("SELECT blocked_id, created_at FROM blocks WHERE blocker_id = $1", [id]),
      query("SELECT item_id, at FROM no_shows WHERE user_id = $1", [id]),
    ]);
    res.json({
      exportedAt: new Date().toISOString(),
      account: { name: req.user.name, email: req.user.email, postcode: req.user.postcode, joined: req.user.created_at },
      listings,
      claims,
      wishList,
      watchlist,
      notifications,
      blocked,
      noShows,
    });
  })
);

app.delete(
  "/api/me",
  auth,
  wrap(async (req, res) => {
    const id = req.user.id;
    const now = Date.now();
    await tx(async (q) => {
      /* live listings come down; anything already collected is anonymised so
         the neighbourhood's diversion total stays true */
      await q("UPDATE items SET expires_at = $1 WHERE owner_id = $2 AND collected_at IS NULL", [now, id]);
      await q("UPDATE items SET claimed_by = NULL, claim_expires_at = NULL WHERE claimed_by = $1 AND collected_at IS NULL", [id]);
      await q("UPDATE items SET address = 'removed' WHERE owner_id = $1", [id]);
      await q("DELETE FROM wish_hits WHERE wish_id IN (SELECT id FROM wishes WHERE user_id = $1)", [id]);
      await q("DELETE FROM wishes WHERE user_id = $1", [id]);
      await q("DELETE FROM notifications WHERE user_id = $1", [id]);
      await q("DELETE FROM saves WHERE user_id = $1", [id]);
      await q("DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1", [id]);
      await q("DELETE FROM sessions WHERE user_id = $1", [id]);
      await q(
        "UPDATE users SET name = 'Former neighbour', email = $1, postcode = '', lat = NULL, lng = NULL, address = NULL, road = NULL, password_hash = $2 WHERE id = $3",
        [`deleted-${id}-${now}@doorstep.invalid`, newToken(), id]
      );
    });
    res.json({ ok: true });
  })
);

/* ---- what happens when nobody claims it ---- */

/* Verified in earlier research: Hackney routes reusable furniture to a charity
   partner and charges £15 for up to five bulky items; Lambeth uses Emmaus;
   BHF and Traid collect free London-wide. Charity first — free, and it keeps
   the item in use. Council booking last: it costs money and ends in disposal. */
const FALLBACK_OPTIONS = [
  {
    key: "bhf",
    name: "British Heart Foundation",
    blurb:
      "Free collection of furniture and electricals across London. Upholstery needs its fire label attached or they'll refuse it.",
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

app.get(
  "/api/items/:id/fallback",
  auth,
  wrap(async (req, res) => {
    const it = await one("SELECT * FROM items WHERE id = $1 AND owner_id = $2", [req.params.id, req.user.id]);
    if (!it) return fail(res, 404, "That isn't one of your listings");
    res.json({
      title: it.title,
      options: FALLBACK_OPTIONS.filter((o) => !o.cats || o.cats.includes(it.cat)),
    });
  })
);

/* ---- diversion reporting ---- */

app.get(
  "/api/impact",
  auth,
  wrap(async (req, res) => {
    const [you, neighbourhood] = await Promise.all([impactFor({ userId: req.user.id }), impactFor({})]);
    res.json({ you, neighbourhood });
  })
);

app.use((req, res) => fail(res, 404, "No such endpoint"));

/* Anything that throws inside a handler lands here rather than hanging. */
app.use((err, req, res, next) => {
  console.error("Unhandled:", err);
  if (res.headersSent) return next(err);
  fail(res, 500, "Something went wrong at our end. Try again in a moment.");
});

const start = async () => {
  await initDb();
  await refreshSeed();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `Doorstep API listening on http://localhost:${PORT} (${process.env.DATABASE_URL ? "Postgres" : "PGlite"})`
    );
  });
};

start().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
