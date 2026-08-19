import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

/* geo.js pulls in db.js; these tests only touch the pure maths, so an
   in-memory PGlite is never even connected to. */
process.env.PGLITE_DIR = path.join(os.tmpdir(), `doorstep-geo-${process.pid}`);

const { milesBetween, formatMiles, approxCoords } = await import("../geo.js");

test("milesBetween measures a known London Fields hop", () => {
  /* London Fields (E8 3EP) to Gayhurst Road (E8 3EN) — walkable, well under
     a quarter mile */
  const miles = milesBetween(51.54161, -0.06368, 51.54237, -0.06258);
  assert.ok(miles > 0.02 && miles < 0.12, `expected a short hop, got ${miles}`);
});

test("milesBetween is symmetric and zero for the same point", () => {
  const a = milesBetween(51.54, -0.06, 51.56, -0.08);
  const b = milesBetween(51.56, -0.08, 51.54, -0.06);
  assert.equal(a.toFixed(6), b.toFixed(6));
  assert.equal(milesBetween(51.54, -0.06, 51.54, -0.06), 0);
});

test("formatMiles never shows a misleading 0.0", () => {
  assert.equal(formatMiles(0.004), "0.1 mi");
  assert.equal(formatMiles(0.34), "0.3 mi");
  assert.equal(formatMiles(12.4), "12 mi");
});

test("approxCoords blurs a pin to roughly a street block", () => {
  const exact = { lat: 51.542371, lng: -0.062583 };
  const pin = approxCoords(exact.lat, exact.lng);
  assert.notEqual(pin.lat, exact.lat, "pin must not equal the front door");
  const drift = milesBetween(exact.lat, exact.lng, pin.lat, pin.lng);
  assert.ok(drift < 0.1, `blur should stay local, drifted ${drift} mi`);
});
