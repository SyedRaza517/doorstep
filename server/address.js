import { query, one } from "./db.js";
import { geocodePostcode } from "./geo.js";

/* Turning a postcode into an address someone can pick from.
 *
 * There is no free source of UK house-level addresses. Royal Mail's Postcode
 * Address File is licensed, and the one popular free-ish API built on it
 * (getAddress.io) was shut down in February 2026 after losing in the High
 * Court. OpenStreetMap has almost no house numbers on London residential
 * streets, and Ordnance Survey's OS Places carries Royal Mail's rights so it
 * is excluded from their free allowance.
 *
 * So this works two ways:
 *
 *   With IDEAL_POSTCODES_KEY set, it asks a licensed provider and returns a
 *   real list of addresses to choose from, each with a UPRN — the stable
 *   identifier worth storing.
 *
 *   Without one, it verifies the postcode against postcodes.io, names the
 *   street by reverse geocoding, and asks the person for their house number.
 *   That is what the DWP's own "find an address" guidance recommends as a
 *   perfectly good default, and it is what most small UK apps do.
 *
 * Either way the postcode is verified and the coordinates are real, so
 * distances are honest. `verified` records which route was taken, so records
 * can be upgraded later without asking anyone to type their address again. */

const KEY = process.env.IDEAL_POSTCODES_KEY;
export const hasAddressProvider = Boolean(KEY);

const clean = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, "");
const pretty = (pc) => {
  const c = clean(pc);
  return c.length > 3 ? `${c.slice(0, -3)} ${c.slice(-3)}` : c;
};

async function fromProvider(postcode) {
  const res = await fetch(
    `https://api.ideal-postcodes.co.uk/v1/postcodes/${encodeURIComponent(clean(postcode))}?api_key=${encodeURIComponent(KEY)}`
  );
  if (res.status === 404) return { ok: false, reason: "invalid" };
  if (!res.ok) return { ok: false, reason: "offline" };
  const body = await res.json();
  if (body.code !== 2000 || !Array.isArray(body.result)) return { ok: false, reason: "offline" };

  return {
    ok: true,
    mode: "list",
    postcode: pretty(postcode),
    addresses: body.result.map((a) => ({
      id: String(a.uprn || a.udprn),
      line: [a.line_1, a.line_2].filter(Boolean).join(", "),
      road: a.thoroughfare || a.line_1,
      full: [a.line_1, a.line_2, a.post_town, a.postcode].filter(Boolean).join(", "),
      lat: a.latitude,
      lng: a.longitude,
    })),
  };
}

/* the street name, from the postcode's own coordinates */
async function streetFor(lat, lng) {
  const cached = await one("SELECT road FROM street_cache WHERE lat = $1 AND lng = $2", [lat, lng]);
  if (cached) return cached.road;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1`,
      { headers: { "User-Agent": "Doorstep/0.1 (neighbourhood giveaway app)" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const road = (data.address && data.address.road) || null;
    if (road) {
      await query("INSERT INTO street_cache (lat, lng, road) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [lat, lng, road]);
    }
    return road;
  } catch {
    return null;
  }
}

export async function lookupPostcode(postcode) {
  if (KEY) {
    const viaProvider = await fromProvider(postcode);
    if (viaProvider.ok || viaProvider.reason === "invalid") return viaProvider;
    /* provider down — fall through rather than blocking a signup */
  }

  const geo = await geocodePostcode(postcode);
  if (!geo.ok) return { ok: false, reason: geo.reason };

  const road = await streetFor(geo.lat, geo.lng);
  return {
    ok: true,
    mode: "street",
    postcode: pretty(postcode),
    road,
    lat: geo.lat,
    lng: geo.lng,
  };
}
