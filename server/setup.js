import { initDb, refreshSeed, query, closeDb } from "./db.js";

/* Creates the schema and lays down the demo neighbourhood.
 *
 *   DATABASE_URL="postgresql://..." npm run db:setup
 *
 * Safe to run more than once: every table is CREATE TABLE IF NOT EXISTS, and
 * the seed replaces its own listings rather than duplicating them. The API
 * does this on boot too — this exists so you can set a database up, and see
 * that it worked, without waiting for a deploy.
 */

const where = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL).host
  : "local PGlite (no DATABASE_URL set)";

console.log(`Setting up Doorstep on ${where}`);

await initDb();
console.log("Schema created.");

await refreshSeed();
console.log("Demo neighbourhood seeded.");

const tables = await query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' ORDER BY table_name`
);
const counts = {};
for (const t of tables.map((r) => r.table_name)) {
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM "${t}"`);
  counts[t] = Number(n);
}

console.log("\nTables:");
for (const [t, n] of Object.entries(counts)) {
  console.log(`  ${t.padEnd(16)} ${n} row${n === 1 ? "" : "s"}`);
}
console.log("\nSign in with demo@doorstep.uk / doorstep123");

await closeDb();
