import { query, one } from "./db.js";

/* London Fields — the launch neighbourhood's centre, used only when
   postcodes.io is unreachable at signup time */
export const FALLBACK = { lat: 51.54163, lng: -0.05754 };

export function milesBetween(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatMiles(mi) {
  if (mi < 0.1) return "0.1 mi";
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

/* Free UK postcode geocoding, cached in the database so each postcode hits
   the network once. Returns:
   { ok: true, lat, lng }            — geocoded
   { ok: false, reason: "invalid" }  — postcodes.io says it doesn't exist
   { ok: false, reason: "offline" }  — network/API failure, caller decides */
export async function geocodePostcode(postcode) {
  const clean = String(postcode).trim().toUpperCase().replace(/\s+/g, "");
  const cached = await one("SELECT lat, lng FROM postcode_cache WHERE postcode = $1", [clean]);
  if (cached) return { ok: true, lat: cached.lat, lng: cached.lng };

  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
    if (res.status === 404) return { ok: false, reason: "invalid" };
    if (!res.ok) return { ok: false, reason: "offline" };
    const data = await res.json();
    const lat = data.result.latitude;
    const lng = data.result.longitude;
    await query(
      `INSERT INTO postcode_cache (postcode, lat, lng) VALUES ($1,$2,$3)
       ON CONFLICT (postcode) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
      [clean, lat, lng]
    );
    return { ok: true, lat, lng };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

/* Coarse coordinates for the map before an item is claimed: snapped to a
   ~110m grid so a pin never points at a front door */
export function approxCoords(lat, lng) {
  return { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000 };
}


/* The name a local would use, from the postcode's outward half. Nextdoor
   spends real money deriving neighbourhood boundaries; for a Hackney launch
   a district map does the same job for free, and "London Fields" warms a
   card in a way "E8" never will. */
const AREA_BY_DISTRICT = {
  E8: "London Fields",
  E5: "Clapton",
  E9: "Homerton",
  E2: "Bethnal Green",
  E3: "Bow",
  N16: "Stoke Newington",
  N1: "De Beauvoir",
  N4: "Finsbury Park",
  N5: "Highbury",
  E10: "Leyton",
  E11: "Leytonstone",
  E17: "Walthamstow",
  EC1: "Clerkenwell",
  EC2: "Shoreditch",
};

export function areaFor(postcode) {
  /* the outward code, whether or not anyone typed the space: the inward half
     is always digit-letter-letter, so peel that off a full postcode first */
  const clean = String(postcode || "").trim().toUpperCase().replace(/[ ]+/g, "");
  const full = clean.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)[0-9][A-Z]{2}$/);
  const m = full || clean.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)$/);
  if (!m) return null;
  const outward = m[1];
  if (AREA_BY_DISTRICT[outward]) return AREA_BY_DISTRICT[outward];
  /* strip the trailing letter of districts like E8A, then give up gracefully */
  const stem = outward.replace(/[A-Z]$/, "");
  return AREA_BY_DISTRICT[stem] || null;
}
