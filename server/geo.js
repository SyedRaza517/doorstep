import { db } from "./db.js";

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

/* Free UK postcode geocoding, cached in SQLite so each postcode hits
   the network once. Returns:
   { ok: true, lat, lng }            — geocoded
   { ok: false, reason: "invalid" }  — postcodes.io says it doesn't exist
   { ok: false, reason: "offline" }  — network/API failure, caller decides */
export async function geocodePostcode(postcode) {
  const clean = postcode.trim().toUpperCase().replace(/\s+/g, "");
  const cached = db.prepare("SELECT lat, lng FROM postcode_cache WHERE postcode = ?").get(clean);
  if (cached) return { ok: true, lat: cached.lat, lng: cached.lng };

  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
    if (res.status === 404) return { ok: false, reason: "invalid" };
    if (!res.ok) return { ok: false, reason: "offline" };
    const data = await res.json();
    const lat = data.result.latitude;
    const lng = data.result.longitude;
    db.prepare("INSERT OR REPLACE INTO postcode_cache (postcode, lat, lng) VALUES (?, ?, ?)").run(clean, lat, lng);
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
