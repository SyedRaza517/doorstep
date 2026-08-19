import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

/* DOORSTEP_DB lets the test suite run against a throwaway database */
export const db = new Database(process.env.DOORSTEP_DB || path.join(dir, "doorstep.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    postcode      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id         INTEGER NOT NULL REFERENCES users(id),
    title            TEXT NOT NULL,
    note             TEXT NOT NULL DEFAULT '',
    cat              TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'bookcase',
    road             TEXT NOT NULL,
    address          TEXT NOT NULL,
    dist             TEXT NOT NULL DEFAULT '',
    window_ms        INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    claimed_by       INTEGER REFERENCES users(id),
    claim_expires_at INTEGER,
    created_at       INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_expires ON items(expires_at);

  CREATE TABLE IF NOT EXISTS postcode_cache (
    postcode TEXT PRIMARY KEY,
    lat      REAL NOT NULL,
    lng      REAL NOT NULL
  );
`);

/* additive migrations for columns that arrived after the first schema */
const itemCols = db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
if (!itemCols.includes("photo")) db.exec("ALTER TABLE items ADD COLUMN photo TEXT");
if (!itemCols.includes("lat")) db.exec("ALTER TABLE items ADD COLUMN lat REAL");
if (!itemCols.includes("lng")) db.exec("ALTER TABLE items ADD COLUMN lng REAL");
if (!itemCols.includes("postcode")) db.exec("ALTER TABLE items ADD COLUMN postcode TEXT");
if (!itemCols.includes("collected_at")) db.exec("ALTER TABLE items ADD COLUMN collected_at INTEGER");
if (!itemCols.includes("spot")) db.exec("ALTER TABLE items ADD COLUMN spot TEXT NOT NULL DEFAULT 'doorstep'");
/* every competitor allows several photos per listing; ours were single */
if (!itemCols.includes("photos")) db.exec("ALTER TABLE items ADD COLUMN photos TEXT");
if (!itemCols.includes("hidden_at")) db.exec("ALTER TABLE items ADD COLUMN hidden_at INTEGER");
db.exec(`
  CREATE TABLE IF NOT EXISTS no_shows (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    item_id INTEGER,
    at      INTEGER NOT NULL
  );

  /* the wish list — our answer to WANTED posts. Nobody has to beg publicly:
     you say what you're after once, and the moment a neighbour lists it you
     are told. Matches run both ways — a new wish also checks what is already
     live right now. */
  CREATE TABLE IF NOT EXISTS wishes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    keyword    TEXT NOT NULL DEFAULT '',
    cat        TEXT NOT NULL DEFAULT 'Anything',
    radius     REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  /* one nudge per wish per item, so nobody is told twice about the same thing */
  CREATE TABLE IF NOT EXISTS wish_hits (
    wish_id INTEGER NOT NULL REFERENCES wishes(id),
    item_id INTEGER NOT NULL REFERENCES items(id),
    at      INTEGER NOT NULL,
    PRIMARY KEY (wish_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    item_id    INTEGER,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

  /* reporting is table stakes everywhere, and a user-to-user service has
     illegal-content duties under the Online Safety Act regardless of size */
  /* save something to come back to — Olio's Watchlist star */
  CREATE TABLE IF NOT EXISTS saves (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    item_id    INTEGER NOT NULL REFERENCES items(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );

  /* a thank-you needs no chat: a fixed token, sent once, after a collection */
  CREATE TABLE IF NOT EXISTS thanks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES items(id),
    from_id    INTEGER NOT NULL REFERENCES users(id),
    to_id      INTEGER NOT NULL REFERENCES users(id),
    token      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (item_id, from_id)
  );

  /* blocking resolves most neighbour friction without moderation */
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id),
    blocked_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES items(id),
    reporter_id INTEGER NOT NULL REFERENCES users(id),
    reason      TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    UNIQUE (item_id, reporter_id)
  );
`);
/* an earlier build called these alerts; carry them over */
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
if (tables.includes("alerts")) {
  db.exec("INSERT INTO wishes (id, user_id, keyword, cat, radius, created_at) SELECT id, user_id, keyword, cat, radius, created_at FROM alerts");
  db.exec("DROP TABLE alerts");
}

const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes("lat")) db.exec("ALTER TABLE users ADD COLUMN lat REAL");
if (!userCols.includes("lng")) db.exec("ALTER TABLE users ADD COLUMN lng REAL");
/* save your address once rather than typing it into every listing */
if (!userCols.includes("address")) db.exec("ALTER TABLE users ADD COLUMN address TEXT");
if (!userCols.includes("road")) db.exec("ALTER TABLE users ADD COLUMN road TEXT");
if (!userCols.includes("spot")) db.exec("ALTER TABLE users ADD COLUMN spot TEXT");

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

export function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* Demo data — London Fields / Dalston / Stoke Newington, the launch
   neighbourhood. Real roads, real postcodes, coordinates verified via
   postcodes.io. Seed items are wiped and re-listed with fresh windows on
   every server start so the feed is never empty in a demo. */
const SEED_GIVERS = [
  { name: "Maya Fletcher", email: "maya@doorstep.seed", postcode: "E8 3PH", lat: 51.54099, lng: -0.05766 },
  { name: "Tomasz Nowak", email: "tomasz@doorstep.seed", postcode: "E8 3EP", lat: 51.54161, lng: -0.06368 },
  { name: "Adaeze Okonkwo", email: "adaeze@doorstep.seed", postcode: "E8 1BG", lat: 51.5457, lng: -0.06159 },
];

const DEMO = { name: "Demo User", email: "demo@doorstep.uk", postcode: "E8 3EP", lat: 51.54161, lng: -0.06368 };

const SEED_ITEMS = [
  { giver: 0, title: "Pine bookcase", note: "Solid pine, five shelves, a few scuffs. Behind the front gate by the bins.", cat: "Furniture", kind: "bookcase", road: "Ellingfort Road, E8", postcode: "E8 3PA", lat: 51.54248, lng: -0.05646, address: "14 Ellingfort Road, London E8 3PA", left: 98 },
  { giver: 1, title: "IKEA POÄNG armchair", note: "Birch frame, beige cushion, no rips. Ground-floor porch, easy carry.", cat: "Furniture", kind: "chairs", road: "Navarino Road, E8", postcode: "E8 1AD", lat: 51.54473, lng: -0.06193, address: "27 Navarino Road, London E8 1AD", left: 115 },
  { giver: 2, title: "Kids balance bike", note: "Strider 12 inch, outgrown. Tyres pumped, ready to ride. Front garden, behind the gate.", cat: "Kids", kind: "bike", road: "Gayhurst Road, E8", postcode: "E8 3EN", lat: 51.54237, lng: -0.06258, address: "52 Gayhurst Road, London E8 3EN", left: 52 },
  { giver: 0, title: "Wooden toy kitchen", note: "IKEA DUKTIG with pans and play food. Bulky but light — on the front steps.", cat: "Kids", kind: "toys", road: "Sandringham Road, E8", postcode: "E8 2LR", lat: 51.54993, lng: -0.07267, address: "89 Sandringham Road, London E8 2LR", left: 81 },
  { giver: 1, title: "Baby bath + stand", note: "Shnuggle bath with folding stand, cleaned up. On the porch all afternoon.", cat: "Kids", kind: "baby", road: "Parkholme Road, E8", postcode: "E8 3AG", lat: 51.54462, lng: -0.06863, address: "34 Parkholme Road, London E8 3AG", left: 38 },
  { giver: 2, title: "Monstera in ceramic pot", note: "About 1m tall, healthy, pot included. By our front door — the blue one.", cat: "Garden", kind: "garden", road: "Broadway Market, E8", postcode: "E8 4PH", lat: 51.53675, lng: -0.06188, address: "71a Broadway Market, London E8 4PH", left: 9 },
  { giver: 0, title: "Terracotta pots x6", note: "Various sizes, one chipped. Stacked inside the front wall — bring a bag.", cat: "Garden", kind: "garden", road: "Barbauld Road, N16", postcode: "N16 0SS", lat: 51.55765, lng: -0.08125, address: "18 Barbauld Road, London N16 0SS", left: 67 },
  { giver: 1, title: "Standing lamp", note: "Tall arc floor lamp, works fine, bulb included. On the doorstep of the flat entrance.", cat: "Electricals", kind: "bookcase", road: "Stoke Newington High Street, N16", postcode: "N16 8EL", lat: 51.5592, lng: -0.07442, address: "69b Stoke Newington High Street, London N16 8EL", left: 25 },
];

/* Several tables point at items (saves, wish hits, reports, thanks), so an
   item can't simply be deleted — its dependents go first. */
function deleteItems(ids) {
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(",");
  for (const table of ["saves", "wish_hits", "reports", "thanks"]) {
    db.prepare(`DELETE FROM ${table} WHERE item_id IN (${marks})`).run(...ids);
  }
  db.prepare(`DELETE FROM notifications WHERE item_id IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM no_shows WHERE item_id IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM items WHERE id IN (${marks})`).run(...ids);
}

export function refreshSeed() {
  const now = Date.now();

  /* create or move a user to their seed postcode (existing accounts get
     relocated so an old Gloucester-era database migrates to London) */
  const ensureUser = ({ name, email, postcode, lat, lng }, password) => {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      db.prepare("UPDATE users SET postcode = ?, lat = ?, lng = ? WHERE id = ?").run(postcode, lat, lng, existing.id);
      return existing.id;
    }
    return db
      .prepare("INSERT INTO users (name, email, postcode, password_hash, created_at, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(name, email, postcode, hashPassword(password), now, lat, lng).lastInsertRowid;
  };

  const giverIds = SEED_GIVERS.map((g) => ensureUser(g, newToken()));
  ensureUser(DEMO, "doorstep123");

  /* wipe seed listings and anything from before items had coordinates */
  const stale = db
    .prepare(`SELECT id FROM items WHERE owner_id IN (${giverIds.map(() => "?").join(",")}) OR lat IS NULL`)
    .all(...giverIds)
    .map((r) => r.id);
  deleteItems(stale);

  const insert = db.prepare(`
    INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const SPOT_BY_TITLE = {
    "Pine bookcase": "front garden",
    "IKEA POÄNG armchair": "porch",
    "Kids balance bike": "front garden",
    "Wooden toy kitchen": "doorstep",
    "Baby bath + stand": "porch",
    "Monstera in ceramic pot": "doorstep",
    "Terracotta pots x6": "front garden",
    "Standing lamp": "buzz and collect",
  };
  const windowMs = 2 * 60 * 60 * 1000;
  for (const it of SEED_ITEMS) {
    insert.run(giverIds[it.giver], it.title, it.note, it.cat, it.kind, it.road, it.address, "", windowMs, now + it.left * 60 * 1000, now, it.postcode, it.lat, it.lng, SPOT_BY_TITLE[it.title] || "doorstep");
  }
}

/* A few items already collected, so the diversion figures aren't a wall of
   zeros in a demo. Runs after refreshSeed (which clears seed-giver items),
   dated over the past three weeks and already expired, so they never appear
   in the feed — only in the impact report. */
const SEED_HISTORY = [
  { title: "Chest of drawers", cat: "Furniture", kind: "bookcase", road: "Ellingfort Road, E8", postcode: "E8 3PA", daysAgo: 19 },
  { title: "Highchair", cat: "Kids", kind: "baby", road: "Navarino Road, E8", postcode: "E8 1AD", daysAgo: 16 },
  { title: "Garden bench", cat: "Garden", kind: "garden", road: "Gayhurst Road, E8", postcode: "E8 3EN", daysAgo: 12 },
  { title: "Desk lamp", cat: "Electricals", kind: "bookcase", road: "Sandringham Road, E8", postcode: "E8 2LR", daysAgo: 9 },
  { title: "Bookshelf", cat: "Furniture", kind: "bookcase", road: "Parkholme Road, E8", postcode: "E8 3AG", daysAgo: 5 },
  { title: "Scooter", cat: "Kids", kind: "bike", road: "Barbauld Road, N16", postcode: "N16 0SS", daysAgo: 2 },
];

export function seedCollectedHistory() {
  const now = Date.now();
  const givers = db.prepare("SELECT id FROM users WHERE email LIKE '%@doorstep.seed'").all().map((r) => r.id);
  const demo = db.prepare("SELECT id FROM users WHERE email = 'demo@doorstep.uk'").get();
  if (!givers.length || !demo) return;

  const previous = db
    .prepare("SELECT id FROM items WHERE collected_at IS NOT NULL AND owner_id IN (" + givers.map(() => "?").join(",") + ")")
    .all(...givers)
    .map((r) => r.id);
  deleteItems(previous);

  const insert = db.prepare(`
    INSERT INTO items (owner_id, title, note, cat, kind, road, address, dist, window_ms, expires_at, created_at, postcode, lat, lng, spot, claimed_by, claim_expires_at, collected_at)
    VALUES (?, ?, '', ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'doorstep', ?, ?, ?)
  `);
  const windowMs = 2 * 60 * 60 * 1000;
  SEED_HISTORY.forEach((h, i) => {
    const at = now - h.daysAgo * 24 * 60 * 60 * 1000;
    const coords = db.prepare("SELECT lat, lng FROM postcode_cache WHERE postcode = ?").get(h.postcode.replace(/\s+/g, "")) || { lat: 51.5416, lng: -0.0575 };
    insert.run(givers[i % givers.length], h.title, h.cat, h.kind, h.road, `${10 + i} ${h.road}`, windowMs, at, at - windowMs, h.postcode, coords.lat, coords.lng, demo.id, at, at);
  });
}
