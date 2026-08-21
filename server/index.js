import express from "express";
import compression from "compression";
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
  photoLibrary,
} from "./db.js";
import { geocodePostcode, milesBetween, formatMiles, approxCoords, FALLBACK } from "./geo.js";
import { lookupPostcode, hasAddressProvider } from "./address.js";
import { areaFor, streetKey, streetName } from "./geo.js";
import { rainOutlook, rainWarning } from "./weather.js";
import { aiConfigured, understand, suggestReplies, translate } from "./ai.js";
import { keywordMatches } from "./matching.js";
import { specFromPhoto, hasCredentials } from "./autospec.js";
import { checkListing, hasCredentials as hasModerationCredentials } from "./moderate.js";
import { impactFor, kgForCat } from "./impact.js";

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
/* A spotted kerbside pile is nobody's listing: the poster can't vouch for it,
   so the bar for killing one is lower — two reports and it's gone, because
   the likeliest complaints are "that's someone's property" or "that's
   bin-day waste", and both need acting on fast. */
const SPOT_REPORTS_TO_HIDE = 2;
/* a pavement pile rarely survives the afternoon, so a spot lives two hours, hard */
const SPOT_LIFE_MS = 2 * 60 * 60 * 1000;
/* and nobody needs to be the neighbourhood's full-time kerb correspondent */
const MAX_LIVE_SPOTS = 3;
const REPORT_REASONS = ["pavement", "unsafe", "not-free", "sold-on", "offensive", "gone", "other"];

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const SPOTS = ["doorstep", "front garden", "porch", "building lobby", "buzz and collect"];

/* Two kinds of listing, because food carries obligations that a bookcase
   does not: a use-by date is a legal line, not a nicety. */
const TYPES = ["food", "nonfood"];
const NONFOOD_CATS = ["Furniture", "Kids", "Garden", "Electricals"];
const FOOD_CATS = ["Bakery", "Fruit & veg", "Dairy", "Store cupboard", "Ready meals", "Drinks"];

/* Food that cannot be passed between households safely. Raw meat and fish,
   unpasteurised dairy and reheated rice are the standard high-risk list;
   baby formula is regulated separately and is not ours to redistribute. */
const UNSAFE_FOOD_RE = new RegExp(
  [
    "raw meat", "raw chicken", "raw beef", "raw pork", "raw fish", "raw egg",
    "unpasteuris", "unpasteuriz", "raw milk",
    "reheated rice", "cooked rice",
    "baby formula", "infant formula", "follow-on milk",
    "home-?made preserve", "home-?canned",
  ].join("|"),
  "i"
);

/* A use-by date is the hard line: past it, food is not legal to pass on.
   Best-before is quality, not safety, so it is not enforced here. */
const FOOD_MAX_WINDOW_MIN = 8 * 60;

/* What a neighbour actually needs to know before walking over: will it fit
   through the door, does it work, is it big enough to need two people. The
   fields differ by category because a highchair and a floor lamp raise
   different questions. */
const DETAIL_FIELDS = {
  common: [
    { key: "condition", label: "Condition", type: "choice", options: ["New", "As good as new", "Good", "Fair", "Well used"] },
    { key: "carry", label: "Getting it home", type: "choice", options: ["One person can carry it", "Two people", "Needs a car or van"] },
  ],
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
    { key: "allergens", label: "Contains", type: "text", hint: "Nuts, milk, gluten and so on — copy what the packet says" },
  ],
};

/* which fields apply to a listing */
function fieldsFor(type, cat) {
  const specific = type === "food" ? DETAIL_FIELDS.food : DETAIL_FIELDS[cat] || [];
  return [...DETAIL_FIELDS.common, ...specific];
}

/* keep only recognised keys, with sane values — this text is shown as fact */
function cleanDetails(type, cat, input) {
  if (!input || typeof input !== "object") return {};
  const out = {};
  for (const f of fieldsFor(type, cat)) {
    const v = input[f.key];
    if (v == null || v === "") continue;
    if (f.type === "choice") {
      if (f.options.includes(v)) out[f.key] = v;
    } else if (f.type === "cm") {
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n > 0 && n < 1000) out[f.key] = n;
    } else {
      out[f.key] = String(v).trim().slice(0, 60);
    }
  }
  return out;
}

/* which drawn glyph stands in when a listing has no photograph */
const FOOD_KIND = {
  Bakery: "bread",
  "Fruit & veg": "veg",
  Dairy: "dairy",
  "Store cupboard": "tin",
  "Ready meals": "meal",
  Drinks: "drink",
};
const NONFOOD_KIND = { Furniture: "chairs", Kids: "toys", Garden: "garden", Electricals: "bookcase" };

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

/* Listings carry their photographs inline as data URLs, and a page of them
   repeats the same illustration many times over. Gzip collapses that to a
   fraction of the wire size, which matters most on a phone. */
app.use(compression());
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

/* The seeded illustrations are shared across hundreds of listings, so they
   are served as ordinary images the browser can cache once, rather than
   repeated inside every listing in every response. They never change, hence
   the immutable year. */
app.get("/api/photos/:slug", (req, res) => {
  const url = photoLibrary()[String(req.params.slug).replace(/[^a-z0-9-]/gi, "")];
  if (!url) return fail(res, 404, "No such picture");
  const [, data] = url.split("base64,");
  const buf = Buffer.from(data, "base64");
  res.set({
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(buf.length),
  });
  res.end(buf);
});

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
    use_by: num(it.use_by),
    portions: num(it.portions),
    event_id: num(it.event_id),
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
  const haystack = `${item.title} ${item.note} ${item.road}`;
  if (wish.keyword && !keywordMatches(wish.keyword, haystack)) return null;
  if (wish.cat !== "Anything" && wish.cat !== item.cat) return null;
  if (wish.ulat == null || item.lat == null) return null;
  const miles = milesBetween(wish.ulat, wish.ulng, item.lat, item.lng);
  return miles <= wish.radius ? miles : null;
}

/* Tell one wisher about one item, at most once ever — remembered against the
   person, not the wish row, so removing a wish and adding it back doesn't
   replay alerts they have already read. */
async function tellWisher(wish, item, miles, { alreadyLive = false } = {}) {
  const now = Date.now();
  const claimed = await query(
    "INSERT INTO wish_told (user_id, item_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id",
    [wish.user_id, item.id, now]
  );
  /* the counter is per wish, so it still records the match either way */
  await query("INSERT INTO wish_hits (wish_id, item_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
    wish.id,
    item.id,
    now,
  ]);
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
       WHERE expires_at > $1 AND hidden_at IS NULL AND collected_at IS NULL AND NOT wanted
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

/* ---- follows ---- */

/* Someone listed something: tell the neighbours who follow them. This is the
   Vinted pattern — trust in a person's taste rather than a keyword — so it
   fires on every listing, with no radius or category filter. Anyone the wish
   system has already told about this item is skipped (wish_told remembers),
   because nobody should hear the same doorbell twice. */
async function notifyFollowers(item, giver) {
  const followers = await query(
    `SELECT u.id, u.lat, u.lng FROM follows f JOIN users u ON u.id = f.follower_id
     WHERE f.giver_id = $1
       AND u.id NOT IN (SELECT user_id FROM wish_told WHERE item_id = $2)
       AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = $1)
       AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1)`,
    [giver.id, item.id]
  );
  const firstName = String(giver.name).split(/\s+/)[0];
  const now = Date.now();
  for (const f of followers) {
    /* distance is a courtesy, not a filter — omitted when either side lacks coordinates */
    const miles = f.lat != null && item.lat != null ? milesBetween(f.lat, f.lng, item.lat, item.lng) : null;
    const body =
      miles != null
        ? `${firstName} just listed this — you follow their giveaways. ${formatMiles(miles)} away on ${item.road}.`
        : `${firstName} just listed this — you follow their giveaways.`;
    const row = await one(
      "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [f.id, item.id, item.title, body, now]
    );
    pushTo(num(f.id), { type: "alert", id: num(row.id), itemId: num(item.id), title: item.title, body, createdAt: now });
  }
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
    /* the address travels with the session, so the give form can fill itself
       in the moment someone lists their first thing */
    user: {
      id: num(user.id),
      name: user.name,
      email: user.email,
      postcode: user.postcode,
      lat: user.lat,
      lng: user.lng,
      address: user.address || null,
      road: user.road || null,
      spot: user.spot || null,
    },
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
  if (!ownerIds.length) return { givers: new Map(), saved: new Set(), following: new Set(), lineages: new Map() };

  const givers = await query(
    `SELECT u.id, u.name, u.lat, u.postcode,
            (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id AND i.collected_at IS NOT NULL) AS handed,
            (SELECT COUNT(*) FROM ratings r WHERE r.ratee_id = u.id) AS rated,
            (SELECT AVG(stars) FROM ratings r WHERE r.ratee_id = u.id) AS stars,
            (SELECT COUNT(*) FROM follows f WHERE f.giver_id = u.id) AS followers
     FROM users u WHERE u.id = ANY($1::bigint[])`,
    [ownerIds]
  );
  const saved = itemIds.length
    ? await query("SELECT item_id FROM saves WHERE user_id = $1 AND item_id = ANY($2::bigint[])", [user.id, itemIds])
    : [];
  /* who this viewer follows, fetched once for the page like saves */
  const followed = await query("SELECT giver_id FROM follows WHERE follower_id = $1 AND giver_id = ANY($2::bigint[])", [
    user.id,
    ownerIds,
  ]);
  const hands = itemIds.length
    ? await query("SELECT item_id, user_id FROM claim_requests WHERE item_id = ANY($1::bigint[])", [itemIds])
    : [];
  const handCounts = new Map();
  const handsUp = new Set();
  for (const h of hands) {
    handCounts.set(num(h.item_id), (handCounts.get(num(h.item_id)) || 0) + 1);
    if (num(h.user_id) === user.id) handsUp.add(num(h.item_id));
  }

  /* Passports, like givers and saves, are fetched once for the whole page:
     most items carry no lineage, so this usually costs nothing at all, and a
     page full of storied items still costs two queries rather than one per
     card. */
  const lineageIds = [...new Set(items.map((i) => i.lineage_id).filter(Boolean))];
  const lineages = new Map();
  if (lineageIds.length) {
    const stats = await query(
      `SELECT lineage_id, COUNT(*) AS homes, MIN(created_at) AS first
       FROM items WHERE lineage_id = ANY($1::text[]) GROUP BY lineage_id`,
      [lineageIds]
    );
    const noteRows = await query(
      `SELECT lineage_id, body, created_at FROM lineage_notes
       WHERE lineage_id = ANY($1::text[]) ORDER BY created_at, id`,
      [lineageIds]
    );
    /* the story reads oldest line first, and five lines is a story — more is a forum */
    const notesBy = new Map();
    for (const n of noteRows) {
      const list = notesBy.get(n.lineage_id) || [];
      if (list.length < 5) list.push({ body: n.body, at: num(n.created_at) });
      notesBy.set(n.lineage_id, list);
    }
    for (const s of stats) {
      lineages.set(s.lineage_id, {
        homes: num(s.homes),
        firstSharedAt: num(s.first),
        notes: notesBy.get(s.lineage_id) || [],
      });
    }
  }

  return {
    givers: new Map(
      givers.map((g) => [
        num(g.id),
        {
          id: num(g.id),
          name: String(g.name).split(/\s+/)[0],
          area: areaFor(g.postcode),
          verified: g.lat != null,
          handed: num(g.handed),
          /* an average of one review is an anecdote; three is a signal */
          stars: num(g.rated) >= 3 ? Math.round(Number(g.stars) * 10) / 10 : null,
          rated: num(g.rated),
          followers: num(g.followers),
        },
      ])
    ),
    saved: new Set(saved.map((s) => num(s.item_id))),
    following: new Set(followed.map((f) => num(f.giver_id))),
    handsUp,
    handCounts,
    lineages,
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
  const lastOrders = inLastOrders(it, now);
  /* pin is snapped to a ~110m grid until the viewer has a right to the door —
     or until last orders, when the whole street may as well know */
  const pin = it.lat != null ? (mine || owner || lastOrders ? { lat: it.lat, lng: it.lng } : approxCoords(it.lat, it.lng)) : null;
  return {
    id: it.id,
    title: it.title,
    note: it.note,
    cat: it.cat,
    kind: it.kind,
    type: it.type || "nonfood",
    wanted: it.wanted === true,
    claimMode: it.claim_mode || "instant",
    demo: it.demo === true,
    lastOrders,
    underCover: it.under_cover === true,
    dibs: it.dibs === true,
    dibsOpensAt: user.guest ? 0 : Math.max(0, dibsOpensAt(it, user) > now ? dibsOpensAt(it, user) : 0),
    handUp: Boolean(ctx && ctx.handsUp && ctx.handsUp.has(it.id)),
    hands: ctx && ctx.handCounts ? ctx.handCounts.get(it.id) || 0 : 0,
    useBy: num(it.use_by),
    portions: num(it.portions) || 1,
    dist: miles != null ? formatMiles(miles) : it.dist,
    miles,
    road: it.road,
    spot: it.spot,
    photo: photoList(it)[0] || null,
    photos: photoList(it),
    photoRef: it.photo_ref || null,
    details: (() => {
      try {
        return it.details ? JSON.parse(it.details) : {};
      } catch {
        return {};
      }
    })(),
    owner,
    lat: pin ? pin.lat : null,
    lng: pin ? pin.lng : null,
    giver: ctx.givers.has(it.owner_id)
      ? { ...ctx.givers.get(it.owner_id), following: ctx.following.has(num(it.owner_id)) }
      : null,
    /* null for the vast majority of items that have never been relisted —
       a passport only exists once a thing has a story to tell */
    passport: it.lineage_id ? (ctx.lineages && ctx.lineages.get(it.lineage_id)) || null : null,
    saved: ctx.saved.has(it.id),
    /* null for almost everything: only things put out for an open doorstep
       belong to one, and the client shows the sale's badge off the back of it */
    eventId: num(it.event_id) || null,
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

/* ---------------- addresses ---------------- */

/* Someone types their postcode; we tell them what we can about it. With a
   licensed provider configured this returns the actual houses to pick from.
   Without one it returns the verified postcode and the street name, and the
   person adds their own house number — which is what the government's own
   address-entry guidance recommends as a sound default. */
app.get(
  "/api/address",
  wrap(async (req, res) => {
    const postcode = String(req.query.postcode || "").trim();
    if (!POSTCODE_RE.test(postcode))
      return fail(res, 400, "Enter a full UK postcode, like E8 3EP", "postcode");

    const found = await lookupPostcode(postcode);
    if (!found.ok) {
      if (found.reason === "invalid")
        return fail(res, 404, "We can't find that postcode — double-check it", "postcode");
      return fail(res, 503, "Address lookup is having a moment — type your address instead", "postcode");
    }
    res.json(found);
  })
);

/* ---------------- auth ---------------- */

app.post(
  "/api/auth/signup",
  wrap(async (req, res) => {
    const {
      name = "",
      email = "",
      postcode = "",
      password = "",
      address = "",
      road = "",
      uprn = null,
      city = "",
      county = "",
      country = "",
      acceptPrivacy = false,
    } = req.body || {};
    /* consent is a fact with a timestamp, not a checkbox that vanishes */
    if (acceptPrivacy !== true)
      return fail(res, 400, "Please read and accept the privacy policy first", "privacy");
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

    /* how sure we are of the address, so records can be upgraded later
       without asking anyone to type theirs again */
    const level = uprn ? "uprn" : String(address).trim() ? "postcode" : "none";

    const row = await one(
      `INSERT INTO users (name, email, postcode, password_hash, created_at, lat, lng, address, road, uprn, address_verified, city, county, country, privacy_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        name.trim(),
        foldEmail(email),
        postcode.trim().toUpperCase(),
        hashPassword(password),
        Date.now(),
        lat,
        lng,
        String(address).trim() || null,
        String(road).trim() || null,
        uprn ? String(uprn) : null,
        level,
        /* typed or derived — either way the postcode's own answer is the
           fallback, so nobody is forced to spell out where London is */
        String(city).trim() || (geo.ok && geo.city) || null,
        String(county).trim() || (geo.ok && geo.county) || null,
        String(country).trim() || (geo.ok && geo.country) || null,
        Date.now(),
      ]
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
    const { address, road, spot, away } = req.body || {};
    if (spot != null && !SPOTS.includes(spot)) return fail(res, 400, "Pick where things usually wait", "spot");
    await query("UPDATE users SET address = $1, road = $2, spot = $3 WHERE id = $4", [
      address != null ? String(address).trim() : req.user.address,
      road != null ? String(road).trim() : req.user.road,
      spot != null ? spot : req.user.spot,
      req.user.id,
    ]);
    /* holiday mode: your listings step out of the feed until you're back —
       Vinted's pattern, so nobody knocks on an empty house */
    if (away != null) {
      await query("UPDATE users SET away_until = $1 WHERE id = $2", [
        away ? Date.now() + 365 * 24 * 60 * 60 * 1000 : null,
        req.user.id,
      ]);
    }
    const u = await one("SELECT address, road, spot, away_until FROM users WHERE id = $1", [req.user.id]);
    res.json({ ok: true, address: u.address, road: u.road, spot: u.spot, away: u.away_until != null && num(u.away_until) > Date.now() });
  })
);

/* Badges with the progress showing. Olio's are opaque — users say there is
   no way to know how far the next one is — so every ladder here says "3 of
   5" out loud. Recognition is the only payment a giver receives. */
const BADGE_LADDERS = [
  {
    track: "given",
    tiers: [
      { need: 1, label: "First give", blurb: "One thing saved from the bin" },
      { need: 5, label: "Streetkeeper", blurb: "Five things rehomed" },
      { need: 15, label: "Hackney hero", blurb: "Fifteen things rehomed" },
    ],
  },
  {
    track: "collected",
    tiers: [
      { need: 1, label: "First collect", blurb: "Claimed, collected, done" },
      { need: 5, label: "Regular", blurb: "Five collections made" },
      { need: 15, label: "Rehomer", blurb: "Fifteen things given a second life" },
    ],
  },
  {
    track: "thanks",
    tiers: [
      { need: 1, label: "Thanked", blurb: "A neighbour said so" },
      { need: 5, label: "Neighbourhood favourite", blurb: "Five thank-yous received" },
    ],
  },
];

function badgeShelf(counts) {
  return BADGE_LADDERS.map(({ track, tiers }) => {
    const have = counts[track] || 0;
    const earned = tiers.filter((t) => have >= t.need);
    const next = tiers.find((t) => have < t.need) || null;
    return {
      track,
      earned: earned.map((t) => t.label),
      current: earned.length ? earned[earned.length - 1].label : null,
      next: next ? { label: next.label, blurb: next.blurb, have: Math.min(have, next.need), need: next.need } : null,
    };
  });
}

app.get(
  "/api/me",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const { id, name, email, postcode, lat, lng, created_at, address, road, spot } = req.user;
    const [given, collected, active, strikes, thanked] = await Promise.all([
      one("SELECT COUNT(*) AS n FROM items WHERE owner_id = $1", [id]),
      one("SELECT COUNT(*) AS n FROM items WHERE claimed_by = $1 AND collected_at IS NOT NULL", [id]),
      one("SELECT COUNT(*) AS n FROM items WHERE claimed_by = $1 AND collected_at IS NULL AND claim_expires_at > $2", [id, now]),
      one("SELECT COUNT(*) AS n FROM no_shows WHERE user_id = $1 AND at > $2", [id, now - 30 * 24 * 60 * 60 * 1000]),
      one("SELECT COUNT(*) AS n FROM thanks WHERE to_id = $1", [id]),
    ]);
    res.json({
      user: {
        id,
        name,
        email,
        postcode,
        lat,
        lng,
        memberSince: created_at,
        address,
        road,
        spot,
        away: req.user.away_until != null && num(req.user.away_until) > now,
        area: areaFor(postcode),
        city: req.user.city || null,
        county: req.user.county || null,
        country: req.user.country || null,
      },
      badges: badgeShelf({ given: num(given.n), collected: num(collected.n), thanks: num(thanked.n) }),
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
    `SELECT i.id, i.claimed_by, i.title, i.owner_id, i.expires_at FROM items i
     WHERE i.claimed_by IS NOT NULL AND i.collected_at IS NULL AND i.claim_expires_at <= $1`,
    [now]
  );
  for (const it of lapsed) {
    await query("INSERT INTO no_shows (user_id, item_id, at) VALUES ($1,$2,$3)", [it.claimed_by, it.id, now]);
    await query("UPDATE items SET claimed_by = NULL, claim_expires_at = NULL WHERE id = $1", [it.id]);

    /* both sides deserve to hear it, not discover it */
    if (num(it.expires_at) > now) {
      const noteBody = "The hold lapsed — it's back up for grabs.";
      const giverRow = await one(
        "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [it.owner_id, it.id, it.title, noteBody, now]
      );
      pushTo(num(it.owner_id), {
        type: "alert",
        id: num(giverRow.id),
        itemId: num(it.id),
        title: it.title,
        body: noteBody,
        createdAt: now,
      });
    }
    const conv = await one("SELECT id FROM conversations WHERE item_id = $1 AND claimer_id = $2", [it.id, it.claimed_by]);
    if (conv) await threadNote(num(conv.id), "The 30-minute hold ran out, so it's back up for grabs. Claim it again if you're still coming.", now);
  }
}

/* The last half hour of an unclaimed window is not a deadline, it is last
   orders: the pin sharpens for everyone and the people who cared — savers,
   wishers — get one bell. Every competitor's endgame is silence; this one
   has a designed ending. Food is excluded: urgency and food safety don't mix. */
const LAST_ORDERS_MS = 30 * 60 * 1000;

const inLastOrders = (it, now) =>
  !it.wanted &&
  (it.type || "nonfood") !== "food" &&
  it.collected_at == null &&
  it.hidden_at == null &&
  !(it.claimed_by != null && it.claim_expires_at > now) &&
  it.expires_at > now &&
  it.expires_at - now <= LAST_ORDERS_MS;

async function ringLastOrders(now) {
  const entering = await query(
    `SELECT * FROM items
     WHERE NOT last_orders_told AND NOT wanted AND type <> 'food'
       AND collected_at IS NULL AND hidden_at IS NULL
       AND (claimed_by IS NULL OR claim_expires_at <= $1)
       AND expires_at > $1 AND expires_at - $1 <= ${LAST_ORDERS_MS}`,
    [now]
  );
  for (const raw of entering) {
    const it = castItem(raw);
    await query("UPDATE items SET last_orders_told = TRUE WHERE id = $1", [it.id]);

    /* one bell for everyone who showed they cared */
    const savers = await query("SELECT user_id FROM saves WHERE item_id = $1 AND user_id <> $2", [it.id, it.owner_id]);
    const care = new Set(savers.map((r) => num(r.user_id)));
    const wishes = await query(WISHES_SQL, [it.owner_id]);
    for (const w of wishes) if (wishMatches(w, it) != null) care.add(num(w.user_id));

    const minsLeft = Math.max(1, Math.round((it.expires_at - now) / 60000));
    const body = `Last orders — ${minsLeft} min left and it's still there, on ${it.road}.`;
    for (const userId of care) {
      const row = await one(
        "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [userId, it.id, it.title, body, now]
      );
      pushTo(userId, { type: "alert", id: num(row.id), itemId: num(it.id), title: it.title, body, createdAt: now });
    }
  }
}

/* First dibs: for the first quarter hour the claim belongs to the streets
   around the doorstep, then to the mile, then to everyone. Freegle fights
   the van-driving cherry-picker with a policy; geometry does it better.
   Returns when the claim opens for this viewer — zero means it's open. */
const DIBS_TIERS = [
  { untilMin: 15, withinMiles: 0.25 },
  { untilMin: 30, withinMiles: 1 },
];

function dibsOpensAt(it, user) {
  if (!it.dibs || it.lat == null || user.lat == null) return 0;
  const miles = milesBetween(user.lat, user.lng, it.lat, it.lng);
  for (const tier of DIBS_TIERS) {
    if (miles <= tier.withinMiles) {
      /* inside this ring: open from the start of its window */
      const prev = DIBS_TIERS[DIBS_TIERS.indexOf(tier) - 1];
      return prev ? it.created_at + prev.untilMin * 60 * 1000 : 0;
    }
  }
  return it.created_at + DIBS_TIERS[DIBS_TIERS.length - 1].untilMin * 60 * 1000;
}

/* The feed is paged: a neighbourhood with a few hundred live listings would
   otherwise send every photograph in one response. */
const PAGE = 24;

app.get(
  "/api/items",
  maybeAuth,
  wrap(async (req, res) => {
    const now = Date.now();
    await sweepLapsedClaims(now);
    await ringLastOrders(now);

    const limit = Math.max(1, Math.min(60, Number(req.query.limit) || PAGE));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const nearest = req.query.sort === "near" && req.user.lat != null;

    /* Filtering belongs in the query, not the browser: with a few hundred
       listings, searching only what happened to be on the current page would
       quietly miss most of the neighbourhood. */
    const params = [now];
    let clause = "expires_at > $1";
    /* offers and asks are different feeds — nobody wants them shuffled */
    clause += req.query.asks === "1" ? " AND wanted" : " AND NOT wanted";
    /* a giver who is away has stepped out — their doorstep has nothing on it */
    clause += ` AND owner_id NOT IN (SELECT id FROM users WHERE away_until IS NOT NULL AND away_until > ${Number(now)})`;
    if (req.guest) {
      clause += " AND hidden_at IS NULL";
    } else {
      params.push(req.user.id);
      clause += ` AND (hidden_at IS NULL OR owner_id = $${params.length}) AND owner_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $${params.length})`;
    }

    const q = String(req.query.q || "").trim();
    if (q) {
      params.push(`%${q}%`);
      clause += ` AND (title ILIKE $${params.length} OR note ILIKE $${params.length} OR road ILIKE $${params.length})`;
    }

    const type = String(req.query.type || "");
    if (type === "food" || type === "nonfood") {
      params.push(type);
      clause += ` AND type = $${params.length}`;
    }

    const cat = String(req.query.cat || "");
    if (cat) {
      params.push(cat);
      clause += ` AND cat = $${params.length}`;
    }

    if (req.query.saved === "1" && !req.guest) {
      params.push(req.user.id);
      clause += ` AND id IN (SELECT item_id FROM saves WHERE user_id = $${params.length})`;
    }

    /* radius, as a bounding box in degrees — a mile is about 1/69 of a degree
       of latitude, and longitude narrows with the cosine of latitude */
    const clauseBeforeRadius = clause;
    const paramsBeforeRadius = [...params];
    const radius = Number(req.query.radius);
    if (radius > 0 && Number.isFinite(radius) && req.user.lat != null) {
      const dLat = radius / 69;
      const dLng = radius / (69 * Math.max(0.2, Math.cos((req.user.lat * Math.PI) / 180)));
      params.push(req.user.lat - dLat, req.user.lat + dLat, req.user.lng - dLng, req.user.lng + dLng);
      const i = params.length;
      clause += ` AND lat BETWEEN $${i - 3} AND $${i - 2} AND lng BETWEEN $${i - 1} AND $${i}`;
    }

    const visible = { clause, params };
    /* the same search with the distance limit lifted, so an empty screen can
       tell someone their neighbourhood is quiet rather than look broken */
    const wider = { clause: clauseBeforeRadius, params: paramsBeforeRadius };

    /* sorting by distance has to happen in the database, or paging would
       reorder only the slice we happened to fetch */
    /* id as the final tie-break: two items expiring in the same millisecond
       must still land on the same page every time */
    const order = nearest
      ? `ORDER BY (lat IS NULL), ((lat - ${Number(req.user.lat)}) * (lat - ${Number(req.user.lat)}) + (lng - ${Number(req.user.lng)}) * (lng - ${Number(req.user.lng)})), expires_at, id`
      : "ORDER BY expires_at, id";

    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM items WHERE ${visible.clause}`, visible.params);
    const rows = (
      await query(
        `SELECT * FROM items WHERE ${visible.clause} ${order} LIMIT ${limit} OFFSET ${offset}`,
        visible.params
      )
    ).map(castItem);

    /* nothing nearby is worth explaining, but only if there is something to
       explain — one extra count, and only when the screen would be empty */
    let elsewhere = 0;
    if (num(total) === 0 && wider.clause !== visible.clause) {
      const [{ n }] = await query(`SELECT COUNT(*) AS n FROM items WHERE ${wider.clause}`, wider.params);
      elsewhere = num(n);
    }

    const ctx = await itemContext(rows, req.user);
    res.json({
      items: rows.map((it) => publicItem(it, req.user, now, ctx)),
      total: num(total),
      elsewhere,
      offset,
      limit,
      more: offset + rows.length < num(total),
      guest: req.guest,
    });
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
      `SELECT title, cat, kind, road, collected_at, photo_ref FROM items
       WHERE collected_at IS NOT NULL AND hidden_at IS NULL
       ORDER BY collected_at DESC LIMIT 12`
    );
    res.json({
      items: rows.map((r) => ({
        title: r.title,
        cat: r.cat,
        kind: r.kind,
        road: r.road,
        photoRef: r.photo_ref || null,
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
      type = "nonfood",
      useBy = null,
      portions = 1,
      details = null,
      wanted = false,
      claimMode = "instant",
      underCover = false,
      dibs = false,
      passFrom = null,
      eventId = null,
    } = req.body || {};
    if (!["instant", "fair"].includes(claimMode)) return fail(res, 400, "First to claim, or you pick", "claimMode");
    const isAsk = wanted === true;
    if (!title.trim()) return fail(res, 400, isAsk ? "Say what you're after" : "Give the item a name", "title");
    /* an ask has no doorstep — nothing is waiting anywhere yet */
    if (!isAsk && !address.trim()) return fail(res, 400, "We need the address the claimer will collect from", "address");
    const shots = validPhotos(photos != null ? photos : photo);
    if (!shots.ok) return fail(res, 400, shots.error, "photo");
    if (!SPOTS.includes(spot)) return fail(res, 400, "Pick where the item will be waiting", "spot");
    if (!TYPES.includes(type)) return fail(res, 400, "Is it food or not?", "type");

    const cats = type === "food" ? FOOD_CATS : NONFOOD_CATS;
    if (!cats.includes(cat)) return fail(res, 400, "Pick a category", "cat");

    let useByAt = null;
    if (type === "food") {
      if (UNSAFE_FOOD_RE.test(`${title} ${note}`))
        return fail(
          res,
          400,
          "That one isn't safe to pass between households — raw meat and fish, unpasteurised dairy, cooked rice and baby formula can't be listed",
          "title"
        );
      useByAt = Number(useBy);
      if (!useByAt || Number.isNaN(useByAt)) return fail(res, 400, "When does it need eating by?", "useBy");
      if (useByAt <= Date.now()) return fail(res, 400, "That date has already passed — food past its use-by can't be passed on", "useBy");
    }

    if (BANNED_RE.test(`${title} ${note}`))
      return fail(
        res,
        400,
        "Some things can't be passed on safely — car seats, cot mattresses, and age-restricted or dangerous items aren't allowed",
        "title"
      );

    /* AI safety check, deliberately AFTER the regexes: the hard bans above
       never depend on a credential being configured, and the model only has
       to catch what a word list can't — "Britax for the little one" is a car
       seat whether or not it says so. Asks are skipped because nothing
       changes hands until a giver answers with their own listing, which gets
       checked in its own right. On any API failure checkListing answers
       "fine", so moderation can never stop a neighbourhood from sharing. */
    let reviewFlag = null;
    if (hasModerationCredentials && !isAsk) {
      const check = await checkListing({ title, note, type, photo: shots.list[0] || null });
      if (check.verdict === "block")
        return fail(res, 400, check.reason || "That can't be passed on second-hand", "title");
      /* "review" goes live regardless — launch friction stays near zero —
         but the verdict is kept on the row as an audit trail for later */
      if (check.verdict === "review")
        reviewFlag = JSON.stringify({ category: check.category || "other", reason: check.reason || "" });
    }

    const now = Date.now();
    /* an ask can wait longer than a melting doorstep listing: up to three days */
    const capMin = isAsk ? 3 * 24 * 60 : type === "food" ? FOOD_MAX_WINDOW_MIN : 24 * 60;
    let windowMs = Math.max(15, Math.min(capMin, Number(windowMinutes) || (isAsk ? 24 * 60 : DEFAULT_WINDOW_MIN))) * 60 * 1000;
    /* a listing must never outlive the food it describes */
    if (type === "food" && now + windowMs > useByAt) windowMs = Math.max(15 * 60 * 1000, useByAt - now);
    const servings = Math.max(1, Math.min(20, Number(portions) || 1));

    /* Passing something on: if the lister collected passFrom through the app,
       the two listings join into one lineage — the item's passport. An
       invalid passFrom (not theirs, never collected, or plain nonsense) is
       ignored silently: a broken link must never block a listing. */
    let lineageId = null;
    const passFromId = Number(passFrom);
    if (passFromId && Number.isSafeInteger(passFromId) && !isAsk) {
      const prev = await one(
        "SELECT id, lineage_id FROM items WHERE id = $1 AND claimed_by = $2 AND collected_at IS NOT NULL",
        [passFromId, req.user.id]
      );
      if (prev) {
        /* inherit the story, or mint one and write it onto both items so the
           chain holds however many more homes the thing goes on to have */
        lineageId = prev.lineage_id || newToken();
        if (!prev.lineage_id) await query("UPDATE items SET lineage_id = $1 WHERE id = $2", [lineageId, prev.id]);
      }
    }

    /* Putting it out for one of your own open doorsteps. The window is
       pulled back to the sale's finish because a doorstep sale ends when the
       sale ends — a thing advertised as part of Saturday afternoon must not
       still be sitting live on Sunday morning with nobody home to hand it
       over. An eventId that isn't theirs, or has already finished, is
       ignored rather than refused, for the same reason a broken passFrom is:
       a stale chip left on the give form must never stop someone listing. */
    let joinEventId = null;
    const eventJoin = Number(eventId);
    if (eventJoin && Number.isSafeInteger(eventJoin) && !isAsk) {
      const ev = await one("SELECT id, ends_at FROM events WHERE id = $1 AND owner_id = $2 AND hidden_at IS NULL", [
        eventJoin,
        req.user.id,
      ]);
      if (ev && num(ev.ends_at) > now) {
        joinEventId = num(ev.id);
        windowMs = num(ev.ends_at) - now;
      }
    }

    /* the item sits on the giver's own property, so it inherits their coordinates */
    const row = await one(
      `INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, photo, photos, spot, postcode, lat, lng, type, use_by, portions, details, wanted, claim_mode, under_cover, dibs, lineage_id, review_flag, event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
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
        type,
        useByAt,
        servings,
        JSON.stringify(cleanDetails(type, cat, details)),
        isAsk,
        isAsk ? "instant" : claimMode,
        underCover === true,
        dibs === true && !isAsk,
        lineageId,
        reviewFlag,
        joinEventId,
      ]
    );

    /* remember it, so the next listing is prefilled — but an ask carries no
       address, and must not blank the one already stored */
    if (!isAsk) {
      await query("UPDATE users SET address = $1, road = $2, spot = $3 WHERE id = $4", [
        address.trim(),
        road.trim() || req.user.road,
        spot,
        req.user.id,
      ]);
    }

    const item = castItem(row);
    const wishers = isAsk ? 0 : await notifyMatchingWishes(item, req.user.id);
    /* followers hear about giveaways, never asks — they signed up for this
       person's cast-offs, not their shopping list. Runs after the wish pass
       so wish_told already records who has been told once. */
    if (!isAsk) await notifyFollowers(item, req.user);
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

    const { title, note, cat, spot, road, address, extendMinutes, details } = req.body || {};
    if (title != null && !String(title).trim()) return fail(res, 400, "Give the item a name", "title");
    if (spot != null && !SPOTS.includes(spot)) return fail(res, 400, "Pick where the item will be waiting", "spot");
    if (title != null && BANNED_RE.test(`${title} ${note || ""}`))
      return fail(res, 400, "Some things can't be passed on safely", "title");

    /* a giver can add time while the window is still open, up to 24h total */
    const extra = Math.max(0, Math.min(240, Number(extendMinutes) || 0)) * 60 * 1000;
    const expires = Math.min(it.expires_at + extra, now + 24 * 60 * 60 * 1000);

    const row = await one(
      `UPDATE items SET title=$1, note=$2, cat=$3, spot=$4, road=$5, address=$6, expires_at=$7, window_ms=$8, details=$9
       WHERE id=$10 RETURNING *`,
      [
        title != null ? String(title).trim() : it.title,
        note != null ? String(note).trim() : it.note,
        cat != null ? cat : it.cat,
        spot != null ? spot : it.spot,
        road != null ? String(road).trim() : it.road,
        address != null ? String(address).trim() : it.address,
        expires,
        it.window_ms + extra,
        details ? JSON.stringify(cleanDetails(it.type, cat != null ? cat : it.cat, details)) : it.details,
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

/* ---- Spotted: the kerbside FREE pile ----
   Someone walking past a pile of free stuff photographs it and posts it.
   It is not their property, so none of the listing machinery applies: no
   claim, no hold, no chat, no relist. Pure first-come, exact coordinates
   (a kerbside pile is already public), and a hard two-hour expiry. */

const publicSpot = (s, user, now) => ({
  id: num(s.id),
  note: s.note,
  photo: s.photo || null,
  lat: s.lat,
  lng: s.lng,
  road: s.road || null,
  agoMinutes: Math.max(1, Math.round((now - num(s.created_at)) / 60000)),
  takenCount: num(s.taken_count),
  mine: num(s.spotter_id) === user.id,
});

app.post(
  "/api/spots",
  auth,
  wrap(async (req, res) => {
    const { note = "", photo = null, lat = null, lng = null, road = "", freeSign = false } = req.body || {};
    /* the one rule that keeps this from becoming a theft catalogue: the
       poster must vouch that the pile is visibly being given away */
    if (freeSign !== true) return fail(res, 400, "Only post piles that are clearly being given away", "freeSign");
    const text = String(note).trim();
    if (!text) return fail(res, 400, "Say what's in the pile", "note");
    if (text.length > 140) return fail(res, 400, "Keep it short — 140 characters is plenty", "note");
    /* same shape as item photos: one data URL, capped at the same size */
    if (photo != null && (typeof photo !== "string" || !photo.startsWith("data:image/") || photo.length > 2_000_000))
      return fail(res, 400, "That photo didn't come through — try taking it again", "photo");

    const now = Date.now();
    const { n } = await one(
      "SELECT COUNT(*) AS n FROM spots WHERE spotter_id = $1 AND expires_at > $2 AND hidden_at IS NULL",
      [req.user.id, now]
    );
    if (num(n) >= MAX_LIVE_SPOTS)
      return fail(res, 400, `${MAX_LIVE_SPOTS} live spots is plenty — one of yours has to lapse first`);

    /* the spotter is standing next to the pile more often than not, so their
       own coordinates are a fair default when the phone offers nothing better */
    const plat = Number.isFinite(Number(lat)) && lat !== null && lat !== "" ? Number(lat) : req.user.lat;
    const plng = Number.isFinite(Number(lng)) && lng !== null && lng !== "" ? Number(lng) : req.user.lng;

    const row = await one(
      `INSERT INTO spots (spotter_id, note, photo, lat, lng, road, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, text, photo, plat, plng, String(road).trim() || null, now, now + SPOT_LIFE_MS]
    );
    res.status(201).json(publicSpot(row, req.user, now));
  })
);

app.get(
  "/api/spots",
  maybeAuth,
  wrap(async (req, res) => {
    const now = Date.now();
    const rows = await query(
      "SELECT * FROM spots WHERE expires_at > $1 AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 20",
      [now]
    );
    res.json({ spots: rows.map((s) => publicSpot(s, req.user, now)) });
  })
);

app.post(
  "/api/spots/:id/took",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const s = await one("SELECT * FROM spots WHERE id = $1", [req.params.id]);
    if (!s || s.hidden_at != null) return fail(res, 404, "That spot doesn't exist");
    if (num(s.expires_at) <= now) return fail(res, 410, "That spot has lapsed — the pile is probably gone");

    /* once per person, however many trips they make back to the pile */
    const inserted = await query(
      "INSERT INTO spot_takes (spot_id, user_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING spot_id",
      [s.id, req.user.id, now]
    );
    if (!inserted.length) return res.json({ ok: true, alreadyTook: true, takenCount: num(s.taken_count) });

    const updated = await one("UPDATE spots SET taken_count = taken_count + 1 WHERE id = $1 RETURNING taken_count", [s.id]);

    /* thank the spotter — unless they are thanking themselves */
    if (num(s.spotter_id) !== req.user.id) {
      const body = `Someone grabbed something from the pile you spotted on ${s.road || "the kerb"}. Good eye.`;
      const row = await one(
        "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,NULL,$2,$3,$4) RETURNING id",
        [num(s.spotter_id), "Spotted pile", body, now]
      );
      pushTo(num(s.spotter_id), { type: "alert", id: num(row.id), itemId: null, title: "Spotted pile", body, createdAt: now });
    }
    res.json({ ok: true, takenCount: num(updated.taken_count) });
  })
);

app.post(
  "/api/spots/:id/report",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const s = await one("SELECT * FROM spots WHERE id = $1", [req.params.id]);
    if (!s) return fail(res, 404, "That spot doesn't exist");

    const inserted = await query(
      "INSERT INTO spot_reports (spot_id, user_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING spot_id",
      [s.id, req.user.id, now]
    );
    if (!inserted.length) return res.json({ ok: true, alreadyReported: true });

    const updated = await one("UPDATE spots SET reports = reports + 1 WHERE id = $1 RETURNING reports", [s.id]);
    /* two voices and it comes down: the likeliest truth is that it is
       someone's property or bin-day waste, and neither should sit in the feed */
    const hidden = num(updated.reports) >= SPOT_REPORTS_TO_HIDE;
    if (hidden && s.hidden_at == null) await query("UPDATE spots SET hidden_at = $1 WHERE id = $2", [now, s.id]);
    res.json({ ok: true, hidden });
  })
);

/* ---- open doorsteps ----
   The British yard sale, with a clock on it. Someone moving out or clearing
   a loft lists the whole lot as one event — "Open doorstep at Wilton Way,
   Saturday 2 to 4" — and neighbours either claim ahead or turn up on the
   day. The event is a frame around ordinary listings rather than a container
   for them, so anything in it can still be claimed, chatted about and
   collected exactly as it would be from the feed. */

/* Half an hour is the shortest walk anyone will make; eight hours is a long
   day on a doorstep, and a whole weekend belongs in two events rather than
   one. Two weeks is as far ahead as a neighbour will plan a Saturday. */
const EVENT_MIN_MS = 30 * 60 * 1000;
const EVENT_MAX_MS = 8 * 60 * 60 * 1000;
const EVENT_MAX_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

const castEvent = (e) =>
  e && {
    ...e,
    id: num(e.id),
    owner_id: num(e.owner_id),
    starts_at: num(e.starts_at),
    ends_at: num(e.ends_at),
    created_at: num(e.created_at),
    hidden_at: num(e.hidden_at),
  };

/* The address rule, and why it is not the item rule: a sale is an invitation
   to a house at a stated hour, so once the doors are open the number belongs
   on screen — turning up is the whole point of the thing. Before it starts,
   a stranger has no business knowing which house on the road is about to be
   full of strangers, so they get the road and nothing more. The owner sees
   their own address throughout. The pin follows the same reasoning in coarse
   form, snapped to the same ~110m grid an unclaimed listing uses. */
function publicEvent(e, user, now, itemCount = 0) {
  const mine = e.owner_id === user.id;
  const running = e.starts_at <= now && e.ends_at > now;
  const miles = e.lat != null && user.lat != null ? milesBetween(user.lat, user.lng, e.lat, e.lng) : null;
  const pin = e.lat != null ? (mine ? { lat: e.lat, lng: e.lng } : approxCoords(e.lat, e.lng)) : null;
  return {
    id: e.id,
    title: e.title,
    note: e.note,
    road: e.road,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    running,
    itemCount,
    owner: { name: String(e.owner_name || "").split(/\s+/)[0], area: areaFor(e.owner_postcode) },
    mine,
    dist: miles != null ? formatMiles(miles) : null,
    lat: pin ? pin.lat : null,
    lng: pin ? pin.lng : null,
    ...(mine || running ? { address: e.address } : {}),
  };
}

app.post(
  "/api/events",
  auth,
  wrap(async (req, res) => {
    const { title = "", note = "", road = "", address = "", startsAt, endsAt } = req.body || {};
    if (!String(title).trim()) return fail(res, 400, "Give the open doorstep a name", "title");
    if (!String(address).trim()) return fail(res, 400, "We need the address neighbours will come to", "address");

    const from = Number(startsAt);
    const to = Number(endsAt);
    if (!Number.isFinite(from) || !from) return fail(res, 400, "When does it start?", "startsAt");
    if (!Number.isFinite(to) || !to) return fail(res, 400, "When does it finish?", "endsAt");
    if (to <= from) return fail(res, 400, "It has to finish after it starts", "endsAt");

    const span = to - from;
    if (span < EVENT_MIN_MS) return fail(res, 400, "Half an hour is the shortest that's worth anyone's walk", "endsAt");
    if (span > EVENT_MAX_MS) return fail(res, 400, "Eight hours is the longest — a whole weekend is two open doorsteps", "endsAt");

    const now = Date.now();
    /* a minute of slack: the phone that picked the time and the server that
       checks it are never on the same second, and "starting now" must not
       bounce because the request spent a moment in flight */
    if (from < now - 60 * 1000) return fail(res, 400, "That time has already passed", "startsAt");
    if (from > now + EVENT_MAX_AHEAD_MS) return fail(res, 400, "Two weeks ahead is as far as anyone plans a Saturday", "startsAt");

    /* the sale happens at the owner's own front door, so it inherits their
       coordinates the way a listing does */
    const row = await one(
      `INSERT INTO events (owner_id, title, note, road, address, postcode, lat, lng, starts_at, ends_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        req.user.id,
        String(title).trim(),
        String(note).trim(),
        String(road).trim() || req.user.road || "your road",
        String(address).trim(),
        req.user.postcode,
        req.user.lat,
        req.user.lng,
        from,
        to,
        now,
      ]
    );
    const e = { ...castEvent(row), owner_name: req.user.name, owner_postcode: req.user.postcode };
    res.status(201).json(publicEvent(e, req.user, now, 0));
  })
);

app.get(
  "/api/events",
  maybeAuth,
  wrap(async (req, res) => {
    const now = Date.now();
    /* soonest first, because the only question anyone brings to this screen
       is what is on this weekend; anything already finished is history */
    const rows = (
      await query(
        `SELECT e.*, u.name AS owner_name, u.postcode AS owner_postcode
         FROM events e JOIN users u ON u.id = e.owner_id
         WHERE e.ends_at > $1 AND e.hidden_at IS NULL
         ORDER BY e.starts_at, e.id LIMIT 20`,
        [now]
      )
    ).map(castEvent);

    /* one tally for the whole page rather than a count per card — the same
       reason givers and saves are fetched once for the feed */
    const counts = new Map();
    if (rows.length) {
      const tally = await query(
        `SELECT event_id, COUNT(*) AS n FROM items
         WHERE event_id = ANY($1::bigint[]) AND expires_at > $2 AND hidden_at IS NULL
         GROUP BY event_id`,
        [rows.map((e) => e.id), now]
      );
      for (const t of tally) counts.set(num(t.event_id), num(t.n));
    }

    res.json({ events: rows.map((e) => publicEvent(e, req.user, now, counts.get(e.id) || 0)) });
  })
);

app.get(
  "/api/events/:id",
  maybeAuth,
  wrap(async (req, res) => {
    const now = Date.now();
    const row = await one(
      `SELECT e.*, u.name AS owner_name, u.postcode AS owner_postcode
       FROM events e JOIN users u ON u.id = e.owner_id WHERE e.id = $1`,
      [req.params.id]
    );
    if (!row || row.hidden_at != null) return fail(res, 404, "That open doorstep doesn't exist");
    const e = castEvent(row);

    const rows = (
      await query(
        "SELECT * FROM items WHERE event_id = $1 AND expires_at > $2 AND hidden_at IS NULL ORDER BY expires_at, id",
        [e.id, now]
      )
    ).map(castItem);

    /* the same shaping the feed uses, so a card inside a sale is the same
       card as everywhere else — photo, timer, distance and claim state all
       behave identically once someone taps through */
    const ctx = await itemContext(rows, req.user);
    res.json({
      event: publicEvent(e, req.user, now, rows.length),
      items: rows.map((it) => publicItem(it, req.user, now, ctx)),
    });
  })
);

app.delete(
  "/api/events/:id",
  auth,
  wrap(async (req, res) => {
    const row = await one("SELECT * FROM events WHERE id = $1 AND owner_id = $2 AND hidden_at IS NULL", [
      req.params.id,
      req.user.id,
    ]);
    if (!row) return fail(res, 404, "That isn't one of your open doorsteps");
    const now = Date.now();
    /* the sale is off, but the things are still on the doorstep: each
       listing keeps its own window and simply stops pointing at an event */
    await query("UPDATE events SET hidden_at = $1 WHERE id = $2", [now, row.id]);
    await query("UPDATE items SET event_id = NULL WHERE event_id = $1", [row.id]);
    res.json({ ok: true });
  })
);

app.get("/api/detail-fields", (req, res) => {
  res.json({
    common: DETAIL_FIELDS.common,
    byCat: Object.fromEntries(Object.entries(DETAIL_FIELDS).filter(([k]) => k !== "common")),
  });
});

/* Type-ahead for the search box: what is actually out there right now,
   rather than a list of words someone once guessed at. */
app.get(
  "/api/suggest",
  maybeAuth,
  wrap(async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ suggestions: [] });
    const now = Date.now();

    const rows = await query(
      `SELECT title, cat, type, COUNT(*) OVER () AS _n
       FROM items
       WHERE expires_at > $1 AND hidden_at IS NULL AND NOT wanted AND title ILIKE $2
       ORDER BY expires_at LIMIT 6`,
      [now, `%${q}%`]
    );

    const cats = [...NONFOOD_CATS, ...FOOD_CATS].filter((c) => c.toLowerCase().includes(q.toLowerCase()));

    res.json({
      suggestions: [
        ...cats.slice(0, 2).map((c) => ({ kind: "category", label: c })),
        ...rows.map((r) => ({ kind: "item", label: r.title, cat: r.cat, type: r.type })),
      ].slice(0, 7),
    });
  })
);

app.get("/api/categories", (req, res) => {
  res.json({
    food: FOOD_CATS.map((c) => ({ cat: c, kind: FOOD_KIND[c] || "meal" })),
    nonfood: NONFOOD_CATS.map((c) => ({ cat: c, kind: NONFOOD_KIND[c] || "bookcase" })),
  });
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

/* How many things are up RIGHT NOW for each wish. A count of past alerts is
   no use to anyone — what a wisher wants to know is whether there is
   something to go and collect today. */
async function liveMatchCounts(wishes, user) {
  if (!wishes.length) return new Map();
  const live = await query(
    `SELECT id, title, note, road, cat, lat, lng FROM items
     WHERE owner_id <> $1 AND claimed_by IS NULL AND expires_at > $2 AND hidden_at IS NULL AND NOT wanted`,
    [user.id, Date.now()]
  );
  const counts = new Map();
  for (const w of wishes) {
    const shaped = { ...w, ulat: user.lat, ulng: user.lng };
    counts.set(num(w.id), live.filter((it) => wishMatches(shaped, it) !== null).length);
  }
  return counts;
}

app.get(
  "/api/wishes",
  auth,
  wrap(async (req, res) => {
    const rows = await query(
      "SELECT id, keyword, cat, radius, created_at FROM wishes WHERE user_id = $1 ORDER BY id DESC",
      [req.user.id]
    );
    const counts = await liveMatchCounts(rows, req.user);
    res.json({
      wishes: rows.map((w) => ({
        id: num(w.id),
        keyword: w.keyword,
        cat: w.cat,
        radius: w.radius,
        createdAt: num(w.created_at),
        upNow: counts.get(num(w.id)) || 0,
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

    const r = Math.max(0.25, Math.min(10, Number(radius) || 1));

    /* the same wish twice would just mean two identical rows and no extra
       alerts, so say so rather than quietly adding it again */
    const already = await one(
      "SELECT id FROM wishes WHERE user_id = $1 AND LOWER(keyword) = LOWER($2) AND cat = $3",
      [req.user.id, keyword.trim(), cat]
    );
    if (already) return fail(res, 409, "That's already on your wish list", "keyword");

    const createdAt = Date.now();
    const row = await one(
      "INSERT INTO wishes (user_id, keyword, cat, radius, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.user.id, keyword.trim(), cat, r, createdAt]
    );

    /* check what is already out there before promising to watch the future */
    const wish = await one(
      "SELECT w.*, u.lat AS ulat, u.lng AS ulng FROM wishes w JOIN users u ON u.id = w.user_id WHERE w.id = $1",
      [row.id]
    );
    const alreadyOut = await notifyExistingMatches(wish);

    const counts = await liveMatchCounts([{ ...wish, id: row.id }], req.user);
    res.status(201).json({
      id: num(row.id),
      keyword: keyword.trim(),
      cat,
      radius: r,
      createdAt,
      upNow: counts.get(num(row.id)) || 0,
      alreadyOut,
    });
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

/* ---- understanding what a neighbour typed ----
   Not a chatbot: chat-style shopping underperforms everywhere it's tried.
   This is one structured call that turns "a desk under half a mile I can
   carry home" into the filters the feed already speaks — magic without a
   chat window. Without a credential it answers null and the app carries on
   with plain search, because AI here is a quickener, never a dependency. */
app.post(
  "/api/understand",
  maybeAuth,
  wrap(async (req, res) => {
    const text = String((req.body || {}).text || "").trim();
    if (!text || !aiConfigured) return res.json({ filters: null });
    try {
      const filters = await understand(text);
      res.json({ filters });
    } catch {
      res.json({ filters: null });
    }
  })
);

/* ---- the demand radar ----
   Every competitor treats givers as saints to be thanked; this treats them
   as people who need proof it's worth the faff of photographing a ladder.
   The wish list, read backwards: what are the neighbours around you already
   waiting for? Counts only, never who — a wish is private until it's met. */
app.get(
  "/api/demand",
  auth,
  wrap(async (req, res) => {
    if (req.user.lat == null) return res.json({ wants: [] });
    const wishes = await query(WISHES_SQL, [req.user.id]);

    /* a wish counts if listing from my doorstep would reach it */
    const reachable = wishes.filter(
      (w) => w.ulat != null && milesBetween(w.ulat, w.ulng, req.user.lat, req.user.lng) <= w.radius
    );

    const byWant = new Map();
    for (const w of reachable) {
      const label = (w.keyword || "").trim().toLowerCase() || `anything in ${w.cat.toLowerCase()}`;
      const entry = byWant.get(label) || { label, cat: w.cat, wishers: new Set() };
      entry.wishers.add(num(w.user_id));
      if (w.cat !== "Anything") entry.cat = w.cat;
      byWant.set(label, entry);
    }

    const wants = [...byWant.values()]
      .map((e) => ({ label: e.label, cat: e.cat, count: e.wishers.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
    res.json({ wants });
  })
);

/* ---- street pages ----
   The growth loop nobody else can run. Nextdoor, Olio and Freegle all group
   people by a drawn radius or a self-chosen group, because none of them
   verify an address. Doorstep does, so it can say something none of them
   can: this road, these neighbours, this many things rehomed. A street is
   something people already feel they belong to, and a page about it is
   worth sending to the WhatsApp group.

   Everything below is computed on read. There is no streets table and
   nothing is written, because a page derived on read can never drift from
   the truth: no counter to increment and forget, no nightly job to re-run,
   nothing to backfill when an item is collected late, a listing is hidden,
   or a neighbour moves away. The numbers are simply what the database says
   at the moment somebody looks.

   The grouping happens in JS rather than SQL. Normalising a road is a
   handful of rules — strip the district, drop the punctuation — and they
   already live in one place, streetKey() in geo.js. Expressing them a
   second time as a Postgres regex would mean two definitions of "the same
   street" that could disagree, and that disagreement is exactly the bug
   that splits one road into two half-empty pages. At launch scale the whole
   user table is a few hundred rows, so pulling them and reducing in JS
   costs nothing and keeps one source of truth. */

/* the calendar month the app is currently living in */
const startOfThisMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/* Consecutive weeks, counting back from the one we are in, that saw at
   least one thing collected on the street. A streak is the honest kind of
   pressure: it only ever says how long the road has been going, never that
   anyone has let it slip. Capped at a year so a long-lived street can't
   turn this into a long loop. */
function weeksRunning(times, now) {
  if (!times.length) return 0;
  const weeks = new Set(times.map((t) => Math.floor((now - t) / WEEK_MS)));
  let streak = 0;
  while (streak < 52 && weeks.has(streak)) streak++;
  return streak;
}

/* "E8 3PA" and "E83PA" are both district E8 — the unit a borough thinks in */
function postcodeDistrict(postcode) {
  const clean = String(postcode || "").trim().toUpperCase().replace(/\s+/g, "");
  const m = clean.match(/^([A-Z]{1,2}\d[A-Z\d]?)(?:\d[A-Z]{2})?$/);
  return m ? m[1] : null;
}

/* Three verified households. Below that, a "street page" is a page about
   one person: their road, roughly their address, how often they are home to
   hand things over. That is a surveillance product, not a neighbourhood
   one, so the floor is a hard rule rather than a setting anyone can lower.
   Three is also the smallest number that reads as a group rather than a
   pair. */
const STREET_FLOOR = 3;

/* Every street the database knows about, keyed by streetKey. */
async function readStreets() {
  const now = Date.now();
  const monthStart = startOfThisMonth();
  const people = await query("SELECT id, road, postcode FROM users WHERE road IS NOT NULL AND road <> ''");
  /* hidden listings still count here: the thing genuinely left the house */
  const collected = await query("SELECT road, cat, collected_at, claimed_by FROM items WHERE collected_at IS NOT NULL");

  const streets = new Map();
  const get = (key) => {
    if (!streets.has(key))
      streets.set(key, {
        key,
        name: "",
        area: null,
        district: null,
        people: new Set(),
        rehomed: 0,
        kg: 0,
        givenThisMonth: 0,
        collectedThisMonth: 0,
        times: [],
      });
    return streets.get(key);
  };

  /* who lives where, so a collection can be credited to the collector's own
     road as well as to the giver's */
  const homeOf = new Map();
  for (const u of people) {
    const key = streetKey(u.road);
    if (!key) continue;
    const s = get(key);
    s.people.add(num(u.id));
    homeOf.set(num(u.id), key);
    if (!s.name) s.name = streetName(u.road);
    if (!s.area) s.area = areaFor(u.postcode);
    if (!s.district) s.district = postcodeDistrict(u.postcode);
  }

  for (const it of collected) {
    const at = num(it.collected_at);
    const key = streetKey(it.road);
    if (key) {
      const s = get(key);
      /* the road gave this away, whoever ended up carrying it off */
      s.rehomed += 1;
      s.kg += kgForCat(it.cat);
      s.times.push(at);
      if (at >= monthStart) s.givenThisMonth += 1;
      if (!s.name) s.name = streetName(it.road);
    }
    /* and what the road carried home, which is the other half of being a
       neighbourhood: a street that only ever gives is a charity shop */
    const takerKey = it.claimed_by != null ? homeOf.get(num(it.claimed_by)) : null;
    if (takerKey && at >= monthStart) get(takerKey).collectedThisMonth += 1;
  }

  for (const s of streets.values()) {
    s.neighbours = s.people.size;
    s.streak = weeksRunning(s.times, now);
    /* kilos are an estimate by construction — the published average weight
       for the category, borrowed from impact.js so the street page and the
       council report can never quote two different numbers */
    s.kg = Math.round(s.kg);
  }
  return streets;
}

const publicStreet = (s) => ({
  name: s.name,
  area: s.area,
  neighbours: s.neighbours,
  rehomed: s.rehomed,
  givenThisMonth: s.givenThisMonth,
  collectedThisMonth: s.collectedThisMonth,
  streak: s.streak,
  kg: s.kg,
});

/* Your own road — or an honest account of why it hasn't got a page yet.
   The below-the-floor answer still carries the road's name, because the
   invitation state on the client needs to say which street is waiting. */
app.get(
  "/api/streets/mine",
  auth,
  wrap(async (req, res) => {
    const key = streetKey(req.user.road);
    if (!key) return res.json({ street: null, name: null, area: null, neighbours: 0, floor: STREET_FLOOR });

    const streets = await readStreets();
    const s = streets.get(key);
    const name = (s && s.name) || streetName(req.user.road);
    const area = (s && s.area) || areaFor(req.user.postcode);
    const neighbours = s ? s.neighbours : 0;
    if (neighbours < STREET_FLOOR) return res.json({ street: null, name, area, neighbours, floor: STREET_FLOOR });

    res.json({ street: publicStreet(s), name, area, neighbours, floor: STREET_FLOOR });
  })
);

/* The borough leaderboard: the streets around you, best month first. Eight
   at most, and never a bottom of the table — a league that shames the quiet
   roads would make listing feel like being marked, and the quiet road is
   precisely the one we want to draw in. */
app.get(
  "/api/streets/top",
  maybeAuth,
  wrap(async (req, res) => {
    const postcode = req.guest ? "" : req.user.postcode;
    /* a viewer with no postcode has no "around here" to show, and someone
       browsing from anywhere is better told nothing than told about a
       street that isn't theirs */
    if (!postcode) return res.json({ streets: [] });

    const district = postcodeDistrict(postcode);
    const area = areaFor(postcode);
    const mine = req.guest ? "" : streetKey(req.user.road);

    const streets = await readStreets();
    const nearby = [...streets.values()]
      .filter((s) => s.neighbours >= STREET_FLOOR && s.name)
      .filter((s) => (area && s.area === area) || (district && s.district === district))
      .sort((a, b) => b.givenThisMonth - a.givenThisMonth || b.rehomed - a.rehomed || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((s) => ({
        name: s.name,
        area: s.area,
        neighbours: s.neighbours,
        /* "rehomed" on a leaderboard means this month — a league table of
           all-time totals only ever rewards the street that joined first */
        rehomed: s.givenThisMonth,
        streak: s.streak,
        mine: Boolean(mine) && s.key === mine,
      }));
    res.json({ streets: nearby });
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

/* ---- the arrangement thread ----
   Every claim opens one conversation between giver and claimer, and the app
   itself writes the milestones into it — claimed, handed back, collected —
   so the thread is the arrangement's own record. It is not a social network:
   no thread exists without a claim behind it. */

async function openThread(item, claimerId, now) {
  const conv = await one(
    `INSERT INTO conversations (item_id, giver_id, claimer_id, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (item_id, claimer_id) DO UPDATE SET item_id = EXCLUDED.item_id
     RETURNING id`,
    [item.id, item.owner_id, claimerId, now]
  );
  return num(conv.id);
}

async function threadNote(convId, body, now = Date.now()) {
  await query("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES ($1,NULL,$2,$3)", [
    convId,
    body,
    now,
  ]);
}

/* tell the other side a message landed, without them having to ask */
async function pushMessage(convId, senderId, body, now) {
  const conv = await one("SELECT * FROM conversations WHERE id = $1", [convId]);
  if (!conv) return;
  const to = num(conv.giver_id) === num(senderId) ? num(conv.claimer_id) : num(conv.giver_id);
  pushTo(to, { type: "message", conversationId: num(convId), body, createdAt: now });
}

app.get(
  "/api/chats",
  auth,
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT c.id, c.item_id, c.giver_id, c.claimer_id, c.created_at,
              i.title, i.photo_ref, i.photo, i.collected_at, i.claimed_by, i.claim_expires_at,
              gu.name AS giver_name, cu.name AS claimer_name,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
              (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at,
              (SELECT m.sender_id = $1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_id IS NOT NULL ORDER BY m.id DESC LIMIT 1) AS last_mine,
              (SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = c.id AND m.read_at IS NULL
                   AND m.sender_id IS NOT NULL AND m.sender_id <> $1) AS unread
       FROM conversations c
       JOIN items i ON i.id = c.item_id
       JOIN users gu ON gu.id = c.giver_id
       JOIN users cu ON cu.id = c.claimer_id
       WHERE c.giver_id = $1 OR c.claimer_id = $1
       ORDER BY COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) DESC
       LIMIT 40`,
      [req.user.id]
    );
    res.json({
      chats: rows.map((c) => {
        const giving = num(c.giver_id) === num(req.user.id);
        return {
          id: num(c.id),
          itemId: num(c.item_id),
          title: c.title,
          photoRef: c.photo_ref || null,
          photo: c.photo || null,
          with: String(giving ? c.claimer_name : c.giver_name).split(/[ ]+/)[0],
          role: giving ? "giving" : "collecting",
          lastBody: c.last_body || "",
          lastAt: num(c.last_at || c.created_at),
          lastMine: c.last_mine === true,
          unread: num(c.unread),
          done: c.collected_at != null,
        };
      }),
      unread: rows.reduce((n, c) => n + num(c.unread), 0),
    });
  })
);

app.get(
  "/api/chats/:id",
  auth,
  wrap(async (req, res) => {
    const conv = await one("SELECT * FROM conversations WHERE id = $1", [req.params.id]);
    if (!conv || (num(conv.giver_id) !== req.user.id && num(conv.claimer_id) !== req.user.id))
      return fail(res, 404, "No such conversation");

    /* opening the thread is reading it */
    await query(
      "UPDATE messages SET read_at = $1 WHERE conversation_id = $2 AND read_at IS NULL AND sender_id IS NOT NULL AND sender_id <> $3",
      [Date.now(), conv.id, req.user.id]
    );

    /* Any English rendering already paid for rides along with the message, so
       a thread reopened tomorrow arrives readable without a second tap and
       without a second call to the model. */
    const msgs = await query(
      `SELECT m.*, t.body AS translated_body, t.source_lang
         FROM messages m
         LEFT JOIN message_translations t ON t.message_id = m.id AND t.lang = 'en'
        WHERE m.conversation_id = $1 ORDER BY m.id ASC LIMIT 200`,
      [conv.id]
    );
    const giving = num(conv.giver_id) === req.user.id;
    const other = await one("SELECT name FROM users WHERE id = $1", [giving ? conv.claimer_id : conv.giver_id]);
    const item = castItem(await one("SELECT * FROM items WHERE id = $1", [conv.item_id]));
    /* once the handover has happened, the thread is where the stars live */
    const rated = await one("SELECT id FROM ratings WHERE item_id = $1 AND rater_id = $2", [conv.item_id, req.user.id]);
    res.json({
      id: num(conv.id),
      itemId: num(conv.item_id),
      title: item ? item.title : "",
      role: giving ? "giving" : "collecting",
      with: other ? String(other.name).split(/[ ]+/)[0] : "",
      address: giving || (item && item.claimed_by === req.user.id) ? item && item.address : null,
      canRate: Boolean(item && item.collected_at != null && !rated),
      messages: msgs.map((m) => ({
        id: num(m.id),
        mine: m.sender_id != null && num(m.sender_id) === req.user.id,
        system: m.sender_id == null,
        body: m.body,
        createdAt: num(m.created_at),
        translation: m.translated_body ? { translated: m.translated_body, sourceLanguage: m.source_lang || null } : null,
      })),
    });
  })
);

/* Situational quick replies: three things this person might plausibly say
   next, written for the live thread rather than picked from the fixed set.
   When no AI credential is configured the answer is a 200 with replies null,
   not an error — an absent key is a normal state of the world, and the
   client quietly keeps its fixed chips without ever surfacing a failure. */
app.get(
  "/api/chats/:id/suggest",
  auth,
  wrap(async (req, res) => {
    const conv = await one("SELECT * FROM conversations WHERE id = $1", [req.params.id]);
    if (!conv || (num(conv.giver_id) !== req.user.id && num(conv.claimer_id) !== req.user.id))
      return fail(res, 404, "No such conversation");

    if (!aiConfigured) return res.json({ replies: null });

    /* the final eight messages are plenty of context for "what would I say
       next", and keep the call cheap; nothing is cached because the right
       suggestion changes with every message that lands */
    const msgs = await query("SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id ASC LIMIT 200", [conv.id]);
    const item = await one("SELECT title FROM items WHERE id = $1", [conv.item_id]);
    try {
      const replies = await suggestReplies({
        role: num(conv.giver_id) === req.user.id ? "giving" : "collecting",
        title: item ? item.title : "",
        messages: msgs.slice(-8).map((m) => ({
          system: m.sender_id == null,
          mine: m.sender_id != null && num(m.sender_id) === req.user.id,
          body: m.body,
        })),
      });
      res.json({ replies });
    } catch {
      /* the fixed chips are always good enough — an AI hiccup must never
         break a chat, so any failure degrades to the same quiet null */
      res.json({ replies: null });
    }
  })
);

app.post(
  "/api/chats/:id",
  auth,
  wrap(async (req, res) => {
    const body = String((req.body || {}).body || "").trim().slice(0, 500);
    if (!body) return fail(res, 400, "Say something", "body");

    const conv = await one("SELECT * FROM conversations WHERE id = $1", [req.params.id]);
    if (!conv || (num(conv.giver_id) !== req.user.id && num(conv.claimer_id) !== req.user.id))
      return fail(res, 404, "No such conversation");

    const otherId = num(conv.giver_id) === req.user.id ? num(conv.claimer_id) : num(conv.giver_id);
    const blocked = await one(
      "SELECT 1 AS x FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
      [req.user.id, otherId]
    );
    if (blocked) return fail(res, 403, "This conversation is closed");

    const now = Date.now();
    const row = await one(
      "INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4) RETURNING id",
      [conv.id, req.user.id, body, now]
    );
    await pushMessage(conv.id, req.user.id, body, now);
    res.status(201).json({ id: num(row.id), body, createdAt: now });
  })
);

/* ---- translation ----
   Hackney is one of the most multilingual boroughs in Britain. A giveaway
   only widens who can give and collect if both people can read the sentence
   arranging the handover, so any message the other person sent can be turned
   into a language you have, once, with one tap.

   The list below is the languages most spoken in Hackney households after
   English, plus English itself as the usual target. It is deliberately short
   — an allowlist rather than a free-text field, so nothing arbitrary is ever
   fed to the model or written into the key of a cache row — and adding a
   language is one line here. */
const TRANSLATE_LANGS = {
  en: "English",
  pl: "Polish",
  tr: "Turkish",
  es: "Spanish",
  fr: "French",
  ro: "Romanian",
  bn: "Bengali",
  ur: "Urdu",
  ar: "Arabic",
  pt: "Portuguese",
  it: "Italian",
  so: "Somali",
};

app.post(
  "/api/messages/:id/translate",
  auth,
  wrap(async (req, res) => {
    const lang = String((req.body || {}).lang || "en").toLowerCase().trim();
    const targetLanguage = TRANSLATE_LANGS[lang];
    if (!targetLanguage) return fail(res, 400, "That language isn't supported yet", "lang");

    const msgId = Number(req.params.id);
    if (!Number.isFinite(msgId) || msgId <= 0) return fail(res, 404, "No such message");

    const msg = await one("SELECT * FROM messages WHERE id = $1", [msgId]);
    if (!msg) return fail(res, 404, "No such message");

    /* the same participant gate as reading the thread: a stranger cannot
       translate their way into a conversation they were never part of, and
       learns nothing — not even that the message exists */
    const conv = await one("SELECT * FROM conversations WHERE id = $1", [msg.conversation_id]);
    if (!conv || (num(conv.giver_id) !== req.user.id && num(conv.claimer_id) !== req.user.id))
      return fail(res, 404, "No such message");

    /* paid for once, read many times — a stored rendering never touches the
       model again, however often the thread is scrolled or reopened */
    const stored = await one("SELECT * FROM message_translations WHERE message_id = $1 AND lang = $2", [msgId, lang]);
    if (stored) return res.json({ translated: stored.body, sourceLanguage: stored.source_lang || null, cached: true });

    /* an absent credential is a normal state of the world, not a failure:
       the answer is a polite nothing, and the client hides the button rather
       than offering a tap that can never work */
    if (!aiConfigured) return res.json({ translated: null });

    try {
      const out = await translate(msg.body, targetLanguage);
      if (!out || !out.translated) return res.json({ translated: null });
      await query(
        "INSERT INTO message_translations (message_id, lang, body, source_lang, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (message_id, lang) DO NOTHING",
        [msgId, lang, out.translated, out.sourceLanguage || null, Date.now()]
      );
      res.json({ translated: out.translated, sourceLanguage: out.sourceLanguage || null, cached: false });
    } catch {
      /* a chat must never break over a translation. Any hiccup degrades to
         the same quiet null the missing-credential path returns. */
      res.json({ translated: null });
    }
  })
);

/* ---- ratings ----
   Stars unlock only after a real handover, both directions, once each. An
   average is shown only after three people have spoken — one review is an
   anecdote. */
app.post(
  "/api/items/:id/rate",
  auth,
  wrap(async (req, res) => {
    const stars = Number((req.body || {}).stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return fail(res, 400, "One to five stars", "stars");

    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it || it.collected_at == null) return fail(res, 400, "Ratings open once the handover has happened");

    let ratee = null;
    if (it.claimed_by === req.user.id) ratee = it.owner_id; /* collector rates the giver */
    if (it.owner_id === req.user.id) ratee = it.claimed_by; /* giver rates the collector */
    if (ratee == null) return fail(res, 403, "Only the two people who met can rate this");

    const inserted = await query(
      `INSERT INTO ratings (item_id, rater_id, ratee_id, stars, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [it.id, req.user.id, ratee, stars, Date.now()]
    );
    if (!inserted.length) return fail(res, 409, "You've already rated this handover");
    res.status(201).json({ ok: true });
  })
);

/* An ask's answer: "I have one." No hold, no countdown — just the two of
   them in a thread, because the thing hasn't been photographed or listed,
   it's still in someone's hallway. */
app.post(
  "/api/items/:id/offer",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it || !it.wanted) return fail(res, 404, "That isn't an ask");
    if (it.expires_at <= now) return fail(res, 410, "This ask has closed");
    if (it.owner_id === req.user.id) return fail(res, 400, "It's your own ask");

    const convId = await openThread(it, req.user.id, now);
    const fresh = await one(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1",
      [convId]
    );
    if (num(fresh.n) === 0) {
      await threadNote(convId, `${req.user.name.split(/[ ]+/)[0]} has one for you — arrange it here.`, now);
      pushTo(num(it.owner_id), {
        type: "message",
        conversationId: convId,
        body: `${req.user.name.split(/[ ]+/)[0]} has a ${it.title.toLowerCase()} for you`,
        createdAt: now,
      });
    }
    res.status(201).json({ conversationId: convId });
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
      if (it.wanted) return { status: 400, error: "This is something they're after — offer yours instead" };
      if (it.expires_at <= now) return { status: 410, error: "Too late — the window has closed" };
      if (it.owner_id === req.user.id) return { status: 400, error: "That one's already yours — you listed it" };
      const claimActive = it.claimed_by != null && it.claim_expires_at > now;
      if (claimActive && it.claimed_by !== req.user.id)
        return { status: 409, error: "Someone beat you to it — it's already claimed" };

      /* first dibs: the street's quarter hour is not yours to jump */
      const opens = dibsOpensAt(it, req.user);
      if (opens > now) {
        const at = new Date(opens).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        return { status: 403, error: `The streets around it get first dibs — it opens to you at ${at}` };
      }

      /* fair chance: the window collects hands, the giver picks one */
      if ((it.claim_mode || "instant") === "fair" && !claimActive) {
        await q("INSERT INTO claim_requests (item_id, user_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
          it.id,
          req.user.id,
          now,
        ]);
        const [{ n: hands }] = await q("SELECT COUNT(*) AS n FROM claim_requests WHERE item_id = $1", [it.id]);
        return { fair: true, item: it, hands: num(hands) };
      }

      const [updated] = await q("UPDATE items SET claimed_by = $1, claim_expires_at = $2 WHERE id = $3 RETURNING *", [
        req.user.id,
        now + CLAIM_HOLD_MS,
        it.id,
      ]);
      return { item: castItem(updated) };
    });

    if (outcome.error) return fail(res, outcome.status, outcome.error);

    if (outcome.fair) {
      /* the first hand tells the giver there is choosing to be done */
      if (outcome.hands === 1) {
        const row = await one(
          "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
          [outcome.item.owner_id, outcome.item.id, outcome.item.title, "A hand is up — open the listing to pick who gets it.", now]
        );
        pushTo(num(outcome.item.owner_id), {
          type: "alert",
          id: num(row.id),
          itemId: num(outcome.item.id),
          title: outcome.item.title,
          body: "A hand is up — open the listing to pick who gets it.",
          createdAt: now,
        });
      }
      return res.json({ fair: true, hands: outcome.hands });
    }

    /* the claim opens the conversation, and the app writes the first line */
    const convId = await openThread(outcome.item, req.user.id, now);
    await threadNote(
      convId,
      `${req.user.name.split(/[ ]+/)[0]} claimed this — it's held for 30 minutes. It'll be waiting ${outcome.item.spot === "buzz and collect" ? "once you buzz" : `on the ${outcome.item.spot}`} at ${outcome.item.address}.`,
      now
    );
    pushTo(num(outcome.item.owner_id), {
      type: "message",
      conversationId: convId,
      body: `${req.user.name.split(/[ ]+/)[0]} claimed ${outcome.item.title}`,
      createdAt: now,
    });

    const claimed = await publicOne(outcome.item, req.user, now);
    res.json({ ...claimed, conversationId: convId });
  })
);

/* ---- one trip: bundling ----
   Vinted's bundle idea, translated to doorsteps: when the giver has more
   than one thing out and a neighbour is already on their way, the rest can
   join the same walk. One walk, one doorstep, one conversation — the giver
   is spared a second arrangement and the street a second trip. */

/* Four things is a full pair of hands and a bag. Any more and "one trip"
   quietly becomes a house clearance, which is a different favour entirely. */
const BUNDLE_MAX = 4;

app.post(
  "/api/items/:id/bundle",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    await sweepLapsedClaims(now);

    const requested = [...new Set((Array.isArray((req.body || {}).itemIds) ? (req.body || {}).itemIds : []).map(Number))];
    if (!requested.length || requested.some((n) => !Number.isFinite(n) || n <= 0))
      return fail(res, 400, "Say which items to add to the trip");

    const outcome = await tx(async (q) => {
      /* The anchor is the claim the caller already holds. It is locked first,
         in the same FOR UPDATE pattern as claiming, so a lapsing hold and a
         bundle cannot cross in mid-air. */
      const [anchorRaw] = await q("SELECT * FROM items WHERE id = $1 FOR UPDATE", [req.params.id]);
      const anchor = castItem(anchorRaw);
      if (!anchor) return { status: 404, error: "That item doesn't exist" };
      if (anchor.claimed_by !== req.user.id || anchor.claim_expires_at == null || anchor.claim_expires_at <= now || anchor.collected_at != null)
        return { status: 403, error: "A trip starts with a claim — claim something of theirs first" };

      /* Deliberately no MAX_ACTIVE_CLAIMS or CLAIMS_PER_28_DAYS check here.
         Those caps exist to stop one person hoovering up the whole
         neighbourhood; a bundle is more things from one giver, collected in
         one walk to one doorstep, which is the opposite of hoarding — it
         removes journeys rather than multiplying them, so the anti-hoarding
         arithmetic should never talk anyone out of it. */

      /* the trip so far: everything already held from this doorstep on the
         same clock, the anchor included */
      const [{ n: tripSize }] = await q(
        "SELECT COUNT(*) AS n FROM items WHERE claimed_by = $1 AND owner_id = $2 AND collected_at IS NULL AND claim_expires_at = $3",
        [req.user.id, anchor.owner_id, anchor.claim_expires_at]
      );
      if (num(tripSize) + requested.length > BUNDLE_MAX)
        return { status: 400, error: `A trip carries ${BUNDLE_MAX} things at most — that's already a full pair of hands` };

      const added = [];
      for (const id of requested) {
        if (id === anchor.id) return { status: 400, error: "That one already is the trip" };
        const [raw] = await q("SELECT * FROM items WHERE id = $1 FOR UPDATE", [id]);
        const it = castItem(raw);
        if (!it) return { status: 404, error: "One of those items doesn't exist" };
        if (it.owner_id !== anchor.owner_id)
          return { status: 400, error: "That one's on a different doorstep — it can't join this trip" };
        if (it.wanted) return { status: 400, error: "That's something they're after, not something waiting" };
        if (it.hidden_at != null) return { status: 410, error: "That listing is under review" };
        if (it.collected_at != null || it.expires_at <= now)
          return { status: 410, error: "Too late for that one — its window has closed" };
        if (it.claimed_by != null && it.claim_expires_at > now)
          return { status: 409, error: "Someone beat you to that one" };

        /* the addition inherits the anchor's clock rather than starting its
           own, so the whole trip is one hold that lapses together */
        const [updated] = await q("UPDATE items SET claimed_by = $1, claim_expires_at = $2 WHERE id = $3 RETURNING *", [
          req.user.id,
          anchor.claim_expires_at,
          it.id,
        ]);
        added.push(castItem(updated));
      }
      return { anchor, added };
    });

    if (outcome.error) return fail(res, outcome.status, outcome.error);

    /* No new conversations: the trip already has one, opened by the anchor
       claim. Each addition is noted there instead, so the giver knows what
       to put out without a second thread appearing for the same knock. */
    const conv = await one("SELECT id FROM conversations WHERE item_id = $1 AND claimer_id = $2", [
      outcome.anchor.id,
      req.user.id,
    ]);
    if (conv) {
      for (const it of outcome.added) await threadNote(num(conv.id), `Also picking up: ${it.title}.`, now);
      await pushMessage(num(conv.id), req.user.id, `Also picking up: ${outcome.added.map((i) => i.title).join(", ")}`, now);
    }

    const items = [];
    for (const it of outcome.added) items.push(await publicOne(it, req.user, now));
    res.json({ items });
  })
);

/* the giver sees who is asking — first name, area, distance, record */
app.get(
  "/api/items/:id/hands",
  auth,
  wrap(async (req, res) => {
    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it || it.owner_id !== req.user.id) return fail(res, 403, "Only the giver sees the hands");
    const rows = await query(
      `SELECT r.user_id, r.at, u.name, u.postcode, u.lat, u.lng,
              (SELECT COUNT(*) FROM items i WHERE i.claimed_by = u.id AND i.collected_at IS NOT NULL) AS collected,
              (SELECT COUNT(*) FROM ratings x WHERE x.ratee_id = u.id) AS rated,
              (SELECT AVG(stars) FROM ratings x WHERE x.ratee_id = u.id) AS stars
       FROM claim_requests r JOIN users u ON u.id = r.user_id
       WHERE r.item_id = $1 ORDER BY r.at ASC`,
      [it.id]
    );
    res.json({
      hands: rows.map((r) => ({
        userId: num(r.user_id),
        name: String(r.name).split(/[ ]+/)[0],
        area: areaFor(r.postcode),
        miles: r.lat != null && it.lat != null ? formatMiles(milesBetween(r.lat, r.lng, it.lat, it.lng)) : null,
        collected: num(r.collected),
        stars: num(r.rated) >= 3 ? Math.round(Number(r.stars) * 10) / 10 : null,
        at: num(r.at),
      })),
    });
  })
);

app.post(
  "/api/items/:id/pick",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const pickedId = Number((req.body || {}).userId);
    const outcome = await tx(async (q) => {
      const [raw] = await q("SELECT * FROM items WHERE id = $1 FOR UPDATE", [req.params.id]);
      const it = castItem(raw);
      if (!it || it.owner_id !== req.user.id) return { status: 403, error: "Only the giver picks" };
      if (it.claimed_by != null && it.claim_expires_at > now) return { status: 409, error: "Already picked" };
      const hand = await q("SELECT user_id FROM claim_requests WHERE item_id = $1 AND user_id = $2", [it.id, pickedId]);
      if (!hand.length) return { status: 400, error: "Pick one of the hands that went up" };
      const [updated] = await q("UPDATE items SET claimed_by = $1, claim_expires_at = $2 WHERE id = $3 RETURNING *", [
        pickedId,
        now + CLAIM_HOLD_MS,
        it.id,
      ]);
      return { item: castItem(updated) };
    });
    if (outcome.error) return fail(res, outcome.status, outcome.error);

    const it = outcome.item;
    /* the chosen one hears, the thread opens, the others are let down gently */
    const convId = await openThread(it, pickedId, now);
    await threadNote(
      convId,
      `${req.user.name.split(/[ ]+/)[0]} picked you for this — it's held for 30 minutes. It'll be waiting ${it.spot === "buzz and collect" ? "once you buzz" : `on the ${it.spot}`} at ${it.address}.`,
      now
    );
    const winRow = await one(
      "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [pickedId, it.id, it.title, "The giver picked you — it's yours for the next 30 minutes.", now]
    );
    pushTo(pickedId, {
      type: "alert",
      id: num(winRow.id),
      itemId: num(it.id),
      title: it.title,
      body: "The giver picked you — it's yours for the next 30 minutes.",
      createdAt: now,
    });

    const others = await query("SELECT user_id FROM claim_requests WHERE item_id = $1 AND user_id <> $2", [it.id, pickedId]);
    for (const o of others) {
      const row = await one(
        "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [o.user_id, it.id, it.title, "This one went to another neighbour — thanks for putting your hand up.", now]
      );
      pushTo(num(o.user_id), {
        type: "alert",
        id: num(row.id),
        itemId: num(it.id),
        title: it.title,
        body: "This one went to another neighbour — thanks for putting your hand up.",
        createdAt: now,
      });
    }
    res.json({ ok: true, conversationId: convId });
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

    const conv = await one("SELECT id FROM conversations WHERE item_id = $1 AND claimer_id = $2", [it.id, req.user.id]);
    if (conv) {
      await threadNote(num(conv.id), "Handed back — it's up for grabs again. No hard feelings.", now);
      await pushMessage(num(conv.id), req.user.id, "Handed back", now);
    }
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

    const conv = await one("SELECT id FROM conversations WHERE item_id = $1 AND claimer_id = $2", [it.id, req.user.id]);
    if (conv) {
      await threadNote(num(conv.id), "Collected. Another thing that never became waste.", now);
      await pushMessage(num(conv.id), req.user.id, "Collected", now);
    }
    res.json({ ok: true });
  })
);

/* One tap puts an expired, uncollected listing back up for another window —
   Trash Nothing calls this repost, and it is the difference between "nobody
   came" and "gone by tea time". */
app.post(
  "/api/items/:id/relist",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it || it.owner_id !== req.user.id) return fail(res, 403, "Only your own listing can go back up");
    if (it.collected_at != null) return fail(res, 400, "That one was collected — nothing to relist");
    if (it.expires_at > now) return fail(res, 400, "It's still live");
    if (it.type === "food" && it.use_by && it.use_by < now + 60 * 60 * 1000)
      return fail(res, 400, "Its use-by date is too close now — food past its date can't be passed on");

    const row = await one(
      "UPDATE items SET expires_at = $1, created_at = $2, claimed_by = NULL, claim_expires_at = NULL WHERE id = $3 RETURNING *",
      [now + num(it.window_ms), now, it.id]
    );
    const fresh = castItem(row);
    /* it counts as newly listed, so wishers hear about it — wish_told still
       guarantees nobody is told about the same item twice */
    await notifyMatchingWishes(fresh, req.user.id);
    res.json(await publicOne(fresh, req.user, now));
  })
);

/* what the sky has planned for a doorstep near you */
app.get(
  "/api/weather",
  auth,
  wrap(async (req, res) => {
    if (req.user.lat == null) return res.json({ warning: null });
    const hours = await rainOutlook(req.user.lat, req.user.lng);
    const windowHours = Math.max(1, Math.min(8, Number(req.query.hours) || 2));
    res.json({ warning: rainWarning(hours, windowHours) });
  })
);

/* Rain check: the most British button in the app. The window shifts back
   two hours, the bell resets, and everyone who saved it hears why. */
app.post(
  "/api/items/:id/raincheck",
  auth,
  wrap(async (req, res) => {
    const now = Date.now();
    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it || it.owner_id !== req.user.id) return fail(res, 403, "Only the giver can call rain");
    if (it.collected_at != null || it.expires_at <= now) return fail(res, 400, "That window has already closed");
    if (it.claimed_by != null && it.claim_expires_at > now)
      return fail(res, 400, "Someone's already on their way — message them instead");
    if (it.type === "food" && it.use_by && it.expires_at + 2 * 60 * 60 * 1000 > num(it.use_by))
      return fail(res, 400, "Its use-by date is too close for a delay");

    const newEnd = it.expires_at + 2 * 60 * 60 * 1000;
    await query("UPDATE items SET expires_at = $1, last_orders_told = FALSE WHERE id = $2", [newEnd, it.id]);

    const when = new Date(newEnd).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const savers = await query("SELECT user_id FROM saves WHERE item_id = $1 AND user_id <> $2", [it.id, it.owner_id]);
    for (const r of savers) {
      const body = `Rain check — it's tucked away for now and back out until ${when}.`;
      const row = await one(
        "INSERT INTO notifications (user_id, item_id, title, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [r.user_id, it.id, it.title, body, now]
      );
      pushTo(num(r.user_id), { type: "alert", id: num(row.id), itemId: num(it.id), title: it.title, body, createdAt: now });
    }
    res.json({ ok: true, until: newEnd });
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

/* ---- item passports ----
   One line each, from the people who actually held the thing: the person who
   gave it and the person who collected it. The line belongs to the lineage,
   not the listing, so it travels with the item to its next home. */
app.post(
  "/api/items/:id/passport-note",
  auth,
  wrap(async (req, res) => {
    const body = String((req.body || {}).body || "").trim();
    if (!body) return fail(res, 400, "Write a line first", "body");
    if (body.length > 120) return fail(res, 400, "Keep it to one line — 120 characters at most", "body");

    const it = castItem(await one("SELECT * FROM items WHERE id = $1", [req.params.id]));
    if (!it) return fail(res, 404, "That listing has gone");
    /* only hands that touched it may write: the current claimer once the
       handover has actually happened, or the person who gave it */
    const heldIt = (it.claimed_by === req.user.id && it.collected_at != null) || it.owner_id === req.user.id;
    if (!heldIt) return fail(res, 403, "Only the giver or whoever collected it can add to its story");

    /* a first note starts the passport — the lineage exists from here on,
       even if the item never gets relisted */
    let lineageId = it.lineage_id;
    if (!lineageId) {
      lineageId = newToken();
      await query("UPDATE items SET lineage_id = $1 WHERE id = $2", [lineageId, it.id]);
    }

    /* one line per person per story — checked in code rather than a unique
       index, since author_id goes NULL on erasure and must not collide */
    const already = await one("SELECT id FROM lineage_notes WHERE lineage_id = $1 AND author_id = $2", [
      lineageId,
      req.user.id,
    ]);
    if (already) return fail(res, 409, "You've already added your line to this one's story");

    await query("INSERT INTO lineage_notes (lineage_id, author_id, body, created_at) VALUES ($1,$2,$3,$4)", [
      lineageId,
      req.user.id,
      body,
      Date.now(),
    ]);
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

/* ---- following a giver ----
   The Vinted pattern: follow a neighbour whose taste you trust, and be told
   the moment they list something new. A block in either direction closes the
   door — following someone who blocked you would be a way around the block. */

app.post(
  "/api/givers/:id/follow",
  auth,
  wrap(async (req, res) => {
    const target = Number(req.params.id);
    if (target === req.user.id) return fail(res, 400, "You can't follow yourself — you already know what's on your doorstep");
    if (!(await one("SELECT id FROM users WHERE id = $1", [target]))) return fail(res, 404, "No such neighbour");
    const wall = await one(
      "SELECT 1 AS x FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
      [req.user.id, target]
    );
    if (wall) return fail(res, 403, "You can't follow this neighbour");
    await query("INSERT INTO follows (follower_id, giver_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
      req.user.id,
      target,
      Date.now(),
    ]);
    res.json({ ok: true, following: true });
  })
);

app.delete(
  "/api/givers/:id/follow",
  auth,
  wrap(async (req, res) => {
    await query("DELETE FROM follows WHERE follower_id = $1 AND giver_id = $2", [req.user.id, req.params.id]);
    res.json({ ok: true, following: false });
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
    const [listings, claims, wishList, watchlist, notifications, blocked, noShows, chatMessages, ratingsGiven] = await Promise.all([
      query("SELECT title, note, cat, road, address, created_at, expires_at, collected_at FROM items WHERE owner_id = $1", [id]),
      query("SELECT title, road, claim_expires_at, collected_at FROM items WHERE claimed_by = $1", [id]),
      query("SELECT keyword, cat, radius, created_at FROM wishes WHERE user_id = $1", [id]),
      query("SELECT item_id, created_at FROM saves WHERE user_id = $1", [id]),
      query("SELECT title, body, created_at FROM notifications WHERE user_id = $1", [id]),
      query("SELECT blocked_id, created_at FROM blocks WHERE blocker_id = $1", [id]),
      query("SELECT item_id, at FROM no_shows WHERE user_id = $1", [id]),
      query(
        `SELECT m.body, m.created_at, m.sender_id = $1 AS sent FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE (c.giver_id = $1 OR c.claimer_id = $1) AND m.sender_id IS NOT NULL`,
        [id]
      ),
      query("SELECT item_id, stars, created_at FROM ratings WHERE rater_id = $1", [id]),
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
      chatMessages,
      ratingsGiven,
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
      await q("DELETE FROM wish_told WHERE user_id = $1", [id]);
      await q("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE giver_id = $1 OR claimer_id = $1)", [id]);
      await q("DELETE FROM conversations WHERE giver_id = $1 OR claimer_id = $1", [id]);
      await q("DELETE FROM ratings WHERE rater_id = $1 OR ratee_id = $1", [id]);
      await q("DELETE FROM claim_requests WHERE user_id = $1", [id]);
      await q("DELETE FROM wishes WHERE user_id = $1", [id]);
      await q("DELETE FROM notifications WHERE user_id = $1", [id]);
      await q("DELETE FROM saves WHERE user_id = $1", [id]);
      /* an open doorstep is the neighbour's own event, so it goes with them;
         the things they put out for it stay standing on their own windows,
         simply no longer pointing at a sale that no longer exists */
      await q("UPDATE items SET event_id = NULL WHERE event_id IN (SELECT id FROM events WHERE owner_id = $1)", [id]);
      await q("DELETE FROM events WHERE owner_id = $1", [id]);
      /* spotted piles are theirs in authorship even if not in property, so
         they go entirely — takes and reports on other people's spots first,
         then their own spots, whose takes and reports cascade with them */
      await q("DELETE FROM spot_takes WHERE user_id = $1", [id]);
      await q("DELETE FROM spot_reports WHERE user_id = $1", [id]);
      await q("DELETE FROM spots WHERE spotter_id = $1", [id]);
      await q("DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1", [id]);
      await q("DELETE FROM follows WHERE follower_id = $1 OR giver_id = $1", [id]);
      /* lineage_notes need nothing here: the account row is anonymised below
         rather than deleted, notes are shown without a name anyway, and the
         column's ON DELETE SET NULL covers any future hard delete — the
         item's story outlives the neighbour who wrote a line of it */
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

/* The demo neighbourhood is furniture for an empty room, and it must never
   be mistaken for the real thing. Its two hundred listings carry real
   Hackney house numbers, so a neighbour who trusted them could walk to a
   stranger's actual front door expecting a chair. It therefore seeds only
   where it is obviously a demo — a local PGlite database — and refuses to
   touch a real Postgres unless someone deliberately asks for it in writing
   with SEED_DEMO=1. */
const seedingWanted = process.env.SEED_DEMO === "1" || !process.env.DATABASE_URL;

const start = async () => {
  await initDb();
  if (seedingWanted) await refreshSeed();
  else console.log("Live database: the demo neighbourhood was not seeded (set SEED_DEMO=1 to override).");
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
