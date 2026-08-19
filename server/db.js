import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/* Illustrations for the demo listings, generated once and committed so a
   fresh database looks like a real neighbourhood rather than a wireframe. */
let SEED_PHOTOS = {};
try {
  SEED_PHOTOS = JSON.parse(fs.readFileSync(path.join(here, "seed-photos.json"), "utf8"));
} catch {
  /* no illustrations available — the app falls back to its drawn glyphs */
}

/* A library of illustrations keyed by slug, shared across the catalogue, and
   the catalogue itself: 200 listings with real Hackney roads and postcodes. */
let PHOTO_LIB = {};
try {
  PHOTO_LIB = JSON.parse(fs.readFileSync(path.join(here, "seed-photo-library.json"), "utf8"));
} catch {}

export const photoLibrary = () => PHOTO_LIB;

let CATALOGUE = [];
try {
  CATALOGUE = JSON.parse(fs.readFileSync(path.join(here, "seed-catalogue.json"), "utf8"));
} catch {}

/* which drawn glyph stands in when a slug has no illustration yet */
const GLYPH_FOR_SLUG = {
  bookcase: "bookcase", "shelf-unit": "bookcase", wardrobe: "bookcase", "chest-of-drawers": "bookcase",
  armchair: "chairs", "dining-chair": "chairs", stool: "chairs", "coffee-table": "chairs", desk: "chairs", mirror: "chairs",
  "toy-kitchen": "toys", "soft-toys": "toys", "board-games": "toys", "kids-books": "toys", "stair-gate": "toys",
  "balance-bike": "bike", pushchair: "bike",
  "high-chair": "baby", "baby-bath": "baby",
  "plant-pot": "garden", houseplant: "garden", "garden-chair": "garden", "watering-can": "garden",
  "plant-trays": "garden", "garden-tools": "garden",
  "floor-lamp": "bookcase", "desk-lamp": "bookcase", kettle: "bookcase", toaster: "bookcase", fan: "bookcase", radio: "bookcase",
  bread: "bread", vegetables: "veg", dairy: "dairy", tins: "tin", "ready-meal": "meal", drinks: "drink",
};

/* Postgres, two ways.
   In production DATABASE_URL points at Supabase and we use `pg`.
   Locally, and in tests, there is no server to run: PGlite is Postgres
   compiled to WASM, in-process, speaking the same SQL. Same queries, same
   semantics, no Docker, no install. */

const url = process.env.DATABASE_URL;

let pool = null;
let lite = null;

async function connect() {
  if (pool || lite) return;
  if (url) {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({
      connectionString: url,
      /* Supabase terminates TLS at its pooler with its own chain */
      ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    await pool.query("SELECT 1");
  } else {
    /* No DATABASE_URL. Locally that means PGlite; on a host it almost
       certainly means the variable was forgotten, so say so plainly rather
       than failing on a missing dev dependency. */
    try {
      const { PGlite } = await import("@electric-sql/pglite");
      /* PGLITE_DIR keeps a local database between restarts; unset means memory */
      lite = new PGlite(process.env.PGLITE_DIR || undefined);
      await lite.query("SELECT 1");
    } catch (e) {
      throw new Error(
        "No DATABASE_URL is set, and the local Postgres fallback isn't available. " +
          "Set DATABASE_URL to your Supabase connection string (Session pooler, port 5432).",
        { cause: e }
      );
    }
  }
}

/* Every query goes through here, so both backends behave identically. */
export async function query(text, params = []) {
  if (pool) return (await pool.query(text, params)).rows;
  return (await lite.query(text, params)).rows;
}

/* A multi-statement script (the schema) goes down a different path: the
   extended protocol only accepts one command per parse, so both drivers need
   their simple-query entry point rather than a parameterised query. */
export async function exec(script) {
  if (pool) return void (await pool.query(script));
  return void (await lite.exec(script));
}

export async function one(text, params = []) {
  const rows = await query(text, params);
  return rows[0];
}

/* A transaction needs the same connection throughout, so it takes a pooled
   client rather than going back to the pool for each statement. */
export async function tx(fn) {
  if (lite) {
    await lite.query("BEGIN");
    try {
      const result = await fn(async (text, params = []) => (await lite.query(text, params)).rows);
      await lite.query("COMMIT");
      return result;
    } catch (e) {
      await lite.query("ROLLBACK");
      throw e;
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(async (text, params = []) => (await client.query(text, params)).rows);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  if (pool) await pool.end();
  if (lite) await lite.close();
  pool = null;
  lite = null;
}

/* Times are epoch milliseconds in BIGINT columns. node-postgres returns
   BIGINT as a string to avoid precision loss, which would quietly turn every
   countdown into NaN — so anything numeric is cast on the way out. */
export const num = (v) => (v == null ? null : Number(v));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  postcode      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  address       TEXT,
  road          TEXT,
  spot          TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id               BIGSERIAL PRIMARY KEY,
  owner_id         BIGINT NOT NULL REFERENCES users(id),
  title            TEXT NOT NULL,
  note             TEXT NOT NULL DEFAULT '',
  cat              TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'bookcase',
  road             TEXT NOT NULL,
  address          TEXT NOT NULL,
  dist             TEXT NOT NULL DEFAULT '',
  window_ms        BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  claimed_by       BIGINT REFERENCES users(id),
  claim_expires_at BIGINT,
  created_at       BIGINT NOT NULL,
  photo            TEXT,
  photos           TEXT,
  postcode         TEXT,
  lat              DOUBLE PRECISION,
  lng              DOUBLE PRECISION,
  spot             TEXT NOT NULL DEFAULT 'doorstep',
  collected_at     BIGINT,
  hidden_at        BIGINT,
  type             TEXT NOT NULL DEFAULT 'nonfood',
  use_by           BIGINT,
  portions         INTEGER NOT NULL DEFAULT 1,
  photo_ref        TEXT,
  details          TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_expires ON items(expires_at);
CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id);
CREATE INDEX IF NOT EXISTS idx_items_claimed ON items(claimed_by);

CREATE TABLE IF NOT EXISTS postcode_cache (
  postcode TEXT PRIMARY KEY,
  lat      DOUBLE PRECISION NOT NULL,
  lng      DOUBLE PRECISION NOT NULL
);

/* Who has already been told about which item. Kept apart from wish_hits so
   that deleting a wish and adding it back doesn't replay alerts someone has
   already read. */
CREATE TABLE IF NOT EXISTS wish_told (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at      BIGINT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS street_cache (
  lat  DOUBLE PRECISION NOT NULL,
  lng  DOUBLE PRECISION NOT NULL,
  road TEXT NOT NULL,
  PRIMARY KEY (lat, lng)
);

CREATE TABLE IF NOT EXISTS no_shows (
  id      BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id BIGINT,
  at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wishes (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword    TEXT NOT NULL DEFAULT '',
  cat        TEXT NOT NULL DEFAULT 'Anything',
  radius     DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wish_hits (
  wish_id BIGINT NOT NULL REFERENCES wishes(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at      BIGINT NOT NULL,
  PRIMARY KEY (wish_id, item_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    BIGINT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  read_at    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

/* One conversation per claim: the giver, the claimer, and the thing between
   them. Chat exists to arrange a handover, not to be a social network, so a
   thread is born when a claim is made and nowhere else. */
CREATE TABLE IF NOT EXISTS conversations (
  id         BIGSERIAL PRIMARY KEY,
  item_id    BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  giver_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  UNIQUE (item_id, claimer_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = the app itself
  body            TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  read_at         BIGINT
);

/* Both sides rate a handover once it has happened — stars unlock only after
   collection, one rating per person per item, exactly Olio's gate. */
CREATE TABLE IF NOT EXISTS ratings (
  id         BIGSERIAL PRIMARY KEY,
  item_id    BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rater_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratee_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at BIGINT NOT NULL,
  UNIQUE (item_id, rater_id)
);

/* Fair chance: hands up instead of fastest finger. The window collects
   requests; the giver picks one, looking at distance and record rather than
   reaction time. Trash Nothing pledges this; here it is a mode. */
CREATE TABLE IF NOT EXISTS claim_requests (
  id      BIGSERIAL PRIMARY KEY,
  item_id BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      BIGINT NOT NULL,
  UNIQUE (item_id, user_id)
);

CREATE TABLE IF NOT EXISTS saves (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS thanks (
  id         BIGSERIAL PRIMARY KEY,
  item_id    BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  from_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (item_id, from_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          BIGSERIAL PRIMARY KEY,
  item_id     BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  UNIQUE (item_id, reporter_id)
);
`;

export async function initDb() {
  await connect();
  await exec(SCHEMA);
  /* additive migrations, so an existing database picks up food support */
  await exec(`
    ALTER TABLE items ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'nonfood';
    ALTER TABLE items ADD COLUMN IF NOT EXISTS use_by BIGINT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS portions INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS photo_ref TEXT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS details TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS uprn TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_verified TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS away_until BIGINT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS wanted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS claim_mode TEXT NOT NULL DEFAULT 'instant';
    ALTER TABLE items ADD COLUMN IF NOT EXISTS last_orders_told BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS under_cover BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS dibs BOOLEAN NOT NULL DEFAULT FALSE;
  `);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, "hex");
  return known.length === candidate.length && crypto.timingSafeEqual(known, candidate);
}

export function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* emails are matched case-insensitively, so they are stored folded */
export const foldEmail = (e) => String(e || "").trim().toLowerCase();

/* Demo data — London Fields / Dalston / Stoke Newington, the launch
   neighbourhood. Real roads, real postcodes, coordinates verified via
   postcodes.io. Seed listings are re-listed with fresh windows on every boot
   so the feed is never empty. */
const SEED_GIVERS = [
  { name: "Maya Fletcher", email: "maya@doorstep.seed", postcode: "E8 3PH", lat: 51.54099, lng: -0.05766 },
  { name: "Tomasz Nowak", email: "tomasz@doorstep.seed", postcode: "E8 3EP", lat: 51.54161, lng: -0.06368 },
  { name: "Adaeze Okonkwo", email: "adaeze@doorstep.seed", postcode: "E8 1BG", lat: 51.5457, lng: -0.06159 },
];

const DEMO = { name: "Demo User", email: "demo@doorstep.uk", postcode: "E8 3EP", lat: 51.54161, lng: -0.06368 };

const SEED_ITEMS = [
  { giver: 0, title: "Pine bookcase", note: "Solid pine, five shelves, a few scuffs. Behind the front gate by the bins.", cat: "Furniture", kind: "bookcase", road: "Ellingfort Road, E8", postcode: "E8 3PA", lat: 51.54248, lng: -0.05646, address: "14 Ellingfort Road, London E8 3PA", left: 98, spot: "front garden" },
  { giver: 1, title: "IKEA POÄNG armchair", note: "Birch frame, beige cushion, no rips. Ground-floor porch, easy carry.", cat: "Furniture", kind: "chairs", road: "Navarino Road, E8", postcode: "E8 1AD", lat: 51.54473, lng: -0.06193, address: "27 Navarino Road, London E8 1AD", left: 115, spot: "porch" },
  { giver: 2, title: "Kids balance bike", note: "Strider 12 inch, outgrown. Tyres pumped, ready to ride. Front garden, behind the gate.", cat: "Kids", kind: "bike", road: "Gayhurst Road, E8", postcode: "E8 3EN", lat: 51.54237, lng: -0.06258, address: "52 Gayhurst Road, London E8 3EN", left: 52, spot: "front garden" },
  { giver: 0, title: "Wooden toy kitchen", note: "IKEA DUKTIG with pans and play food. Bulky but light — on the front steps.", cat: "Kids", kind: "toys", road: "Sandringham Road, E8", postcode: "E8 2LR", lat: 51.54993, lng: -0.07267, address: "89 Sandringham Road, London E8 2LR", left: 81, spot: "doorstep" },
  { giver: 1, title: "Baby bath + stand", note: "Shnuggle bath with folding stand, cleaned up. On the porch all afternoon.", cat: "Kids", kind: "baby", road: "Parkholme Road, E8", postcode: "E8 3AG", lat: 51.54462, lng: -0.06863, address: "34 Parkholme Road, London E8 3AG", left: 38, spot: "porch" },
  { giver: 2, title: "Monstera in ceramic pot", note: "About 1m tall, healthy, pot included. By our front door — the blue one.", cat: "Garden", kind: "garden", road: "Broadway Market, E8", postcode: "E8 4PH", lat: 51.53675, lng: -0.06188, address: "71a Broadway Market, London E8 4PH", left: 9, spot: "doorstep" },
  { giver: 0, title: "Terracotta pots x6", note: "Various sizes, one chipped. Stacked inside the front wall — bring a bag.", cat: "Garden", kind: "garden", road: "Barbauld Road, N16", postcode: "N16 0SS", lat: 51.55765, lng: -0.08125, address: "18 Barbauld Road, London N16 0SS", left: 67, spot: "front garden" },
  { giver: 1, title: "Standing lamp", note: "Tall arc floor lamp, works fine, bulb included. On the doorstep of the flat entrance.", cat: "Electricals", kind: "bookcase", road: "Stoke Newington High Street, N16", postcode: "N16 8EL", lat: 51.5592, lng: -0.07442, address: "69b Stoke Newington High Street, London N16 8EL", left: 25, spot: "buzz and collect" },
];

/* Already-collected items, so the diversion figures are not a wall of zeros.
   Dated over the past three weeks and already expired, so they never appear
   in the feed — only in the impact report. */
const SEED_HISTORY = [
  { title: "Chest of drawers", cat: "Furniture", kind: "bookcase", pic: "chest-of-drawers", road: "Ellingfort Road, E8", postcode: "E8 3PA", daysAgo: 19 },
  { title: "Highchair", cat: "Kids", kind: "baby", pic: "high-chair", road: "Navarino Road, E8", postcode: "E8 1AD", daysAgo: 16 },
  { title: "Garden bench", cat: "Garden", kind: "garden", pic: "garden-chair", road: "Gayhurst Road, E8", postcode: "E8 3EN", daysAgo: 12 },
  { title: "Desk lamp", cat: "Electricals", kind: "bookcase", pic: "desk-lamp", road: "Sandringham Road, E8", postcode: "E8 2LR", daysAgo: 9 },
  { title: "Bookshelf", cat: "Furniture", kind: "bookcase", pic: "shelf-unit", road: "Parkholme Road, E8", postcode: "E8 3AG", daysAgo: 5 },
  { title: "Scooter", cat: "Kids", kind: "bike", pic: "balance-bike", road: "Barbauld Road, N16", postcode: "N16 0SS", daysAgo: 2 },
];

/* "Just gone" only means something if it really did just go. These were
   collected by other neighbours in the last day or so, so the strip on the
   home screen shows the neighbourhood actually working rather than a
   fortnight of stale history. */
const SEED_JUST_GONE = [
  { title: "Ercol dining chairs x2", cat: "Furniture", kind: "chairs", pic: "dining-chair", road: "Wilton Way, E8", postcode: "E8 3PZ", minutesAgo: 14 },
  { title: "Sourdough, still warm", cat: "Bakery", kind: "bread", pic: "bread", road: "Broadway Market, E8", postcode: "E8 4QJ", minutesAgo: 31, type: "food" },
  { title: "Monstera, big one", cat: "Garden", kind: "garden", pic: "houseplant", road: "Lansdowne Drive, E8", postcode: "E8 3EP", minutesAgo: 52 },
  { title: "Toddler stair gate", cat: "Kids", kind: "baby", pic: "stair-gate", road: "Greenwood Road, E8", postcode: "E8 1AB", minutesAgo: 78 },
  { title: "Dualit toaster", cat: "Electricals", kind: "bookcase", pic: "toaster", road: "Mare Street, E8", postcode: "E8 3RH", minutesAgo: 104 },
  { title: "Box of board games", cat: "Kids", kind: "toys", pic: "board-games", road: "Richmond Road, E8", postcode: "E8 3AS", minutesAgo: 142 },
  { title: "Veg box, half unused", cat: "Fruit & veg", kind: "veg", pic: "vegetables", road: "Middleton Road, E8", postcode: "E8 4LN", minutesAgo: 189, type: "food" },
  { title: "Pine desk", cat: "Furniture", kind: "bookcase", pic: "desk", road: "Dalston Lane, E8", postcode: "E8 3AH", minutesAgo: 236 },
  { title: "Watering can and trays", cat: "Garden", kind: "garden", pic: "watering-can", road: "Forest Road, E8", postcode: "E8 3BH", minutesAgo: 305 },
  { title: "Two floor cushions", cat: "Furniture", kind: "chairs", pic: "stool", road: "Albion Drive, E8", postcode: "E8 4ET", minutesAgo: 402 },
  { title: "Kids books, a whole bag", cat: "Kids", kind: "toys", pic: "kids-books", road: "Queensbridge Road, E8", postcode: "E8 3ND", minutesAgo: 520 },
  { title: "Anglepoise lamp", cat: "Electricals", kind: "bookcase", pic: "floor-lamp", road: "Shrubland Road, E8", postcode: "E8 4NN", minutesAgo: 640 },
];

/* Food moves faster and lives shorter, so the demo reflects that: short
   windows, portions, and a use-by date on everything. */
const SEED_FOOD = [
  { giver: 0, title: "Sourdough loaves x2", note: "Baked this morning at the bakery on the corner, more than we can eat.", cat: "Bakery", kind: "bread", road: "Ellingfort Road, E8", postcode: "E8 3PA", lat: 51.54248, lng: -0.05646, address: "14 Ellingfort Road, London E8 3PA", left: 95, spot: "doorstep", portions: 2, useByDays: 1 },
  { giver: 1, title: "Veg box, half unused", note: "Carrots, leeks, two peppers and a squash. All firm.", cat: "Fruit & veg", kind: "veg", road: "Navarino Road, E8", postcode: "E8 1AD", lat: 51.54473, lng: -0.06193, address: "27 Navarino Road, London E8 1AD", left: 140, spot: "porch", portions: 4, useByDays: 3 },
  { giver: 2, title: "Six eggs and a butter", note: "Bought too much before going away. Unopened.", cat: "Dairy", kind: "dairy", road: "Gayhurst Road, E8", postcode: "E8 3EN", lat: 51.54237, lng: -0.06258, address: "52 Gayhurst Road, London E8 3EN", left: 62, spot: "doorstep", portions: 6, useByDays: 5 },
  { giver: 0, title: "Tins: chickpeas, tomatoes", note: "Four tins, all in date, from a shop we no longer use.", cat: "Store cupboard", kind: "tin", road: "Sandringham Road, E8", postcode: "E8 2LR", lat: 51.54993, lng: -0.07267, address: "89 Sandringham Road, London E8 2LR", left: 175, spot: "front garden", portions: 4, useByDays: 200 },
  { giver: 1, title: "Two cartons of oat milk", note: "Unopened, we switched brands.", cat: "Drinks", kind: "drink", road: "Parkholme Road, E8", postcode: "E8 3AG", lat: 51.54462, lng: -0.06863, address: "34 Parkholme Road, London E8 3AG", left: 45, spot: "porch", portions: 2, useByDays: 9 },
];

/* Asks: things neighbours are after. A young feed with only twenty offers
   still feels alive if people can be seen wanting. */
const SEED_ASKS = [
  { giver: 0, title: "Moving boxes, any size", note: "We're packing up the flat this weekend — flattened ones are perfect.", cat: "Furniture", kind: "bookcase", road: "Wilton Way, E8", postcode: "E8 3PZ", hours: 48 },
  { giver: 1, title: "Spare plant pots", note: "Repotting season. Terracotta or plastic, any state, will collect.", cat: "Garden", kind: "garden", road: "Middleton Road, E8", postcode: "E8 4LN", hours: 72 },
  { giver: 2, title: "Toddler wellies, size 8", note: "Puddle season is upon us and she's outgrown hers overnight.", cat: "Kids", kind: "toys", road: "Albion Drive, E8", postcode: "E8 4ET", hours: 48 },
  { giver: 0, title: "A few jam jars with lids", note: "Making chutney, ran out of jars. Half a dozen would do.", cat: "Store cupboard", kind: "tin", road: "Shrubland Road, E8", postcode: "E8 4NN", hours: 24 },
];

/* Coordinates for a seeded postcode: cached first, then postcodes.io, then
   the middle of London Fields so a seed never fails on a bad connection. */
async function geocodeSeed(postcode) {
  const clean = String(postcode).toUpperCase().replace(/\s+/g, "");
  const hit = await one("SELECT lat, lng FROM postcode_cache WHERE postcode = $1", [clean]);
  if (hit) return hit;
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
    if (res.ok) {
      const { result } = await res.json();
      await query(
        "INSERT INTO postcode_cache (postcode, lat, lng) VALUES ($1,$2,$3) ON CONFLICT (postcode) DO NOTHING",
        [clean, result.latitude, result.longitude]
      );
      return { lat: result.latitude, lng: result.longitude };
    }
  } catch {}
  return { lat: 51.54163, lng: -0.05754 };
}

export async function refreshSeed() {
  const now = Date.now();

  const ensureUser = async ({ name, email, postcode, lat, lng }, password) => {
    const key = foldEmail(email);
    const existing = await one("SELECT id FROM users WHERE email = $1", [key]);
    if (existing) {
      await query("UPDATE users SET postcode = $1, lat = $2, lng = $3 WHERE id = $4", [postcode, lat, lng, existing.id]);
      return Number(existing.id);
    }
    const row = await one(
      "INSERT INTO users (name, email, postcode, password_hash, created_at, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [name, key, postcode, hashPassword(password), now, lat, lng]
    );
    return Number(row.id);
  };

  const giverIds = [];
  for (const g of SEED_GIVERS) giverIds.push(await ensureUser(g, newToken()));
  const demoId = await ensureUser(DEMO, "doorstep123");

  /* clear previous seed listings — dependants first, since they reference items */
  const stale = await query("SELECT id FROM items WHERE owner_id = ANY($1::bigint[]) OR lat IS NULL", [giverIds]);
  const staleIds = stale.map((r) => r.id);
  if (staleIds.length) {
    for (const t of ["saves", "wish_hits", "reports", "thanks"]) {
      await query(`DELETE FROM ${t} WHERE item_id = ANY($1::bigint[])`, [staleIds]);
    }
    await query("DELETE FROM notifications WHERE item_id = ANY($1::bigint[])", [staleIds]);
    await query("DELETE FROM no_shows WHERE item_id = ANY($1::bigint[])", [staleIds]);
    await query("DELETE FROM items WHERE id = ANY($1::bigint[])", [staleIds]);
  }

  const windowMs = 2 * 60 * 60 * 1000;
  const listed = {};
  for (const it of SEED_ITEMS) {
    const shots = SEED_PHOTOS[it.title] || [];
    const row = await one(
      `INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot, photo, photos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [
        giverIds[it.giver],
        it.title,
        it.note,
        it.cat,
        it.kind,
        it.road,
        it.address,
        windowMs,
        now + it.left * 60 * 1000,
        now,
        it.postcode,
        it.lat,
        it.lng,
        it.spot,
        shots[0] || null,
        JSON.stringify(shots),
      ]
    );
    listed[it.title] = Number(row.id);
  }

  for (const f of SEED_FOOD) {
    const shots = SEED_PHOTOS[f.title] || [];
    await query(
      `INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot, photo, photos, type, use_by, portions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12,$13,$14,$15,$16,'food',$17,$18)`,
      [
        giverIds[f.giver], f.title, f.note, f.cat, f.kind, f.road, f.address,
        f.left * 60 * 1000, now + f.left * 60 * 1000, now, f.postcode, f.lat, f.lng, f.spot,
        shots[0] || null, JSON.stringify(shots),
        now + f.useByDays * 24 * 60 * 60 * 1000,
        f.portions,
      ]
    );
  }

  /* Plausible details for a seeded listing, derived from what it is, so the
     demo shows the spec table doing its job rather than sitting empty. */
  const detailsFor = (c) => {
    const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
    const n = c.title.length + c.road.length;
    const d = { condition: pick(["As good as new", "Good", "Good", "Fair", "Well used"], n) };

    if (c.type === "food") {
      d.storage = c.cat === "Bakery" || c.cat === "Store cupboard" ? "Cupboard" : c.cat === "Drinks" ? "Cupboard" : "Fridge";
      d.opened = pick(["Unopened", "Unopened", "Opened but sealed inside"], n);
      d.diet = pick(["Anyone", "Anyone", "Vegetarian", "Vegan"], n + 1);
      d.carry = "One person can carry it";
      return d;
    }

    d.carry = pick(
      ["One person can carry it", "One person can carry it", "Two people", "Needs a car or van"],
      n + (c.cat === "Furniture" ? 2 : 0)
    );

    if (c.cat === "Furniture") {
      d.width = 40 + (n % 120);
      d.depth = 30 + (n % 45);
      d.height = 45 + (n % 130);
      d.material = pick(["Wood", "Wood", "Metal", "Fabric", "Glass", "Mixed"], n);
      d.colour = pick(["Oak", "Pine", "White", "Black", "Grey", "Beech"], n + 3);
      d.flatpack = pick(["Yes, flat packs", "No, one piece"], n);
    } else if (c.cat === "Kids") {
      d.ages = pick(["0-1", "1-3", "3-5", "5-8", "8-12", "Any age"], n);
      d.pieces = pick(["Yes, complete", "Yes, complete", "Some pieces missing"], n);
      d.washed = pick(["Yes, cleaned", "Needs a wipe"], n + 1);
    } else if (c.cat === "Garden") {
      d.width = 15 + (n % 70);
      d.height = 15 + (n % 90);
      d.material = pick(["Terracotta", "Plastic", "Wood", "Metal", "Stone"], n);
    } else if (c.cat === "Electricals") {
      d.works = pick(["Works fine", "Works fine", "Works fine", "Works, with a fault"], n);
      d.cable = pick(["Included", "Included", "Not included"], n);
      d.age = pick(["Under a year", "1-3 years", "3-5 years", "Over 5 years"], n + 2);
    }
    return d;
  };

  /* The catalogue: 200 listings across twenty real Hackney roads. Each one
     takes its illustration from the shared library by slug, so two hundred
     items cost the size of thirty-odd pictures rather than two hundred. */
  if (CATALOGUE.length) {
    /* the row stores which illustration to use, not the illustration itself:
       two hundred listings share thirty-odd pictures, and the browser can
       cache each one once instead of receiving it in every response */
    const insert = `INSERT INTO items
      (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot, photo, photos, type, use_by, portions, photo_ref, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`;

    for (const [i, c] of CATALOGUE.entries()) {
      const coords = await geocodeSeed(c.postcode);
      const windowMs = (c.windowHours || 2) * 60 * 60 * 1000;
      const expires = now + c.minutesLeft * 60 * 1000;
      await query(insert, [
        giverIds[i % giverIds.length],
        c.title,
        c.note,
        c.cat,
        GLYPH_FOR_SLUG[c.photo] || "bookcase",
        c.road,
        `${c.house} ${c.road.replace(/,.*$/, "")}, London ${c.postcode}`,
        windowMs,
        expires,
        now,
        c.postcode,
        coords.lat,
        coords.lng,
        c.spot,
        null,
        "[]",
        c.type,
        c.type === "food" ? now + c.useByDays * 24 * 60 * 60 * 1000 : null,
        c.type === "food" ? c.portions : 1,
        c.photo,
        JSON.stringify(detailsFor(c)),
      ]);
    }
  }

  /* collected history, owned by the seed givers and taken by the demo user */
  const history = {};
  for (const [i, h] of SEED_HISTORY.entries()) {
    const at = now - h.daysAgo * 24 * 60 * 60 * 1000;
    const coords = await one("SELECT lat, lng FROM postcode_cache WHERE postcode = $1", [h.postcode.replace(/\s+/g, "")]);
    const hist = await one(
      `INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot, claimed_by, claim_expires_at, collected_at, photo_ref)
       VALUES ($1,$2,'',$3,$4,$5,$6,'',$7,$8,$9,$10,$11,$12,'doorstep',$13,$14,$15,$16) RETURNING id`,
      [
        giverIds[i % giverIds.length],
        h.title,
        h.cat,
        h.kind,
        h.road,
        `${10 + i} ${h.road}`,
        windowMs,
        at,
        at - windowMs,
        h.postcode,
        coords ? coords.lat : 51.5416,
        coords ? coords.lng : -0.0575,
        demoId,
        at,
        at,
        h.pic || null,
      ]
    );
    history[h.title] = Number(hist.id);
  }

  /* things that went in the last few hours, collected by neighbours rather
     than the demo account, so "Just gone" has something true to show */
  for (const [i, g] of SEED_JUST_GONE.entries()) {
    const at = now - g.minutesAgo * 60 * 1000;
    const coords = await geocodeSeed(g.postcode);
    const taker = giverIds[(i + 1) % giverIds.length];
    await query(
      `INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot, claimed_by, claim_expires_at, collected_at, photo_ref, type)
       VALUES ($1,$2,'',$3,$4,$5,$6,'',$7,$8,$9,$10,$11,$12,'doorstep',$13,$14,$15,$16,$17)`,
      [
        giverIds[i % giverIds.length],
        g.title,
        g.cat,
        g.kind,
        g.road,
        `${20 + i} ${g.road.replace(/,.*$/, "")}`,
        2 * 60 * 60 * 1000,
        at,
        at - 2 * 60 * 60 * 1000,
        g.postcode,
        coords.lat,
        coords.lng,
        taker,
        at,
        at,
        g.pic,
        g.type || "nonfood",
      ]
    );
  }

  /* live asks */
  for (const [i, a] of SEED_ASKS.entries()) {
    const coords = await geocodeSeed(a.postcode);
    await query(
      `INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot, type, wanted)
       VALUES ($1,$2,$3,$4,$5,$6,'','',$7,$8,$9,$10,$11,$12,'doorstep','nonfood',TRUE)`,
      [
        giverIds[a.giver],
        a.title,
        a.note,
        a.cat,
        a.kind,
        a.road,
        a.hours * 60 * 60 * 1000,
        now + a.hours * 60 * 60 * 1000 - i * 37 * 60 * 1000,
        now - i * 41 * 60 * 1000,
        a.postcode,
        coords.lat,
        coords.lng,
      ]
    );
  }

  await seedActivity({ now, demoId, giverIds, listed, history });
}

/* Everything else a demo needs: a claim on the go, a couple of saved items,
   a wish list with a hit against it, thanks already sent, and the alerts
   those actions produce. Without this the personal screens are all empty and
   the app looks half-finished on first run. */
async function seedActivity({ now, demoId, giverIds, listed, history }) {
  const wipe = [
    ["saves", "user_id"],
    ["wishes", "user_id"],
    ["notifications", "user_id"],
    ["thanks", "from_id"],
  ];
  await query("DELETE FROM wish_hits WHERE wish_id IN (SELECT id FROM wishes WHERE user_id = $1)", [demoId]);
  await query("DELETE FROM wish_told WHERE user_id = $1", [demoId]);
  for (const [table, col] of wipe) await query(`DELETE FROM ${table} WHERE ${col} = $1`, [demoId]);

  /* one item already claimed, so "To collect" has something in it and the
     30-minute hold is visibly ticking */
  const claiming = listed["Kids balance bike"];
  if (claiming) {
    await query("UPDATE items SET claimed_by = $1, claim_expires_at = $2 WHERE id = $3", [
      demoId,
      now + 22 * 60 * 1000,
      claiming,
    ]);
  }

  /* two things saved for later */
  for (const title of ["Pine bookcase", "Monstera in ceramic pot"]) {
    if (listed[title]) {
      await query("INSERT INTO saves (user_id, item_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
        demoId,
        listed[title],
        now - 20 * 60 * 1000,
      ]);
    }
  }

  /* a wish list, one of which has already turned something up */
  const wishes = [
    { keyword: "desk", cat: "Furniture", radius: 1 },
    { keyword: "lamp", cat: "Anything", radius: 2 },
    { keyword: "", cat: "Kids", radius: 0.5 },
  ];
  const wishIds = [];
  for (const w of wishes) {
    const row = await one(
      "INSERT INTO wishes (user_id, keyword, cat, radius, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [demoId, w.keyword, w.cat, w.radius, now - 3 * 24 * 60 * 60 * 1000]
    );
    wishIds.push(Number(row.id));
  }

  /* the lamp wish matched the standing lamp that is live right now */
  const lampWish = wishIds[1];
  const lamp = listed["Standing lamp"];
  if (lampWish && lamp) {
    await query("INSERT INTO wish_hits (wish_id, item_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
      lampWish,
      lamp,
      now - 25 * 60 * 1000,
    ]);
    await query(
      "INSERT INTO notifications (user_id, item_id, title, body, created_at, read_at) VALUES ($1,$2,$3,$4,$5,NULL)",
      [
        demoId,
        lamp,
        "Standing lamp",
        "On your wish list, and it's already up — 1.3 mi away on Stoke Newington High Street, N16.",
        now - 25 * 60 * 1000,
      ]
    );
  }

  /* an older alert, already read, so the list is not all unread */
  if (listed["Baby bath + stand"]) {
    await query(
      "INSERT INTO notifications (user_id, item_id, title, body, created_at, read_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        demoId,
        listed["Baby bath + stand"],
        "Baby bath + stand",
        "0.3 mi away on Parkholme Road, E8 — claim it before the window closes.",
        now - 90 * 60 * 1000,
        now - 80 * 60 * 1000,
      ]
    );
  }

  /* things the demo user has put out themselves, so "Given" is not empty:
     one live, one that nobody took (which is the route into the charity
     fallback), and one already collected with a thank-you against it */
  await query("DELETE FROM thanks WHERE to_id = $1", [demoId]);
  const mineStale = await query("SELECT id FROM items WHERE owner_id = $1", [demoId]);
  const mineIds = mineStale.map((r) => r.id);
  if (mineIds.length) {
    for (const t of ["saves", "wish_hits", "reports", "thanks"]) {
      await query(`DELETE FROM ${t} WHERE item_id = ANY($1::bigint[])`, [mineIds]);
    }
    await query("DELETE FROM notifications WHERE item_id = ANY($1::bigint[])", [mineIds]);
    await query("DELETE FROM no_shows WHERE item_id = ANY($1::bigint[])", [mineIds]);
    await query("DELETE FROM items WHERE id = ANY($1::bigint[])", [mineIds]);
  }

  const home = { road: "Gayhurst Road, E8", postcode: "E8 3EN", lat: 51.54237, lng: -0.06258, address: "18 Gayhurst Road, London E8 3EN" };
  const windowMs2 = 2 * 60 * 60 * 1000;
  const mine = [
    { title: "Cane laundry basket", note: "Lid included, one small split in the weave.", cat: "Furniture", kind: "bookcase", spot: "porch", expires: now + 74 * 60 * 1000, collected: null },
    { title: "Box of picture frames", note: "Eight frames, mixed sizes, glass all intact.", cat: "Furniture", kind: "bookcase", spot: "doorstep", expires: now - 3 * 60 * 60 * 1000, collected: null },
    { title: "Toddler trike", note: "Push handle detaches. Went to a family on Wilton Way.", cat: "Kids", kind: "bike", spot: "front garden", expires: now - 26 * 60 * 60 * 1000, collected: now - 26 * 60 * 60 * 1000 },
  ];

  for (const m of mine) {
    const shots = SEED_PHOTOS[m.title] || [];
    const row = await one(
      `INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot, photo, photos, claimed_by, claim_expires_at, collected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [
        demoId, m.title, m.note, m.cat, m.kind, home.road, home.address, windowMs2,
        m.expires, m.expires - windowMs2, home.postcode, home.lat, home.lng, m.spot,
        shots[0] || null, JSON.stringify(shots),
        m.collected ? giverIds[0] : null,
        m.collected ? m.collected : null,
        m.collected,
      ]
    );
    /* the trike earned a thank-you from the neighbour who took it */
    if (m.collected) {
      await query(
        "INSERT INTO thanks (item_id, from_id, to_id, token, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [Number(row.id), giverIds[0], demoId, "star", m.collected + 5 * 60 * 1000]
      );
      await query(
        "INSERT INTO notifications (user_id, item_id, title, body, created_at, read_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [demoId, Number(row.id), "Thank you", "Maya says you're a star for the toddler trike.", m.collected + 5 * 60 * 1000, now - 60 * 60 * 1000]
      );
    }
  }

  /* thanks already sent for two of the things collected earlier */
  const thanksFor = [
    ["Bookshelf", "brew"],
    ["Garden bench", "plant"],
  ];
  for (const [title, token] of thanksFor) {
    const itemId = history[title];
    if (!itemId) continue;
    const owner = await one("SELECT owner_id FROM items WHERE id = $1", [itemId]);
    await query(
      "INSERT INTO thanks (item_id, from_id, to_id, token, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [itemId, demoId, owner.owner_id, token, now - 4 * 24 * 60 * 60 * 1000]
    );
  }
}
